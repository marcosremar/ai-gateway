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
