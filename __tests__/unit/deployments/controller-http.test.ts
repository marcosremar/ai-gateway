/**
 * Controller + HTTP routes mounted on the real proxy server (auth included), against in-process fake replicas.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createProxyServer } from '../../../src/gateway/proxy/server';
import { DeploymentController } from '../../../src/deployments/controller';
import { createDeploymentRoutes, HttpReplicaProbe } from '../../../src/deployments/http';
import { FileDeploymentStore, MemoryDeploymentStore } from '../../../src/deployments/store';
import type { DeploymentStore } from '../../../src/deployments/types';
import { FakeCloud, until } from './_fake-cloud';

const ADMIN = 'admin-key-0123456789';
const SITE = 'site-key-0123456789';

interface Harness { cloud: FakeCloud; controller: DeploymentController; server: Server; base: string }

async function harness(opts: { store?: DeploymentStore; cloud?: FakeCloud; maxTotal?: number } = {}): Promise<Harness> {
  const cloud = opts.cloud ?? new FakeCloud();
  const controller = new DeploymentController({
    backend: cloud, store: opts.store ?? new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000),
    namespace: 'test', reconcileMs: 50, maxTotalReplicas: opts.maxTotal ?? 6,
  });
  await controller.init();
  controller.start();
  const handler = createDeploymentRoutes({
    controller,
    isAdmin: (req) => req.headers.authorization === `Bearer ${ADMIN}`,
  });
  const server = createProxyServer({
    apiKeys: [`${ADMIN}:owner`, `${SITE}:site-a`],
    providers: { stt: {}, chat: {}, tts: {} } as never,
    prefixRoutes: [{ prefix: '/v1/deployments', handler }, { prefix: '/v1/profiles', handler }],
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return { cloud, controller, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function call(h: Harness, method: string, path: string, body?: unknown, key = ADMIN, headers: Record<string, string> = {}) {
  return fetch(`${h.base}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

let h: Harness;
const extra: Harness[] = [];

async function close(x: Harness) {
  x.controller.stop();
  x.server.closeAllConnections();
  await new Promise<void>(r => x.server.close(() => r()));
}

beforeEach(async () => { h = await harness(); });
afterEach(async () => {
  for (const x of [h, ...extra.splice(0)]) { await close(x); await x.cloud.closeAll(); }
});

describe('deployments API', () => {
  it('rejects callers without an API key and non-admin mutations', async () => {
    expect((await fetch(`${h.base}/v1/deployments`)).status).toBe(401);
    expect((await call(h, 'GET', '/v1/deployments', undefined, SITE)).status).toBe(200);
    expect((await call(h, 'PUT', '/v1/deployments/x', { profile: 'cpu-echo' }, SITE)).status).toBe(403);
  });

  it('lists built-in profiles and stores new ones', async () => {
    const names = ((await (await call(h, 'GET', '/v1/profiles')).json()) as { profiles: { name: string }[] }).profiles.map(p => p.name);
    expect(names).toEqual(expect.arrayContaining(['qwen3-tts', 'qwen3-tts-clone', 'cpu-echo']));
    const put = await call(h, 'PUT', '/v1/profiles/whisper', { image: 'me/whisper:1', port: 9000, healthPath: '/ping' });
    expect(put.status).toBe(200);
    const created = await call(h, 'PUT', '/v1/deployments/stt', { profile: 'whisper' });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { spec: { image: string } }).spec.image).toBe('me/whisper:1');
    expect((await call(h, 'DELETE', '/v1/profiles/qwen3-tts')).status).toBe(404); // built-in
  });

  it('400 on invalid spec, 404 on unknown deployment', async () => {
    const bad = await call(h, 'PUT', '/v1/deployments/x', { image: 'a', port: 1, maxReplicas: 99 });
    expect(bad.status).toBe(400);
    expect((await call(h, 'GET', '/v1/deployments/nope')).status).toBe(404);
    expect((await call(h, 'PATCH', '/v1/deployments/nope', { maxReplicas: 2 })).status).toBe(404);
  });

  it('never returns env values or registry credentials', async () => {
    const res = await call(h, 'PUT', '/v1/deployments/sec', {
      image: 'me/app:1', port: 80, machineType: 'DEV1-S', env: { HF_TOKEN: 'hf_secret' },
      registryAuth: { username: 'u', password: 'p4ss' },
    });
    const text = await res.text();
    expect(text).not.toContain('hf_secret');
    expect(text).not.toContain('p4ss');
    expect(JSON.parse(text).spec).toMatchObject({ envKeys: ['HF_TOKEN'], privateRegistry: true });
  });

  it('scales from zero on the first request: waits through boot, then forwards with the replica token', async () => {
    await call(h, 'PUT', '/v1/deployments/echo', { profile: 'cpu-echo' });
    await h.controller.reconcile();
    expect(h.cloud.machines.size).toBe(0); // scaled to zero until used

    h.cloud.bootMs = 300;
    const res = await call(h, 'POST', '/v1/deployments/echo/invoke/v1/audio/speech?x=1', { input: 'olá' }, SITE);
    expect(res.status).toBe(200);
    const body = await res.json() as { url: string; body: string; method: string; sawAuthorization: boolean };
    expect(body).toMatchObject({ url: '/v1/audio/speech?x=1', method: 'POST', sawAuthorization: false });
    expect(JSON.parse(body.body)).toEqual({ input: 'olá' });
    expect(res.headers.get('x-upstream')).toBe('yes');
    expect(res.headers.get('x-aigw-replica')).toMatch(/^fr-par-2:fake-/);
    expect(h.cloud.created).toHaveLength(1);
    expect(h.cloud.created[0].cloudInit).toContain('docker run');
    expect(h.cloud.created[0].namespace).toBe('test');
  });

  it('answers 503 + Retry-After when the replica is not ready within the wait', async () => {
    h.cloud.bootMs = 60_000;
    await call(h, 'PUT', '/v1/deployments/slow', { profile: 'cpu-echo' });
    const res = await call(h, 'GET', '/v1/deployments/slow/invoke/', undefined, SITE, { 'x-aigw-wait': '0' });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(((await res.json()) as { status: string }).status).toBe('warming');
    await until(() => h.cloud.machines.size === 1);
    const view = await (await call(h, 'GET', '/v1/deployments/slow')).json() as { status: string; replicas: { phase: string }[] };
    expect(view.status).toBe('warming');
    expect(view.replicas[0].phase).toBe('booting');
  });

  it('adds replicas under load up to maxReplicas, then scales back to zero when idle', async () => {
    h.cloud.appDelayMs = 400;
    await call(h, 'PUT', '/v1/deployments/busy', {
      profile: 'cpu-echo', maxReplicas: 3, targetInflightPerReplica: 1, idleMinutes: 1, scaleDownDelaySeconds: 0,
    });
    await call(h, 'POST', '/v1/deployments/busy/wake');
    await until(() => h.controller.get('busy')!.status === 'ready');
    const burst = await Promise.all(Array.from({ length: 6 }, () => call(h, 'GET', '/v1/deployments/busy/invoke/', undefined, SITE)));
    expect(burst.every(r => r.status === 200)).toBe(true);
    expect(h.cloud.created.length).toBe(3);
    // The burst was served right away by the one ready replica (no request waits for a booting one). Once the
    // extra replicas are ready, the next burst is spread by least in-flight.
    await until(() => h.controller.get('busy')!.replicas.filter(r => r.phase === 'ready').length === 3);
    const spread = await Promise.all(Array.from({ length: 6 }, () => call(h, 'GET', '/v1/deployments/busy/invoke/', undefined, SITE)));
    const replicasUsed = new Set(await Promise.all(spread.map(async r => ((await r.json()) as { replica: string }).replica)));
    expect(replicasUsed.size).toBe(3);

    // Idle: push lastRequestAt back past idleMinutes.
    (h.controller as unknown as { deployments: Map<string, { record: { lastRequestAt: number } }> })
      .deployments.get('busy')!.record.lastRequestAt = Date.now() - 2 * 60_000;
    await until(() => h.cloud.machines.size === 0, 3000);
    expect(h.controller.get('busy')!.status).toBe('scaled-to-zero');
  });

  it('retries on another replica when one dies, and replaces the dead one', async () => {
    await call(h, 'PUT', '/v1/deployments/ha', { profile: 'cpu-echo', minReplicas: 2, maxReplicas: 2 });
    await until(() => h.controller.get('ha')!.replicas.filter(r => r.phase === 'ready').length === 2);
    const [first] = [...h.cloud.machines.keys()];
    await h.cloud.crash(first);
    for (let i = 0; i < 4; i++) {
      const res = await call(h, 'GET', '/v1/deployments/ha/invoke/', undefined, SITE);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { replica: string }).replica).not.toBe(first);
    }
    await until(() => h.cloud.released.includes(first), 3000);
    await until(() => h.controller.get('ha')!.replicas.filter(r => r.phase === 'ready').length === 2, 3000);
  });

  it('replaces a replica whose app health fails 3 checks in a row', async () => {
    await call(h, 'PUT', '/v1/deployments/sick', { profile: 'cpu-echo', minReplicas: 1 });
    await until(() => h.controller.get('sick')!.status === 'ready');
    const [id] = [...h.cloud.machines.keys()];
    h.cloud.machines.get(id)!.healthy = false;
    await until(() => h.cloud.released.includes(id), 3000);
    await until(() => h.controller.get('sick')!.status === 'ready', 3000);
  });

  it('refuses a machine above maxEurPerHour and reports why', async () => {
    h.cloud.price = 2.5;
    await call(h, 'PUT', '/v1/deployments/pricey', { profile: 'cpu-echo', minReplicas: 1 });
    await until(() => (h.controller.get('pricey')!.lastError ?? '').includes('above maxEurPerHour'));
    expect(h.cloud.created).toHaveLength(0);
  });

  it('a failed provider list never creates machines', async () => {
    h.cloud.failList = true;
    await call(h, 'PUT', '/v1/deployments/blind', { profile: 'cpu-echo', minReplicas: 2, maxReplicas: 2 });
    await new Promise(r => setTimeout(r, 200));
    expect(h.cloud.created).toHaveLength(0);
  });

  it('enforces the replica cap across deployments', async () => {
    await close(h);
    await h.cloud.closeAll();
    h = await harness({ maxTotal: 2 });
    await call(h, 'PUT', '/v1/deployments/a', { profile: 'cpu-echo', minReplicas: 2, maxReplicas: 2 });
    await call(h, 'PUT', '/v1/deployments/b', { profile: 'cpu-echo', minReplicas: 1 });
    await until(() => (h.controller.get('b')!.lastError ?? '').includes('replica cap'));
    expect(h.cloud.created).toHaveLength(2);
  });

  it('DELETE releases every replica; machines of unknown deployments are swept', async () => {
    await call(h, 'PUT', '/v1/deployments/gone', { profile: 'cpu-echo', minReplicas: 1 });
    await until(() => h.cloud.machines.size === 1);
    expect((await call(h, 'DELETE', '/v1/deployments/gone')).status).toBe(200);
    expect(h.cloud.machines.size).toBe(0);

    // A machine left by a lost state file (tagged with our namespace, unknown deployment) is released.
    const orphan = await h.cloud.createReplica({
      spec: { ...h.controller.list()[0]?.spec, name: 'ghost', zone: 'fr-par-2', machineType: 'DEV1-S', healthPath: '/health' } as never,
      replicaToken: 'x'.repeat(32), cloudInit: '', namespace: 'test',
    });
    await until(() => h.cloud.released.includes(orphan.id), 3000);
  });

  it('survives a gateway restart: specs from the state file, replicas adopted from the provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aigw-deploy-'));
    try {
      await close(h);
      await h.cloud.closeAll();
      const cloud = new FakeCloud();
      h = await harness({ store: FileDeploymentStore.inDir(dir), cloud });
      await call(h, 'PUT', '/v1/deployments/keep', { profile: 'cpu-echo', minReplicas: 1 });
      await until(() => h.controller.get('keep')!.status === 'ready');
      await close(h);

      const again = await harness({ store: FileDeploymentStore.inDir(dir), cloud });
      extra.push(again);
      await until(() => again.controller.get('keep')?.status === 'ready');
      expect(cloud.created).toHaveLength(1); // adopted, not re-created
      const res = await call(again, 'GET', '/v1/deployments/keep/invoke/', undefined, SITE);
      expect(res.status).toBe(200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('pausing releases replicas and refuses invokes with 409', async () => {
    await call(h, 'PUT', '/v1/deployments/p', { profile: 'cpu-echo', minReplicas: 1 });
    await until(() => h.cloud.machines.size === 1);
    await call(h, 'PATCH', '/v1/deployments/p', { paused: true });
    await until(() => h.cloud.machines.size === 0);
    expect((await call(h, 'GET', '/v1/deployments/p/invoke/', undefined, SITE)).status).toBe(409);
  });
});
