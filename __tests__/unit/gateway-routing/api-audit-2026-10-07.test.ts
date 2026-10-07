/**
 * Regressions of the API audit of 2026-10-07 at the proxy level: what the public /health shows, error types, the
 * malformed-multipart 400, the query string in route matching, the 410 hint, CORS lists, Retry-After on the per-user
 * concurrency 429, X-Request-Id hygiene and echo, and /v1/workloads no longer mounted by serve.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createProxyServer } from '../../../src/gateway/proxy/server';
import { appStagesView } from '../../../src/gateway/proxy/health-view';
import { errorTypeForStatus, requestIdOf } from '../../../src/gateway/proxy/http-conventions';
import type { ProxyConfig } from '../../../src/gateway/proxy/types';

const ADMIN = 'admin-key-0123456789';
const APP = 'parle-key-0123456789';
const OTHER = 'other-key-0123456789';

const STAGES = {
  stages: {
    stt: { 'parle-stt': { links: [{ target: 'deployment:parle-speech', state: 'missing', reason: 'GHCR_READ_TOKEN is not set' }] } },
    chat: { 'parle-llm': { links: [] }, 'other-llm': { links: [{ target: 'deployment:other-gpu', state: 'cold' }] } },
  },
  warnings: ['stt parle-stt: primary deployment:parle-speech is missing (GHCR_READ_TOKEN is not set) — serving from openrouter',
    'chat other-llm: primary deployment:other-gpu is error — no link can serve'],
};
const OWN_ALIASES: Record<string, Record<string, Set<string>>> = {
  parle: { stt: new Set(['parle-stt']), chat: new Set(['parle-llm']) },
};

let server: Server | null = null;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>(r => server!.close(() => r()));
  server = null;
});

async function start(extra: Partial<ProxyConfig> = {}): Promise<string> {
  server = createProxyServer({
    apiKeys: [`${ADMIN}:owner`, `${APP}:parle`, `${OTHER}:other`],
    providers: { chat: {}, stt: {}, tts: {} } as never,
    deepHealth: { authorize: (t) => t === ADMIN, report: async () => ({ status: 200, body: { status: 'ok', deep: true } }) },
    healthDetails: (viewer) => (viewer.admin ? STAGES
      : appStagesView(STAGES, (stage) => OWN_ALIASES[viewer.userId]?.[stage] ?? null)),
    ...extra,
  });
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

describe('S3: /health shows internals only to keys', () => {
  it('unauthenticated /health is minimal: status, version, uptime — no chains, deployments, env names or counters', async () => {
    const base = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['status', 'uptimeSeconds', 'version']);
    expect(JSON.parse(text).status).toBe('ok');
    expect(text).not.toMatch(/GHCR_READ_TOKEN|parle-speech|stages|connections|noWake/);
    // A key does not change the plain answer (the SDK breaker sends its key on every call).
    expect(Object.keys(await (await fetch(`${base}/health`, { headers: auth(APP) })).json() as object).sort())
      .toEqual(['status', 'uptimeSeconds', 'version']);
  });

  it('?details=1 needs a key: an app key sees its own aliases only, an admin everything', async () => {
    const base = await start();
    expect((await fetch(`${base}/health?details=1`)).status).toBe(401);

    const own = await (await fetch(`${base}/health?details=1`, { headers: auth(APP) })).json() as Record<string, any>;
    expect(own.status).toBe('ok');
    expect(Object.keys(own.stages.stt)).toEqual(['parle-stt']);
    expect(Object.keys(own.stages.chat)).toEqual(['parle-llm']);
    expect(own.warnings).toEqual([STAGES.warnings[0]]);
    expect(own.connections).toBeUndefined();
    expect(own.noWake).toBeUndefined();

    const other = await (await fetch(`${base}/health?details=1`, { headers: auth(OTHER) })).json() as Record<string, any>;
    expect(other.stages).toEqual({});
    expect(JSON.stringify(other)).not.toMatch(/parle|GHCR/);

    const admin = await (await fetch(`${base}/health?details=1`, { headers: auth(ADMIN) })).json() as Record<string, any>;
    expect(Object.keys(admin.stages.chat).sort()).toEqual(['other-llm', 'parle-llm']);
    expect(admin.warnings).toHaveLength(2);
    expect(admin.connections).toBeDefined();
    expect(admin.noWake).toBeDefined();
  });

  it('?deep=1: no key 401 (authentication_error), a non-admin key 403 (permission_error), admin 200', async () => {
    const base = await start();
    const none = await fetch(`${base}/health?deep=1`);
    expect(none.status).toBe(401);
    expect(((await none.json()) as any).error.type).toBe('authentication_error');
    const app = await fetch(`${base}/health?deep=1`, { headers: auth(APP) });
    expect(app.status).toBe(403);
    expect(((await app.json()) as any).error.type).toBe('permission_error');
    expect((await fetch(`${base}/health?deep=1`, { headers: auth(ADMIN) })).status).toBe(200);
  });

  it('appStagesView drops other aliases and their warnings', () => {
    const view = appStagesView(STAGES, (stage) => (stage === 'chat' ? new Set(['other-llm']) : null));
    expect(view).toEqual({ stages: { chat: { 'other-llm': STAGES.stages.chat['other-llm'] } }, warnings: [STAGES.warnings[1]] });
  });
});

describe('quick wins', () => {
  it('error type follows the status, not always server_error', () => {
    expect(errorTypeForStatus(400)).toBe('invalid_request_error');
    expect(errorTypeForStatus(401)).toBe('authentication_error');
    expect(errorTypeForStatus(403)).toBe('permission_error');
    expect(errorTypeForStatus(404)).toBe('not_found_error');
    expect(errorTypeForStatus(413)).toBe('request_too_large');
    expect(errorTypeForStatus(429)).toBe('rate_limit_error');
    expect(errorTypeForStatus(500)).toBe('server_error');
    expect(errorTypeForStatus(503)).toBe('server_error');
  });

  it('a bad key is a 401 authentication_error', async () => {
    const base = await start();
    const res = await fetch(`${base}/v1/models`, { headers: auth('nope-0123456789') });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.type).toBe('authentication_error');
  });

  it('route matching ignores the query string: /v1/models?x=1 is /v1/models', async () => {
    const base = await start();
    const res = await fetch(`${base}/v1/models?x=1`, { headers: auth(ADMIN) });
    expect(res.status).toBe(200);
  });

  it('the removed streaming routes point to /v1/s2s or /v1/chat/completions (no /v1/speech)', async () => {
    const base = await start();
    const res = await fetch(`${base}/ws/stream`, { headers: auth(ADMIN) });
    expect(res.status).toBe(410);
    const message = ((await res.json()) as any).error.message as string;
    expect(message).toContain('/v1/s2s');
    expect(message).toContain('/v1/chat/completions');
    expect(message).not.toContain('/v1/speech');
  });

  it('CORS: preflight allows PUT and the gateway headers; responses expose the gateway headers', async () => {
    const base = await start();
    const pre = await fetch(`${base}/v1/apps/parle/routes`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toContain('PUT');
    const allowed = pre.headers.get('access-control-allow-headers')!;
    for (const h of ['X-App', 'X-Request-Id', 'X-Aigw-Wait', 'X-Gateway-No-Wake']) expect(allowed).toContain(h);
    const res = await fetch(`${base}/v1/models`, { headers: { ...auth(ADMIN), Origin: 'http://localhost:3000' } });
    const exposed = res.headers.get('access-control-expose-headers')!;
    for (const h of ['X-Gateway-Provider', 'X-Gateway-Fallback', 'X-STT-Filtered', 'Retry-After', 'X-Request-Id']) expect(exposed).toContain(h);
  });

  it('per-user concurrency 429 carries Retry-After and a rate_limit_error type', async () => {
    const prev = process.env.MAX_CONCURRENT_PER_USER;
    process.env.MAX_CONCURRENT_PER_USER = '1';
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    try {
      const base = await start({
        customRoutes: [{ method: 'POST', path: '/hold', handler: async (_req, res) => { await held; res.end('done'); } }],
      });
      const first = fetch(`${base}/hold`, { method: 'POST', headers: auth(APP) });
      await new Promise(r => setTimeout(r, 100));
      const second = await fetch(`${base}/v1/models`, { headers: auth(APP) });
      expect(second.status).toBe(429);
      expect(second.headers.get('retry-after')).toBe('1');
      expect(((await second.json()) as any).error.type).toBe('rate_limit_error');
      release();
      expect((await first).status).toBe(200);
    } finally {
      release();
      if (prev === undefined) delete process.env.MAX_CONCURRENT_PER_USER; else process.env.MAX_CONCURRENT_PER_USER = prev;
    }
  });

  it('X-Request-Id: a short [\\w.-] id is echoed, anything else replaced; custom and prefix routes echo it too', async () => {
    expect(requestIdOf('turn-42.a_b')).toBe('turn-42.a_b');
    expect(requestIdOf('x'.repeat(129))).not.toBe('x'.repeat(129));
    expect(requestIdOf('bad id\r\nSet-Cookie: a')).toMatch(/^[0-9a-f-]{36}$/);
    const seen: string[] = [];
    const base = await start({
      customRoutes: [{ method: 'POST', path: '/v1/s2s', handler: async (req, res) => {
        seen.push(String(req.headers['x-request-id'])); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{}');
      } }],
      prefixRoutes: [{ prefix: '/v1/deployments', handler: (_req, res) => { res.writeHead(200); res.end('{}'); return true; } }],
    });
    const s2s = await fetch(`${base}/v1/s2s`, { method: 'POST', headers: { ...auth(APP), 'X-Request-Id': 'turn-1' } });
    expect(s2s.headers.get('x-request-id')).toBe('turn-1');
    const dep = await fetch(`${base}/v1/deployments`, { headers: { ...auth(APP), 'X-Request-Id': 'a b<script>' } });
    const echoed = dep.headers.get('x-request-id')!;
    expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
    const s2sBad = await fetch(`${base}/v1/s2s`, { method: 'POST', headers: { ...auth(APP), 'X-Request-Id': 'y'.repeat(200) } });
    expect(seen[1]).toBe(s2sBad.headers.get('x-request-id'));
    expect(seen[1]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('S2: /v1/workloads is not mounted by the production entry point', () => {
  it('serve.ts neither requires the workload handlers nor mounts /v1/workloads', () => {
    const serve = readFileSync(join(__dirname, '../../../serve.ts'), 'utf8');
    expect(serve).not.toMatch(/require\(['"]\.\/server\/workload-handlers/);
    expect(serve).not.toMatch(/prefix:\s*['"]\/v1\/workloads/);
  });

  it('without the mount, /v1/workloads is a 404 for an app key', async () => {
    const base = await start();
    const res = await fetch(`${base}/v1/workloads`, { headers: auth(APP) });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.type).toBe('invalid_request_error');
  });
});
