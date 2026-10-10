/**
 * Live production QA 2026-10-07 (ai-gateway, `parle-speech` on one L40S, targetInflightPerReplica 8, maxReplicas 2):
 *   1. 16 concurrent non-stream chats made the ready replica `unhealthy` within seconds and the controller replaced it
 *      (~9 min boot), twice in a row. Root cause: every hedged request the OpenRouter fallback won was aborted, and the
 *      abort reached `lease.done(true)` — a "connection failure" — so 15 hedge losers were 15 strikes; a health check
 *      queued behind the LLM work counted as one more. Busy is not dead.
 *   1b. The replica count never went above 1 under 16–40 concurrent: the planner sampled `inflight` at the tick, after the
 *      hedged requests had ended and while cold ones fell back at once (waitMs 0), so the load was never seen.
 *   2. A replica still booting was released at 172 s by idle scale-down (`idleMinutes: 1`, `scaleDownDelaySeconds: 0`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentController, type ControllerOptions } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { DeploymentLLMProvider } from '../../../src/deployments/inference-providers';
import { planReplicas, desiredReplicas, type ObservedReplica } from '../../../src/deployments/planner';
import { buildSpec } from '../../../src/deployments/spec';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import type { DeploymentSpec, ProbeResult, ReplicaMachine, ReplicaProbe } from '../../../src/deployments/types';
import { FakeCloud, until } from './_fake-cloud';

const MIN = 60_000;
const NOW = 10_000_000;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

function spec(over: Partial<DeploymentSpec> = {}): DeploymentSpec {
  return { ...buildSpec('speech', { image: 'a/b:1', port: 8000 }, { profiles: new Map() }), ...over };
}

function replica(id: string, over: Partial<ObservedReplica> & { age?: number } = {}): ObservedReplica {
  const { age = 30 * MIN, ...rest } = over;
  return {
    machine: { id, deployment: 'speech', ip: '1.2.3.4', state: 'running', createdAt: NOW - age, zone: 'fr-par-2', machineType: 'L40S-1-48G', pricePerHour: 1.47 },
    everReady: true, readyNow: true, failures: 0, inflight: 0, ...rest,
  };
}

const base = { inflight: 0, waiting: 0, lastRequestAt: NOW - 10_000, aboveSince: null, now: NOW };

describe('planner: busy is not dead', () => {
  const s = spec({ minReplicas: 0, maxReplicas: 2, targetInflightPerReplica: 8, idleMinutes: 1, scaleDownDelaySeconds: 0 });
  const sick = { readyNow: false, failures: 5 };

  it('a replica that failed its probes but answered a request recently is kept', () => {
    expect(planReplicas({ ...base, spec: s, replicas: [replica('a', { ...sick, servedRecently: true })] }).release).toEqual([]);
  });

  it('a replica with requests in flight is kept whatever its probe says', () => {
    expect(planReplicas({ ...base, spec: s, inflight: 3, replicas: [replica('a', { ...sick, inflight: 3 })] }).release).toEqual([]);
  });

  it('a silent, idle replica that failed its probes is still replaced', () => {
    expect(planReplicas({ ...base, spec: s, replicas: [replica('a', sick)] }).release).toEqual([{ id: 'a', reason: 'unhealthy' }]);
  });

  it('the strike count is configurable', () => {
    const r = [replica('a', { readyNow: false, failures: 3 })];
    expect(planReplicas({ ...base, spec: s, replicas: r, unhealthyStrikes: 5 }).release).toEqual([]);
    expect(planReplicas({ ...base, spec: s, replicas: r }).release.map(x => x.reason)).toEqual(['unhealthy']);
  });
});

describe('planner: sustained load above target asks for a second replica', () => {
  const s = spec({ minReplicas: 0, maxReplicas: 2, targetInflightPerReplica: 8, idleMinutes: 1 });

  it('the recent peak demand sizes the deployment while active', () => {
    expect(desiredReplicas({ ...base, spec: s, demand: 16 })).toBe(2);
    expect(desiredReplicas({ ...base, spec: s, demand: 40 })).toBe(2); // maxReplicas
    expect(desiredReplicas({ ...base, spec: s, demand: 8 })).toBe(1);
  });

  it('an old peak never keeps an idle deployment up', () => {
    expect(desiredReplicas({ ...base, spec: s, lastRequestAt: NOW - 5 * MIN, demand: 16 })).toBe(0);
  });
});

describe('planner: a booting replica finishes its boot (released at 172 s live)', () => {
  const s = spec({ minReplicas: 0, maxReplicas: 2, idleMinutes: 1, scaleDownDelaySeconds: 0, bootTimeoutMinutes: 20 });
  // Created by earlier traffic; the last sparse request came 70 s later; 172 s into the boot the window is over.
  const booting = replica('boot', { everReady: false, readyNow: false, age: 172_000 });

  it('is not released for idleness', () => {
    const plan = planReplicas({ ...base, spec: s, lastRequestAt: NOW - 102_000, replicas: [booting] });
    expect(plan.desired).toBe(0);
    expect(plan.release).toEqual([]);
  });

  it('idle rules apply from its ready time once it is ready', () => {
    const ready = replica('boot', { readyAt: NOW - 30_000, age: 600_000 });
    expect(planReplicas({ ...base, spec: s, lastRequestAt: NOW - 400_000, replicas: [ready] }).release).toEqual([]);
    const later = replica('boot', { readyAt: NOW - 61_000, age: 631_000 });
    expect(planReplicas({ ...base, spec: s, lastRequestAt: NOW - 431_000, replicas: [later] }).release.map(r => r.reason)).toEqual(['scale-down']);
  });

  it('still goes on park, pause or boot timeout', () => {
    expect(planReplicas({ ...base, spec: s, lastRequestAt: null, replicas: [booting] }).release.map(r => r.reason)).toEqual(['scale-down']);
    expect(planReplicas({ ...base, spec: { ...s, paused: true }, replicas: [booting] }).release.map(r => r.reason)).toEqual(['paused']);
    const late = replica('boot', { everReady: false, readyNow: false, age: 21 * MIN });
    expect(planReplicas({ ...base, spec: s, replicas: [late] }).release.map(r => r.reason)).toEqual(['boot-timeout']);
  });
});

// ── Controller over a fake cloud ────────────────────────────────────────────

const controllers: DeploymentController[] = [];
const clouds: FakeCloud[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) c.stop();
  for (const c of clouds.splice(0)) await c.closeAll();
});

/** A probe whose readiness answer the test can override (`forced`), else the real HTTP probe. */
class SwitchProbe implements ReplicaProbe {
  forced: ProbeResult | null = null;
  private readonly http = new HttpReplicaProbe(1000);
  async ready(m: ReplicaMachine, s: DeploymentSpec, t: string) { return this.forced ? this.forced === 'ready' : this.http.ready(m, s, t); }
  async check(m: ReplicaMachine, s: DeploymentSpec, t: string): Promise<ProbeResult> {
    return this.forced ?? ((await this.http.ready(m, s, t)) ? 'ready' : 'down');
  }
}

async function setup(opts: Partial<ControllerOptions> = {}) {
  const cloud = new FakeCloud();
  const probe = new SwitchProbe();
  const controller = new DeploymentController({
    backend: cloud, store: new MemoryDeploymentStore(), probe, namespace: 'test', reconcileMs: 20, maxTotalReplicas: 6, ...opts,
  });
  controllers.push(controller);
  clouds.push(cloud);
  await controller.init();
  controller.start();
  return { controller, cloud, probe };
}

const SPEECH = { profile: 'cpu-echo', maxReplicas: 2, targetInflightPerReplica: 8, idleMinutes: 1, scaleDownDelaySeconds: 0 };

describe('controller: 16 concurrent chats on a ready replica', () => {
  it('hedge losers (aborted by the caller) are not strikes: the replica stays ready and is never replaced', async () => {
    const x = await setup();
    await x.controller.put('speech', { ...SPEECH, maxReplicas: 1 });
    x.controller.wake('speech');
    await until(() => x.controller.get('speech')!.status === 'ready');
    const llm = new DeploymentLLMProvider(x.controller, 'speech');
    const ask = (signal?: AbortSignal) => llm.chat({ model: 'm', messages: [{ role: 'user', content: 'oi' }], ...(signal ? { signal } : {}) });
    await ask(); // round 1 live: served by the GPU
    x.cloud.appDelayMs = 300; // round 2: the GPU answers slower than the hedge…
    x.probe.forced = 'busy'; // …and its health check queues behind the LLM work and times out
    // The fallback won after 50 ms: the route aborts every deployment attempt (provider-routing hedge).
    const calls = Array.from({ length: 16 }, () => {
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);
      return ask(abort.signal).catch(() => null);
    });
    await Promise.all(calls);
    await wait(200); // several reconciles with the health check still timing out
    expect(x.cloud.released).toEqual([]);
    expect(x.controller.get('speech')!.replicas[0].phase).toBe('ready');
    x.probe.forced = null;
    x.cloud.appDelayMs = 0;
    expect((await ask()).content).toBeDefined(); // and it still serves
  });

  it('a health check that times out while the replica works marks it busy, not unhealthy, and caps new requests', async () => {
    const x = await setup();
    await x.controller.put('speech', { ...SPEECH, maxReplicas: 1, targetInflightPerReplica: 2 });
    x.controller.wake('speech');
    await until(() => x.controller.get('speech')!.status === 'ready');
    const held = [await x.controller.acquire('speech'), await x.controller.acquire('speech')];
    x.probe.forced = 'busy';
    await until(() => x.controller.get('speech')!.replicas[0].busy);
    await wait(150);
    expect(x.cloud.released).toEqual([]);
    expect(x.controller.get('speech')!.replicas[0].phase).toBe('ready');
    // Saturated and busy: no third request on it (the chain falls back), but the two in flight finish there.
    await expect(x.controller.acquire('speech', { waitMs: 0 })).rejects.toThrow(/no ready replica|starting|at capacity/);
    for (const l of held) l.done(false);
    // Just served: still never released while its probe keeps timing out (busy grace).
    await wait(150);
    expect(x.cloud.released).toEqual([]);
    x.probe.forced = null;
    await until(() => !x.controller.get('speech')!.replicas[0].busy);
  });

  it('a silent replica whose app stopped answering is still replaced', async () => {
    const x = await setup({ busyGraceMs: 50 });
    await x.controller.put('speech', { ...SPEECH, maxReplicas: 1 });
    x.controller.wake('speech');
    await until(() => x.controller.get('speech')!.status === 'ready');
    x.probe.forced = 'busy';
    await until(() => x.cloud.releaseReasons.includes('unhealthy'), 3000);
  });

  it('a replica whose app died behind its front (every answer a 5xx) is replaced even while callers keep coming', async () => {
    const x = await setup();
    await x.controller.put('speech', { ...SPEECH, maxReplicas: 1 });
    x.controller.wake('speech');
    await until(() => x.controller.get('speech')!.status === 'ready');
    x.probe.forced = 'busy';
    let calling = true;
    const caller = (async () => {
      while (calling) {
        const lease = await x.controller.acquire('speech', { waitMs: 0 }).catch(() => null);
        lease?.done('errored');
        await wait(10);
      }
    })();
    await until(() => x.cloud.releaseReasons.includes('unhealthy'), 3000).finally(() => { calling = false; });
    await caller;
  });

  it('a burst of 16 above the target of 8 creates the second replica even after the burst ended', async () => {
    const x = await setup();
    await x.controller.put('speech', SPEECH);
    x.controller.wake('speech');
    await until(() => x.controller.get('speech')!.status === 'ready');
    expect(x.cloud.created).toHaveLength(1);
    // 12 fit (target 8 × maxInflightFactor 1.5), 4 spill to the fallback; all count as load.
    const leases = await Promise.all(Array.from({ length: 16 }, () => x.controller.acquire('speech', { waitMs: 0 }).catch(() => null)));
    expect(leases.filter(Boolean)).toHaveLength(12);
    for (const l of leases) l?.done('cancelled'); // hedged: all ended before the next tick looked
    await until(() => x.cloud.created.length === 2, 3000);
  });

  it('requests refused while every replica is saturated count as load too', async () => {
    const x = await setup();
    await x.controller.put('speech', { ...SPEECH, targetInflightPerReplica: 2 });
    x.controller.wake('speech');
    await until(() => x.controller.get('speech')!.status === 'ready');
    const held = [await x.controller.acquire('speech'), await x.controller.acquire('speech')];
    x.probe.forced = 'busy';
    await until(() => x.controller.get('speech')!.replicas.some(r => r.busy));
    for (let i = 0; i < 3; i++) await x.controller.acquire('speech', { waitMs: 0 }).catch(() => null);
    await until(() => x.cloud.created.length === 2, 3000);
    for (const l of held) l.done(false);
  });
});
