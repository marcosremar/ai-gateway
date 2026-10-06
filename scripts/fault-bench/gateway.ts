/**
 * Starts the real gateway (`serve.ts`, under Bun) against the fake upstream, with fake keys and no way out:
 * HTTP(S)_PROXY points at a closed local port and only 127.0.0.1 bypasses it, so any call that would leave the machine
 * (a real provider, the palco dev API) fails at once instead of spending money.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * Chaves falsas geradas a cada execução: nenhum literal com cara de credencial no repositório (regra
 * aigw-no-hardcoded-provider-token), e o teste de vazamento (16) procura estes valores exatos nos logs.
 */
export const fakeKey = (label: string): string => ['bench', label, randomUUID().replaceAll('-', '')].join('_');

export const FAKE_KEYS = {
  OPENROUTER_API_KEY: fakeKey('openrouter'),
  GROQ_API_KEY: fakeKey('groq'),
  GATEWAY_KEY: fakeKey('client'),
};

export interface RunningGateway {
  url: string;
  port: number;
  proc: ChildProcess;
  /** Everything the process printed (stdout + stderr). */
  output: () => string;
  stop: () => Promise<void>;
}

const ROOT = join(import.meta.dirname, '..', '..');
let nextPort = 4700 + Math.floor(Math.random() * 200);

export const DEFAULT_ROUTES = {
  chat: { 't-llm': ['openrouter:a', 'openrouter:b', 'groq:c'] },
  stt: { 't-stt': ['openrouter:sa', 'groq:sc'] },
  tts: { 't-tts': ['openrouter:ta', 'groq:tc'] },
};

export async function startGateway(upstreamUrl: string, env: Record<string, string> = {}): Promise<RunningGateway> {
  const port = nextPort++;
  let out = '';
  // Same Bun as the bench runner (BENCH_BUN overrides): node:http abort events differ between Bun releases.
  const proc = spawn(process.env.BENCH_BUN ?? process.execPath, ['serve.ts'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '/tmp',
      PORT: String(port),
      NODE_ENV: 'test',
      OPENROUTER_API_BASE: `${upstreamUrl}/or`,
      GROQ_API_BASE: `${upstreamUrl}/groq`,
      OPENROUTER_API_KEY: FAKE_KEYS.OPENROUTER_API_KEY,
      GROQ_API_KEY: FAKE_KEYS.GROQ_API_KEY,
      GATEWAY_API_KEYS: `${FAKE_KEYS.GATEWAY_KEY}:bench`,
      MODEL_ROUTES: JSON.stringify(DEFAULT_ROUTES),
      DECLARED_DEPLOYMENTS: '0',
      S2S_STT_MODEL: 't-stt',
      S2S_CHAT_MODEL: 't-llm',
      S2S_TTS_MODEL: 't-tts',
      // No way out of the machine.
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      http_proxy: 'http://127.0.0.1:9',
      https_proxy: 'http://127.0.0.1:9',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
  proc.stderr!.on('data', (d: Buffer) => { out += d.toString(); });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`gateway exited (${proc.exitCode}):\n${out.slice(-3000)}`);
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) { proc.kill('SIGKILL'); throw new Error(`gateway did not start:\n${out.slice(-3000)}`); }
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    url, port, proc,
    output: () => out,
    stop: () => new Promise<void>((resolve) => {
      if (proc.exitCode !== null) return resolve();
      proc.once('exit', () => resolve());
      proc.kill('SIGKILL');
    }),
  };
}
