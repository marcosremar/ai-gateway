import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const CLUSTER_HOST = process.env.CLUSTER_HOST;
let gatewayUrl = process.env.GATEWAY_URL;
let local: { child: ChildProcess; home: string; output: string[] } | null = null;

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
}

async function startLocalGateway(): Promise<string> {
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), 'aigw-serve-'));
  const child = spawn('bun', ['--no-env-file', 'serve.ts'], {
    cwd: resolve(__dirname, '..'),
    env: { PATH: process.env.PATH, HOME: home, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  local = { child, home, output: [] };
  child.stdout!.on('data', (b) => local?.output.push(String(b)));
  child.stderr!.on('data', (b) => local?.output.push(String(b)));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    const up = await fetch(`${url}/health`).then((r) => r.ok, () => false);
    if (up) return url;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`serve.ts did not answer /health on ${port}:\n${local.output.join('').slice(-2000)}`);
}

async function fetchHealth(): Promise<Record<string, unknown>> {
  if (gatewayUrl) {
    const res = await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(10_000) });
    expect(res.status).toBe(200);
    return res.json() as Promise<Record<string, unknown>>;
  }
  const { ssh, parseJSON } = await import('./helpers');
  return parseJSON(ssh(CLUSTER_HOST!, 'curl -sf http://localhost:8000/health'));
}

describe('GET /health', () => {
  beforeAll(async () => {
    if (CLUSTER_HOST && !gatewayUrl) {
      const { waitForHealthy, keepAlive } = await import('./setup');
      waitForHealthy(CLUSTER_HOST);
      keepAlive(CLUSTER_HOST);
      return;
    }
    gatewayUrl ??= await startLocalGateway();
  }, 180_000);

  afterAll(() => {
    if (!local) return;
    local.child.kill('SIGKILL');
    rmSync(local.home, { recursive: true, force: true });
  });

  it('returns healthy status', async () => {
    const data = await fetchHealth();
    expect(data.status).toMatch(local ? /^ok$/ : /ok|healthy|degraded/);
  });

  it('includes uptime or system info', async () => {
    const data = await fetchHealth();
    expect(data.uptimeSeconds !== undefined || data.uptime_sec !== undefined || data.system !== undefined).toBe(true);
  });
});
