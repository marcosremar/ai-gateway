import { createLogger } from '../../logger';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const log = createLogger('local-kokoro');

const DEFAULT_PORT = 8001;
// import.meta.dir is Bun-specific; fall back to Node's import.meta.url
const __dir = (import.meta as any).dir ?? dirname(fileURLToPath(import.meta.url));
const VENV_DIR = join(__dir, '..', '..', '..', '.venv-kokoro');
const SERVER_DIR = join(__dir, '..', '..', '..', 'dockers', 'kokoro-tts');

let proc: any = null;
let _url: string | null = null;
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

export function getLocalKokoroUrl(): string | null {
  if (process.env.LOCAL_KOKORO_URL) return process.env.LOCAL_KOKORO_URL;
  if (process.env.LOCAL_KOKORO_DISABLED === '1') return null;
  return _url;
}

export async function startLocalKokoro(): Promise<string | null> {
  if (process.env.LOCAL_KOKORO_DISABLED === '1') {
    log.log('disabled via LOCAL_KOKORO_DISABLED=1');
    return null;
  }

  if (process.env.LOCAL_KOKORO_URL) {
    _url = process.env.LOCAL_KOKORO_URL;
    log.log(`using external LOCAL_KOKORO_URL=${_url}`);
    return _url;
  }

  const port = parseInt(process.env.LOCAL_KOKORO_PORT || String(DEFAULT_PORT), 10);

  const pythonBin = join(VENV_DIR, 'bin', 'python3');
  if (!existsSync(pythonBin)) {
    log.warn(`venv not found at ${VENV_DIR}, skipping local Kokoro`);
    return null;
  }

  const serverFile = join(SERVER_DIR, 'server.py');
  if (!existsSync(serverFile)) {
    log.warn(`server.py not found at ${serverFile}, skipping local Kokoro`);
    return null;
  }

  log.log(`starting local Kokoro TTS on port ${port}...`);

  try {
    const { spawn } = await import('bun');
    proc = spawn({
      cmd: [pythonBin, '-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', `--port=${port}`],
      cwd: SERVER_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    const url = `http://127.0.0.1:${port}`;

    const ready = await waitForHealth(url, 60_000);
    if (!ready) {
      log.warn('local Kokoro did not become healthy in time, killing');
      proc.kill();
      proc = null;
      return null;
    }

    _url = url;
    log.log(`local Kokoro TTS ready at ${url}`);

    healthCheckInterval = setInterval(() => checkHealth(url), 30_000);

    return _url;
  } catch (e) {
    log.error(`failed to start local Kokoro: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) {
        const body = await res.json() as any;
        if (body.status === 'ok') return true;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 2_000));
  }
  return false;
}

async function checkHealth(url: string): Promise<void> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) log.warn(`local Kokoro health check failed: ${res.status}`);
  } catch (e) {
    log.warn(`local Kokoro health check error: ${e instanceof Error ? e.message : e}`);
  }
}

export async function stopLocalKokoro(): Promise<void> {
  if (healthCheckInterval) { clearInterval(healthCheckInterval); healthCheckInterval = null; }
  if (proc) {
    log.log('stopping local Kokoro TTS server');
    proc.kill();
    proc = null;
    _url = null;
  }
}
