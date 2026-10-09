import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createProxyServer } from '../../../src/gateway/proxy/server';
import { DeploymentController } from '../../../src/deployments/controller';
import { createDeploymentRoutes, HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { AppRegistry, MemoryAppStore, type AppAccount } from '../../../src/deployments/apps';
import { AppDevices, DEVICE_HEADER, deviceIdOf } from '../../../src/deployments/app-devices';
import type { LLMProvider } from '../../../src/gateway/providers/cloud/types';
import { FakeCloud } from './_fake-cloud';

const ADMIN = 'admin-key-0123456789';
const APP = 'app-key-0123456789';
const OTHER = 'other-key-0123456789';
const USERS: Record<string, string> = { [`Bearer ${ADMIN}`]: 'owner', [`Bearer ${APP}`]: 'babelcast', [`Bearer ${OTHER}`]: 'other' };
const PHONE = 'install-7f3a9c21';
const TABLET = 'install-0b5d4e88';

class CountingStore extends MemoryAppStore {
  saves = 0;
  async save(apps: Record<string, AppAccount>) { this.saves++; return super.save(apps); }
}

async function registry(store = new CountingStore(), opts: ConstructorParameters<typeof AppDevices>[1] = {}) {
  const apps = new AppRegistry(store);
  await apps.init();
  return { store, apps, devices: new AppDevices(apps, { flushMs: 0, ...opts }) };
}

describe('AppDevices', () => {
  it('records a device on first sight and updates last seen, kind and counts', async () => {
    let t = Date.parse('2026-10-08T10:00:00Z');
    const { devices } = await registry(undefined, { now: () => t });
    expect(devices.admit('babelcast', PHONE, 'chat')).toBeNull();
    t += 5_000;
    expect(devices.admit('babelcast', PHONE, 'stt')).toBeNull();
    expect(devices.admit('babelcast', TABLET, 'tts')).toBeNull();
    const listed = devices.list('babelcast');
    expect(listed).toMatchObject({ app: 'babelcast', total: 2, blocked: 0, requireDevice: false });
    expect(listed.devices.find(d => d.id === PHONE)).toEqual({
      id: PHONE, firstSeen: t - 5_000, lastSeen: t, requestsToday: 2, requests: 2, lastKind: 'stt',
    });
    expect(devices.list('other').devices).toEqual([]);
  });

  it('counts per UTC day and sorts by last seen (default, newest first) or another field', async () => {
    let t = Date.parse('2026-10-08T23:59:00Z');
    const { devices } = await registry(undefined, { now: () => t });
    devices.admit('babelcast', PHONE, 'chat');
    devices.admit('babelcast', PHONE, 'chat');
    t += 120_000;
    devices.admit('babelcast', TABLET, 'chat');
    expect(devices.list('babelcast').devices.map(d => [d.id, d.requestsToday, d.requests])).toEqual([[TABLET, 1, 1], [PHONE, 0, 2]]);
    expect(devices.list('babelcast', new URLSearchParams('order=asc')).devices[0]!.id).toBe(PHONE);
    expect(devices.list('babelcast', new URLSearchParams('sort=requests&limit=1')).devices.map(d => d.id)).toEqual([PHONE]);
    expect(() => devices.list('babelcast', new URLSearchParams('sort=reason'))).toThrow(/sort must be/);
  });

  it('a blocked device is refused with device_blocked until it is unblocked', async () => {
    const { devices } = await registry();
    devices.admit('babelcast', PHONE, 'chat');
    await devices.block('babelcast', PHONE, 'shared account', 'owner');
    expect(devices.admit('babelcast', PHONE, 'chat')).toMatchObject({ status: 403, code: 'device_blocked' });
    expect(devices.admit('babelcast', TABLET, 'chat')).toBeNull();
    expect(devices.admit('other', PHONE, 'chat')).toBeNull();
    expect(devices.list('babelcast', new URLSearchParams('blocked=1')).devices).toMatchObject([
      { id: PHONE, requests: 1, blocked: { reason: 'shared account', by: 'owner' } },
    ]);
    await devices.unblock('babelcast', PHONE, 'owner');
    expect(devices.admit('babelcast', PHONE, 'chat')).toBeNull();
    await expect(devices.unblock('babelcast', 'install-unknown1', 'owner')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses malformed ids and anything that looks like a key or token, and stores nothing', async () => {
    const { devices, apps } = await registry();
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzaWQiOiJ4In0.c2ln';
    for (const bad of ['short', 'x'.repeat(65), 'has space 123', 'sk-live-0123456789', jwt, 'token_abcdefgh', '-leading-dash', 42, ['a']]) {
      expect(devices.admit('babelcast', bad, 'chat')).toMatchObject({ status: 400, code: 'invalid_device' });
    }
    expect(deviceIdOf('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(devices.list('babelcast').total).toBe(0);
    await devices.flush();
    expect(apps.get('babelcast')).toBeNull();
    await expect(devices.block('babelcast', 'sk-live-0123456789', null, 'owner')).rejects.toMatchObject({ status: 400 });
  });

  it('requireDevice refuses requests without a device id; off by default', async () => {
    const { devices, apps } = await registry();
    expect(devices.admit('babelcast', undefined, 'chat')).toBeNull();
    expect(devices.admit(null, undefined, 'chat')).toBeNull();
    await apps.setRequireDevice('babelcast', true);
    expect(devices.admit('babelcast', undefined, 'chat')).toMatchObject({ status: 403, code: 'device_required' });
    expect(devices.admit('babelcast', '', 's2s')).toMatchObject({ code: 'device_required' });
    expect(devices.admit('babelcast', PHONE, 'chat')).toBeNull();
    expect(devices.admit('other', undefined, 'chat')).toBeNull();
    await expect(apps.setRequireDevice('babelcast', 'yes')).rejects.toMatchObject({ status: 400 });
  });

  it('the request path is synchronous and writes nothing: the registry is flushed later', async () => {
    const { devices, store } = await registry();
    for (let i = 0; i < 500; i++) {
      const verdict = devices.admit('babelcast', `install-${String(i % 50).padStart(8, '0')}`, 'chat');
      expect(verdict).toBeNull();
    }
    expect(devices.admit('babelcast', PHONE, 'chat') instanceof Promise).toBe(false);
    expect(store.saves).toBe(0);
    await devices.flush();
    expect(store.saves).toBe(1);
    await devices.flush();
    expect(store.saves).toBe(1);
  });

  it('a debounced flush writes once for many requests', async () => {
    const { devices, store } = await registry(undefined, { flushMs: 20 });
    for (let i = 0; i < 20; i++) devices.admit('babelcast', PHONE, 'chat');
    expect(store.saves).toBe(0);
    await new Promise(r => setTimeout(r, 80));
    expect(store.saves).toBe(1);
  });

  it('survives a restart: devices, counts and blocks come back from the app store', async () => {
    const first = await registry();
    first.devices.admit('babelcast', PHONE, 'chat');
    first.devices.admit('babelcast', TABLET, 'realtime');
    await first.devices.block('babelcast', TABLET, 'abuse', 'owner');
    await first.apps.setRequireDevice('babelcast', true);
    await first.devices.flush();

    const second = await registry(first.store);
    expect(second.devices.list('babelcast')).toMatchObject({ total: 2, blocked: 1, requireDevice: true });
    expect(second.devices.admit('babelcast', TABLET, 'chat')).toMatchObject({ code: 'device_blocked' });
    expect(second.devices.admit('babelcast', PHONE, 'chat')).toBeNull();
    expect(second.devices.list('babelcast').devices.find(d => d.id === PHONE)!.requests).toBe(2);
  });

  it('the cap evicts the least recently seen unblocked device and never a blocked one', async () => {
    let t = 1_000_000;
    const { devices } = await registry(undefined, { maxPerApp: 3, now: () => (t += 1000) });
    const id = (n: number) => `install-${String(n).padStart(8, '0')}`;
    devices.admit('babelcast', id(1), 'chat');
    devices.admit('babelcast', id(2), 'chat');
    devices.admit('babelcast', id(3), 'chat');
    await devices.block('babelcast', id(1), null, 'owner');
    devices.admit('babelcast', id(2), 'chat');
    devices.admit('babelcast', id(4), 'chat');
    expect(devices.list('babelcast').devices.map(d => d.id).sort()).toEqual([id(1), id(2), id(4)]);
    for (let n = 5; n < 40; n++) devices.admit('babelcast', id(n), 'chat');
    expect(devices.list('babelcast').total).toBe(3);
    expect(devices.isBlocked('babelcast', id(1))).toBe(true);

    await devices.block('babelcast', id(50), null, 'owner');
    await devices.block('babelcast', id(51), null, 'owner');
    expect(devices.list('babelcast')).toMatchObject({ total: 3, blocked: 3 });
    expect(devices.admit('babelcast', id(60), 'chat')).toBeNull();
    expect(devices.list('babelcast').devices.map(d => d.id)).not.toContain(id(60));
    await expect(devices.block('babelcast', id(61), null, 'owner')).rejects.toMatchObject({ status: 409 });
  });
});

describe('devices over HTTP', () => {
  let server: Server;
  let base: string;
  let devices: AppDevices;
  const llm: LLMProvider = { providerId: 'openrouter', isConfigured: () => true, chat: async (r) => ({ content: 'ok', model: r.model }) };

  beforeEach(async () => {
    const controller = new DeploymentController({
      backend: new FakeCloud(), store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test',
    });
    await controller.init();
    const made = await registry();
    devices = made.devices;
    const userOf = (req: { headers: { authorization?: string } }) => USERS[req.headers.authorization ?? ''] ?? null;
    const handler = createDeploymentRoutes({ controller, apps: made.apps, devices, isAdmin: (req) => userOf(req) === 'owner', userOf });
    server = createProxyServer({
      apiKeys: [`${ADMIN}:owner`, `${APP}:babelcast`, `${OTHER}:other`],
      providers: { stt: {}, tts: {}, chat: {}, chatRoutes: { 'babel-llm': [{ providerId: 'openrouter', provider: llm, model: 'x/y' }] } } as never,
      prefixRoutes: [{ prefix: '/v1/apps', handler }],
      deviceGate: (userId, headers, kind) => {
        const named = typeof headers['x-app'] === 'string' ? headers['x-app'] : null;
        return devices.admit(userId === 'owner' ? named : userId, headers[DEVICE_HEADER], kind);
      },
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise(r => server.close(() => r(null))));

  const call = (method: string, path: string, key = APP, opts: { body?: unknown; headers?: Record<string, string> } = {}) =>
    fetch(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...opts.headers },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  const infer = (path: string, device?: string, key = APP) => call('POST', path, key, {
    body: { model: 'babel-llm', messages: [{ role: 'user', content: 'oi' }], input: 'oi' },
    headers: device ? { 'X-Gateway-Device': device } : {},
  });
  const ROUTES = ['/v1/chat/completions', '/v1/audio/transcriptions', '/v1/audio/speech'];

  it('lists the devices an app used, blocks one (403 device_blocked on chat, STT and TTS) and unblocks it', async () => {
    expect((await infer('/v1/chat/completions', PHONE)).status).toBe(200);
    expect((await infer('/v1/chat/completions', TABLET)).status).toBe(200);
    const listed = await (await call('GET', '/v1/apps/babelcast/devices')).json() as Record<string, any>;
    expect(listed).toMatchObject({ app: 'babelcast', total: 2, blocked: 0 });
    expect(listed.devices.map((d: { id: string }) => d.id).sort()).toEqual([TABLET, PHONE].sort());

    const blocked = await call('POST', `/v1/apps/babelcast/devices/${PHONE}/block`, APP, { body: { reason: 'abuse' } });
    expect(blocked.status).toBe(200);
    expect(await blocked.json()).toMatchObject({ id: PHONE, blocked: { reason: 'abuse', by: 'babelcast' } });
    for (const path of ROUTES) {
      const res = await infer(path, PHONE);
      expect(res.status).toBe(403);
      expect((await res.json() as Record<string, any>).error).toMatchObject({ code: 'device_blocked', type: 'permission_error' });
    }
    expect((await infer('/v1/chat/completions', TABLET)).status).toBe(200);
    expect((await infer('/v1/chat/completions')).status).toBe(200);

    expect((await call('DELETE', `/v1/apps/babelcast/devices/${PHONE}/block`)).status).toBe(200);
    expect((await infer('/v1/chat/completions', PHONE)).status).toBe(200);
    for (const path of ROUTES.slice(1)) {
      expect((await (await infer(path, PHONE)).json() as Record<string, any>).error?.code).not.toBe('device_blocked');
    }
  });

  it("an app key cannot list or block another app's devices; an admin can, with X-App or by path", async () => {
    await infer('/v1/chat/completions', PHONE);
    expect((await call('GET', '/v1/apps/babelcast/devices', OTHER)).status).toBe(403);
    expect((await call('POST', `/v1/apps/babelcast/devices/${PHONE}/block`, OTHER, { body: {} })).status).toBe(403);
    expect((await call('DELETE', `/v1/apps/babelcast/devices/${PHONE}/block`, OTHER)).status).toBe(403);
    expect((await call('GET', '/v1/apps/babelcast/devices', OTHER, { headers: { 'X-App': 'babelcast' } })).status).toBe(403);
    expect((await call('PATCH', '/v1/apps/babelcast', OTHER, { body: { requireDevice: true } })).status).toBe(403);
    expect(devices.isBlocked('babelcast', PHONE)).toBe(false);

    const asAdmin = await call('POST', `/v1/apps/babelcast/devices/${PHONE}/block`, ADMIN, { body: { reason: 'r' }, headers: { 'X-App': 'babelcast' } });
    expect(await asAdmin.json()).toMatchObject({ blocked: { by: 'owner' } });
    expect((await call('GET', '/v1/apps/babelcast/devices', ADMIN)).status).toBe(200);
    expect((await infer('/v1/chat/completions', PHONE)).status).toBe(403);
    expect((await infer('/v1/chat/completions', PHONE, ADMIN)).status).not.toBe(403);
  });

  it('requireDevice is an app setting (PATCH /v1/apps/:app); malformed ids and unknown paths are refused', async () => {
    expect(await (await call('GET', '/v1/apps/babelcast')).json()).toMatchObject({ requireDevice: false });
    expect((await call('PATCH', '/v1/apps/babelcast', APP, { body: { requireDevice: true } })).status).toBe(200);
    expect(await (await call('GET', '/v1/apps/babelcast')).json()).toMatchObject({ requireDevice: true });
    const missing = await infer('/v1/chat/completions');
    expect(missing.status).toBe(403);
    expect((await missing.json() as Record<string, any>).error.code).toBe('device_required');
    expect((await infer('/v1/chat/completions', PHONE)).status).toBe(200);
    expect((await infer('/v1/chat/completions', undefined, OTHER)).status).not.toBe(403);

    const bad = await infer('/v1/chat/completions', 'short');
    expect(bad.status).toBe(400);
    expect((await bad.json() as Record<string, any>).error.code).toBe('invalid_device');
    expect((await call('PATCH', '/v1/apps/babelcast', APP, { body: { requireDevice: 'yes' } })).status).toBe(400);
    expect((await call('PATCH', '/v1/apps/babelcast', APP, { body: { images: {} } })).status).toBe(400);
    expect((await call('POST', '/v1/apps/babelcast/devices/sk-live-0123456789/block', APP, { body: {} })).status).toBe(400);
    expect((await call('POST', `/v1/apps/babelcast/devices/${PHONE}/erase`, APP, { body: {} })).status).toBe(404);
    expect((await call('PUT', '/v1/apps/babelcast/devices')).status).toBe(405);
  });
});
