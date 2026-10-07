/**
 * Adaptive hedge of a deployment target (D4, live QA 2026-10-07): at 16 / 25 concurrent chats on one L40S the fixed
 * 1.5 s hedge fired before the busy GPU answered, so most requests ran twice (GPU + OpenRouter). Now:
 *   - `DeploymentController.hedgeDelayMs` waits max(base, recent p95 of the replica × 1.2, scaled by the queue it
 *     joins beyond the target), capped;
 *   - beyond its target a replica whose answers would be slower than the route's hedge takes nothing more: the request
 *     spills at once (`saturated`) instead of running twice;
 *   - `runTargets` reads the per-request delay (`hedgeDelay`), null = no hedge.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServeProviders, type ServeInstances } from '../../../src/config/serve-providers';
import { DeploymentController, DeploymentError, type Lease } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import { CooldownTracker } from '../../../src/gateway/providers/cloud/fallback';
import { routeRequest, type RouteTarget } from '../../../src/gateway/proxy/provider-routing';
import { FakeCloud, until } from './_fake-cloud';
import { parleRoutes } from '../gateway-routing/_parle-routes';

const controllers: DeploymentController[] = [];
const clouds: FakeCloud[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) c.stop();
  for (const c of clouds.splice(0)) await c.closeAll();
});

/** A ready one-replica deployment on a clock the test moves (target 8, capacity 12). */
async function ready() {
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const cloud = new FakeCloud(now);
  const controller = new DeploymentController({
    backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20,
    maxTotalReplicas: 6, now,
  });
  controllers.push(controller);
  clouds.push(cloud);
  await controller.init();
  controller.start();
  await controller.put('speech', { profile: 'cpu-echo', maxReplicas: 1, targetInflightPerReplica: 8 });
  controller.wake('speech');
  await until(() => controller.get('speech')!.status === 'ready');
  /** `n` requests answered in `ms` each (sequential: one in flight at a time). */
  const answered = async (n: number, ms: number) => {
    for (let i = 0; i < n; i++) {
      const lease = await controller.acquire('speech', { waitMs: 0 });
      clock.t += ms;
      lease.done(false);
    }
  };
  const hold = async (n: number) => {
    const leases: Lease[] = [];
    for (let i = 0; i < n; i++) leases.push(await controller.acquire('speech', { waitMs: 0 }));
    return leases;
  };
  return { controller, clock, answered, hold };
}

describe('DeploymentController.hedgeDelayMs', () => {
  it('no recent answers, or answers faster than the base: the base delay; hedging off: null', async () => {
    const x = await ready();
    expect(x.controller.hedgeDelayMs('speech', 1_500, 3_000)).toBe(1_500);
    expect(x.controller.hedgeDelayMs('nope', 1_500, 3_000)).toBe(1_500);
    expect(x.controller.hedgeDelayMs('speech', 0, 3_000)).toBeNull();
    await x.answered(6, 900);
    expect(x.controller.hedgeDelayMs('speech', 1_500, 3_000)).toBe(1_500); // 900 × 1.2 < 1500
  });

  it('a replica answering slower than the base: hedge only past its p95 × 1.2, capped', async () => {
    const x = await ready();
    await x.answered(6, 2_000);
    expect(x.controller.hedgeDelayMs('speech', 1_500, 3_000)).toBe(2_400);
    await x.answered(20, 4_000);
    expect(x.controller.hedgeDelayMs('speech', 1_500, 3_000)).toBe(3_000);
  });

  it('beyond the target, a request that would be slower than the hedge spills at once instead of running twice', async () => {
    const x = await ready();
    await x.answered(6, 1_800); // p95 1.8 s: a 9th request in flight would take ~2 s > 1.5 s × 1.2
    expect(x.controller.hedgeDelayMs('speech', 1_500, 3_000)).toBe(2_160); // the route's hedge is now known
    const held = await x.hold(8);
    const err = await x.controller.acquire('speech', { waitMs: 0 }).catch(e => e);
    expect(err).toBeInstanceOf(DeploymentError);
    expect(err.code).toBe('saturated');
    for (const l of held) l.done('cancelled');
  });

  it('beyond the target, a fast replica still takes requests up to its capacity, hedged late (queued for a slot soon)', async () => {
    const x = await ready();
    await x.answered(6, 1_000);
    x.controller.hedgeDelayMs('speech', 1_500, 3_000);
    const held = await x.hold(8);
    // 9th: 1000 × 9/8 = 1125 ms expected ≤ 1800: it goes to the GPU; its hedge waits for the queue it joins.
    expect(x.controller.hedgeDelayMs('speech', 1_500, 3_000)).toBe(1_500);
    held.push(await x.controller.acquire('speech', { waitMs: 0 }));
    expect(held).toHaveLength(9);
    for (const l of held) l.done('cancelled');
  });

  it('a route without adaptive hedge keeps the old routing: no latency-based spill', async () => {
    const x = await ready();
    await x.answered(6, 2_500);
    const held = await x.hold(10); // never told a hedge: up to capacity (12) as before
    expect(held).toHaveLength(10);
    for (const l of held) l.done('cancelled');
  });
});

interface Fake { providerId: string; isConfigured(): boolean; call: ReturnType<typeof vi.fn> }
const fake = (providerId: string, ms: number, v: string): Fake =>
  ({ providerId, isConfigured: () => true, call: vi.fn(() => new Promise<string>(r => setTimeout(() => r(v), ms))) });

function run(targets: Array<RouteTarget<Fake>>) {
  return routeRequest(targets, (t) => t.provider.call(), {
    stage: 'test', cooldownTracker: new CooldownTracker(), breakers: new CircuitBreakerRegistry(), timeoutMs: 5_000,
  });
}

describe('runTargets: per-request hedge delay', () => {
  it('hedgeDelay wins over hedgeAfterMs; null means no hedge (the fallback is never called while the GPU answers)', async () => {
    const dep = fake('deployment:speech', 120, 'gpu');
    const or = fake('openrouter', 10, 'cloud');
    const late = await run([{ providerId: dep.providerId, provider: dep, hedgeAfterMs: 20, hedgeDelay: () => null }, { providerId: 'openrouter', provider: or }]);
    expect(late.result).toBe('gpu');
    expect(or.call).not.toHaveBeenCalled();
    const early = await run([{ providerId: dep.providerId, provider: dep, hedgeAfterMs: 5_000, hedgeDelay: () => 20 }, { providerId: 'openrouter', provider: or }]);
    expect(early.result).toBe('cloud');
  });

  it('serve-providers wires the deployment hedge: base DEPLOYMENT_HEDGE_MS, cap 3/4 of the attempt timeout', () => {
    const calls: unknown[][] = [];
    const p = { providerId: 'x', isConfigured: () => true } as never;
    const instances: ServeInstances = { chat: { openrouter: p }, stt: { openrouter: p }, tts: { openrouter: p } };
    const { providers } = buildServeProviders({
      instances, openrouter: { state: 'valid' }, deploymentProvider: () => p, appRoutes: parleRoutes(), env: {},
      deploymentHedge: (...args) => { calls.push(args); return 2_222; },
    });
    const target = providers.chatRoutes!['parle-llm'][0];
    expect(target).toMatchObject({ hedgeAfterMs: 1_500, timeoutMs: 4_000 });
    expect(target.hedgeDelay!()).toBe(2_222);
    expect(calls).toEqual([['parle-speech', 1_500, 3_000]]);
  });
});
