import { createLogger } from '../../logger';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const log = createLogger('local-kokoro');

const DEFAULT_PORT = 8001;
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

async function probeHealth(url: string, timeoutMs = 1_500): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = await res.json() as { status?: string };
    return body.status === 'ok';
  } catch {
    return false;
  }
}

/** Fast poll at startup — 250ms then backoff to 1.5s (was fixed 2s). */
async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let delayMs = 250;
  while (Date.now() < deadline) {
    if (await probeHealth(url)) return true;
    await new Promise(r => setTimeout(r, delayMs));
    delayMs = Math.min(Math.round(delayMs * 1.4), 1_500);
  }
  return false;
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
  const url = `http://127.0.0.1:${port}`;

  // Reuse an already-running local server (gateway restart, parallel dev tools).
  if (await probeHealth(url)) {
    _url = url;
    log.log(`reusing existing Kokoro at ${url}`);
    if (!healthCheckInterval) {
      healthCheckInterval = setInterval(() => { void probeHealth(url).then(ok => { if (!ok) log.warn('local Kokoro health check failed'); }); }, 30_000);
    }
    return _url;
  }

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

    const ready = await waitForHealth(url, 90_000);
    if (!ready) {
      log.warn('local Kokoro did not become healthy in time, killing');
      proc.kill();
      proc = null;
      return null;
    }

    _url = url;
    log.log(`local Kokoro TTS ready at ${url}`);

    healthCheckInterval = setInterval(() => {
      void probeHealth(url).then(ok => { if (!ok) log.warn('local Kokoro health check failed'); });
    }, 30_000);

    return _url;
  } catch (e) {
    log.error(`failed to start local Kokoro: ${e instanceof Error ? e.message : e}`);
    return null;
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
