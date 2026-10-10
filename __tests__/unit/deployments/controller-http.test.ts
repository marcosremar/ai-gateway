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
import { AppRegistry, FileAppStore, MemoryAppStore } from '../../../src/deployments/apps';
import type { DeploymentStore } from '../../../src/deployments/types';
import { FakeCloud, until } from './_fake-cloud';
import { resetStreamCuts, streamCuts } from '../../../src/telemetry/stream-cuts';

const ADMIN = 'admin-key-0123456789';
const SITE = 'site-key-0123456789';
/** Deployments the site key invokes belong to its app (an app key invokes only its own app's deployments). */
const AS_SITE = { 'x-app': 'site-a' };

interface Harness { cloud: FakeCloud; controller: DeploymentController; server: Server; base: string }

async function harness(opts: { store?: DeploymentStore; cloud?: FakeCloud; maxTotal?: number; onRoutesChange?: () => void; declaredStatus?: () => unknown; invokeIdleMs?: number; maxWaitSeconds?: number } = {}): Promise<Harness> {
  const cloud = opts.cloud ?? new FakeCloud();
  const controller = new DeploymentController({
    backend: cloud, store: opts.store ?? new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000),
    namespace: 'test', reconcileMs: 50, maxTotalReplicas: opts.maxTotal ?? 6,
    ...(opts.maxWaitSeconds ? { maxColdStartWaitSeconds: opts.maxWaitSeconds } : {}),
  });
  await controller.init();
  controller.start();
  const apps = new AppRegistry(new MemoryAppStore());
  await apps.init();
  const handler = createDeploymentRoutes({
    controller,
    apps,
    isAdmin: (req) => req.headers.authorization === `Bearer ${ADMIN}`,
    userOf: (req) => (req.headers.authorization === `Bearer ${SITE}` ? 'site-a' : req.headers.authorization === `Bearer ${ADMIN}` ? 'owner' : null),
    onRoutesChange: opts.onRoutesChange,
    ...(opts.invokeIdleMs ? { invokeIdleMs: opts.invokeIdleMs } : {}),
    ...(opts.declaredStatus ? { declaredStatus: opts.declaredStatus } : {}),
  });
  const server = createProxyServer({
    apiKeys: [`${ADMIN}:owner`, `${SITE}:site-a`],
    providers: { stt: {}, chat: {}, tts: {} } as never,
    prefixRoutes: [{ prefix: '/v1/deployments', handler }, { prefix: '/v1/profiles', handler }, { prefix: '/v1/apps', handler }],
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

  it('GET /v1/deployments lists the declared deployments for an admin, not for an app-scoped key', async () => {
    const d = await harness({ declaredStatus: () => [{ name: 'parle-speech', state: 'pending', reason: 'GHCR_READ_TOKEN is not set' }] });
    extra.push(d);
    const admin = await (await call(d, 'GET', '/v1/deployments')).json() as { declared?: unknown };
    expect(admin.declared).toEqual([{ name: 'parle-speech', state: 'pending', reason: 'GHCR_READ_TOKEN is not set' }]);
    const site = await (await call(d, 'GET', '/v1/deployments', undefined, SITE)).json() as { declared?: unknown };
    expect(site.declared).toBeUndefined();
  });

  it('GET /v1/deployments: an app key sees health of its own deployments only, never the namespace (QA 2026-10-07)', async () => {
    await call(h, 'PUT', '/v1/deployments/mine', { profile: 'cpu-echo', minReplicas: 1 }, ADMIN, AS_SITE);
    await call(h, 'PUT', '/v1/deployments/other', { profile: 'cpu-echo', minReplicas: 1 }, ADMIN, { 'x-app': 'site-b' });
    await call(h, 'PUT', '/v1/deployments/ops', { profile: 'cpu-echo', minReplicas: 1 });
    await until(() => h.cloud.machines.size === 3);
    await until(() => h.controller.health().running === 3);
    type Health = { deployments: number; replicas: number; running: number; eurPerHour: number; listError: unknown; maxReplicas: number };
    const site = await (await call(h, 'GET', '/v1/deployments', undefined, SITE)).json() as { health: Health; deployments: Array<{ name: string }> };
    expect(site.deployments.map(d => d.name)).toEqual(['mine']);
    expect(site.health).toMatchObject({ deployments: 1, replicas: 1, running: 1, eurPerHour: 0.01, listError: null });
    expect(site.health.maxReplicas).toBe(h.controller.health().maxReplicas); // the gateway's limit, the same for all
    const admin = await (await call(h, 'GET', '/v1/deployments')).json() as { health: Health };
    expect(admin.health).toMatchObject({ deployments: 3, replicas: 3, running: 3, eurPerHour: 0.03 });
  });

  it('POST /v1/deployments/:name/warm: admin pre-warm window, validated, shown in the view with the autoscale reason', async () => {
    await call(h, 'PUT', '/v1/deployments/class', { profile: 'cpu-echo', maxReplicas: 2 }, ADMIN, AS_SITE);
    expect((await call(h, 'POST', '/v1/deployments/class/warm', { replicas: 2, untilMinutes: 30 }, SITE)).status).toBe(403);
    expect((await call(h, 'POST', '/v1/deployments/class/warm', { replicas: 7, untilMinutes: 30 })).status).toBe(400);
    const res = await call(h, 'POST', '/v1/deployments/class/warm', { replicas: 2, untilMinutes: 30 });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { warm: { replicas: number } }).warm.replicas).toBe(2);
    await until(() => h.cloud.created.length === 2);
    const view = await (await call(h, 'GET', '/v1/deployments/class')).json() as { autoscale: { floor: number; desired: number } };
    expect(view.autoscale).toMatchObject({ floor: 2, desired: 2 });
  });

  it('PATCH scaling.hold freezes the replica count; GET …/capacity reports ceiling and boot time, to the owning app only', async () => {
    await call(h, 'PUT', '/v1/deployments/class', { profile: 'cpu-echo', maxReplicas: 2 }, ADMIN, AS_SITE);
    expect((await call(h, 'PATCH', '/v1/deployments/class', { scaling: { hold: { replicas: 2, untilMinutes: 30 } } }, SITE)).status).toBe(403);
    expect((await call(h, 'PATCH', '/v1/deployments/class', { scaling: { hold: { replicas: 3, untilMinutes: 30 } } })).status).toBe(400);
    const held = await call(h, 'PATCH', '/v1/deployments/class', { scaling: { hold: { replicas: 2, untilMinutes: 30 } } });
    expect(held.status).toBe(200);
    expect((await held.json()) as { hold: unknown; spec: { scaling?: unknown } }).toMatchObject({ hold: { replicas: 2 }, desiredReplicas: 2 });
    await until(() => h.cloud.created.length === 2);
    const capacity = await call(h, 'GET', '/v1/deployments/class/capacity', undefined, SITE);
    expect(capacity.status).toBe(200);
    expect(await capacity.json()).toMatchObject({
      deployment: 'class', mode: null, hold: { replicas: 2 },
      capacity: [{ ceiling: { sessions: 8, source: 'default' }, boot: { source: expect.stringMatching(/default|measured/) }, confident: false }],
    });
    await call(h, 'PUT', '/v1/deployments/other', { profile: 'cpu-echo' });
    expect((await call(h, 'GET', '/v1/deployments/other/capacity', undefined, SITE)).status).toBe(404);
    expect((await call(h, 'GET', '/v1/deployments/nope/capacity')).status).toBe(404);
    const released = await call(h, 'PATCH', '/v1/deployments/class', { scaling: { hold: null } });
    expect((await released.json()) as { hold: unknown }).toMatchObject({ hold: null });
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

  it('boot-script deployments ship their files as user_data and never return script or files', async () => {
    const res = await call(h, 'PUT', '/v1/deployments/vm', {
      bootScript: 'echo secret-in-script', files: { 'ref-a': Buffer.from('RIFF').toString('base64') },
      machineType: 'DEV1-S', minReplicas: 1, maxEurPerHour: 0.05,
    });
    const text = await res.text();
    expect(res.status).toBe(201);
    expect(text).not.toContain('secret-in-script');
    expect(JSON.parse(text).spec).toMatchObject({ bootScript: true, fileKeys: ['ref-a'] });
    await until(() => h.cloud.created.length === 1);
    expect(Object.keys(h.cloud.created[0].files!)).toEqual(['aigw-pack-0']);
    expect(Buffer.from(h.cloud.created[0].files!['aigw-pack-0']).toString()).toBe('RIFF');
  });

  it('fileUrls: the view names the files and never returns their URLs', async () => {
    const res = await call(h, 'PUT', '/v1/deployments/vm2', {
      bootScript: 'true', machineType: 'DEV1-S', maxEurPerHour: 0.05, files: { 'ref-a': 'UklGRg==' },
      fileUrls: { 'voices.json': { url: 'https://assets.example/v.json?sig=secret-signature', sha256: 'a'.repeat(64) } },
    });
    const text = await res.text();
    expect(res.status).toBe(201);
    expect(text).not.toContain('secret-signature');
    expect(JSON.parse(text).spec.fileKeys).toEqual(['ref-a', 'voices.json']);
    expect(JSON.parse(text).spec.fileUrls).toBeUndefined();
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

  it('a private image in the provider registry gets the backend credentials on the machine, never in the spec', async () => {
    h.cloud.registryAuthFor = (image: string) => image.startsWith('rg.fr-par.scw.cloud/')
      ? { server: 'rg.fr-par.scw.cloud', username: 'nologin', password: 'scw-secret-xyz' } : null;
    await call(h, 'PUT', '/v1/deployments/priv', { image: 'rg.fr-par.scw.cloud/aigw/app:1', port: 80, machineType: 'DEV1-S', minReplicas: 1 });
    await call(h, 'PUT', '/v1/deployments/pub', { image: 'me/app:1', port: 80, machineType: 'DEV1-S', minReplicas: 1 });
    await until(() => h.cloud.created.length === 2);
    const byName = Object.fromEntries(h.cloud.created.map(c => [c.spec.name, c.cloudInit]));
    expect(byName.priv).toContain("docker login 'rg.fr-par.scw.cloud' -u 'nologin' --password-stdin");
    expect(byName.pub).not.toContain('docker login');
    const view = await (await call(h, 'GET', '/v1/deployments/priv')).text();
    expect(view).not.toContain('scw-secret-xyz');
    expect(JSON.parse(view).spec.privateRegistry).toBeFalsy();
  });

  it('scales from zero on the first request: waits through boot, then forwards with the replica token', async () => {
    await call(h, 'PUT', '/v1/deployments/echo', { profile: 'cpu-echo' }, ADMIN, AS_SITE);
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

  it('a cold start longer than the proxy idle timeout is still served (regression: socket killed at 60 s)', async () => {
    await close(h);
    await h.cloud.closeAll();
    process.env.PROXY_TOTAL_TIMEOUT_MS = '300';
    try {
      h = await harness();
    } finally {
      delete process.env.PROXY_TOTAL_TIMEOUT_MS;
    }
    h.cloud.bootMs = 1200;
    await call(h, 'PUT', '/v1/deployments/longboot', { profile: 'cpu-echo' }, ADMIN, AS_SITE);
    const res = await call(h, 'GET', '/v1/deployments/longboot/invoke/x', undefined, SITE);
    expect(res.status).toBe(200);
  });

  it('caps the cold-start wait at the gateway maximum: a stored 840 s or X-Aigw-Wait: 840 answers 503 + Retry-After in time, with a warning in the view', async () => {
    const capped = await harness({ maxWaitSeconds: 1 });
    extra.push(capped);
    capped.cloud.bootMs = 60_000;
    const put = await call(capped, 'PUT', '/v1/deployments/slow', { profile: 'cpu-echo', coldStartWaitSeconds: 840 }, ADMIN, AS_SITE);
    expect(put.status).toBe(201);
    expect(((await put.json()) as { warnings: string[] }).warnings).toEqual([expect.stringMatching(/coldStartWaitSeconds 840 .* maximum wait of 1 s \(DEPLOYMENTS_MAX_WAIT_SECONDS\)/)]);
    for (const headers of [{}, { 'x-aigw-wait': '840' }]) {
      const started = Date.now();
      const res = await call(capped, 'GET', '/v1/deployments/slow/invoke/', undefined, SITE, headers);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('30');
      expect(((await res.json()) as { status: string }).status).toBe('warming');
      expect(Date.now() - started).toBeLessThan(4000);
    }
    const within = await call(h, 'PUT', '/v1/deployments/ok', { profile: 'cpu-echo', coldStartWaitSeconds: 240 }, ADMIN, AS_SITE);
    expect(((await within.json()) as { warnings: string[] }).warnings).toEqual([]);
  });

  it('answers 503 + Retry-After when the replica is not ready within the wait', async () => {
    h.cloud.bootMs = 60_000;
    await call(h, 'PUT', '/v1/deployments/slow', { profile: 'cpu-echo' }, ADMIN, AS_SITE);
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
    }, ADMIN, AS_SITE);
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

    // Idle: push lastRequestAt (and when the replicas became ready) back past idleMinutes. First wait until every lease is
    // done: the proxy ends a lease (`done()`, which stamps lastRequestAt = now) AFTER the client has read the body, so
    // rewinding the clock right after `r.json()` could be overwritten a tick later and the deployment never went idle
    // (the flake of this test).
    await until(() => h.controller.get('busy')!.inflight === 0 && h.controller.get('busy')!.replicas.every(r => r.inflight === 0));
    const internals = h.controller as unknown as {
      deployments: Map<string, { record: { lastRequestAt: number } }>; probes: Map<string, { readyAt?: number }>;
    };
    internals.deployments.get('busy')!.record.lastRequestAt = Date.now() - 2 * 60_000;
    for (const p of internals.probes.values()) if (p.readyAt) p.readyAt = Date.now() - 3 * 60_000;
    await until(() => h.cloud.machines.size === 0, 3000);
    expect(h.controller.get('busy')!.status).toBe('scaled-to-zero');
  });

  it('exposed deployment: one reserved IP + firewall for all its replicas, shown as publicIp, released with it', async () => {
    // LiveKit-like: clients reach the machine directly (WebRTC), so the address must outlive the replica.
    await call(h, 'PUT', '/v1/deployments/rtc', {
      profile: 'cpu-echo', minReplicas: 1, exposure: { ports: [{ protocol: 'tcp', port: 443 }, { protocol: 'udp', port: 7882 }] },
    });
    await until(() => h.controller.get('rtc')!.status === 'ready');
    const view = h.controller.get('rtc')!;
    expect(view.publicIp).toBe('51.15.0.1');
    expect(h.cloud.created[0]!.network).toMatchObject({ ipId: 'ip-rtc', groupId: 'sg-rtc' });
    const nginx = /echo '([A-Za-z0-9+/=]+)' \| base64 -d > \/srv\/aigw\/nginx\.conf/.exec(h.cloud.created[0]!.cloudInit)![1]!;
    expect(Buffer.from(nginx, 'base64').toString()).toContain('listen 8089 default_server');
    const before = h.cloud.networkCalls;
    await call(h, 'PATCH', '/v1/deployments/rtc', { exposure: { ports: [{ protocol: 'tcp', port: 443 }, { protocol: 'udp', port: 7882 }, { protocol: 'tcp', port: 7881 }] } });
    await until(() => h.cloud.networkCalls > before);
    expect((await call(h, 'DELETE', '/v1/deployments/rtc')).status).toBe(200);
    await until(() => h.cloud.releasedNetworks.includes('ip-rtc'));
    await until(async () => (await (await call(h, 'GET', '/v1/deployments')).json() as { pendingNetworkReleases: unknown[] }).pendingNetworkReleases.length === 0);
    expect((await (await call(h, 'GET', '/v1/deployments', undefined, SITE)).json() as Record<string, unknown>).pendingNetworkReleases).toBeUndefined();
  });

  it("idleAction 'stop': idle powers the replica off (kept, not deleted) and the next demand powers it back on", async () => {
    await call(h, 'PUT', '/v1/deployments/park', { profile: 'cpu-echo', idleMinutes: 1, idleAction: 'stop' });
    await call(h, 'POST', '/v1/deployments/park/wake');
    await until(() => h.controller.get('park')!.status === 'ready');
    const internals = h.controller as unknown as {
      deployments: Map<string, { record: { lastRequestAt: number } }>; probes: Map<string, { readyAt?: number }>;
    };
    internals.deployments.get('park')!.record.lastRequestAt = Date.now() - 2 * 60_000;
    for (const p of internals.probes.values()) if (p.readyAt) p.readyAt = Date.now() - 3 * 60_000;
    await until(() => h.cloud.stops.length === 1, 3000);
    expect(h.cloud.released).toEqual([]);
    expect([...h.cloud.machines.values()].map(m => m.machine.state)).toEqual(['stopped']);

    await call(h, 'POST', '/v1/deployments/park/wake');
    await until(() => h.controller.get('park')!.status === 'ready', 3000);
    expect(h.cloud.starts).toHaveLength(1);
    expect(h.cloud.created).toHaveLength(1);

    // POST /park: the caller is done now (its traffic bypassed the gateway) → powered off at once, no idle wait.
    expect((await call(h, 'POST', '/v1/deployments/park/park')).status).toBe(202);
    await until(() => h.cloud.stops.length === 2, 3000);
    expect(h.cloud.released).toEqual([]);
  });

  it('retries on another replica when one dies, and replaces the dead one', async () => {
    await call(h, 'PUT', '/v1/deployments/ha', { profile: 'cpu-echo', minReplicas: 2, maxReplicas: 2 }, ADMIN, AS_SITE);
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

  it('regression: a client that aborts an invoke does not mark the replica suspect (lease ends `cancelled`)', async () => {
    await call(h, 'PUT', '/v1/deployments/slowapp', { profile: 'cpu-echo', minReplicas: 1 }, ADMIN, AS_SITE);
    await until(() => h.controller.get('slowapp')!.status === 'ready');
    h.cloud.appDelayMs = 2_000;
    const outcomes: unknown[] = [];
    const acquire = h.controller.acquire.bind(h.controller);
    h.controller.acquire = (async (...args: Parameters<typeof acquire>) => {
      const lease = await acquire(...args);
      const done = lease.done;
      lease.done = (outcome) => { outcomes.push(outcome); done(outcome); };
      return lease;
    }) as typeof h.controller.acquire;
    const abort = new AbortController();
    const pending = fetch(`${h.base}/v1/deployments/slowapp/invoke/`, { headers: { authorization: `Bearer ${SITE}` }, signal: abort.signal }).catch(() => null);
    await until(() => h.controller.get('slowapp')!.inflight === 1);
    abort.abort();
    await pending;
    await until(() => outcomes.length === 1);
    expect(outcomes).toEqual(['cancelled']); // before: true — a connection failure strike for the client's own abort
    expect(h.controller.get('slowapp')!.replicas[0].phase).toBe('ready');
    h.cloud.appDelayMs = 0;
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
      await call(h, 'PUT', '/v1/deployments/keep', { profile: 'cpu-echo', minReplicas: 1 }, ADMIN, AS_SITE);
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
    await call(h, 'PUT', '/v1/deployments/p', { profile: 'cpu-echo', minReplicas: 1 }, ADMIN, AS_SITE);
    await until(() => h.cloud.machines.size === 1);
    await call(h, 'PATCH', '/v1/deployments/p', { paused: true });
    await until(() => h.cloud.machines.size === 0);
    expect((await call(h, 'GET', '/v1/deployments/p/invoke/', undefined, SITE)).status).toBe(409);
  });
});

describe('app accounts: saved image addresses per app', () => {
  const SPEECH = 'rg.fr-par.scw.cloud/aigw/speech-stack:20261006-0107';
  const SPEECH_OLD = 'rg.fr-par.scw.cloud/aigw/speech-stack:20261004-2240';
  const asParle = { 'x-app': 'parle' };

  beforeEach(async () => { h = await harness(); });
  afterEach(async () => { await close(h); for (const x of extra.splice(0)) await close(x); });

  it('an app saves its image address once and deploys it by name; the deployment belongs to the app', async () => {
    let res = await call(h, 'PUT', '/v1/apps/parle/images/speech-stack', {
      image: SPEECH_OLD, port: 8000, healthPath: '/health', description: 'Whisper + Qwen3.5-9B + Qwen3-TTS',
      defaults: { machineType: 'DEV1-S', gpu: false, maxReplicas: 2 },
    }, ADMIN, asParle);
    expect(res.status).toBe(201);
    res = await call(h, 'PUT', '/v1/apps/parle/images/speech-stack', { image: SPEECH }, ADMIN, asParle);
    const saved = await res.json() as { image: string; port: number; history: Array<{ image: string }> };
    expect(saved).toMatchObject({ image: SPEECH, port: 8000 });
    expect(saved.history.map(v => v.image)).toEqual([SPEECH_OLD]); // the previous address is kept

    res = await call(h, 'PUT', '/v1/deployments/parle-speech', { appImage: 'speech-stack', minReplicas: 0 }, ADMIN, asParle);
    expect(res.status).toBe(201);
    const view = await res.json() as { app: string; appImage: string; spec: { image: string; port: number; machineType: string; maxReplicas: number } };
    expect(view).toMatchObject({ app: 'parle', appImage: 'speech-stack' });
    expect(view.spec).toMatchObject({ image: SPEECH, port: 8000, machineType: 'DEV1-S', maxReplicas: 2 });

    // Roll back to the previous address by version
    res = await call(h, 'PATCH', '/v1/deployments/parle-speech', { appImage: 'speech-stack', appImageVersion: 1 }, ADMIN, asParle);
    expect(((await res.json()) as { spec: { image: string } }).spec.image).toBe(SPEECH_OLD);

    // The app's account lists its images and deployments
    const account = await (await call(h, 'GET', '/v1/apps/parle', undefined, ADMIN, asParle)).json() as {
      images: Array<{ name: string }>; deployments: Array<{ name: string }>;
    };
    expect(account.images.map(i => i.name)).toEqual(['speech-stack']);
    expect(account.deployments.map(d => d.name)).toEqual(['parle-speech']);
  });

  it('apps are isolated: a key sees and edits only its own app, cannot act for another', async () => {
    await call(h, 'PUT', '/v1/apps/parle/images/speech-stack', { image: SPEECH, port: 8000 }, ADMIN, asParle);
    await call(h, 'PUT', '/v1/deployments/parle-echo', { profile: 'cpu-echo' }, ADMIN, asParle);
    expect((await call(h, 'PUT', '/v1/apps/site-a/images/web', { image: 'ghcr.io/site-a/web:1', port: 80 }, SITE)).status).toBe(403);
    expect((await call(h, 'PUT', '/v1/apps/site-a/images/web', { image: 'ghcr.io/site-a/web:1', port: 80 }, ADMIN, { 'x-app': 'site-a' })).status).toBe(201);
    // …but not parle's, and cannot impersonate it
    expect((await call(h, 'GET', '/v1/apps/parle', undefined, SITE)).status).toBe(403);
    expect((await call(h, 'GET', '/v1/apps/site-a', undefined, SITE, asParle)).status).toBe(403);
    expect((await call(h, 'GET', '/v1/deployments/parle-echo', undefined, SITE)).status).toBe(403);
    const list = await (await call(h, 'GET', '/v1/deployments', undefined, SITE)).json() as { deployments: unknown[] };
    expect(list.deployments).toEqual([]);
    const apps = await (await call(h, 'GET', '/v1/apps', undefined, SITE)).json() as { apps: Array<{ id: string }> };
    expect(apps.apps.map(a => a.id)).toEqual(['site-a']);
    // The admin sees every app
    const all = await (await call(h, 'GET', '/v1/apps', undefined, ADMIN)).json() as { apps: Array<{ id: string }> };
    expect(all.apps.map(a => a.id).sort()).toEqual(['parle', 'site-a']);
  });

  it('refuses bad image addresses, secrets in defaults, unknown images and appImage without an app', async () => {
    expect((await call(h, 'PUT', '/v1/apps/parle/images/x', { image: 'not an image; rm -rf /' }, ADMIN, asParle)).status).toBe(400);
    expect((await call(h, 'PUT', '/v1/apps/parle/images/x', { image: SPEECH, defaults: { env: { KEY: 'secret' } } }, ADMIN, asParle)).status).toBe(400);
    expect((await call(h, 'PUT', '/v1/apps/parle/images/x', { image: SPEECH, registryAuth: { password: 'p' } }, ADMIN, asParle)).status).toBe(400);
    expect((await call(h, 'PUT', '/v1/deployments/y', { appImage: 'missing' }, ADMIN, asParle)).status).toBe(404);
    expect((await call(h, 'PUT', '/v1/deployments/y', { appImage: 'speech-stack' }, ADMIN)).status).toBe(400);
  });

  it('an app\'s daily budgets: an admin sets them, the app key reads and cannot raise them', async () => {
    expect((await call(h, 'PUT', '/v1/apps/site-a/limits', { dailyRequests: 60_000, dailyTokens: null }, ADMIN, AS_SITE)).status).toBe(200);
    expect(await (await call(h, 'GET', '/v1/apps/site-a/limits', undefined, SITE)).json()).toEqual({ app: 'site-a', limits: { dailyRequests: 60_000 } });
    expect((await call(h, 'PUT', '/v1/apps/site-a/limits', { dailyRequests: 9_999_999 }, SITE)).status).toBe(403);
    expect((await call(h, 'PUT', '/v1/apps/site-a/limits', { dailyRequests: -1 }, ADMIN, AS_SITE)).status).toBe(400);
    expect((await call(h, 'PUT', '/v1/apps/site-a/limits', { perMinute: 1 }, ADMIN, AS_SITE)).status).toBe(400);
    expect(await (await call(h, 'GET', '/v1/apps/site-a/limits', undefined, ADMIN, AS_SITE)).json()).toEqual({ app: 'site-a', limits: { dailyRequests: 60_000 } });
  });

  it('an app owns its aliases: PUT routes validates, re-mounts the providers, and refuses another app\'s alias', async () => {
    let remounts = 0;
    const r = await harness({ onRoutesChange: () => { remounts++; } });
    extra.push(r);
    const chain = { tts: { 'parle-tts': [
      { provider: 'deployment', deployment: 'parle-qwen-tts' },
      { provider: 'openrouter', model: 'hexgrad/kokoro-82m', voice: 'pf_dora', fixedVoice: true },
    ] } };
    let res = await call(r, 'PUT', '/v1/apps/parle/routes', chain, ADMIN, asParle);
    expect(res.status).toBe(200);
    expect(remounts).toBe(1);
    const got = await (await call(r, 'GET', '/v1/apps/parle/routes', undefined, ADMIN, asParle)).json() as { routes: typeof chain };
    expect(got.routes.tts['parle-tts'][1]).toMatchObject({ voice: 'pf_dora', fixedVoice: true });
    // Invalid entries and non-objects are refused, and nothing is re-mounted
    expect((await call(r, 'PUT', '/v1/apps/parle/routes', { chat: { x: [42] } }, ADMIN, asParle)).status).toBe(400);
    expect((await call(r, 'PUT', '/v1/apps/parle/routes', '[1]', ADMIN, asParle)).status).toBe(400);
    // site-a cannot take parle's alias, nor write parle's routes
    res = await call(r, 'PUT', '/v1/apps/site-a/routes', { tts: { 'parle-tts': [{ provider: 'openrouter', model: 'm' }] } }, SITE);
    expect(res.status).toBe(409);
    expect((await call(r, 'PUT', '/v1/apps/parle/routes', chain, SITE)).status).toBe(403);
    expect(remounts).toBe(1);
  });

  // Regression (security test 06/10/2026): an app key may rewrite its own routes, so a leaked one could point them at
  // any OpenRouter model or at another app's GPU deployment; and any key could invoke any deployment.
  it('an app key rewrites its routes only within what an admin gave it, plus its own deployments', async () => {
    const asSite = { 'x-app': 'site-a' };
    const given = { chat: { 'site-llm': [
      { provider: 'deployment', deployment: 'site-gpu' },
      { provider: 'openrouter', model: 'qwen/qwen3.5-9b', extraBody: { reasoning: { enabled: false } } },
    ] } };
    expect((await call(h, 'PUT', '/v1/apps/site-a/routes', given, ADMIN, asSite)).status).toBe(200);
    await call(h, 'PUT', '/v1/deployments/site-own', { profile: 'cpu-echo' }, ADMIN, asSite);
    await call(h, 'PUT', '/v1/deployments/other-gpu', { profile: 'cpu-echo' }, ADMIN, { 'x-app': 'other' });

    // Reorder, re-alias, drop, and add its own deployment: allowed.
    const reordered = { chat: { 'site-llm-2': [
      { provider: 'openrouter', model: 'qwen/qwen3.5-9b', extraBody: { reasoning: { enabled: false } } },
      { provider: 'deployment', deployment: 'site-own' },
    ] } };
    expect((await call(h, 'PUT', '/v1/apps/site-a/routes', reordered, SITE)).status).toBe(200);
    // A new upstream model, the same model with other extraBody, another app's deployment: refused (403), unchanged.
    for (const entry of [
      { provider: 'openrouter', model: 'some-org/expensive-model' },
      { provider: 'openrouter', model: 'qwen/qwen3.5-9b', extraBody: { models: ['some-org/expensive-model'] } },
      { provider: 'deployment', deployment: 'other-gpu' },
      { provider: 'deployment', deployment: 'site-own', oneGpuDeployment: 'other-gpu' },
    ]) {
      const res = await call(h, 'PUT', '/v1/apps/site-a/routes', { chat: { 'site-llm-2': [entry] } }, SITE);
      expect(res.status).toBe(403);
    }
    // An alias without model calls the alias itself upstream: a new alias name is a new target.
    expect((await call(h, 'PUT', '/v1/apps/site-a/routes', { chat: { 'some-org/expensive-model': [{ provider: 'openrouter' }] } }, SITE)).status).toBe(403);
    const now = await (await call(h, 'GET', '/v1/apps/site-a/routes', undefined, SITE)).json() as { routes: typeof reordered };
    expect(now.routes).toEqual(reordered);
    // The admin is not restricted.
    expect((await call(h, 'PUT', '/v1/apps/site-a/routes', { chat: { x: [{ provider: 'openrouter', model: 'any/model' }] } }, ADMIN, asSite)).status).toBe(200);

    // Invoke: an app key reaches only its own app's deployments.
    expect((await call(h, 'GET', '/v1/deployments/other-gpu/invoke/', undefined, SITE)).status).toBe(403);
    expect((await call(h, 'GET', '/v1/deployments/nope/invoke/', undefined, SITE)).status).toBe(403);
    expect(h.cloud.created).toHaveLength(0); // the refused invoke woke nothing
  });

  it('accounts persist across a gateway restart (file store)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aigw-apps-'));
    try {
      const first = new AppRegistry(FileAppStore.inDir(dir));
      await first.init();
      await first.putImage('parle', 'speech-stack', { image: SPEECH, port: 8000 });
      const second = new AppRegistry(FileAppStore.inDir(dir));
      await second.init();
      expect(second.image('parle', 'speech-stack')).toMatchObject({ image: SPEECH, port: 8000 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('invoke: a replica stream that does not end', () => {
  type Script = (res: import('http').ServerResponse, n: number) => void;

  async function scripted(x: Harness, script: Script) {
    await call(x, 'PUT', '/v1/deployments/cut', { profile: 'cpu-echo', minReplicas: 1 }, ADMIN, AS_SITE);
    await until(() => x.controller.get('cut')!.status === 'ready');
    const fake = [...x.cloud.machines.values()][0];
    const probe = fake.server.listeners('request')[0] as (...a: unknown[]) => void;
    fake.server.removeAllListeners('request');
    let n = 0;
    fake.server.on('request', (req, res) => {
      if (req.url !== '/stream') return probe(req, res);
      req.resume();
      script(res, ++n);
    });
    const outcomes: unknown[] = [];
    const acquire = x.controller.acquire.bind(x.controller);
    x.controller.acquire = (async (...args: Parameters<typeof acquire>) => {
      const lease = await acquire(...args);
      const done = lease.done;
      lease.done = (outcome) => { outcomes.push(outcome); done(outcome); };
      return lease;
    }) as typeof x.controller.acquire;
    resetStreamCuts();
    return outcomes;
  }

  const read = async (x: Harness, headers: Record<string, string> = {}) => {
    const res = await call(x, 'GET', '/v1/deployments/cut/invoke/stream', undefined, SITE, headers);
    const text = await res.text().then(t => `ended:${t}`, () => 'connection error');
    return { status: res.status, text };
  };

  it('regression: a replica that resets mid-body gives the client a connection error, a failed lease and a count', async () => {
    const outcomes = await scripted(h, (res) => { res.writeHead(200); res.write('half'); setTimeout(() => res.socket!.destroy(), 30); });
    expect(await read(h)).toEqual({ status: 200, text: 'connection error' }); // before: 'ended:half', a cut that looked complete
    await until(() => outcomes.length > 0);
    expect(outcomes[0]).toBe(true);
    expect(streamCuts()).toEqual([expect.objectContaining({ deployment: 'cut', stage: 'invoke', truncated: 1, stalled: 0 })]);
  });

  it('regression: a replica that stops sending is cut at the idle limit, as busy (no health strike)', async () => {
    await close(h);
    await h.cloud.closeAll();
    h = await harness({ invokeIdleMs: 150 });
    const outcomes = await scripted(h, (res) => { res.writeHead(200); res.write('half'); });
    const started = Date.now();
    expect(await read(h)).toEqual({ status: 200, text: 'connection error' }); // before: never ended
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(outcomes[0]).toBe('timeout');
    expect(streamCuts()).toEqual([expect.objectContaining({ stage: 'invoke', truncated: 0, stalled: 1 })]);
  });

  it('a long gap under the idle limit and a clean end pass through untouched', async () => {
    const outcomes = await scripted(h, (res) => { res.writeHead(200); res.write('a'); setTimeout(() => res.end('b'), 300); });
    expect(await read(h)).toEqual({ status: 200, text: 'ended:ab' });
    expect(outcomes[0]).toBe(false);
    expect(streamCuts()).toEqual([]);
  });

  it('regression: a failed connection to the only replica is retried on it, not waited out for the whole X-Aigw-Wait', async () => {
    await scripted(h, (res, n) => { if (n === 1) res.socket!.destroy(); else res.end('ok'); });
    const started = Date.now();
    expect(await read(h, { 'x-aigw-wait': '4' })).toEqual({ status: 200, text: 'ended:ok' }); // before: 503 after the 4 s
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
