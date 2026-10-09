import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { FileDeploymentStore, MemoryDeploymentStore } from '../../../src/deployments/store';
import { FileAppStore } from '../../../src/deployments/apps';
import { ClientStabilityLog } from '../../../src/deployments/stability';
import { PartialListError, ScalewayClient } from '../../../src/cpu-providers/scaleway-client';
import { DeploymentSTTProvider } from '../../../src/deployments/inference-providers';
import { runTargets, ProviderUnavailableError } from '../../../src/gateway/proxy/provider-routing';
import { createProxyServer } from '../../../src/gateway/proxy/server';
import { AppLimits } from '../../../src/gateway/proxy/app-limits';
import { scheduleFloor } from '../../../src/deployments/autoscale';
import { buildServeProviders, parseModelRoutes } from '../../../src/config/serve-providers';
import { warmScheduleOf } from '../../../src/deployments/autoscale-spec';
import type { ChatRequest, LLMProvider } from '../../../src/gateway/providers/cloud/types';
import type { ReplicaMachine } from '../../../src/deployments/types';
import { FakeCloud, until } from './_fake-cloud';

const controllers: DeploymentController[] = [];
const clouds: FakeCloud[] = [];
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of controllers.splice(0)) c.stop();
  for (const c of clouds.splice(0)) await c.closeAll();
  for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aigw-state-'));
  dirs.push(dir);
  return dir;
}

async function controllerOn(cloud: FakeCloud, store = new MemoryDeploymentStore()) {
  const controller = new DeploymentController({
    backend: cloud, store, probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20, maxTotalReplicas: 6,
  });
  controllers.push(controller);
  clouds.push(cloud);
  await controller.init();
  return controller;
}

describe('#9 a damaged or missing state file', () => {
  it('a truncated deployments.json is recovered from the last good backup', async () => {
    const dir = tempDir();
    const first = FileDeploymentStore.inDir(dir);
    await first.load();
    const record = { spec: { name: 'tts' }, createdAt: 1, updatedAt: 1, lastRequestAt: null, replicaToken: 't' } as never;
    await first.saveDeployment(record);
    await first.saveDeployment({ ...(record as object), updatedAt: 2 } as never);
    writeFileSync(join(dir, 'deployments.json'), '{"version":1,"deployme');
    const loaded = await FileDeploymentStore.inDir(dir).load();
    expect(loaded.deployments.map(d => d.spec.name)).toEqual(['tts']);
  });

  it('a corrupt file with no usable backup is refused, not read as empty', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'deployments.json'), '');
    writeFileSync(join(dir, 'deployments.json.bak'), '{');
    await expect(FileDeploymentStore.inDir(dir).load()).rejects.toThrow(/state file/);
  });

  it('a corrupt apps.json is recovered from its backup', async () => {
    const dir = tempDir();
    const store = FileAppStore.inDir(dir);
    await store.save({ parle: { id: 'parle', images: {}, createdAt: 1 } } as never);
    await store.save({ parle: { id: 'parle', images: {}, createdAt: 2 } } as never);
    writeFileSync(join(dir, 'apps.json'), '');
    expect(Object.keys(await FileAppStore.inDir(dir).load())).toEqual(['parle']);
  });

  it('a gateway starting with no state file does not release the namespace machines on its first ticks', async () => {
    const cloud = new FakeCloud();
    const controller = await controllerOn(cloud, FileDeploymentStore.inDir(tempDir()));
    controller.start();
    await controller.put('tts', { profile: 'cpu-echo', maxReplicas: 1, idleMinutes: 15 });
    controller.wake('tts');
    await until(() => controller.get('tts')!.status === 'ready');
    controller.stop();

    const restarted = await controllerOn(cloud, FileDeploymentStore.inDir(tempDir()));
    restarted.start();
    await new Promise(r => setTimeout(r, 300));
    expect(cloud.releaseReasons).toEqual([]);
  });

  it('a state write that fails is surfaced in health, not swallowed', async () => {
    const dir = tempDir();
    const controller = await controllerOn(new FakeCloud(), FileDeploymentStore.inDir(dir));
    chmodSync(dir, 0o500);
    try {
      await expect(controller.put('tts', { profile: 'cpu-echo', maxReplicas: 1 })).rejects.toThrow();
      expect(controller.health().stateWriteError).toMatch(/EACCES|permission/i);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe('#12 one Scaleway zone failing to list', () => {
  it('the client lists the zones that answered and names the one that did not', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/zones/pl-waw-1/')) return new Response('boom', { status: 503 });
      const zone = /zones\/([a-z0-9-]+)\//.exec(u)?.[1];
      const servers = zone === 'fr-par-2' ? [{ id: 'a', name: 'n', state: 'running', tags: ['aigw-ns-test'], public_ip: null, commercial_type: 'L4-1-24G' }] : [];
      return new Response(JSON.stringify({ servers }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const err = await new ScalewayClient().listInstancesByTag('aigw-ns-test', { apiKey: 'k' }).catch(e => e);
    expect(err).toBeInstanceOf(PartialListError);
    expect(err.failedZones).toEqual(['pl-waw-1']);
    expect(err.items.map((i: { instanceId: string }) => i.instanceId)).toEqual(['fr-par-2:a']);
  });

  it('a deployment in fr-par-2 still creates while pl-waw-1 fails to list', async () => {
    const cloud = new FakeCloud();
    const controller = await controllerOn(cloud);
    const list = cloud.listReplicas.bind(cloud);
    cloud.listReplicas = async () => { throw new PartialListError(await list(), ['pl-waw-1'], 'pl-waw-1: 503'); };
    controller.start();
    await controller.put('tts', { profile: 'cpu-echo', maxReplicas: 1, zone: 'fr-par-2' });
    controller.wake('tts');
    await until(() => controller.get('tts')!.status === 'ready');
    expect(cloud.created.length).toBe(1);
  });

  it('a known machine of the failed zone is neither forgotten nor released, and that zone gets no new machine', async () => {
    const cloud = new FakeCloud();
    const controller = await controllerOn(cloud);
    await controller.put('waw', { profile: 'cpu-echo', maxReplicas: 1, zone: 'pl-waw-1' });
    controller.start();
    controller.wake('waw');
    await until(() => controller.get('waw')!.status === 'ready');
    const list = cloud.listReplicas.bind(cloud);
    cloud.listReplicas = async () => {
      const all: ReplicaMachine[] = await list();
      throw new PartialListError(all.filter(m => m.zone !== 'pl-waw-1'), ['pl-waw-1'], 'pl-waw-1: 503');
    };
    await controller.put('waw2', { profile: 'cpu-echo', maxReplicas: 1, zone: 'pl-waw-1' });
    await controller.put('par', { profile: 'cpu-echo', maxReplicas: 1, zone: 'fr-par-2' });
    controller.wake('waw2');
    controller.wake('par');
    await until(() => controller.get('par')!.status === 'ready');
    await new Promise(r => setTimeout(r, 200));
    expect(cloud.created.map(c => c.spec.name).sort()).toEqual(['par', 'waw']);
    expect(cloud.releaseReasons).toEqual([]);
    expect(controller.get('waw')!.replicas.length).toBe(1);
  });
});

describe('#14 cold start: wait a little, then say when to come back', () => {
  it('a 503 from a cold deployment link keeps its Retry-After hint', async () => {
    const cold = Object.assign(new Error('replicas are starting'), { status: 503, gatewayCode: 'cold', skipRetry: true, retryAfterSec: 30 });
    const err = await runTargets([{ providerId: 'deployment:tts', provider: {}, model: 'x' }], async () => { throw cold; }, { stage: 'stt' } as never)
      .catch(e => e);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err.retryAfterSec).toBe(30);
  });

  it('a request arriving while the replica boots waits for it (bounded) instead of failing at once', async () => {
    const cloud = new FakeCloud();
    cloud.bootMs = 400;
    const controller = await controllerOn(cloud);
    controller.start();
    await controller.put('stt', { profile: 'cpu-echo', maxReplicas: 1, idleMinutes: 15 });
    controller.wake('stt');
    await until(() => cloud.created.length === 1);
    const provider = new DeploymentSTTProvider(controller, 'stt', { coldWaitMs: 2000 });
    const out = await provider.transcribe({ audio: Buffer.from('x'), model: 'stt' } as never);
    expect(out).toBeDefined();
  });

  it('the wait is bounded and the refusal carries the hint', async () => {
    const cloud = new FakeCloud();
    cloud.bootMs = 60_000;
    const controller = await controllerOn(cloud);
    controller.start();
    await controller.put('stt', { profile: 'cpu-echo', maxReplicas: 1, idleMinutes: 15 });
    const provider = new DeploymentSTTProvider(controller, 'stt', { coldWaitMs: 200 });
    const t0 = Date.now();
    const err = await provider.transcribe({ audio: Buffer.from('x'), model: 'stt' } as never).catch(e => e);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(err).toMatchObject({ status: 503, gatewayCode: 'cold', retryAfterSec: 30 });
  });
});

const PARLE = 'parle-key-0123456789';
const DAY_START = Date.parse('2026-10-12T16:00:00Z');

function limits(statePath?: string, now = () => DAY_START) {
  return new AppLimits({
    env: { APP_DAILY_REQUESTS: '100' }, now, ...(statePath ? { statePath } : {}),
    isAdmin: () => false,
    aliasesOf: (u, stage) => (u === 'parle' && stage === 'chat' ? new Set(['parle-llm']) : null),
  });
}

describe('#14 only the last link of a chain waits', () => {
  const build = (fallbackKey: 'valid' | 'invalid') => {
    const made: Array<{ name: string; coldWaitMs?: number }> = [];
    const { providers } = buildServeProviders({
      instances: { chat: { openrouter: { isConfigured: () => true } as never }, stt: {}, tts: {} },
      env: {}, openrouter: { state: fallbackKey }, modelRoutes: {}, zaiModels: [], listOpenRouterModels: async () => [],
      appRoutes: parseModelRoutes(JSON.stringify({ chat: { 'parle-llm': ['deployment:llm', 'openrouter:m'] } })).routes,
      deploymentExists: () => true,
      deploymentProvider: (_stage, name, wait) => { made.push({ name, ...wait }); return { name, wait } as never; },
    });
    const chain = (providers as { chatRoutes: Record<string, Array<{ provider: { wait?: { coldWaitMs?: number } } }>> }).chatRoutes['parle-llm'];
    return chain[0].provider.wait?.coldWaitMs ?? 0;
  };

  it('waits when the fallback is dead, not when it is alive', () => {
    expect(build('invalid')).toBe(2000);
    expect(build('valid')).toBe(0);
  });
});

describe('#15 daily budget charged only for what was served, kept across a restart', () => {
  it('a request that fails with 503 is not charged', async () => {
    const failing: LLMProvider = {
      id: 'deployment:llm', isConfigured: () => true,
      chat: async (_r: ChatRequest) => { throw Object.assign(new Error('cold'), { status: 503, gatewayCode: 'cold', skipRetry: true }); },
    } as never;
    const appLimits = limits();
    const server = createProxyServer({
      apiKeys: [`${PARLE}:parle`],
      providers: { chat: {}, stt: {}, tts: {}, chatRoutes: { 'parle-llm': [{ providerId: 'deployment:llm', provider: failing, model: 'm' }] } } as never,
      appLimits,
    });
    servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${PARLE}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'parle-llm', messages: [{ role: 'user', content: 'oi' }] }),
    });
    expect(res.status).toBe(503);
    expect(appLimits.usageOf('parle')).toEqual({ requests: 0, tokens: 0 });
  });

  it('the day count survives a restart and resets on the next UTC day', async () => {
    const path = join(tempDir(), 'app-budgets.json');
    const before = limits(path);
    for (let i = 0; i < 3; i++) expect(before.check('parle', 'chat', { model: 'parle-llm', messages: [] })).toBeNull();
    await before.flush();
    expect(limits(path).usageOf('parle').requests).toBe(3);
    expect(limits(path, () => DAY_START + 86_400_000).usageOf('parle').requests).toBe(0);
  });
});

describe('#22 stability reports: bounded file, bounded rate', () => {
  const report = (n: number) => ({ client: 'sdk', events: Array.from({ length: n }, (_, i) => ({ at: i, kind: 'slow', detail: 'x'.repeat(300) })) });

  it('the JSONL file is rotated at its size cap', async () => {
    const file = join(tempDir(), 'client-stability.jsonl');
    let t = 0;
    const log = new ClientStabilityLog({ file, maxFileBytes: 50_000, now: () => (t += 61_000) });
    for (let i = 0; i < 20; i++) log.append('parle', report(50));
    await log.flush();
    expect(statSync(file).size).toBeLessThanOrEqual(50_000 + 40_000);
    expect(existsSync(`${file}.1`)).toBe(true);
  });

  it('one app key flooding reports is cut off for the minute', () => {
    const log = new ClientStabilityLog();
    const accepted = Array.from({ length: 40 }, () => log.append('parle', report(1)));
    expect(accepted.filter(a => a === null).length).toBeGreaterThan(0);
    expect(log.append('other', report(1))).toBe(1);
  });
});

describe('#23 warm windows across the 2026-10-25 clock change', () => {
  it('a window without timeZone is read in Europe/Paris and stays at 18:00 local on both sides of the change', () => {
    const [entry] = warmScheduleOf([{ start: '18:00', end: '20:00', minReplicas: 1 }], 4);
    expect(entry.timeZone).toBe('Europe/Paris');
    const legacy = [{ start: '18:00', end: '20:00', minReplicas: 1 }];
    expect(scheduleFloor(legacy, Date.parse('2026-10-23T16:30:00Z'))).toBe(1);
    expect(scheduleFloor(legacy, Date.parse('2026-10-26T17:30:00Z'))).toBe(1);
    expect(scheduleFloor(legacy, Date.parse('2026-10-26T16:30:00Z'))).toBe(0);
  });

  it('the app daily budget resets at 00:00 UTC on both sides of the change', () => {
    let t = Date.parse('2026-10-24T23:59:30Z');
    const l = new AppLimits({
      env: { APP_DAILY_REQUESTS: '1' }, now: () => t, isAdmin: () => false,
      aliasesOf: () => new Set(['parle-llm']),
    });
    expect(l.check('parle', 'chat', { model: 'parle-llm', messages: [] })).toBeNull();
    expect(l.check('parle', 'chat', { model: 'parle-llm', messages: [] })).toMatchObject({ resetAt: '2026-10-25T00:00:00.000Z' });
    t = Date.parse('2026-10-25T23:59:30Z');
    expect(l.check('parle', 'chat', { model: 'parle-llm', messages: [] })).toBeNull();
    expect(l.check('parle', 'chat', { model: 'parle-llm', messages: [] })).toMatchObject({ resetAt: '2026-10-26T00:00:00.000Z' });
  });
});

