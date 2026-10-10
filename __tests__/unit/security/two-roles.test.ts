import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccessKeys } from '../../../src/config/access-keys';
import { AdminGate } from '../../../src/config/admin-gate';
import { createAccessRoutes } from '../../../src/config/access-routes';
import { KeyAudit } from '../../../src/config/key-audit';
import { createKeyAdminRoutes, KeyManager } from '../../../src/config/key-manager';
import { deploymentsFromEnv } from '../../../src/deployments';
import { createProxyServer } from '../../../src/gateway/proxy/server';

const ADMIN = 'admin-key-0123456789';
const CLIENT = 'client-key-0123456789';
const DEV_TOKEN = 'dev-token-0123456789abcdef';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 3 });
});

async function gateway() {
  const dir = await mkdtemp(join(tmpdir(), 'aigw-roles-'));
  dirs.push(dir);
  const env: Record<string, string | undefined> = {
    GATEWAY_API_KEYS: `${ADMIN}:ops,${CLIENT}:parle`, SANDBOX_TOKEN: DEV_TOKEN, ACCEPT_SANDBOX_TOKEN_AS_KEY: '1', SANDBOX_TOKEN_ADMIN: '1',
  };
  const access = new AccessKeys(env, { path: join(dir, 'access.json') });
  await access.load();
  access.setBaseAdmins(['ops', 'sandbox']);
  const audit = new KeyAudit({ path: join(dir, 'key-audit.jsonl') });
  await audit.init();
  const userOf = (bearer: string) => access.resolve(bearer)?.userId ?? null;
  const gate = new AdminGate({ actorOf: (t) => { const u = userOf(t); return u && access.admins.has(u) ? u : null; }, audit, rpm: 10_000 });
  const deployments = deploymentsFromEnv({ SCW_SECRET_KEY: 's', DEPLOYMENTS_NAMESPACE: 'test', DEPLOYMENTS_STATE_DIR: dir }, {
    userOf: req => userOf(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')),
    admins: access.admins,
  })!;
  await deployments.apps.init();
  const server = createProxyServer({
    providers: {}, keyRegistry: access,
    deepHealth: { authorize: t => { const u = userOf(t); return Boolean(u && access.admins.has(u)); }, report: async () => ({ ok: true }) as never },
    customRoutes: [
      ...createAccessRoutes({ access, gate, audit, deployments: { list: () => [], rotateReplicaSecret: async name => ({ deployment: name, pinnedReplicas: 0 }) } }),
      ...createKeyAdminRoutes(new KeyManager(env, { fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch }), gate),
    ],
    prefixRoutes: ['/v1/deployments', '/v1/profiles', '/v1/apps'].map(prefix => ({ prefix, handler: deployments.handler })),
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, key: string, body: unknown = {}, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
    await res.text();
    return res.status;
  };
  return { access, call };
}

const ADMIN_ONLY: Array<[string, string, unknown?, Record<string, string>?]> = [
  ['GET', '/v1/admin/access/keys'],
  ['POST', '/v1/admin/access/keys', { user: 'x' }],
  ['POST', '/v1/admin/access/keys/revoke', { id: 'env-ops' }],
  ['GET', '/v1/admin/access/admins'],
  ['PUT', '/v1/admin/access/admins', { users: ['parle'] }],
  ['PUT', '/v1/admin/access/sandbox-token', { token: 'another-token-0123456789' }],
  ['POST', '/v1/admin/access/replica-secrets/rotate', {}],
  ['GET', '/v1/admin/access/audit'],
  ['POST', '/v1/admin/keys/reload'],
  ['PUT', '/v1/admin/keys', { GROQ_API_KEY: 'x' }],
  ['PUT', '/v1/deployments/parle-speech', { image: 'rg.fr-par.scw.cloud/aigw/x:1' }],
  ['PATCH', '/v1/deployments/parle-speech', { maxReplicas: 9 }],
  ['DELETE', '/v1/deployments/parle-speech'],
  ['POST', '/v1/deployments/parle-speech/wake'],
  ['POST', '/v1/deployments/parle-speech/park'],
  ['POST', '/v1/deployments/parle-speech/warm', { replicas: 1, untilMinutes: 10 }],
  ['GET', '/v1/deployments/parle-speech/offers'],
  ['PUT', '/v1/profiles/p', {}],
  ['DELETE', '/v1/profiles/p'],
  ['PUT', '/v1/apps/parle/images/speech-stack', { image: 'rg.fr-par.scw.cloud/aigw/x:1' }],
  ['DELETE', '/v1/apps/parle/images/speech-stack'],
  ['PUT', '/v1/apps/parle/limits', { dailyRequests: 1 }],
  ['GET', '/v1/apps/other', undefined, { 'x-app': 'other' }],
  ['GET', '/health?deep=1'],
];

describe('two roles (owner, 10/10/2026): an admin manages, a client calls the APIs', () => {
  it('no client key — the production client, the dev token, even with the former SANDBOX_TOKEN_ADMIN=1 — reaches an admin route', async () => {
    const g = await gateway();
    for (const [method, path, body, headers] of ADMIN_ONLY) {
      for (const key of [CLIENT, DEV_TOKEN]) {
        expect([method, path, key === CLIENT ? 'client' : 'dev token', await g.call(method, path, key, body, headers)])
          .toEqual([method, path, key === CLIENT ? 'client' : 'dev token', 403]);
      }
    }
  });

  it('the admin key passes the same gate (whatever the route then answers)', async () => {
    const g = await gateway();
    for (const [method, path, body, headers] of ADMIN_ONLY) {
      expect([method, path, await g.call(method, path, ADMIN, body, headers)]).not.toEqual([method, path, 403]);
    }
  });

  it('the dev token cannot be made an admin, not even by the admin list', async () => {
    const g = await gateway();
    expect(await g.call('PUT', '/v1/admin/access/admins', ADMIN, { users: ['ops', 'sandbox'] })).toBe(200);
    expect(await g.call('POST', '/v1/admin/access/keys', ADMIN, { user: 'sandbox', admin: true })).toBe(201);
    expect(g.access.admins.has('sandbox')).toBe(false);
    expect(await g.call('GET', '/v1/admin/access/keys', DEV_TOKEN)).toBe(403);
  });

  it('every key is listed with its role', async () => {
    const g = await gateway();
    const roles = Object.fromEntries(g.access.list().map(k => [k.user, k.role]));
    expect(roles).toEqual({ ops: 'admin', parle: 'client' });
  });

  it('a client works without admin: its models, its own deployments list and its own app', async () => {
    const g = await gateway();
    expect(await g.call('GET', '/v1/models', CLIENT)).toBe(200);
    expect(await g.call('GET', '/v1/deployments', CLIENT)).toBe(200);
    expect(await g.call('GET', '/v1/apps/parle', CLIENT, undefined, { 'x-app': 'parle' })).not.toBe(403);
    expect(await g.call('GET', '/health?details=1', CLIENT)).toBe(200);
  });
});
