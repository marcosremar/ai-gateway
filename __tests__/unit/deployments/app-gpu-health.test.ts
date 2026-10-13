import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createProxyServer } from '../../../src/gateway/proxy/server';
import { DeploymentController } from '../../../src/deployments/controller';
import { createDeploymentRoutes } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { AppRegistry, MemoryAppStore, parseAppProfile } from '../../../src/deployments/apps';
import { AppGpuHealth, appMode, DEGRADED_HEADER, FALLBACK_ACTIVE_MS } from '../../../src/deployments/app-gpu-health';
import { GPU_PROBE_INTERVAL_MS, servedStages } from '../../../src/deployments/gpu-probe';
import type { LLMProvider } from '../../../src/gateway/providers/cloud/types';
import { FakeCloud, until } from './_fake-cloud';

const ROUTES = {
  stt: { 'app-stt': [{ provider: 'deployment', deployment: 'speech', model: 'whisper-large-v3-turbo' }] },
  chat: { 'app-llm': [{ provider: 'deployment', deployment: 'speech', model: 'qwen3.5-9b' }] },
  tts: { 'app-tts': [{ provider: 'deployment', deployment: 'voice', oneGpuDeployment: 'speech', model: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base' }] },
};
const PROFILE = { requiresGpu: true, gpuDeployments: ['speech'] };
const CATALOG = { model: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base', voices: [{ id: 'lia', lang: 'pt', audio: 'http://refs/lia.wav', text: 'Oi.' }] };

let now = 0;
const clouds: FakeCloud[] = [];
afterEach(async () => { for (const c of clouds.splice(0)) await c.closeAll(); });

/** A fake replica: answers each stage, or fails the ones in `broken`; records what it was sent. */
function replica(broken: Set<string>) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    const stage = path.includes('transcriptions') ? 'stt' : path.includes('chat') ? 'llm' : 'tts';
    if (path === '/refs/voices.json') return broken.has('catalog') ? new Response('not found', { status: 404 }) : Response.json(CATALOG);
    if (broken.has(stage)) return new Response('engine dead', { status: 500 });
    if (stage === 'stt') return Response.json({ text: '' });
    if (stage === 'llm') return Response.json({ choices: [{ message: { content: 'o' } }] });
    return new Response(new Uint8Array(4_000), { headers: { 'content-type': 'audio/wav' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function setup(opts: { replicas?: number; broken?: Set<string>; cloudLinks?: () => Array<{ stage: 'chat' | 'stt' | 'tts'; aliases: string[]; ok: boolean }> } = {}) {
  now = 1_000_000;
  const cloud = new FakeCloud(() => now);
  clouds.push(cloud);
  const controller = new DeploymentController({
    backend: cloud, store: new MemoryDeploymentStore(), probe: { ready: async () => true }, namespace: 'test', now: () => now,
  });
  await controller.init();
  const replicas = opts.replicas ?? 1;
  await controller.put('speech', { profile: 'cpu-echo', minReplicas: replicas, maxReplicas: Math.max(1, replicas) }, { app: 'parle' });
  if (replicas) {
    await until(async () => { await controller.reconcile(); return controller.get('speech')!.replicas.filter(r => r.phase === 'ready').length === replicas; });
  }
  const apps = new AppRegistry(new MemoryAppStore(), () => now);
  await apps.init();
  await apps.putRoutes('parle', ROUTES);
  await apps.putProfile('parle', PROFILE);
  const broken = opts.broken ?? new Set<string>();
  const fake = replica(broken);
  const degraded: unknown[] = [];
  const health = new AppGpuHealth({
    controller, apps, fetchImpl: fake.fetchImpl, now: () => now, onDegraded: e => degraded.push(e),
    ...(opts.cloudLinks ? { cloudLinks: opts.cloudLinks } : {}),
  });
  return { controller, apps, health, broken, calls: fake.calls, degraded };
}

describe('app profile', () => {
  it('validates the body and refuses an app key that names a deployment of another app', async () => {
    expect(parseAppProfile({ requiresGpu: true, gpuDeployments: ['a', 'a', 'b'] })).toEqual({ requiresGpu: true, gpuDeployments: ['a', 'b'] });
    expect(parseAppProfile({ requiresGpu: false })).toEqual({ requiresGpu: false, gpuDeployments: [] });
    for (const bad of [null, [], { requiresGpu: 'yes' }, { requiresGpu: true }, { requiresGpu: true, gpuDeployments: ['Bad Name'] }, { requiresGpu: false, extra: 1 }]) {
      expect(() => parseAppProfile(bad)).toThrow();
    }
    const apps = new AppRegistry(new MemoryAppStore());
    await apps.init();
    await expect(apps.putProfile('parle', PROFILE, { ownsDeployment: d => d !== 'speech' })).rejects.toMatchObject({ status: 403 });
    expect(await apps.putProfile('parle', PROFILE, { ownsDeployment: () => true })).toEqual(PROFILE);
    expect(apps.get('parle')!.profile).toEqual(PROFILE);
  });

  it('a deployment serves the stages its app routes send it, one-GPU mode included', () => {
    const exists = (n: string) => n === 'speech';
    expect(servedStages(ROUTES, 'speech', exists).map(s => s.stage)).toEqual(['stt', 'llm', 'tts']);
    expect(servedStages(ROUTES, 'speech', () => true).map(s => s.stage)).toEqual(['stt', 'llm']);
    expect(servedStages(ROUTES, 'voice', () => true)).toEqual([{ stage: 'tts', model: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base' }]);
  });
});

describe('mode', () => {
  it('gpu only with every GPU ready and probed and no cloud answer; down only when neither the GPU nor the reserve serves', () => {
    expect(appMode({ gpuReady: true, cloudServing: false, reserveDown: false })).toBe('gpu');
    expect(appMode({ gpuReady: true, cloudServing: false, reserveDown: true })).toBe('gpu');
    expect(appMode({ gpuReady: true, cloudServing: true, reserveDown: false })).toBe('degraded');
    expect(appMode({ gpuReady: true, cloudServing: true, reserveDown: true })).toBe('degraded');
    expect(appMode({ gpuReady: false, cloudServing: true, reserveDown: false })).toBe('degraded');
    expect(appMode({ gpuReady: false, cloudServing: false, reserveDown: false })).toBe('degraded');
    expect(appMode({ gpuReady: false, cloudServing: false, reserveDown: true })).toBe('down');
  });
});

describe('GPU probe', () => {
  it('probes every stage of a ready replica (cloned voice from its catalog), then not again before the interval', async () => {
    const { health, calls } = await setup();
    expect(health.status('parle')!.mode).toBe('degraded');
    await health.probe.tick();
    expect(calls.map(c => c.path)).toEqual(['/v1/audio/transcriptions', '/v1/chat/completions', '/refs/voices.json', '/v1/audio/speech']);
    expect(calls[1]!.body).toMatchObject({ model: 'qwen3.5-9b', max_tokens: 1 });
    const tts = calls[3]!.body as Record<string, unknown>;
    expect(tts).toMatchObject({ task_type: 'Base', ref_audio: 'http://refs/lia.wav', ref_text: 'Oi.', language: 'Portuguese' });
    expect(tts.voice).toBeUndefined();
    const status = health.status('parle')!;
    expect(status).toMatchObject({
      app: 'parle', requiresGpu: true, mode: 'gpu',
      deployments: [{ name: 'speech', stages: ['stt', 'llm', 'tts'], state: 'ready', replicas: { ready: 1, total: 1 }, lastProbe: { ok: true, error: null } }],
      fallback: { active: false, since: null, last: null },
    });
    now += GPU_PROBE_INTERVAL_MS - 1;
    await health.probe.tick();
    expect(calls).toHaveLength(4);
  });

  it('two failed rounds make the replica failing and take the broken stage out of rotation until a round passes', async () => {
    const { controller, health, broken } = await setup();
    const id = controller.get('speech')!.replicas[0]!.id;
    broken.add('tts');
    await health.probe.tick();
    expect(health.status('parle')!.deployments[0]).toMatchObject({ state: 'ready', lastProbe: { ok: false, error: expect.stringMatching(/^tts: HTTP 500/) } });
    expect(health.status('parle')!.mode).toBe('degraded');
    expect(controller.get('speech')!.replicas[0]!.stagesOut).toEqual([]);
    now += GPU_PROBE_INTERVAL_MS;
    await health.probe.tick();
    expect(health.status('parle')!.deployments[0]).toMatchObject({ state: 'failing', replicas: { ready: 0, total: 1 } });
    expect(controller.get('speech')!.replicas[0]!.stagesOut).toEqual(['tts']);
    await expect(controller.acquire('speech', { waitMs: 0, stage: 'tts' })).rejects.toMatchObject({ code: 'stage_out' });
    (await controller.acquire('speech', { waitMs: 0, stage: 'chat' })).done();
    broken.clear();
    now += GPU_PROBE_INTERVAL_MS;
    await health.probe.tick();
    expect(controller.get('speech')!.replicas.find(r => r.id === id)!.stagesOut).toEqual([]);
    expect(health.status('parle')!).toMatchObject({ mode: 'gpu', deployments: [{ state: 'ready' }] });
  });

  it('a cloning TTS without its voice catalog fails the round and is never sent a bare voice (it would kill its engine)', async () => {
    const { health, calls } = await setup({ broken: new Set(['catalog']) });
    await health.probe.tick();
    expect(calls.map(c => c.path)).not.toContain('/v1/audio/speech');
    expect(health.status('parle')!.deployments[0]!.lastProbe).toMatchObject({ ok: false, error: expect.stringMatching(/^tts: voice catalog unavailable/) });
  });

  it('never calls a deployment without a ready replica', async () => {
    const { health, calls } = await setup({ replicas: 0 });
    await health.probe.tick();
    expect(calls).toEqual([]);
    expect(health.status('parle')!.deployments[0]).toMatchObject({ state: 'stopped', replicas: { ready: 0, total: 0 }, lastProbe: null });
  });
});

describe('cloud fallback of a GPU app', () => {
  it('marks a cloud answer degraded, keeps since across the run, forgets it once no cloud answer came for a while', async () => {
    const { health, degraded } = await setup();
    await health.probe.tick();
    const cloud = { 'X-Gateway-Provider': 'openrouter:qwen/qwen3.5-9b', 'X-Gateway-Fallback': 'cold', 'X-Gateway-Fallback-From': 'deployment:speech' };
    expect(health.served('parle', 'chat', 200, { 'X-Gateway-Provider': 'deployment:speech' })).toBeUndefined();
    const start = now;
    expect(health.served('parle', 'chat', 200, cloud)).toEqual({ [DEGRADED_HEADER]: 'degraded' });
    now += 30_000;
    health.served('parle', 'chat', 200, cloud);
    expect(degraded).toEqual([{ app: 'parle', stage: 'llm', served: 'openrouter:qwen/qwen3.5-9b', from: 'deployment:speech' }]);
    expect(health.status('parle')!).toMatchObject({
      mode: 'degraded',
      fallback: { active: true, since: new Date(start).toISOString(), last: { at: new Date(now).toISOString(), stage: 'llm', served: 'openrouter:qwen/qwen3.5-9b' } },
    });
    now += FALLBACK_ACTIVE_MS;
    expect(health.status('parle')!.fallback).toMatchObject({ active: false, since: null, last: { stage: 'llm' } });
    expect(health.served('other', 'chat', 200, cloud)).toBeUndefined();
  });

  it('down when the GPU is not serving and the reserve failed: a request answered by nobody, or every probed cloud link', async () => {
    let links = [{ stage: 'chat' as const, aliases: ['app-llm'], ok: true }];
    const { health } = await setup({ replicas: 0, cloudLinks: () => links });
    expect(health.status('parle')!.mode).toBe('degraded');
    links = [{ stage: 'chat', aliases: ['app-llm'], ok: false }];
    expect(health.status('parle')!.mode).toBe('down');
    links = [];
    health.served('parle', 'stt', 503, { 'Retry-After': '30' });
    expect(health.status('parle')!.mode).toBe('down');
    now += FALLBACK_ACTIVE_MS;
    expect(health.status('parle')!.mode).toBe('degraded');
  });
});

describe('over HTTP', () => {
  const ADMIN = 'admin-key-0123456789';
  const PARLE = 'parle-key-0123456789';
  const OTHER = 'other-key-0123456789';
  const USERS: Record<string, string> = { [`Bearer ${ADMIN}`]: 'owner', [`Bearer ${PARLE}`]: 'parle', [`Bearer ${OTHER}`]: 'other' };
  let server: Server;
  let base: string;
  let health: AppGpuHealth;

  beforeEach(async () => {
    const made = await setup();
    health = made.health;
    const userOf = (req: { headers: { authorization?: string } }) => USERS[req.headers.authorization ?? ''] ?? null;
    const handler = createDeploymentRoutes({
      controller: made.controller, apps: made.apps, gpuHealth: health, isAdmin: (req) => userOf(req) === 'owner', userOf,
    });
    const llm: LLMProvider = { providerId: 'openrouter', isConfigured: () => true, chat: async r => ({ content: 'ok', model: r.model }) };
    server = createProxyServer({
      apiKeys: [`${ADMIN}:owner`, `${PARLE}:parle`, `${OTHER}:other`],
      providers: { stt: {}, tts: {}, chat: {}, chatRoutes: { 'app-llm': [{ providerId: 'openrouter', provider: llm, model: 'qwen/qwen3.5-9b' }] } } as never,
      prefixRoutes: [{ prefix: '/v1/apps', handler }],
      onServed: ({ userId, kind, status, headers }) => health.served(userId, kind, status, headers),
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise(r => server.close(() => r(null))));

  const call = (method: string, path: string, key: string, body?: unknown) => fetch(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  it('status: the app key and an admin read it, another app key does not, an app without profile is 404', async () => {
    const own = await call('GET', '/v1/apps/parle/status', PARLE);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ app: 'parle', requiresGpu: true, deployments: [{ name: 'speech' }] });
    expect((await call('GET', '/v1/apps/parle/status', ADMIN)).status).toBe(200);
    expect((await call('GET', '/v1/apps/parle/status', OTHER)).status).toBe(403);
    expect((await call('GET', '/v1/apps/other/status', OTHER)).status).toBe(404);
    expect((await call('POST', '/v1/apps/parle/status', PARLE)).status).toBe(405);
  });

  it('profile: admin sets any; the app key only its own deployments; another app key nothing', async () => {
    expect((await call('PUT', '/v1/apps/parle/profile', OTHER, PROFILE)).status).toBe(403);
    expect((await call('PUT', '/v1/apps/parle/profile', PARLE, { requiresGpu: true, gpuDeployments: ['speech', 'not-mine'] })).status).toBe(403);
    const byAdmin = await call('PUT', '/v1/apps/parle/profile', ADMIN, { requiresGpu: true, gpuDeployments: ['speech', 'later'] });
    expect(byAdmin.status).toBe(200);
    expect(await byAdmin.json()).toMatchObject({ profile: { gpuDeployments: ['speech', 'later'] }, warnings: [expect.stringMatching(/no warmSchedule/), expect.stringMatching(/'later' is not registered/)] });
    expect(await (await call('GET', '/v1/apps/parle/profile', PARLE)).json()).toEqual({ app: 'parle', profile: { requiresGpu: true, gpuDeployments: ['speech', 'later'] } });
    expect((await call('PUT', '/v1/apps/parle/profile', ADMIN, { requiresGpu: 'yes' })).status).toBe(400);
  });

  it('a cloud answer to the GPU app carries X-Gateway-Status: degraded; another app\'s does not', async () => {
    const chat = (key: string) => call('POST', '/v1/chat/completions', key, { model: 'app-llm', messages: [{ role: 'user', content: 'oi' }] });
    const res = await chat(PARLE);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-provider')).toBe('openrouter:qwen/qwen3.5-9b');
    expect(res.headers.get('x-gateway-status')).toBe('degraded');
    expect((await chat(ADMIN)).headers.get('x-gateway-status')).toBeNull();
    expect(health.status('parle')!.fallback.active).toBe(true);
  });
});
