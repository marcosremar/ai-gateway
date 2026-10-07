/**
 * Hardening for the 4 CodeQL alerts on PR #45 (request forgery on invoke, error details to the client, prototype keys
 * in app records, network data written to the stability file). Each test fails on the code before the fix.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDeploymentRoutes, replicaTarget } from '../../../src/deployments/http';
import { AppRegistry, MemoryAppStore } from '../../../src/deployments/apps';
import { ClientStabilityLog, fileRecord, fileText } from '../../../src/deployments/stability';

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise(r => s.close(r)); } });

async function routes(controller: unknown, fetchImpl?: typeof fetch) {
  const handler = createDeploymentRoutes({ controller: controller as never, isAdmin: () => true, userOf: () => 'owner', ...(fetchImpl ? { fetchImpl } : {}) });
  const server = createServer((req, res) => { if (!handler(req, res, (req.url ?? '').split('?')[0]!, req.method ?? 'GET')) { res.writeHead(404); res.end(); } });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('invoke: the forwarded URL stays on the replica (request forgery)', () => {
  const base = 'http://10.0.0.9:8000';

  it('plain paths and queries resolve on the replica', () => {
    expect(replicaTarget(base, 'v1/audio/speech', '?x=1')!.href).toBe('http://10.0.0.9:8000/v1/audio/speech?x=1');
    expect(replicaTarget(base, 'health/', '')!.href).toBe('http://10.0.0.9:8000/health/');
  });

  it('refuses scheme, authority, backslash and dot segments (raw or encoded)', () => {
    for (const rest of ['..', 'a/../b', '%2e%2e/etc', 'a%2fb', 'http://evil', 'https:evil', '\\\\evil/x', 'a\\b', 'a b', '%zz']) {
      expect(replicaTarget(base, rest, ''), rest).toBeNull();
    }
    expect(replicaTarget(base, 'ok', 'no-question-mark')).toBeNull();
  });

  it('the route answers 400 and never fetches for a traversal path', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
    const lease = { machine: { id: 'm', ip: '10.0.0.9:8000' }, token: 't', exposed: false, done: vi.fn() };
    const controller = { get: () => ({ app: null }), acquire: vi.fn(async () => lease), namespace: 'x', health: () => ({}), list: () => [] };
    const url = await routes(controller, fetchImpl as never);
    // Raw path: fetch() and URL parsing would normalize the dot segments client-side.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: new URL(url).port, path: '/v1/deployments/tts/invoke/%2e%2e/%2e%2e/admin', method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    const good = await fetch(`${url}/v1/deployments/tts/invoke/v1/models?a=b`, { method: 'GET' });
    expect(good.status).toBe(200);
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe('http://10.0.0.9:8000/v1/models?a=b');
  });
});

describe('deployment routes: an unexpected error never reaches the client (stack trace exposure)', () => {
  it('500 carries a generic message and a request id, not the error', async () => {
    const controller = { list: () => { throw new Error('boom at /srv/secret/path.ts:12'); }, namespace: 'x', health: () => ({}) };
    const url = await routes(controller);
    const res = await fetch(`${url}/v1/deployments`, { headers: { 'x-request-id': 'req-42' } });
    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: 'internal error', requestId: 'req-42' });
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});

describe('app registry: prototype member names are never records (remote property injection)', () => {
  it('constructor / prototype are not apps or images, and cannot be created or deleted', async () => {
    const apps = new AppRegistry(new MemoryAppStore());
    await apps.init();
    await apps.putImage('parle', 'speech', { image: 'ghcr.io/me/speech:1' });
    expect(apps.get('constructor')).toBeNull();
    expect(apps.image('parle', 'constructor')).toBeNull();
    expect(await apps.deleteImage('parle', 'constructor')).toBe(false);
    await expect(apps.putImage('parle', 'prototype', { image: 'ghcr.io/me/x:1' })).rejects.toMatchObject({ status: 400 });
    await expect(apps.putImage('constructor', 'speech', { image: 'ghcr.io/me/x:1' })).rejects.toMatchObject({ status: 400 });
    expect(await apps.deleteImage('parle', 'speech')).toBe(true);
    expect(apps.image('parle', 'speech')).toBeNull();
  });
});

describe('stability file: whitelisted, one line per report (network data written to file)', () => {
  it('free text is re-spelled from a fixed alphabet, kinds/routes from the SDK vocabulary', () => {
    expect(fileText('ok /v1/s2s: 502', 50)).toBe('ok /v1/s2s: 502');
    expect(fileText('a\nb\r\u0000c', 50)).toBe('a_b__c');
    expect(fileText('x'.repeat(500), 10)).toHaveLength(10);
    const rec = fileRecord({
      app: 'parle', client: 'site\nINJECT', receivedAt: 1_700_000_000_000,
      events: [{ at: 1, kind: 'rm -rf', route: 'evil', path: '/v1/chat\n{"x":1}', latencyMs: 12.7, detail: 'line1\nline2' }],
    });
    expect(rec).toMatchObject({ app: 'parle', client: 'site_INJECT', receivedAtIso: '2023-11-14T22:13:20.000Z' });
    expect((rec.events as Array<Record<string, unknown>>)[0]).toEqual({
      at: 1, kind: 'other', route: 'other', path: '/v1/chat___x_:1_', latencyMs: 13, detail: 'line1_line2',
    });
  });

  it('the JSONL file gets the whitelisted record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stab-'));
    try {
      const file = join(dir, 'client-stability.jsonl');
      const log = new ClientStabilityLog({ file, now: () => 1_700_000_000_000 });
      log.append('parle', { client: 'c\nX', events: [{ at: 5, kind: 'unreachable', detail: 'a\nb' }] });
      await until(async () => (await readFile(file, 'utf8').catch(() => '')).length > 0);
      const lines = (await readFile(file, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ client: 'c_X', events: [{ kind: 'unreachable', detail: 'a_b' }] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function until(cond: () => Promise<boolean>, ms = 2000) {
  const end = Date.now() + ms;
  while (!(await cond())) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); }
}
