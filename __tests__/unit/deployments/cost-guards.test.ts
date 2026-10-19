/**
 * Cost and robustness guards of the deployments controller (QA 2026-10-06, `qa-4-cost` / `qa-2-stress`):
 * a stopping replica is not a halted one, parked replicas do not use the running cap, `maxHours` counts from the last
 * power-on, a failing provider list never keeps an idle replica billing, the € ceiling, the `maxReplicas` check and the
 * release of a machine whose deployment was deleted while it was created.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentController, type ControllerOptions } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { SpecError } from '../../../src/deployments/spec';
import type { CreateReplicaInput, ReplicaMachine } from '../../../src/deployments/types';
import { FakeCloud, until } from './_fake-cloud';

const controllers: DeploymentController[] = [];
const clouds: FakeCloud[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) c.stop();
  for (const c of clouds.splice(0)) await c.closeAll();
});

/** A controller on a clock the test moves (`clock.t`), over a fake cloud on the same clock. */
async function setup(opts: Partial<ControllerOptions> = {}, cloud?: FakeCloud) {
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const fake = cloud ?? new FakeCloud(now);
  const controller = new DeploymentController({
    backend: fake, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20,
    maxTotalReplicas: 6, now, ...opts,
  });
  controllers.push(controller);
  clouds.push(fake);
  await controller.init();
  controller.start();
  return { controller, cloud: fake, clock };
}

const PARKING = { profile: 'cpu-echo', idleMinutes: 1, idleAction: 'stop', maxEurPerHour: 2 };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Wakes `name`, waits until ready, then lets the idle window pass so it is parked; returns once the cloud stopped it. */
async function parkIt(x: Awaited<ReturnType<typeof setup>>, name: string, stops: number) {
  x.controller.wake(name);
  await until(() => x.controller.get(name)!.status === 'ready', 3000);
  x.clock.t += 3 * 60_000;
  await until(() => x.cloud.stops.length === stops, 3000);
}

describe('idleAction stop: a stopping replica is not halted', () => {
  it('is never deleted or replaced while the provider lists it `stopping`, and ends parked', async () => {
    const x = await setup({}, undefined);
    x.cloud.stoppingMs = 400;
    await x.controller.put('park', { ...PARKING });
    await parkIt(x, 'park', 1);
    // Several reconciles read `stopping` (in prod: ~1 min of it): that must not look like a halted replica.
    await wait(250);
    expect(x.cloud.released).toEqual([]);
    expect(x.cloud.created).toHaveLength(1);
    await until(() => x.controller.get('park')!.replicas[0]?.providerState === 'stopped', 3000);
    await wait(100);
    expect(x.cloud.released).toEqual([]);
    expect(x.cloud.created).toHaveLength(1);
    expect(x.controller.health().stopped).toBe(1);
  });

  it('a parked replica that still lists as exited right after power-on (Vast, 18/10/2026) comes back, not deleted', async () => {
    const x = await setup({}, undefined);
    await x.controller.put('park', { ...PARKING });
    await parkIt(x, 'park', 1);
    await until(() => x.controller.get('park')!.replicas[0]?.providerState === 'stopped', 3000);
    x.cloud.startLagMs = 300;
    x.controller.wake('park');
    await until(() => x.controller.get('park')!.status === 'ready', 4000);
    expect(x.cloud.starts).toHaveLength(1);
    expect(x.cloud.released).toEqual([]);
    expect(x.cloud.created).toHaveLength(1);
  });

  it('a replica adopted while `stopping` (gateway restart) is also left alone', async () => {
    const x = await setup();
    x.cloud.stoppingMs = 300;
    await x.controller.put('park', { ...PARKING });
    await parkIt(x, 'park', 1);
    // Forget what this process knows about the stop, as after a restart.
    (x.controller as unknown as { stopping: Map<string, number> }).stopping.clear();
    await wait(150);
    expect(x.cloud.released).toEqual([]);
  });
});

describe('resume deadline: a parked replica powered on that never resumes is given up (Vast, 18-19/10/2026)', () => {
  const GAVE_UP = 'deployments: resume timed out, releasing to rent a fresh replica';

  /** Parks `park`, then powers it on with a cloud that accepts the start but never resumes it (listed `state`). */
  async function resumeThatFails(state: string, opts: Partial<ControllerOptions> = {}) {
    const x = await setup(opts);
    await x.controller.put('park', { ...PARKING });
    await parkIt(x, 'park', 1);
    await until(() => x.controller.get('park')!.replicas[0]?.providerState === 'stopped', 3000);
    const parked = x.controller.get('park')!.replicas[0]!.id;
    x.cloud.resumeFailsAs = state;
    x.controller.wake('park');
    await until(() => x.cloud.starts.length === 1, 3000);
    return { ...x, parked };
  }

  it('listed exited: still starting during the grace, released as resume-timeout past the deadline, and a fresh replica serves', async () => {
    const logs: Array<[string, Record<string, unknown> | undefined]> = [];
    const x = await resumeThatFails('exited', { log: (msg, data) => logs.push([msg, data]) });
    x.clock.t += 3 * 60_000; // inside the #214 grace and the deadline (no measured resume: 2 × 180 s = 6 min)
    x.controller.wake('park');
    await wait(150);
    expect(x.cloud.released).toEqual([]);
    expect(x.cloud.created).toHaveLength(1);
    x.clock.t += 4 * 60_000; // 7 min after the power-on
    x.controller.wake('park');
    await until(() => x.cloud.releaseReasons.includes('resume-timeout'), 3000);
    expect(x.cloud.released).toEqual([x.parked]);
    await until(() => x.controller.get('park')!.status === 'ready', 3000);
    expect(x.cloud.created).toHaveLength(2);
    expect(x.cloud.starts).toHaveLength(1);
    expect(logs.find(([msg]) => msg === GAVE_UP)?.[1]).toMatchObject({ deployment: 'park', id: x.parked, deadlineSeconds: 360, state: 'exited' });
  });

  it('still listed stopped: powered on again meanwhile (counted as capacity), but the deadline counts from the first power-on', async () => {
    const x = await resumeThatFails('stopped');
    for (const n of [2, 3]) {
      x.clock.t += 2 * 60_000; // past PARKED_START_GRACE_MS: still stopped, so powered on again
      x.controller.wake('park');
      await until(() => x.cloud.starts.length === n, 3000);
    }
    // Before: powered on every 90 s for up to parkedMaxMs (72 h), never a fresh replica.
    expect(x.cloud.created).toHaveLength(1);
    expect(x.cloud.released).toEqual([]);
    x.clock.t += 3 * 60_000; // 7 min after the first power-on, 3 min after the last one
    x.controller.wake('park');
    await until(() => x.cloud.releaseReasons.includes('resume-timeout'), 3000);
    await until(() => x.controller.get('park')!.status === 'ready', 3000);
    expect(x.cloud.released).toEqual([x.parked]);
    expect(x.cloud.created).toHaveLength(2);
    expect(x.cloud.starts).toHaveLength(3);
  });

  it('a resume that serves within the deadline is kept, also long after its power-on', async () => {
    const x = await setup();
    await x.controller.put('park', { ...PARKING });
    await parkIt(x, 'park', 1);
    await until(() => x.controller.get('park')!.replicas[0]?.providerState === 'stopped', 3000);
    x.cloud.startLagMs = 300; // listed exited for a while after the power-on, then boots
    x.controller.wake('park');
    await until(() => x.cloud.starts.length === 1, 3000);
    x.clock.t += 3 * 60_000; // a slow resume, still within the deadline
    x.controller.wake('park');
    await until(() => x.controller.get('park')!.status === 'ready', 4000);
    x.clock.t += 10 * 60_000; // long past the deadline, but it served: nothing to give up
    x.controller.wake('park');
    await wait(150);
    expect(x.cloud.released).toEqual([]);
    expect(x.cloud.created).toHaveLength(1);
    expect(x.cloud.starts).toHaveLength(1);
    expect(x.controller.get('park')!.status).toBe('ready');
  });

  it('the deadline is 2 × the measured median resume, at least 4 min and at most the boot timeout', async () => {
    const x = await setup();
    await x.controller.put('park', { ...PARKING });
    type Rt = { record: { spec: { machineType: string; image: string }; measured?: Record<string, { boot: number[]; resume: number[] }> } };
    const internals = x.controller as unknown as { deployments: Map<string, Rt>; resumeDeadlineMs(rt: Rt, m: ReplicaMachine): number };
    const rt = internals.deployments.get('park')!;
    const { machineType, image } = rt.record.spec;
    const m: ReplicaMachine = { id: 'r', deployment: 'park', ip: null, state: 'exited', createdAt: x.clock.t, zone: 'fr-par-2', machineType, pricePerHour: null };
    const deadlineSeconds = (resume: number[]) => {
      rt.record.measured = { [`${machineType}|${image}`]: { boot: [], resume } };
      return internals.resumeDeadlineMs(rt, m) / 1000;
    };
    expect(deadlineSeconds([])).toBe(360); // DEFAULT_RESUME_SECONDS × 2
    expect(deadlineSeconds([115, 126, 137])).toBe(252); // the clone's 3090, measured
    expect(deadlineSeconds([60])).toBe(240); // floor: 4 min
    expect(deadlineSeconds([3_600])).toBe(15 * 60); // ceiling: cpu-echo's bootTimeoutMinutes
  });
});

describe('parked replicas and the caps', () => {
  it('a parked replica does not use a slot of the running cap', async () => {
    const x = await setup({ maxTotalReplicas: 1 });
    await x.controller.put('a', { ...PARKING });
    await parkIt(x, 'a', 1);
    await x.controller.put('b', { profile: 'cpu-echo', minReplicas: 1, maxEurPerHour: 2 });
    await until(() => x.controller.get('b')!.status === 'ready', 3000);
    expect(x.controller.get('b')!.lastError).toBeNull();
    expect(x.cloud.created).toHaveLength(2);
    expect(x.cloud.released).toEqual([]);
    expect(x.controller.health()).toMatchObject({ running: 1, stopped: 1, maxReplicas: 1 });
  });

  it('powering a parked replica on still respects the running cap', async () => {
    const x = await setup({ maxTotalReplicas: 1 });
    await x.controller.put('a', { ...PARKING });
    await parkIt(x, 'a', 1);
    await x.controller.put('b', { profile: 'cpu-echo', minReplicas: 1, maxEurPerHour: 2 });
    await until(() => x.controller.get('b')!.status === 'ready', 3000);
    x.controller.wake('a');
    await wait(150);
    expect(x.cloud.starts).toEqual([]);
    expect(x.controller.get('a')!.lastError).toMatch(/replica cap reached/);
  });

  it('parked replicas have their own cap (DEPLOYMENTS_MAX_STOPPED): past it, idle deletes instead of parking', async () => {
    const x = await setup({ maxStoppedReplicas: 1 });
    await x.controller.put('a', { ...PARKING });
    await x.controller.put('b', { ...PARKING });
    await parkIt(x, 'a', 1);
    x.controller.wake('b');
    await until(() => x.controller.get('b')!.status === 'ready', 3000);
    x.clock.t += 3 * 60_000;
    await until(() => x.cloud.released.length === 1, 3000);
    expect(x.cloud.stops).toHaveLength(1);
    expect(x.controller.health().stopped).toBe(1);
  });

  it('a parked replica nobody used for parkedMaxMs is released (a forgotten park bills its disk)', async () => {
    const x = await setup({ parkedMaxMs: 6 * 3_600_000 });
    await x.controller.put('a', { ...PARKING });
    await parkIt(x, 'a', 1);
    await wait(100);
    expect(x.cloud.released).toEqual([]);
    x.clock.t += 7 * 3_600_000;
    await until(() => x.cloud.released.length === 1, 3000);
    expect(x.cloud.releaseReasons).toEqual(['parked-too-long']);
  });
});

describe('maxHours counts from the last power-on', () => {
  it('a parked replica older than maxHours is not thrown away right after it boots again', async () => {
    const x = await setup({ parkedMaxMs: 0 });
    await x.controller.put('a', { ...PARKING, maxHours: 12 });
    await parkIt(x, 'a', 1);
    x.clock.t += 13 * 3_600_000; // parked a whole night: older than maxHours since creation, 0 h since power-on
    x.controller.wake('a');
    await until(() => x.controller.get('a')!.status === 'ready', 3000);
    await wait(150);
    expect(x.cloud.starts).toHaveLength(1);
    expect(x.cloud.released).toEqual([]);
    // ...and once it has run maxHours since the power-on, it is replaced as usual.
    x.clock.t += 12 * 3_600_000 + 1;
    x.controller.wake('a');
    await until(() => x.cloud.releaseReasons.includes('max-hours'), 3000);
  });
});

describe('a failing provider list', () => {
  it('still releases an idle replica (the controller is blind, not paralysed)', async () => {
    const x = await setup();
    await x.controller.put('d', { profile: 'cpu-echo', idleMinutes: 1, maxEurPerHour: 2 });
    x.controller.wake('d');
    await until(() => x.controller.get('d')!.status === 'ready', 3000);
    x.cloud.failList = true;
    x.clock.t += 3 * 60_000;
    await until(() => x.cloud.released.length === 1, 3000);
    expect(x.cloud.created).toHaveLength(1); // and never a create while blind
  });

  it('never creates while the list fails', async () => {
    const blind = new FakeCloud();
    blind.failList = true; // from the very first reconcile
    const x = await setup({}, blind);
    await x.controller.put('d', { profile: 'cpu-echo', minReplicas: 1, maxEurPerHour: 2 });
    await wait(200);
    expect(x.cloud.created).toEqual([]);
  });
});

describe('spend ceiling (DEPLOYMENTS_MAX_EUR_PER_HOUR)', () => {
  it('refuses the create that would pass it, says so in lastError and shows the burn in health', async () => {
    const x = await setup({ maxEurPerHour: 2.5 });
    x.cloud.price = 1;
    await x.controller.put('big', { profile: 'cpu-echo', minReplicas: 3, maxReplicas: 3, maxEurPerHour: 2 });
    await until(() => (x.controller.get('big')!.lastError ?? '').includes('spend ceiling'), 3000);
    await wait(100);
    expect(x.cloud.created).toHaveLength(2);
    expect(x.controller.get('big')!.lastError).toMatch(/€2\/h.*€1\/h.*€2\.5\/h ceiling.*DEPLOYMENTS_MAX_EUR_PER_HOUR/);
    expect(x.controller.health()).toMatchObject({ eurPerHour: 2, maxEurPerHour: 2.5, running: 2 });
  });

  it('parked replicas do not count toward the burn', async () => {
    const x = await setup({ maxEurPerHour: 1.2 });
    x.cloud.price = 1;
    await x.controller.put('a', { ...PARKING });
    await parkIt(x, 'a', 1);
    await until(() => x.controller.health().eurPerHour === 0, 3000); // listed `stopped` (while `stopping` it still bills)
    await x.controller.put('b', { profile: 'cpu-echo', minReplicas: 1, maxEurPerHour: 2 });
    await until(() => x.controller.get('b')!.status === 'ready', 3000);
    expect(x.controller.health().eurPerHour).toBe(1);
  });
});

describe('PUT maxReplicas above the global cap', () => {
  it('is refused with the cap in the message', async () => {
    const x = await setup({ maxTotalReplicas: 4 });
    await expect(x.controller.put('x', { profile: 'cpu-echo', maxReplicas: 8 })).rejects.toThrow(SpecError);
    await expect(x.controller.put('x', { profile: 'cpu-echo', maxReplicas: 8 })).rejects.toThrow(/cap of 4 across all deployments/);
    expect(x.controller.get('x')).toBeNull();
    await x.controller.put('x', { profile: 'cpu-echo', maxReplicas: 4 });
    expect(x.controller.get('x')!.spec.maxReplicas).toBe(4);
  });
});

/** The server exists but the provider refuses to delete it while it is still being set up (`resource_still_in_use`). */
class BusyCreateCloud extends FakeCloud {
  finish: (() => void) | null = null;
  releaseAttempts = 0;
  override async createReplica(input: CreateReplicaInput): Promise<ReplicaMachine> {
    const made = await super.createReplica(input);
    input.onCreated?.(made.id);
    await new Promise<void>((r) => { this.finish = r; });
    return made;
  }
  override async releaseReplica(machine: ReplicaMachine, reason?: string): Promise<void> {
    if (++this.releaseAttempts <= 2) throw new Error('scaleway HTTP 400 precondition_failed resource_still_in_use');
    return super.releaseReplica(machine, reason);
  }
}

describe('DELETE while a replica is being created', () => {
  it('retries the release when the create ends, instead of leaving the server to the next orphan sweep', async () => {
    const cloud = new BusyCreateCloud();
    // The reconcile tick is far away: only the retry in the create itself can remove the server in time.
    const x = await setup({ reconcileMs: 600_000, releaseRetryMs: 10 }, cloud);
    await x.controller.put('gone', { profile: 'cpu-echo', minReplicas: 1, maxEurPerHour: 2 });
    await until(() => cloud.finish !== null);
    await x.controller.remove('gone');
    cloud.finish!();
    await until(() => cloud.machines.size === 0, 2000);
    expect(cloud.releaseAttempts).toBe(3);
  });
});

describe('the replica cap keeps the floor of every deployment (vast stress D6)', () => {
  it('a burst above its own floor leaves the slot another deployment needs for its minReplicas', async () => {
    const cloud = new FakeCloud();
    const controller = new DeploymentController({
      backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20,
      maxTotalReplicas: 2,
    });
    controllers.push(controller);
    clouds.push(cloud);
    await controller.init();
    await controller.put('burst', { profile: 'cpu-echo', maxReplicas: 2, maxEurPerHour: 2, scaling: { hold: { replicas: 2, untilMinutes: 60 } } });
    await controller.put('kept', { profile: 'cpu-echo', minReplicas: 1, maxEurPerHour: 2 });
    controller.start();
    await until(() => controller.get('kept')!.status === 'ready', 3000);
    await wait(150);
    expect(cloud.created.map(c => c.spec.name).sort()).toEqual(['burst', 'kept']);
    expect(controller.get('burst')!.lastError).toMatch(/replica cap reached/);
  });

  it('a deployment below its own floor still fills it up to the cap', async () => {
    const x = await setup({ maxTotalReplicas: 2 });
    await x.controller.put('kept', { profile: 'cpu-echo', minReplicas: 1, maxEurPerHour: 2, paused: true });
    await x.controller.put('own', { profile: 'cpu-echo', minReplicas: 2, maxReplicas: 2, maxEurPerHour: 2 });
    await until(() => x.cloud.created.length === 2, 3000);
    expect(x.cloud.created.map(c => c.spec.name)).toEqual(['own', 'own']);
  });
});
