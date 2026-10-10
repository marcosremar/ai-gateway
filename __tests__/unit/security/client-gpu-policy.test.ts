import type { IncomingMessage, Server, ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccessKeys } from '../../../src/config/access-keys';
import { AdminGate } from '../../../src/config/admin-gate';
import { createAccessRoutes } from '../../../src/config/access-routes';
import { KeyAudit } from '../../../src/config/key-audit';
import { ClientGpu } from '../../../src/deployments/client-gpu';
import { createDeploymentRoutes } from '../../../src/deployments/http';
import { noWakeActive } from '../../../src/gateway/proxy/no-wake';
import { createProxyServer } from '../../../src/gateway/proxy/server';

const ADMIN = 'admin-key-0123456789';
const PROD = 'prod-key-0123456789';
const DEV = 'dev-key-0123456789';
const OTHER = 'other-key-0123456789';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 3 });
});

async function keys(migrate = true) {
  const dir = await mkdtemp(join(tmpdir(), 'aigw-policy-'));
  dirs.push(dir);
  const env = { GATEWAY_API_KEYS: `${ADMIN}:ops,${PROD}:parle,${DEV}:parle-dev,${OTHER}:site` };
  const access = new AccessKeys(env, { path: join(dir, 'access.json') });
  await access.load();
  if (migrate) access.migratePolicies();
  access.setBaseAdmins(['ops']);
  return { access, dir, env };
}

describe('GPU policy per client key (owner, 10/10/2026)', () => {
  it('autoWake is off by default; the migration keeps the class client (parle) waking and able to start its GPUs', async () => {
    const { access } = await keys();
    const policy = (token: string) => access.policyOf(access.resolve(token)?.keyId);
    expect(policy(PROD)).toEqual({ autoWake: true, canStartGpu: true, gpuDailyEur: null, startIdleMinutes: 10 });
    expect(policy(DEV)).toEqual({ autoWake: false, canStartGpu: false, gpuDailyEur: 5, startIdleMinutes: 10 });
    expect(policy(OTHER).autoWake).toBe(false);
  });

  it('the migration runs once and survives a restart; a policy set later is kept', async () => {
    const { access, dir, env } = await keys();
    await access.setPolicy({ id: 'env-parle', autoWake: false });
    const again = new AccessKeys(env, { path: join(dir, 'access.json') });
    await again.load();
    again.migratePolicies();
    expect(again.policyOf('env-parle').autoWake).toBe(false);
    expect(again.policyOf('env-parle').canStartGpu).toBe(true);
  });

  it('rotating a key carries its policy to the new key', async () => {
    const { access } = await keys();
    const { key } = await access.issue({ replaces: 'env-parle', overlapMinutes: 60 }, 'ops');
    expect(access.policyOf(access.resolve(key)?.keyId)).toMatchObject({ autoWake: true, canStartGpu: true, gpuDailyEur: null });
  });

  it('setPolicy validates every field and the key id', async () => {
    const { access } = await keys();
    await expect(access.setPolicy({ id: 'nope', autoWake: true })).rejects.toMatchObject({ status: 404 });
    await expect(access.setPolicy({ id: 'env-parle-dev', autoWake: 'yes' })).rejects.toMatchObject({ status: 400 });
    await expect(access.setPolicy({ id: 'env-parle-dev', gpuDailyEur: -1 })).rejects.toMatchObject({ status: 400 });
    await expect(access.setPolicy({ id: 'env-parle-dev', startIdleMinutes: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(access.setPolicy({ id: 'env-parle-dev', admin: true })).rejects.toMatchObject({ status: 400 });
    expect((await access.setPolicy({ id: 'env-parle-dev', canStartGpu: true, gpuDailyEur: 3 })).policy)
      .toEqual({ autoWake: false, canStartGpu: true, gpuDailyEur: 3, startIdleMinutes: 10 });
    expect(access.list().find(k => k.id === 'env-parle-dev')?.policy.gpuDailyEur).toBe(3);
  });

  it('only an admin sets a policy (PUT /v1/admin/access/keys/policy); a request runs no-wake unless its key has autoWake', async () => {
    const { access, dir } = await keys();
    const audit = new KeyAudit({ path: join(dir, 'audit.jsonl') });
    await audit.init();
    const gate = new AdminGate({ actorOf: (t) => { const u = access.resolve(t)?.userId; return u && access.admins.has(u) ? u : null; }, audit });
    const server = createProxyServer({
      providers: {}, keyRegistry: access,
      autoWake: bearer => access.policyOf(access.resolve(bearer)?.keyId).autoWake,
      customRoutes: [
        ...createAccessRoutes({ access, gate, audit }),
        { method: 'GET', path: '/probe', handler: (_req, res) => { res.writeHead(200); res.end(JSON.stringify({ noWake: noWakeActive() })); } },
      ],
    });
    servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, key: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${key}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
    };
    expect((await call('GET', '/probe', PROD)).json.noWake).toBe(false);
    expect((await call('GET', '/probe', DEV)).json.noWake).toBe(true);
    expect((await call('GET', '/probe', ADMIN)).json.noWake).toBe(true);
    expect((await call('PUT', '/v1/admin/access/keys/policy', PROD, { id: 'env-parle-dev', autoWake: true })).status).toBe(403);
    expect((await call('PUT', '/v1/admin/access/keys/policy', ADMIN, { id: 'env-parle-dev', autoWake: true })).status).toBe(200);
    expect((await call('GET', '/probe', DEV)).json.noWake).toBe(false);
  });
});

function stubController() {
  const deployments: Record<string, { app: string; warm: null }> = { 'parle-speech': { app: 'parle', warm: null }, 'site-gpu': { app: 'site', warm: null } };
  const calls: string[] = [];
  const view = (name: string) => (deployments[name]
    ? { name, app: deployments[name].app, status: 'scaled-to-zero', warm: null, sessions: 0, realtime: null, lastRequestAt: null, replicas: [], spec: { maxEurPerHour: 1.5 } }
    : null);
  const controller = {
    get: (name: string) => view(name),
    list: () => Object.keys(deployments).map(view),
    warm: async (name: string, replicas: number, minutes: number) => { calls.push(`warm ${name} ${replicas} ${Math.round(minutes)}`); return view(name); },
    wake: (name: string) => { calls.push(`wake ${name}`); return view(name); },
    park: async (name: string) => { calls.push(`park ${name}`); return view(name); },
  };
  return { controller, calls };
}

async function routes() {
  const { access } = await keys();
  await access.setPolicy({ id: 'env-parle-dev', canStartGpu: true });
  const { controller, calls } = stubController();
  const clientGpu = new ClientGpu(controller as never);
  const token = (req: IncomingMessage) => String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const handler = createDeploymentRoutes({
    controller: controller as never, clientGpu,
    userOf: req => access.resolve(token(req))?.userId ?? null,
    isAdmin: req => access.admins.has(access.resolve(token(req))?.userId ?? ''),
    keyOf: (req) => {
      const found = access.resolve(token(req));
      if (!found) return null;
      return { keyId: found.keyId, user: found.userId, app: found.userId === 'parle-dev' ? 'parle' : found.userId, policy: access.policyOf(found.keyId) };
    },
  });
  const call = (key: string, method: string, path: string, body: unknown = {}) => new Promise<{ status: number; body: string }>((resolve) => {
    let status = 0;
    const res = {
      headersSent: false, writeHead: (s: number) => { status = s; return res; }, end: (data?: string) => resolve({ status, body: data ?? '' }), on: () => res,
    } as unknown as ServerResponse;
    const req = Object.assign((async function* () { yield Buffer.from(JSON.stringify(body)); })(), {
      headers: { authorization: `Bearer ${key}` }, url: path, socket: {},
    }) as unknown as IncomingMessage;
    handler(req, res, path, method);
  });
  return { call, calls, access };
}

describe('POST /v1/deployments/:name/start — a client turns its own GPU on without an admin key', () => {
  it('a key with canStartGpu starts and extends a GPU of its app; the answer says until when, the idle and the cap', async () => {
    const r = await routes();
    const started = await r.call(DEV, 'POST', '/v1/deployments/parle-speech/start', { minutes: 20 });
    expect(started.status).toBe(202);
    expect(JSON.parse(started.body)).toMatchObject({ deployment: 'parle-speech', idleMinutes: 10, capEur: 5, spentTodayEur: 0 });
    expect((await r.call(DEV, 'POST', '/v1/deployments/parle-speech/extend', { minutes: 10 })).status).toBe(202);
    expect(r.calls).toEqual(['warm parle-speech 1 20', 'warm parle-speech 1 30']);
  });

  it('refused: a key without canStartGpu, another app\'s deployment, a cap exceeded (402)', async () => {
    const r = await routes();
    expect((await r.call(OTHER, 'POST', '/v1/deployments/site-gpu/start', { minutes: 10 })).status).toBe(403);
    expect((await r.call(DEV, 'POST', '/v1/deployments/site-gpu/start', { minutes: 10 })).status).toBe(403);
    expect((await r.call(PROD, 'POST', '/v1/deployments/site-gpu/start', { minutes: 10 })).status).toBe(403);
    const capped = await r.call(DEV, 'POST', '/v1/deployments/parle-speech/start', { minutes: 240 });
    expect(capped.status).toBe(402);
    expect(JSON.parse(capped.body).error).toMatch(/daily GPU cap/);
    expect(r.calls).toEqual([]);
  });

  it('a client still cannot create, change or delete a deployment', async () => {
    const r = await routes();
    for (const key of [PROD, DEV]) {
      expect((await r.call(key, 'PUT', '/v1/deployments/parle-speech', { maxReplicas: 3 })).status).toBe(403);
      expect((await r.call(key, 'PATCH', '/v1/deployments/parle-speech', { maxReplicas: 3 })).status).toBe(403);
      expect((await r.call(key, 'DELETE', '/v1/deployments/parle-speech')).status).toBe(403);
      expect((await r.call(key, 'POST', '/v1/deployments/parle-speech/warm', { replicas: 1, untilMinutes: 5 })).status).toBe(403);
    }
  });

  it('the class client (no cap) wakes and parks its own GPUs without admin; a capped key must use start', async () => {
    const r = await routes();
    expect((await r.call(PROD, 'POST', '/v1/deployments/parle-speech/wake')).status).toBe(202);
    expect((await r.call(PROD, 'POST', '/v1/deployments/parle-speech/park')).status).toBe(202);
    const devWake = await r.call(DEV, 'POST', '/v1/deployments/parle-speech/wake');
    expect(devWake.status).toBe(403);
    expect(JSON.parse(devWake.body).error).toMatch(/use POST \/v1\/deployments\/parle-speech\/start/);
    expect((await r.call(DEV, 'POST', '/v1/deployments/parle-speech/park')).status).toBe(202);
    expect(r.calls).toEqual(['wake parle-speech', 'park parle-speech', 'park parle-speech']);
  });
});
