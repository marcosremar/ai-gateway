/**
 * Local STT service management handlers.
 * Supports installing, starting, stopping, and checking status of local STT servers
 * (mlx-qwen3-asr on Apple Silicon).
 */

import { createLogger } from '../src/logger';
import { execFile, spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const log = createLogger('local-stt');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SCRIPTS_DIR = path.join(PROJECT_ROOT, 'scripts');
const PID_FILE = '/tmp/babelcast-mlx-qwen3-asr.pid';
const LOG_FILE = path.join(PROJECT_ROOT, 'logs', 'mlx-qwen3-asr.log');
const VENV_DIR = path.join(PROJECT_ROOT, '.venv-mlx-qwen3-asr');

const ALLOWED_VARIANTS = ['4bit', 'fp16', '1.7b'];
// eslint-disable-next-line no-control-regex, no-useless-escape
const SHELL_META_CHARS = /[;|&$`\\!#<>{}\[\]()*?~\n\r]/;

function validateScriptPath(scriptPath: string): string | null {
  if (!scriptPath || typeof scriptPath !== 'string') {
    return 'Script path is required';
  }
  if (SHELL_META_CHARS.test(scriptPath)) {
    return 'Invalid characters in script path';
  }
  if (!path.isAbsolute(scriptPath)) {
    return 'Script path must be absolute';
  }
  if (!existsSync(scriptPath)) {
    return `Script not found: ${scriptPath}`;
  }
  return null;
}

function validateVariant(variant: string): string | null {
  if (!variant || typeof variant !== 'string') {
    return 'Variant is required';
  }
  if (SHELL_META_CHARS.test(variant)) {
    return 'Invalid characters in variant';
  }
  if (!ALLOWED_VARIANTS.includes(variant)) {
    return `Invalid variant: ${variant}. Allowed: ${ALLOWED_VARIANTS.join(', ')}`;
  }
  return null;
}

interface LocalSTTStatus {
  installed: boolean;
  running: boolean;
  variant: string | null;
  model: string | null;
  dtype: string | null;
  port: number;
  host: string;
  pid: number | null;
  uptime: number | null;
}

async function getQwenStatus(): Promise<LocalSTTStatus> {
  const port = parseInt(process.env.MLX_QWEN3_ASR_PORT || '8765');
  const host = `http://localhost:${port}`;
  const installed = existsSync(path.join(VENV_DIR, 'bin', 'mlx-qwen3-asr'));

  let running = false;
  let model: string | null = null;
  let dtype: string | null = null;
  let uptime: number | null = null;
  let pid: number | null = null;

  // Check PID file
  if (existsSync(PID_FILE)) {
    try {
      pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
    } catch { /* best-effort: cleanup or optional side-effect */ }
  }

  // Check health endpoint
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${host}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json() as any;
      running = true;
      model = data.model || null;
      dtype = data.dtype || null;
      uptime = data.uptime_seconds || null;
    }
  } catch { /* best-effort: cleanup or optional side-effect */ }

  // Detect variant from model name
  let variant: string | null = null;
  if (model) {
    if (model.includes('4bit') || model.includes('4-bit')) variant = '4bit';
    else if (model.includes('1.7B') || model.includes('1.7b')) variant = '1.7b';
    else variant = 'fp16';
  }

  return { installed, running, variant, model, dtype, port, host, pid, uptime };
}

export async function handleLocalSttStatus(req: Request): Promise<Response> {
  const status = await getQwenStatus();
  return Response.json(status);
}

export async function handleLocalSttInstall(req: Request): Promise<Response> {
  const body = await req.json() as { variant?: string };
  const variant = body.variant || '4bit';

  const variantError = validateVariant(variant);
  if (variantError) {
    return Response.json({ error: variantError }, { status: 400 });
  }

  const script = path.join(SCRIPTS_DIR, 'setup-mlx-qwen3-asr.sh');
  const scriptError = validateScriptPath(script);
  if (scriptError) {
    return Response.json({ error: scriptError }, { status: 500 });
  }

  return new Promise((resolve) => {
    execFile('bash', [script, variant], {
      cwd: PROJECT_ROOT,
      timeout: 300_000,  // 5 min max
      env: { ...process.env, MLX_QWEN3_ASR_PORT: process.env.MLX_QWEN3_ASR_PORT || '8765' },
    }, (error, stdout, stderr) => {
      if (error) {
        log.error('Install failed: %s', error.message);
        resolve(Response.json({
          success: false,
          error: error.message,
          output: stdout + stderr,
        }, { status: 500 }));
      } else {
        log.log('Install completed for variant: %s', variant);
        resolve(Response.json({
          success: true,
          variant,
          output: stdout,
        }));
      }
    });
  });
}

export async function handleLocalSttStart(req: Request): Promise<Response> {
  const body = await req.json() as { variant?: string };
  const variant = body.variant || '4bit';

  const modelMap: Record<string, string> = {
    '4bit': 'mlx-community/Qwen3-ASR-0.6B-4bit',
    'fp16': 'Qwen/Qwen3-ASR-0.6B',
    '1.7b': 'Qwen/Qwen3-ASR-1.7B',
  };

  const model = modelMap[variant];
  if (!model) {
    return Response.json({ error: `Invalid variant: ${variant}` }, { status: 400 });
  }

  const binary = path.join(VENV_DIR, 'bin', 'mlx-qwen3-asr');
  if (!existsSync(binary)) {
    return Response.json({ error: 'mlx-qwen3-asr not installed. Run install first.' }, { status: 400 });
  }

  // Stop existing server first
  await stopServer();

  const port = process.env.MLX_QWEN3_ASR_PORT || '8765';
  const apiKey = process.env.MLX_QWEN3_ASR_API_KEY || 'babelcast-qwen3';
  const host = `http://localhost:${port}`;

  log.log('Starting mlx-qwen3-asr: model=%s port=%d', model, port);

  const child = spawn(binary, ['serve', '--model', model, '--port', port, '--api-key', apiKey], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  child.unref();

  // Write PID
  const { writeFileSync, mkdirSync } = await import('fs');
  mkdirSync(path.join(PROJECT_ROOT, 'logs'), { recursive: true });
  writeFileSync(PID_FILE, String(child.pid));

  // Wait for health (up to 180s for model download)
  const maxWait = 180;
  for (let i = 0; i < maxWait; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${host}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        log.log('Server ready in %ds', i + 1);
        return Response.json({ success: true, variant, pid: child.pid, port: parseInt(port) });
      }
    } catch { /* best-effort: cleanup or optional side-effect */ }
    await new Promise(r => setTimeout(r, 1000));
  }

  return Response.json({ error: `Server did not start within ${maxWait}s` }, { status: 500 });
}

async function stopServer(): Promise<void> {
  if (existsSync(PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
      if (pid > 0) {
        process.kill(pid, 'SIGTERM');
        await new Promise(r => setTimeout(r, 2000));
        try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* best-effort: cleanup or optional side-effect */ }
      }
    } catch { /* best-effort: cleanup or optional side-effect */ }
    const { unlinkSync } = await import('fs');
    try { unlinkSync(PID_FILE); } catch { /* best-effort: cleanup or optional side-effect */ }
  }
}

export async function handleLocalSttStop(_req: Request): Promise<Response> {
  await stopServer();
  log.log('Server stopped');
  return Response.json({ success: true });
}

export async function handleLocalSttLogs(_req: Request): Promise<Response> {
  if (!existsSync(LOG_FILE)) {
    return Response.json({ logs: '' });
  }
  try {
    const content = readFileSync(LOG_FILE, 'utf-8');
    const lines = content.split('\n');
    const tail = lines.slice(-100).join('\n');
    return Response.json({ logs: tail });
  } catch {
    return Response.json({ logs: '' });
  }
}
