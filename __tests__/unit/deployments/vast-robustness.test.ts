import { createServer, type AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { connectRttOnce, probeConnectRtt } from '../../../src/gateway/providers/gpu/rtt-probe';
import { DeploymentController, type ControllerOptions } from '../../../src/deployments/controller';
import { DeploymentError } from '../../../src/deployments/controller-state';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { missingImage, parseImage } from '../../../src/deployments/image-check';
import { planReplicas, VAST_MIN_BOOT_TIMEOUT_MINUTES, type ObservedReplica } from '../../../src/deployments/planner';
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';
import { buildSpec } from '../../../src/deployments/spec';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import type { CreditIssue, DeploymentSpec, ProbeResult, ReplicaMachine, ReplicaProbe } from '../../../src/deployments/types';
import { VastDeploymentBackend } from '../../../src/deployments/vast-backend';
import { getLogContext, withLogContext } from '../../../src/logger';
import { FakeCloud, until } from './_fake-cloud';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const MIN = 60_000;
const profiles = new Map(BUILTIN_PROFILES.map(p => [p.name, p]));
const llm = buildSpec('llm', {
  provider: 'vast', image: 'ghcr.io/ggml-org/llama.cpp:server-cuda-b11382', bootScript: 'exec /app/llama-server', port: 8000,
  machineType: 'RTX 3090', maxEurPerHour: 0.22,
}, { profiles });
const input = { spec: llm, replicaToken: TOKEN, cloudInit: '', namespace: 'stress' };

const controllers: DeploymentController[] = [];
const clouds: FakeCloud[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) c.stop();
  for (const c of clouds.splice(0)) await c.closeAll();
});

async function make(cloud: FakeCloud, opts: Partial<ControllerOptions> = {}): Promise<DeploymentController> {
  const controller = new DeploymentController({
    backends: { [cloud.provider]: cloud }, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test',
    reconcileMs: 20, ...opts,
  });
  await controller.init();
  controller.start();
  controllers.push(controller);
  clouds.push(cloud);
  return controller;
}

function vastFetch(opts: { credit?: number; offers: object[] }) {
  const puts: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.endsWith('/users/current/')) return new Response(JSON.stringify(opts.credit === undefined ? {} : { credit: opts.credit }));
    if (method === 'POST') return new Response(JSON.stringify({ offers: opts.offers }));
    if (method === 'PUT') { puts.push(url); return new Response(JSON.stringify({ success: true, new_contract: 900 + puts.length })); }
    return new Response('{}');
  };
  return { puts, fetchImpl };
}

const offer = (id: number, extra: object = {}) => ({
  id, machine_id: 100 + id, geolocation: 'Paris, FR', dph_total: 0.15 + id / 100, reliability2: 0.99, inet_down: 900, gpu_name: 'RTX 3090', ...extra,
});

function rejectsWithin<T>(p: Promise<T>, ms: number): Promise<unknown> {
  return Promise.race([
    p.then(() => { throw new Error('resolved'); }, (err: unknown) => err),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms)),
  ]);
}

describe('V5: the RTT gate under load', () => {
  it('the backend remembers the quietest baseline and reports it next to a loaded one', async () => {
    const samples = [31, 143];
    const backend = new VastDeploymentBackend('k', { fetch: vastFetch({ offers: [] }).fetchImpl, rtt: async () => samples.shift() ?? null });
    expect(await backend.measureBaselineRtt('FR')).toEqual({ anchor: 's3.fr-par.scw.cloud', rttMs: 31, quietMs: 31 });
    expect(await backend.measureBaselineRtt('FR')).toEqual({ anchor: 's3.fr-par.scw.cloud', rttMs: 143, quietMs: 31 });
  });

  it('a host that passes only because the baseline was measured under load serves but is not remembered as good', async () => {
    const cloud = new FakeCloud(Date.now, 'vast');
    cloud.marketPriced = true;
    cloud.measureRtt = async () => 144;
    cloud.measureBaselineRtt = async () => ({ anchor: 's3.fr-par.scw.cloud', rttMs: 143, quietMs: 31 });
    const remembered: number[] = [];
    cloud.recordRtt = (_m, rtt) => { remembered.push(rtt); };
    const controller = await make(cloud);
    await controller.put('gpu', { image: 'a/b:1', bootScript: 'serve', port: 8010, provider: 'vast', machineType: 'RTX 3090', minReplicas: 1 });
    await until(() => controller.get('gpu')!.status === 'ready');
    expect(remembered).toEqual([]);
    expect(controller.get('gpu')!.lastPlacement).toMatch(/baseline 31 ms when quiet: measured under load, not remembered as a good host\): kept$/);
  });

  it('a quiet measurement is remembered as before', async () => {
    const cloud = new FakeCloud(Date.now, 'vast');
    cloud.marketPriced = true;
    cloud.measureRtt = async () => 42;
    cloud.measureBaselineRtt = async () => ({ anchor: 's3.fr-par.scw.cloud', rttMs: 45, quietMs: 40 });
    const remembered: number[] = [];
    cloud.recordRtt = (_m, rtt) => { remembered.push(rtt); };
    const controller = await make(cloud);
    await controller.put('gpu', { image: 'a/b:1', bootScript: 'serve', port: 8010, provider: 'vast', machineType: 'RTX 3090', minReplicas: 1 });
    await until(() => controller.get('gpu')!.status === 'ready');
    expect(remembered).toEqual([42]);
  });
});

describe('V6: probe the host before renting it', () => {
  const offers = [offer(1, { public_ipaddr: '5.5.5.1', direct_port_start: 40000 }), offer(2, { public_ipaddr: '5.5.5.2', direct_port_start: 40000 })];

  it('an offer whose host answers far above the baseline is skipped and avoided; the near one is rented', async () => {
    const { puts, fetchImpl } = vastFetch({ offers });
    const probes: string[] = [];
    const backend = new VastDeploymentBackend('k', {
      fetch: fetchImpl, rtt: async () => 31,
      preRentRtt: async (host, port) => { probes.push(`${host}:${port}`); return host === '5.5.5.1' ? 70 : 33; },
    });
    const m = await backend.createReplica(input);
    expect(probes.sort()).toEqual(['5.5.5.1:40000', '5.5.5.2:40000']);
    expect(puts).toEqual([expect.stringContaining('/asks/2/')]);
    expect(m.id).toBe('901');
    expect(backend.avoidedHosts()).toEqual([101]);
  });

  it('every offer far before renting: nothing rented, out_of_stock with the measures', async () => {
    const { puts, fetchImpl } = vastFetch({ offers });
    const backend = new VastDeploymentBackend('k', { fetch: fetchImpl, rtt: async () => 31, preRentRtt: async () => 90 });
    await expect(backend.createReplica(input)).rejects.toThrow(/out_of_stock: every vast offer tried is too far before renting .*RTT 90 ms, baseline 31 ms/);
    expect(puts).toEqual([]);
  });

  it('the pre-rent probe times the TCP answer, a refusal included, and gives up on a network that answers for any address', async () => {
    const server = createServer(socket => socket.destroy());
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const open = (server.address() as AddressInfo).port;
    try {
      expect(await connectRttOnce('127.0.0.1', open)).toEqual(expect.any(Number));
      expect(await probeConnectRtt('127.0.0.1', open, 3, 1000)).toEqual(expect.any(Number));
      expect(await probeConnectRtt('127.0.0.1', open, 3, 1000, { canaryIp: '127.0.0.1' })).toBeNull();
    } finally {
      await new Promise(r => server.close(r));
    }
    expect(await connectRttOnce('127.0.0.1', open)).toEqual(expect.any(Number));
  });

  it('a host that does not answer the probe is rented as before (the gate after boot decides)', async () => {
    const { puts, fetchImpl } = vastFetch({ offers });
    const backend = new VastDeploymentBackend('k', { fetch: fetchImpl, rtt: async () => 31, preRentRtt: async () => null });
    await backend.createReplica(input);
    expect(puts).toEqual([expect.stringContaining('/asks/1/')]);
  });
});

describe('V7: the Vast boot deadline covers a large image pull', () => {
  const spec = buildSpec('speech', { image: 'a/b:1', port: 8000, bootTimeoutMinutes: 20 }, { profiles: new Map() });
  const booting = (provider: 'vast' | 'scaleway', ageMin: number): ObservedReplica => ({
    machine: { id: provider, deployment: 'speech', ip: '1.2.3.4', state: 'starting', createdAt: -ageMin * MIN, zone: '', machineType: 'x', pricePerHour: 1, provider },
    everReady: false, readyNow: false, failures: 0, inflight: 0,
  });
  const plan = (r: ObservedReplica) => planReplicas({ spec, replicas: [r], inflight: 0, waiting: 0, lastRequestAt: -MIN, aboveSince: null, now: 0 }).release;

  it(`a Vast replica gets at least ${VAST_MIN_BOOT_TIMEOUT_MINUTES} min, a Scaleway one keeps the spec's`, () => {
    expect(plan(booting('vast', 21))).toEqual([]);
    expect(plan(booting('vast', VAST_MIN_BOOT_TIMEOUT_MINUTES))).toEqual([{ id: 'vast', reason: 'boot-timeout' }]);
    expect(plan(booting('scaleway', 21))).toEqual([{ id: 'scaleway', reason: 'boot-timeout' }]);
  });

  it('the Vast machine is told the same deadline (boot checks, signed file links)', async () => {
    const cloud = new FakeCloud(Date.now, 'vast');
    cloud.marketPriced = true;
    const controller = await make(cloud);
    await controller.put('gpu', { image: 'a/b:1', bootScript: 'serve', port: 8010, provider: 'vast', machineType: 'RTX 3090', minReplicas: 1, bootTimeoutMinutes: 20 });
    await until(() => cloud.created.length === 1);
    expect(cloud.created[0].spec.bootTimeoutMinutes).toBe(VAST_MIN_BOOT_TIMEOUT_MINUTES);
    expect(controller.specOf('gpu')!.bootTimeoutMinutes).toBe(20);
  });
});

describe('V8: Vast credit', () => {
  it('below the floor: no rent, a terminal error, one alert line, and the issue visible until the credit is back', async () => {
    const state = { credit: 0.4 };
    const { puts, fetchImpl } = vastFetch({ offers: [offer(1)] });
    const logs: Array<[string, Record<string, unknown> | undefined]> = [];
    const backend = new VastDeploymentBackend('k', {
      fetch: async (url, init) => (url.endsWith('/users/current/') ? new Response(JSON.stringify({ credit: state.credit })) : fetchImpl(url, init)),
      minCreditUsd: 1, log: (msg, data) => logs.push([msg, data]),
    });
    await expect(backend.createReplica(input)).rejects.toThrow(/^insufficient_credit: Vast credit \$0\.40 is below the floor \$1/);
    await expect(backend.createReplica(input)).rejects.toThrow(/insufficient_credit/);
    expect(puts).toEqual([]);
    expect(logs.filter(([m]) => m === 'deployments: provider credit exhausted')).toEqual([
      ['deployments: provider credit exhausted', expect.objectContaining({ provider: 'vast', balanceUsd: 0.4, floorUsd: 1 })],
    ]);
    expect(backend.creditIssue()).toMatchObject({ provider: 'vast', balanceUsd: 0.4, floorUsd: 1 });
    state.credit = 5;
    await backend.createReplica(input);
    expect(puts).toHaveLength(1);
    expect(backend.creditIssue()).toBeNull();
  });

  it('a rent refused for insufficient_credit is recorded as the same issue', async () => {
    const backend = new VastDeploymentBackend('k', {
      fetch: async (url, init) => ((init?.method ?? 'GET') === 'POST' ? new Response(JSON.stringify({ offers: [offer(1)] }))
        : init?.method === 'PUT' ? new Response('{"success":false,"error":"insufficient_credit"}', { status: 400 }) : new Response('{}')),
    });
    await expect(backend.createReplica(input)).rejects.toThrow(/insufficient_credit: Vast refused the rent/);
    expect(backend.creditIssue()).toMatchObject({ provider: 'vast', balanceUsd: null });
  });

  it('a Vast place without credit is skipped and the next place of the ladder is tried', async () => {
    const vast = new FakeCloud(Date.now, 'vast');
    vast.marketPriced = true;
    vast.failCreate = 'insufficient_credit: Vast refused the rent: insufficient_credit; top up the Vast account';
    const scaleway = new FakeCloud();
    clouds.push(vast);
    const controller = await make(scaleway, { backends: { vast, scaleway } });
    await controller.put('gpu', {
      image: 'a/b:1', bootScript: 'serve', port: 8010, minReplicas: 1,
      candidates: [
        { provider: 'vast', machineType: 'RTX 3090', maxEurPerHour: 1 },
        { zone: 'pl-waw-2', machineType: 'L4-1-24G', maxEurPerHour: 1 },
      ],
    });
    await until(() => controller.get('gpu')!.status === 'ready');
    expect(scaleway.created).toHaveLength(1);
    expect(controller.get('gpu')!.lastPlacement).toMatch(/insufficient_credit/);
  });

  it('the controller answers 503 at once instead of holding callers, and lists the issue for /health', async () => {
    const cloud = new FakeCloud(Date.now, 'vast');
    cloud.marketPriced = true;
    cloud.failCreate = 'insufficient_credit: Vast credit $0.40 is below the floor $1 (VAST_MIN_CREDIT_USD); top up the Vast account';
    const issue: CreditIssue = { provider: 'vast', message: 'below the floor', balanceUsd: 0.4, floorUsd: 1, since: 1, at: 1 };
    Object.assign(cloud, { creditIssue: () => issue });
    const controller = await make(cloud);
    await controller.put('gpu', { image: 'a/b:1', bootScript: 'serve', port: 8010, provider: 'vast', machineType: 'RTX 3090', minReplicas: 1 });
    await until(() => /insufficient_credit/.test(controller.get('gpu')!.lastError ?? ''));
    const err = await rejectsWithin(controller.acquire('gpu'), 2000);
    expect(err).toBeInstanceOf(DeploymentError);
    expect((err as DeploymentError).status).toBe(503);
    expect((err as DeploymentError).message).toMatch(/insufficient_credit/);
    expect((err as DeploymentError).retryAfterSeconds).toBeGreaterThan(500);
    expect(controller.creditIssues()).toEqual([issue]);
  });
});

class SwitchProbe implements ReplicaProbe {
  forced: ProbeResult | null = null;
  private readonly http = new HttpReplicaProbe(1000);
  async ready(m: ReplicaMachine, s: DeploymentSpec, t: string) { return this.forced ? this.forced === 'ready' : this.http.ready(m, s, t); }
  async check(m: ReplicaMachine, s: DeploymentSpec, t: string): Promise<ProbeResult> {
    return this.forced ?? ((await this.http.ready(m, s, t)) ? 'ready' : 'down');
  }
}

describe('V9: losing the only ready replica', () => {
  it('callers get 503 + Retry-After at once (they fall back) instead of waiting for the replacement', async () => {
    const cloud = new FakeCloud();
    const controller = await make(cloud);
    await controller.put('echo', { profile: 'cpu-echo', minReplicas: 1 });
    await until(() => controller.get('echo')!.status === 'ready');
    cloud.bootMs = 60_000;
    const [lost] = cloud.machines.values();
    await cloud.releaseReplica(lost.machine);
    await until(() => cloud.created.length === 2);
    const err = await rejectsWithin(controller.acquire('echo'), 2000);
    expect(err).toMatchObject({ status: 503, retryAfterSeconds: 30 });
    expect((err as Error).message).toMatch(/ready replica was lost/);
  });

  it('only 5xx since the last good answer: the replica is replaced after a short grace, not the 2-minute busy grace', async () => {
    let offset = 0;
    const clock = () => Date.now() + offset;
    const cloud = new FakeCloud();
    const probe = new SwitchProbe();
    const controller = await make(cloud, { probe, now: clock });
    await controller.put('echo', { profile: 'cpu-echo', minReplicas: 1, maxReplicas: 1 });
    await until(() => controller.get('echo')!.status === 'ready');
    (await controller.acquire('echo')).done('ok');
    cloud.bootMs = 60_000;
    probe.forced = 'busy';
    (await controller.acquire('echo')).done('errored');
    offset += 25_000;
    await until(() => cloud.releaseReasons.includes('unhealthy'), 3000);
    probe.forced = null;
    expect(await rejectsWithin(controller.acquire('echo'), 2000)).toMatchObject({ status: 503, retryAfterSeconds: 30 });
  });
});

describe('V10: labels', () => {
  const spec = buildSpec('speech', { image: 'a/b:1', port: 8000, bootTimeoutMinutes: 20 }, { profiles: new Map() });

  it('an adopted replica already past its boot window that never answers is unhealthy (the app died), not a boot timeout', () => {
    const r: ObservedReplica = {
      machine: { id: 'a', deployment: 'speech', ip: '1.2.3.4', state: 'running', createdAt: -60 * MIN, zone: '', machineType: 'x', pricePerHour: 1 },
      everReady: false, readyNow: false, failures: 0, inflight: 0, bootStartedAt: -21 * MIN, adoptedPastBoot: true,
    };
    const release = planReplicas({ spec, replicas: [r], inflight: 0, waiting: 0, lastRequestAt: -MIN, aboveSince: null, now: 0 }).release;
    expect(release).toEqual([{ id: 'a', reason: 'unhealthy' }]);
  });

  it('an adopted replica logs ready without a boot time (its age is not a boot)', async () => {
    const cloud = new FakeCloud();
    const store = new MemoryDeploymentStore();
    const first = await make(cloud, { store });
    await first.put('echo', { profile: 'cpu-echo', minReplicas: 1 });
    await until(() => first.get('echo')!.status === 'ready');
    first.stop();
    const logs: Array<Record<string, unknown> | undefined> = [];
    await make(cloud, { store, log: (msg, data) => { if (msg === 'deployments: replica ready') logs.push(data); } });
    await until(() => logs.length === 1);
    expect(logs[0]).toMatchObject({ deployment: 'echo', bootMs: null, adopted: true });
  });

  it('the controller loop never carries the log context of the request that woke it', async () => {
    const cloud = new FakeCloud();
    const contexts: unknown[] = [];
    const controller = await make(cloud, { reconcileMs: 60_000, log: () => { contexts.push(getLogContext()); } });
    await new Promise(r => setTimeout(r, 50));
    contexts.length = 0;
    await withLogContext({ requestId: 'req-1' }, () => controller.put('echo', { profile: 'cpu-echo', minReplicas: 1 }));
    await until(async () => {
      await withLogContext({ requestId: 'req-2' }, () => controller.reconcile());
      return controller.get('echo')!.status === 'ready';
    });
    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts.filter(Boolean)).toEqual([]);
  });
});

describe('V11: cold callers and missing images', () => {
  it('a cold call whose measured boot ends after its wait gets 503 + Retry-After at once', async () => {
    const cloud = new FakeCloud();
    cloud.bootMs = 60_000;
    const controller = await make(cloud);
    await controller.put('echo', { profile: 'cpu-echo', minReplicas: 0 });
    const internals = controller as unknown as { deployments: Map<string, { record: { measured?: Record<string, { boot: number[]; resume: number[] }> } }> };
    const spec = controller.specOf('echo')!;
    internals.deployments.get('echo')!.record.measured = { [`${spec.machineType}|${spec.image}`]: { boot: [300, 300, 300], resume: [] } };
    const err = await rejectsWithin(controller.acquire('echo'), 2000);
    expect(err).toMatchObject({ status: 503 });
    expect((err as DeploymentError).retryAfterSeconds).toBeGreaterThan(240);
    expect((err as Error).message).toMatch(/measured boot time/);
  });

  it('parses image references like Docker does', () => {
    expect(parseImage('ghcr.io/ggml-org/llama.cpp:server-cuda-b11382')).toEqual({ registry: 'ghcr.io', repo: 'ggml-org/llama.cpp', reference: 'server-cuda-b11382' });
    expect(parseImage('ubuntu')).toEqual({ registry: 'registry-1.docker.io', repo: 'library/ubuntu', reference: 'latest' });
    expect(parseImage('traefik/whoami:v1.10')).toEqual({ registry: 'registry-1.docker.io', repo: 'traefik/whoami', reference: 'v1.10' });
    expect(parseImage('localhost:5000/a/b@sha256:abc')).toEqual({ registry: 'localhost:5000', repo: 'a/b', reference: 'sha256:abc' });
  });

  function registry(status: number, opts: { basicOnly?: boolean } = {}) {
    const calls: Array<{ url: string; authorization?: string }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      calls.push({ url, ...(authorization ? { authorization } : {}) });
      if (url.includes('/token?')) return new Response(JSON.stringify({ token: 't0k' }));
      if (!authorization) {
        const challenge = opts.basicOnly ? 'Basic realm="registry"' : 'Bearer realm="https://reg.example/token",service="reg.example",scope="repository:a/b:pull"';
        return new Response(null, { status: 401, headers: { 'www-authenticate': challenge } });
      }
      return new Response(null, { status });
    };
    return { calls, fetchImpl };
  }

  it('a tag the registry does not have is reported, through the anonymous token dance', async () => {
    const { calls, fetchImpl } = registry(404);
    expect(await missingImage('reg.example/a/b:nope', null, fetchImpl)).toMatch(/image reg\.example\/a\/b:nope does not exist: reg\.example has no manifest for a\/b:nope/);
    expect(calls.map(c => c.url)).toEqual([
      'https://reg.example/v2/a/b/manifests/nope',
      'https://reg.example/token?service=reg.example&scope=repository%3Aa%2Fb%3Apull',
      'https://reg.example/v2/a/b/manifests/nope',
    ]);
    expect(calls[2].authorization).toBe('Bearer t0k');
  });

  it('an existing image passes; credentials go to the token endpoint; an unreachable registry never blocks', async () => {
    const { calls, fetchImpl } = registry(200);
    expect(await missingImage('reg.example/a/b:1', { server: 'reg.example', username: 'nologin', password: 'ro' }, fetchImpl)).toBeNull();
    expect(calls[1].authorization).toBe(`Basic ${Buffer.from('nologin:ro').toString('base64')}`);
    expect(await missingImage('reg.example/a/b:1', null, async () => { throw new Error('ENOTFOUND'); })).toBeNull();
    expect(await missingImage('', null, fetchImpl)).toBeNull();
  });

  it('PUT refuses an image that does not exist, and does not ask again for an unchanged image', async () => {
    const asked: string[] = [];
    const cloud = new FakeCloud();
    const controller = await make(cloud, {
      checkImage: async (image) => { asked.push(image); return image.endsWith(':missing') ? `image ${image} does not exist` : null; },
    });
    await expect(controller.put('echo', { profile: 'cpu-echo', image: 'a/b:missing' })).rejects.toThrow(/image a\/b:missing does not exist/);
    expect(controller.get('echo')).toBeNull();
    await controller.put('echo', { profile: 'cpu-echo', image: 'a/b:1' });
    await controller.put('echo', { profile: 'cpu-echo', image: 'a/b:1', minReplicas: 0 });
    expect(asked).toEqual(['a/b:missing', 'a/b:1']);
  });
});
