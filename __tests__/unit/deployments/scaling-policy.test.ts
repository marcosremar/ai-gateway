import { describe, expect, it } from 'vitest';
import { SimClock, SimCloud, SimProbe, L40S_MODEL } from '../../../scripts/autoscale-sim/engine';
import { DeploymentController } from '../../../src/deployments/controller';
import { episodeExcess, loadCurve, scalingDecision, type LoadSample, type ScalingInput } from '../../../src/deployments/scaling-policy';
import { holdOf, scalingOf, splitHold } from '../../../src/deployments/scaling-spec';
import { buildSpec } from '../../../src/deployments/spec';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import type { ScalingMode } from '../../../src/deployments/types';

const T0 = Date.parse('2026-10-07T08:00:00Z');
const BASE = { image: 'ghcr.io/parle/speech-stack:1', port: 8000, machineType: 'L40S-1-48G', targetInflightPerReplica: 8, maxReplicas: 4, maxEurPerHour: 2 };
const specOf = (mode: ScalingMode) => buildSpec('speech', { ...BASE, scaling: { mode } }, { profiles: new Map() });

type Point = [second: number, level: number, refused?: number, sessions?: number | null];
const traceOf = (points: Point[]): LoadSample[] => points.map(([s, level, refused = 0, sessions = null]) => ({ at: T0 + s * 1000, level, refused, sessions }));

function decide(mode: ScalingMode, points: Point[], nowSecond: number, extra: Partial<ScalingInput> = {}) {
  return scalingDecision({
    spec: specOf(mode), trace: traceOf(points), refusedHoldMs: 1500, now: T0 + nowSecond * 1000, live: 1, maxReplicas: 4,
    capNote: 'maxReplicas 4', price: 1.47, bootSeconds: 600, idleSeconds: 600, active: true, state: { highSince: null, desired: 1 }, ...extra,
  });
}

describe('scaling policy: the decision', () => {
  it('a 5 s blip of two above capacity starts nothing in economy and balanced, a replica in fast', () => {
    const blip: Point[] = [[0, 8], [1000, 10], [1005, 8]];
    expect(decide('economy', blip, 1010).desired).toBe(1);
    expect(decide('balanced', blip, 1010).desired).toBe(1);
    expect(decide('fast', blip, 1010)).toMatchObject({ desired: 2, reason: expect.stringContaining('fast: any excess') });
  });

  it('two above capacity, sustained: balanced starts after ~2.5 min, economy after ~12 min', () => {
    const excess: Point[] = [[0, 10]];
    expect(decide('balanced', excess, 140).desired).toBe(1);
    expect(decide('balanced', excess, 150)).toMatchObject({ desired: 2, reason: expect.stringContaining('€0.50 at the balanced rate') });
    expect(decide('economy', excess, 720).desired).toBe(1);
    expect(decide('economy', excess, 740).desired).toBe(2);
  });

  it('sixteen above capacity, sustained: sized to the load, economy within a minute and a half', () => {
    const klass: Point[] = [[0, 24]];
    expect(decide('balanced', klass, 20).desired).toBe(3);
    expect(decide('economy', klass, 80).desired).toBe(1);
    expect(decide('economy', klass, 100).desired).toBe(3);
  });

  it('one burst of 16 refused requests on a full replica: balanced and fast size to it, economy leaves it to the fallback', () => {
    const burst: Point[] = [[0, 8], [1000, 8, 16]];
    expect(decide('balanced', burst, 1020)).toMatchObject({ desired: 3, reason: expect.stringContaining('burst: load 24') });
    expect(decide('fast', burst, 1020).desired).toBe(3);
    expect(decide('economy', burst, 1020).desired).toBe(1);
    expect(decide('balanced', burst, 1070).desired).toBe(1);
  });

  it('the same burst every 20 s: economy pays for a replica after ~15 min of them', () => {
    const bursts: Point[] = [[0, 8], ...Array.from({ length: 60 }, (_, i): Point => [100 + i * 20, 8, 16])];
    expect(decide('economy', bursts, 100 + 10 * 60).desired).toBe(1);
    expect(decide('economy', bursts, 100 + 17 * 60).desired).toBe(2);
  });

  it('trend: sessions rising for half the trend window start a replica before the ceiling; a step does not, nor load without the session signal', () => {
    const slow: Point[] = [[0, 1, 0, 1], [90, 2, 0, 2], [180, 3, 0, 3]];
    expect(decide('balanced', slow, 200)).toMatchObject({ desired: 2, reason: expect.stringContaining('trend: sessions at 3') });
    expect(decide('economy', slow, 200).desired).toBe(1);
    const step: Point[] = [[0, 1, 0, 1], [10, 3, 0, 3], [30, 5, 0, 5]];
    expect(decide('balanced', step, 200).desired).toBe(1);
    expect(decide('balanced', slow.map(([s, level]): Point => [s, level]), 200).desired).toBe(1);
  });

  it('fast keeps one spare replica from half a replica of sessions', () => {
    expect(decide('fast', [[0, 3, 0, 3]], 100).desired).toBe(1);
    expect(decide('fast', [[0, 4, 0, 4]], 100)).toMatchObject({ desired: 2, reason: 'fast: one spare replica at load 4' });
    expect(decide('fast', [[0, 9, 0, 9]], 100, { live: 2, state: { highSince: null, desired: 2 } }).desired).toBe(3);
  });

  it('scale-in: only after the start has had its boot + idle time and the load fitted for the whole idle window', () => {
    const fell: Point[] = [[0, 24], [2000, 8]];
    const three = (startedAgo: number) => ({ live: 3, state: { highSince: T0 + (2700 - startedAgo) * 1000, desired: 3 } });
    expect(decide('balanced', fell, 2700, three(1300))).toMatchObject({ desired: 1, reason: 'low load: peak 8 in the last 10 min fits 1' });
    expect(decide('balanced', fell, 2700, three(900)).desired).toBe(3);
    expect(decide('balanced', fell, 2500, three(1300)).desired).toBe(3);
  });

  it('caps: the stricter limit wins and the reason names it; idle asks for nothing', () => {
    const capped = decide('balanced', [[0, 24]], 20, { maxReplicas: 2, capNote: 'budget.maxReplicas 2' });
    expect(capped).toMatchObject({ desired: 2, reason: expect.stringContaining('(budget.maxReplicas 2)') });
    expect(decide('fast', [[0, 24]], 20, { active: false })).toMatchObject({ desired: 0, reason: 'idle' });
  });

  it('the load curve holds a refusal for the fallback\'s answer time, and an episode ends after two quiet minutes', () => {
    const { loads } = loadCurve(traceOf([[0, 8], [10, 8, 4]]), 15, T0 + 14_000, 1500);
    expect(loads.slice(-6)).toEqual([8, 12, 12, 8, 8, 8]);
    const quietGap = [...Array(60).fill(10), ...Array(130).fill(8), ...Array(5).fill(10)];
    expect(episodeExcess(quietGap, 8)).toBe(10);
    expect(episodeExcess([...Array(60).fill(10), ...Array(100).fill(8), ...Array(5).fill(10)], 8)).toBe(130);
  });
});

describe('scaling spec', () => {
  it('validates the block, defaults the mode, and null removes it', () => {
    expect(scalingOf({})).toEqual({ mode: 'balanced' });
    expect(scalingOf({ mode: 'economy', target: { p50Ms: 1500, p95Ms: 2000 }, budget: { eurPerHour: 6, eurPerMonth: 150, maxReplicas: 6 } }))
      .toEqual({ mode: 'economy', target: { p50Ms: 1500, p95Ms: 2000 }, budget: { eurPerHour: 6, eurPerMonth: 150, maxReplicas: 6 } });
    expect(() => scalingOf({ mode: 'turbo' })).toThrow(/scaling.mode/);
    expect(() => scalingOf({ budget: { eurPerDay: 1 } })).toThrow(/unknown field 'eurPerDay'/);
    expect(() => scalingOf({ target: { p50Ms: 3000, p95Ms: 2000 } })).toThrow(/p50Ms cannot exceed/);
    expect(() => scalingOf({ budget: { maxReplicas: 1.5 } })).toThrow(/integer/);
    expect(() => scalingOf({ hold: {} })).toThrow(/unknown field 'hold'/);
    const withBlock = specOf('fast');
    expect(buildSpec('speech', { scaling: null }, { profiles: new Map(), previous: withBlock }).scaling).toBeUndefined();
    expect(buildSpec('speech', BASE, { profiles: new Map() }).scaling).toBeUndefined();
  });

  it('hold is taken out of the body and validated against maxReplicas', () => {
    expect(splitHold({ maxReplicas: 2 })).toEqual({ body: { maxReplicas: 2 } });
    expect(splitHold({ scaling: { hold: { replicas: 1, untilMinutes: 5 } } })).toEqual({ body: {}, hold: { replicas: 1, untilMinutes: 5 } });
    expect(splitHold({ scaling: { mode: 'fast', hold: null } })).toEqual({ body: { scaling: { mode: 'fast' } }, hold: null });
    expect(holdOf({ replicas: 2, untilMinutes: 30 }, 4, T0)).toEqual({ replicas: 2, until: T0 + 30 * 60_000 });
    expect(holdOf(null, 4, T0)).toBeUndefined();
    expect(() => holdOf({ replicas: 5, untilMinutes: 30 }, 4, T0)).toThrow(/0–4/);
    expect(() => holdOf({ replicas: 1, untilMinutes: 721 }, 4, T0)).toThrow(/untilMinutes/);
  });
});

async function rig(body: Record<string, unknown>, bootSeconds = 300) {
  const clock = new SimClock(T0);
  const model = { ...L40S_MODEL, bootMs: bootSeconds * 1000 };
  const cloud = new SimCloud(clock, model, () => 0);
  const store = new MemoryDeploymentStore();
  const logs: string[] = [];
  const controller = new DeploymentController({
    backend: cloud, store, probe: new SimProbe(cloud, clock, model, () => 0), namespace: 'sim', now: clock.now,
    log: msg => logs.push(msg),
  });
  await controller.init();
  await controller.put('speech', { ...BASE, coldStartWaitSeconds: 0, ...body });
  const run = async (seconds: number) => {
    for (let s = 0; s < seconds; s += 20) {
      clock.t += 20_000;
      await controller.reconcile();
      for (let i = 0; i < 50; i++) await Promise.resolve();
    }
  };
  await run(0);
  return { clock, cloud, store, controller, logs, run };
}

describe('scaling: hold, capacity and the monthly budget on the controller', () => {
  it('scaling.hold freezes the replica count for its window on a deployment with no scaling block, then the rules return', async () => {
    const r = await rig({});
    await r.controller.put('speech', { scaling: { hold: { replicas: 2, untilMinutes: 30 } } });
    await r.run(400);
    const view = r.controller.get('speech')!;
    expect(view.spec.scaling).toBeUndefined();
    expect(view.replicas.filter(x => x.phase === 'ready')).toHaveLength(2);
    expect(view.hold).toEqual({ replicas: 2, until: new Date(T0 + 30 * 60_000).toISOString() });
    expect(r.controller.capacity('speech')!.hold?.replicas).toBe(2);
    await r.run(30 * 60);
    expect(r.controller.get('speech')).toMatchObject({ hold: null, replicas: [] });
    await expect(r.controller.put('speech', { scaling: { hold: { replicas: 9, untilMinutes: 5 } } })).rejects.toThrow(/0–4/);
  });

  it('a hold caps as well as it floors, and null ends it', async () => {
    const r = await rig({ minReplicas: 2 });
    await r.run(400);
    expect(r.controller.get('speech')!.replicas).toHaveLength(2);
    await r.controller.put('speech', { scaling: { hold: { replicas: 1, untilMinutes: 60 } } });
    await r.run(400);
    expect(r.controller.get('speech')!.replicas).toHaveLength(1);
    await r.controller.put('speech', { scaling: { hold: null } });
    await r.run(40);
    expect(r.controller.get('speech')).toMatchObject({ hold: null, desiredReplicas: 2 });
  });

  it('capacity: defaults first, the boot time once the controller has seen one, the ceiling when configured', async () => {
    const r = await rig({ minReplicas: 1 });
    expect(r.controller.capacity('nope')).toBeNull();
    expect(r.controller.capacity('speech')).toEqual({
      deployment: 'speech', mode: null, target: null, budget: null, hold: null,
      capacity: [{
        machineType: 'L40S-1-48G', image: BASE.image, ceiling: { sessions: 8, source: 'default', samples: 0 },
        boot: { seconds: 600, source: 'default', samples: 0 }, resume: { seconds: 180, source: 'default', samples: 0 },
        confident: false, missing: ['ceiling', 'boot'],
      }],
    });
    await r.run(320);
    expect(r.controller.capacity('speech')!.capacity[0].boot).toEqual({ seconds: 300, source: 'measured', samples: 1 });
    expect((await r.store.load()).deployments[0].measured).toEqual({ [`L40S-1-48G|${BASE.image}`]: { boot: [300], resume: [] } });
    await r.controller.put('speech', {
      realtime: { maxSessions: 12 }, placements: [{ machineType: 'L4-1-24G' }],
      scaling: { mode: 'economy', target: { p95Ms: 2000 }, budget: { eurPerMonth: 150 } },
    });
    const view = r.controller.capacity('speech')!;
    expect(view).toMatchObject({ mode: 'economy', target: { p95Ms: 2000 }, budget: { eurPerMonth: 150, month: '2026-10', exhausted: false } });
    expect(view.capacity.map(c => [c.machineType, c.ceiling.source, c.ceiling.sessions, c.boot.source, c.missing]))
      .toEqual([['L40S-1-48G', 'configured', 12, 'measured', ['boot']], ['L4-1-24G', 'configured', 12, 'default', ['boot']]]);
  });

  it('monthly budget: the ledger is kept in the store; once spent, replicas go and a request is refused with the reason', async () => {
    const r = await rig({ minReplicas: 1, scaling: { mode: 'balanced', budget: { eurPerMonth: 0.2 } } });
    await r.run(420);
    const lease = await r.controller.acquire('speech', { waitMs: 0 });
    lease.done();
    expect((await r.store.load()).deployments[0].spend).toMatchObject({ month: '2026-10' });
    await r.run(200);
    expect(r.logs).toContain('deployments: monthly budget spent, new load goes to the fallback');
    expect(r.controller.get('speech')!.replicas).toEqual([]);
    expect(r.controller.get('speech')!.autoscale.blockedBy).toMatch(/^monthly budget spent: €0\.2\d of €0\.2 in 2026-10, new load goes to the fallback$/);
    await expect(r.controller.acquire('speech', { waitMs: 60_000 })).rejects.toThrow(/monthly budget spent: €0\.2\d of €0\.2 in 2026-10/);
    expect(r.controller.capacity('speech')!.budget).toMatchObject({ exhausted: true });
    expect(r.cloud.events.filter(e => e.type === 'create')).toHaveLength(1);
    r.clock.t = Date.parse('2026-11-01T00:00:10Z');
    await r.run(40);
    expect(r.controller.capacity('speech')!.budget).toMatchObject({ month: '2026-11', exhausted: false });
    expect(r.controller.capacity('speech')!.budget!.spentEur).toBeLessThan(0.02);
    expect(r.cloud.events.filter(e => e.type === 'create')).toHaveLength(2);
  });

  it('budget.eurPerHour and budget.maxReplicas: the stricter of them and maxReplicas is the cap', async () => {
    const sessions = { n: 30 };
    const clock = new SimClock(T0);
    const cloud = new SimCloud(clock, L40S_MODEL, () => 0);
    const controller = new DeploymentController({
      backend: cloud, store: new MemoryDeploymentStore(), probe: new SimProbe(cloud, clock, L40S_MODEL, () => 0), namespace: 'sim',
      now: clock.now, sessions: () => sessions.n,
    });
    await controller.init();
    await controller.put('speech', { ...BASE, scaling: { mode: 'fast', budget: { eurPerHour: 3, maxReplicas: 3 } } });
    controller.wake('speech');
    for (let i = 0; i < 6; i++) { clock.t += 20_000; await controller.reconcile(); for (let k = 0; k < 50; k++) await Promise.resolve(); }
    expect(cloud.events.filter(e => e.type === 'create')).toHaveLength(2);
    expect(controller.get('speech')!.autoscale.reason).toContain('(budget €3/h pays for 2 at €1.47/h)');
  });
});
