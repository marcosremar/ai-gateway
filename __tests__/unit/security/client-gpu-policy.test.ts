import type { IncomingMessage, Server, ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccessKeys, autoWakesNow } from '../../../src/config/access-keys';
import { classWindowOpen } from '../../../src/deployments/autoscale';
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
    expect(policy(PROD)).toEqual({ autoWake: true, autoWakeOutsideClass: true, canStartGpu: true, neverWake: false, countsAsUse: true, gpuDailyEur: null, startIdleMinutes: 10, wakeDeployments: [] });
    expect(policy(DEV)).toEqual({ autoWake: false, autoWakeOutsideClass: true, canStartGpu: false, neverWake: false, countsAsUse: true, gpuDailyEur: 5, startIdleMinutes: 10, wakeDeployments: [] });
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

  it('autoWakeOutsideClass off: the key wakes GPUs only while a class window (a warm schedule) is open', async () => {
    const { access } = await keys();
    await expect(access.setPolicy({ id: 'env-parle', autoWakeOutsideClass: 'no' })).rejects.toMatchObject({ status: 400 });
    const { policy } = await access.setPolicy({ id: 'env-parle', autoWakeOutsideClass: false });
    const views = [{ spec: { warmSchedule: [{ days: [1, 2, 3, 4], start: '17:30', end: '20:30', timeZone: 'Europe/Paris', minReplicas: 1 }] } }, { spec: {} }];
    const monday = (utc: string) => classWindowOpen(views, Date.parse(`2026-10-12T${utc}:00Z`));
    expect([monday('15:29'), monday('15:30'), monday('18:29'), monday('18:30')]).toEqual([false, true, true, false]);
    expect(classWindowOpen(views, Date.parse('2026-10-16T16:00:00Z'))).toBe(false);
    expect(autoWakesNow(policy, true)).toBe(true);
    expect(autoWakesNow(policy, false)).toBe(false);
    expect(autoWakesNow(access.policyOf('env-parle-dev'), true)).toBe(false);
    expect(autoWakesNow({ ...policy, autoWakeOutsideClass: true }, false)).toBe(true);
  });

  it('setPolicy validates every field and the key id', async () => {
    const { access } = await keys();
    await expect(access.setPolicy({ id: 'nope', autoWake: true })).rejects.toMatchObject({ status: 404 });
    await expect(access.setPolicy({ id: 'env-parle-dev', autoWake: 'yes' })).rejects.toMatchObject({ status: 400 });
    await expect(access.setPolicy({ id: 'env-parle-dev', gpuDailyEur: -1 })).rejects.toMatchObject({ status: 400 });
    await expect(access.setPolicy({ id: 'env-parle-dev', startIdleMinutes: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(access.setPolicy({ id: 'env-parle-dev', admin: true })).rejects.toMatchObject({ status: 400 });
    expect((await access.setPolicy({ id: 'env-parle-dev', canStartGpu: true, gpuDailyEur: 3 })).policy)
      .toEqual({ autoWake: false, autoWakeOutsideClass: true, canStartGpu: true, neverWake: false, countsAsUse: true, gpuDailyEur: 3, startIdleMinutes: 10, wakeDeployments: [] });
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

const APP_USER_KEY = 'ucast_live_user-activation-key';

const ALL_DAY = [{ start: '00:00', end: '12:00', minReplicas: 1 }, { start: '12:00', end: '00:00', minReplicas: 1 }];

function stubController(classOpen = { now: false }, withTestCopy = false) {
  const deployments: Record<string, { app: string; warm: null; testFor?: string }> = {
    'parle-speech': { app: 'parle', warm: null }, 'site-gpu': { app: 'site', warm: null },
    'parle-qwen-tts': { app: 'parle', warm: null },
    'babelcast-tts-clone': { app: 'babelcast', warm: null }, 'babelcast-gpu': { app: 'babelcast', warm: null },
    ...(withTestCopy ? { 'parle-speech-test': { app: 'parle', warm: null, testFor: 'parle-speech' } } : {}),
  };
  const calls: string[] = [];
  const view = (name: string) => (deployments[name]
    ? { name, app: deployments[name].app, status: 'scaled-to-zero', warm: null, sessions: 0, realtime: null, lastRequestAt: null, replicas: [], spec: { maxEurPerHour: 1.5, warmSchedule: classOpen.now ? ALL_DAY : [], testFor: deployments[name].testFor } }
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

async function routes(withTestCopy = false) {
  const { access } = await keys();
  await access.setPolicy({ id: 'env-parle-dev', canStartGpu: true });
  const classOpen = { now: false };
  const { controller, calls } = stubController(classOpen, withTestCopy);
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
    appKeyWakes: (req, name) => token(req) === APP_USER_KEY && name === 'babelcast-tts-clone',
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
  return { call, calls, access, classOpen };
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

describe('app users wake the voice-clone GPU (owner, 18/10/2026: "Clonar a voz" on keeps it up)', () => {
  it('an activation key wakes only the listed deployment; every other wake and every other action stays refused', async () => {
    const r = await routes();
    expect((await r.call(APP_USER_KEY, 'POST', '/v1/deployments/babelcast-tts-clone/wake')).status).toBe(202);
    for (const path of ['/v1/deployments/babelcast-gpu/wake', '/v1/deployments/parle-speech/wake', '/v1/deployments/babelcast-tts-clone/park', '/v1/deployments/babelcast-tts-clone/start']) {
      expect((await r.call(APP_USER_KEY, 'POST', path)).status, path).toBe(403);
    }
    expect((await r.call(OTHER, 'POST', '/v1/deployments/babelcast-tts-clone/wake')).status).toBe(403);
    expect(r.calls).toEqual(['wake babelcast-tts-clone']);
  });
});

describe('wake outside class (owner, 12/10/2026): /wake and /start obey the key, only an admin passes', () => {
  it('autoWakeOutsideClass off: wake and start are refused with no class open, allowed while one is; the admin always passes', async () => {
    const r = await routes();
    await r.access.setPolicy({ id: 'env-parle', autoWakeOutsideClass: false });
    await r.access.setPolicy({ id: 'env-parle-dev', autoWakeOutsideClass: false });
    const wake = await r.call(PROD, 'POST', '/v1/deployments/parle-speech/wake');
    expect(wake.status).toBe(403);
    expect(JSON.parse(wake.body).error).toMatch(/outside the class window/);
    expect((await r.call(DEV, 'POST', '/v1/deployments/parle-speech/start', { minutes: 10 })).status).toBe(403);
    expect(r.calls).toEqual([]);
    expect((await r.call(ADMIN, 'POST', '/v1/deployments/parle-speech/wake')).status).toBe(202);
    expect((await r.call(ADMIN, 'POST', '/v1/deployments/parle-speech/warm', { replicas: 1, untilMinutes: 5 })).status).toBe(202);
    r.classOpen.now = true;
    expect((await r.call(PROD, 'POST', '/v1/deployments/parle-speech/wake')).status).toBe(202);
    expect(r.calls).toEqual(['wake parle-speech', 'warm parle-speech 1 5', 'wake parle-speech']);
  });

  it('a dev key (neverWake, countsAsUse false) never wakes, not even in class; it never auto-wakes either', async () => {
    const r = await routes();
    const { policy } = await r.access.setPolicy({ id: 'env-parle', neverWake: true, countsAsUse: false });
    r.classOpen.now = true;
    const wake = await r.call(PROD, 'POST', '/v1/deployments/parle-speech/wake');
    expect(wake.status).toBe(403);
    expect(JSON.parse(wake.body).error).toMatch(/never wakes a GPU/);
    expect((await r.call(PROD, 'POST', '/v1/deployments/parle-speech/start', { minutes: 10 })).status).toBe(403);
    expect(r.calls).toEqual([]);
    expect(autoWakesNow(policy, true)).toBe(false);
    await expect(r.access.setPolicy({ id: 'env-parle', countsAsUse: 'no' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('dev key wakes only its test deployments (owner, 12/10/2026): agents turn GPUs on through the gateway, never production', () => {
  async function devRoutes(policy: Record<string, unknown> = {}) {
    const r = await routes(true);
    await r.access.setPolicy({ id: 'env-parle-dev', autoWake: true, neverWake: false, countsAsUse: false, wakeDeployments: ['parle-speech-test'], ...policy });
    return r;
  }

  it('outside class the dev key wakes parle-speech-test (a start of startIdleMinutes, under its cap)', async () => {
    const r = await devRoutes();
    const woke = await r.call(DEV, 'POST', '/v1/deployments/parle-speech-test/wake');
    expect(woke.status).toBe(202);
    expect(JSON.parse(woke.body)).toMatchObject({ deployment: 'parle-speech-test', idleMinutes: 10, capEur: 5 });
    expect((await r.call(DEV, 'POST', '/v1/deployments/parle-speech-test/start', { minutes: 20 })).status).toBe(202);
    expect(r.calls).toEqual(['warm parle-speech-test 1 10', 'warm parle-speech-test 1 20']);
  });

  it('refused (403) on production: parle-qwen-tts and parle-speech, even if an admin lists one by mistake', async () => {
    const r = await devRoutes({ wakeDeployments: ['parle-speech-test', 'parle-qwen-tts'] });
    const tts = await r.call(DEV, 'POST', '/v1/deployments/parle-qwen-tts/wake');
    expect(tts.status).toBe(403);
    expect(JSON.parse(tts.body).error).toMatch(/wakes only its test deployments/);
    expect((await r.call(DEV, 'POST', '/v1/deployments/parle-qwen-tts/start', { minutes: 10 })).status).toBe(403);
    expect((await r.call(DEV, 'POST', '/v1/deployments/parle-speech/wake')).status).toBe(403);
    expect(r.calls).toEqual([]);
  });

  it('refused (403) on parle-speech-test during the class window', async () => {
    const r = await devRoutes();
    r.classOpen.now = true;
    const wake = await r.call(DEV, 'POST', '/v1/deployments/parle-speech-test/wake');
    expect(wake.status).toBe(403);
    expect(JSON.parse(wake.body).error).toMatch(/during a class window/);
    expect((await r.call(DEV, 'POST', '/v1/deployments/parle-speech-test/start', { minutes: 10 })).status).toBe(403);
    expect(r.calls).toEqual([]);
  });

  it('the daily cap refuses (402)', async () => {
    const r = await devRoutes({ gpuDailyEur: 0.1 });
    const wake = await r.call(DEV, 'POST', '/v1/deployments/parle-speech-test/wake');
    expect(wake.status).toBe(402);
    expect(JSON.parse(wake.body).error).toMatch(/daily GPU cap/);
    expect(r.calls).toEqual([]);
  });

  it('wakeDeployments is validated; without autoWake a request of the key never wakes anything', async () => {
    const r = await devRoutes({ autoWake: false });
    await expect(r.access.setPolicy({ id: 'env-parle-dev', wakeDeployments: 'parle-speech-test' })).rejects.toMatchObject({ status: 400 });
    await expect(r.access.setPolicy({ id: 'env-parle-dev', wakeDeployments: ['Bad Name'] })).rejects.toMatchObject({ status: 400 });
    const policy = r.access.policyOf('env-parle-dev');
    expect(autoWakesNow({ ...policy, autoWake: true }, false)).toBe(false);
    const dev = { keyId: 'env-parle-dev', user: 'parle-dev' };
    const classOpen = { now: true };
    const gpu = new ClientGpu(stubController(classOpen, true).controller as never);
    expect(gpu.requestMayWake(dev, policy, 'parle-speech-test')).toBe(false);
    const awake = { ...policy, autoWake: true };
    expect(gpu.requestMayWake(dev, awake, 'parle-speech-test')).toBe(false);
    classOpen.now = false;
    expect(gpu.requestMayWake(dev, awake, 'parle-qwen-tts')).toBe(false);
    expect(gpu.requestMayWake(dev, { ...awake, gpuDailyEur: 0.1 }, 'parle-speech-test')).toBe(false);
    expect(gpu.requestMayWake(dev, awake, 'parle-speech-test')).toBe(true);
  });
});
