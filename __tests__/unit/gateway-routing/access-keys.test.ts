import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessKeys } from '../../../src/config/access-keys';
import { AdminGate } from '../../../src/config/admin-gate';
import { createAccessRoutes } from '../../../src/config/access-routes';
import { KeyAudit } from '../../../src/config/key-audit';
import { createProxyServer } from '../../../src/gateway/proxy/server';

const ENV_ADMIN = 'env-admin-key-0123456789';
const ENV_APP = 'env-app-key-0123456789';
const NEW_TOKEN = 'sandbox-new-token-0123456789';
const OLD_TOKEN = 'sandbox-old-token-0123456789';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'aigw-access-'));
  dirs.push(dir);
  return dir;
}

function palco(accepts: Set<string>) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const token = String((init?.headers as Record<string, string>)?.Authorization ?? '').replace('Bearer ', '');
    return accepts.has(token) ? Response.json({ GROQ_API_KEY: 'gsk_x' }) : new Response('', { status: 401 });
  });
}

async function harness(opts: { dir?: string; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: () => number; rpm?: number } = {}) {
  const dir = opts.dir ?? await tempDir();
  const env: Record<string, string | undefined> = opts.env ?? { GATEWAY_API_KEYS: `${ENV_ADMIN}:ops,${ENV_APP}:parle`, SANDBOX_TOKEN: OLD_TOKEN };
  const logs: string[] = [];
  const log = (msg: string, data?: Record<string, unknown>) => { logs.push(`${msg} ${JSON.stringify(data ?? {})}`); };
  const access = new AccessKeys(env, { path: join(dir, 'access.json'), fetchImpl: opts.fetchImpl, now: opts.now, log });
  await access.load();
  access.setBaseAdmins(['ops']);
  const audit = new KeyAudit({ path: join(dir, 'key-audit.jsonl'), log });
  await audit.init();
  const gate = new AdminGate({ actorOf: (t) => { const u = access.resolve(t)?.userId; return u && access.admins.has(u) ? u : null; }, audit, rpm: opts.rpm });
  const rotate = vi.fn(async (name: string) => ({ deployment: name, pinnedReplicas: 1 }));
  const server = createProxyServer({
    providers: {}, keyRegistry: access,
    customRoutes: createAccessRoutes({ access, gate, audit, deployments: { list: () => [{ name: 'speech' }], rotateReplicaSecret: rotate } }),
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, key: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) as Record<string, any> : {} };
  };
  return { dir, env, access, audit, call, logs, rotate };
}

describe('client and admin keys change at runtime', () => {
  it('issues a key that works at once, lists it without its value, and revokes it at once', async () => {
    const h = await harness();
    const issued = await h.call('POST', '/v1/admin/access/keys', ENV_ADMIN, { user: 'site', label: 'site prod' });
    expect(issued.status).toBe(201);
    const key = issued.json.key as string;
    expect(key).toMatch(/^aigw_/);
    expect((await h.call('GET', '/v1/admin/access/keys', key)).status).toBe(403);
    expect((await h.call('GET', '/nope', key)).status).not.toBe(401);
    const list = await h.call('GET', '/v1/admin/access/keys', ENV_ADMIN);
    expect(list.text).not.toContain(key);
    expect(list.text).not.toContain(ENV_ADMIN);
    expect(list.json.keys.find((k: any) => k.id === issued.json.id)).toMatchObject({ user: 'site', source: 'issued', active: true, label: 'site prod' });
    expect(list.json.keys.find((k: any) => k.user === 'parle')).toMatchObject({ source: 'env', active: true });
    const revoked = await h.call('POST', '/v1/admin/access/keys/revoke', ENV_ADMIN, { id: issued.json.id });
    expect(revoked.json).toMatchObject({ active: false });
    expect((await h.call('GET', '/nope', key)).status).toBe(401);
  });

  it('revokes an environment key without a restart', async () => {
    const h = await harness();
    const envApp = (await h.call('GET', '/v1/admin/access/keys', ENV_ADMIN)).json.keys.find((k: any) => k.user === 'parle');
    expect(h.access.resolve(ENV_APP)?.userId).toBe('parle');
    await h.call('POST', '/v1/admin/access/keys/revoke', ENV_ADMIN, { id: envApp.id });
    expect(h.access.resolve(ENV_APP)).toBeNull();
  });

  it('a rotation keeps the old key valid for the overlap window, then it stops working', async () => {
    let now = 1_000_000;
    const h = await harness({ now: () => now });
    const envApp = h.access.list().find(k => k.user === 'parle')!;
    const r = await h.call('POST', '/v1/admin/access/keys', ENV_ADMIN, { replaces: envApp.id, overlapMinutes: 10 });
    expect(r.json).toMatchObject({ user: 'parle', replaced: { id: envApp.id, active: true } });
    expect(h.access.resolve(ENV_APP)?.userId).toBe('parle');
    expect(h.access.resolve(r.json.key)?.userId).toBe('parle');
    now += 10 * 60_000;
    expect(h.access.resolve(ENV_APP)).toBeNull();
    expect(h.access.resolve(r.json.key)?.userId).toBe('parle');
  });

  it('persists issued keys (hash only), revocations and the admin list across a restart', async () => {
    const h = await harness();
    const issued = await h.call('POST', '/v1/admin/access/keys', ENV_ADMIN, { user: 'ci', admin: true });
    await h.call('PUT', '/v1/admin/access/admins', ENV_ADMIN, { users: ['ops', 'ci'] });
    const envApp = h.access.list().find(k => k.user === 'parle')!;
    await h.call('POST', '/v1/admin/access/keys/revoke', ENV_ADMIN, { id: envApp.id });
    const file = await readFile(join(h.dir, 'access.json'), 'utf8');
    expect(file).not.toContain(issued.json.key);
    const again = await harness({ dir: h.dir });
    expect(again.access.resolve(issued.json.key)?.userId).toBe('ci');
    expect(again.access.admins.has('ci')).toBe(true);
    expect(again.access.resolve(ENV_APP)).toBeNull();
    expect((await again.call('GET', '/v1/admin/access/keys', issued.json.key)).status).toBe(200);
  });

  it('the admin list is set by API, and an admin cannot remove itself', async () => {
    const h = await harness();
    expect((await h.call('PUT', '/v1/admin/access/admins', ENV_ADMIN, { users: ['parle'] })).status).toBe(400);
    expect((await h.call('PUT', '/v1/admin/access/admins', ENV_ADMIN, { users: ['ops', 'parle'] })).json.users).toEqual(['ops', 'parle']);
    expect((await h.call('GET', '/v1/admin/access/keys', ENV_APP)).status).toBe(200);
  });

  it('rejects malformed requests', async () => {
    const h = await harness();
    expect((await h.call('POST', '/v1/admin/access/keys', ENV_ADMIN, { user: 'a,b' })).status).toBe(400);
    expect((await h.call('POST', '/v1/admin/access/keys', ENV_ADMIN, { user: 'x', overlapMinutes: -1 })).status).toBe(400);
    expect((await h.call('POST', '/v1/admin/access/keys/revoke', ENV_ADMIN, { id: 'key-nope' })).status).toBe(404);
  });
});

describe('the SANDBOX_TOKEN changes at runtime', () => {
  it('switches only after the palco accepts the new token; the old one is accepted during the overlap', async () => {
    let now = 5_000_000;
    const h = await harness({ fetchImpl: palco(new Set([OLD_TOKEN, NEW_TOKEN])) as never, now: () => now });
    const r = await h.call('PUT', '/v1/admin/access/sandbox-token', ENV_ADMIN, { token: NEW_TOKEN, overlapMinutes: 5 });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(NEW_TOKEN);
    expect(h.env.SANDBOX_TOKEN).toBe(NEW_TOKEN);
    expect(h.access.isSandboxToken(NEW_TOKEN)).toBe(true);
    expect(h.access.isSandboxToken(OLD_TOKEN)).toBe(true);
    now += 5 * 60_000;
    expect(h.access.isSandboxToken(OLD_TOKEN)).toBe(false);
  });

  it('a token the palco refuses is rejected and the gateway keeps the current one', async () => {
    const h = await harness({ fetchImpl: palco(new Set([OLD_TOKEN])) as never });
    const r = await h.call('PUT', '/v1/admin/access/sandbox-token', ENV_ADMIN, { token: NEW_TOKEN });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain(NEW_TOKEN);
    expect(h.env.SANDBOX_TOKEN).toBe(OLD_TOKEN);
  });

  it('after a restart the stored token is used; if the palco refuses it, the environment token is', async () => {
    const h = await harness({ fetchImpl: palco(new Set([OLD_TOKEN, NEW_TOKEN])) as never });
    await h.call('PUT', '/v1/admin/access/sandbox-token', ENV_ADMIN, { token: NEW_TOKEN });
    const env = { GATEWAY_API_KEYS: `${ENV_ADMIN}:ops`, PALCO_PROXY: OLD_TOKEN };
    const restarted = new AccessKeys(env, { path: join(h.dir, 'access.json'), fetchImpl: palco(new Set([NEW_TOKEN])) as never });
    await restarted.load();
    expect((await restarted.bootSandboxEnv()).source).not.toBeNull();
    expect(env.PALCO_PROXY).toBe(NEW_TOKEN);
    const env2 = { GATEWAY_API_KEYS: `${ENV_ADMIN}:ops`, SANDBOX_TOKEN: OLD_TOKEN };
    const fallback = new AccessKeys(env2, { path: join(h.dir, 'access.json'), fetchImpl: palco(new Set([OLD_TOKEN])) as never });
    await fallback.load();
    expect((await fallback.bootSandboxEnv()).source).not.toBeNull();
    expect(env2.SANDBOX_TOKEN).toBe(OLD_TOKEN);
  });
});

describe('boot order', () => {
  it('client keys the palco provides at boot (GATEWAY_API_KEYS absent from the host) are accepted', async () => {
    const env: Record<string, string | undefined> = { SANDBOX_TOKEN: OLD_TOKEN };
    const fetchImpl = vi.fn(async () => Response.json({ GATEWAY_API_KEYS: `${ENV_APP}:parle` }));
    const access = new AccessKeys(env, { fetchImpl: fetchImpl as never });
    await access.bootSandboxEnv();
    expect(access.resolve(ENV_APP)?.userId).toBe('parle');
  });
});

describe('replica secrets, audit and rate limit', () => {
  it('rotates the replica secret of one or every deployment', async () => {
    const h = await harness();
    expect((await h.call('POST', '/v1/admin/access/replica-secrets/rotate', ENV_ADMIN, {})).json).toEqual({ rotated: [{ deployment: 'speech', pinnedReplicas: 1 }] });
    expect(h.rotate).toHaveBeenCalledWith('speech');
  });

  it('every change is audited with who, when and names — never a value, in the endpoint, the file or the log', async () => {
    const h = await harness({ fetchImpl: palco(new Set([OLD_TOKEN, NEW_TOKEN])) as never });
    const issued = await h.call('POST', '/v1/admin/access/keys', ENV_ADMIN, { user: 'site' });
    await h.call('PUT', '/v1/admin/access/sandbox-token', ENV_ADMIN, { token: NEW_TOKEN });
    await h.call('POST', '/v1/admin/access/keys/revoke', ENV_ADMIN, { id: 'key-nope' });
    const audit = await h.call('GET', '/v1/admin/access/audit', ENV_ADMIN);
    expect(audit.json.entries.map((e: any) => [e.actor, e.action, e.ok])).toEqual([
      ['ops', 'access.keys.revoke', false], ['ops', 'access.sandbox-token.rotate', true], ['ops', 'access.keys.issue', true],
    ]);
    expect(audit.json.entries[1].names).toEqual(['SANDBOX_TOKEN']);
    await h.audit.flush();
    const file = await readFile(join(h.dir, 'key-audit.jsonl'), 'utf8');
    for (const text of [audit.text, file, h.logs.join('\n')]) {
      for (const secret of [issued.json.key, NEW_TOKEN, OLD_TOKEN, ENV_ADMIN]) expect(text).not.toContain(secret);
    }
  });

  it('rate-limits the admin key routes', async () => {
    const h = await harness({ rpm: 2 });
    expect((await h.call('GET', '/v1/admin/access/keys', ENV_ADMIN)).status).toBe(200);
    expect((await h.call('GET', '/v1/admin/access/keys', ENV_ADMIN)).status).toBe(200);
    expect((await h.call('GET', '/v1/admin/access/keys', ENV_ADMIN)).status).toBe(429);
  });
});
