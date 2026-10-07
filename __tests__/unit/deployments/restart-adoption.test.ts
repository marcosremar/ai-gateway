/**
 * A gateway restart with a scale-to-zero replica running, and a parked replica the provider cannot power on.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentController } from '../../../src/deployments/controller';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import type { DeploymentStore } from '../../../src/deployments/types';
import { FakeCloud, until } from './_fake-cloud';

const SPEC = { profile: 'cpu-echo', minReplicas: 0, idleMinutes: 1, idleAction: 'stop' };

let now = 0;
const clouds: FakeCloud[] = [];
afterEach(async () => { for (const c of clouds.splice(0)) await c.closeAll(); });

function controllerOn(store: DeploymentStore, cloud: FakeCloud): DeploymentController {
  return new DeploymentController({ backend: cloud, store, probe: { ready: async () => true }, namespace: 'test', now: () => now });
}

async function readyReplica(store: DeploymentStore, cloud: FakeCloud, spec: Record<string, unknown> = SPEC): Promise<DeploymentController> {
  const controller = controllerOn(store, cloud);
  await controller.init();
  await controller.put('rt', spec);
  controller.wake('rt');
  await until(async () => { await controller.reconcile(); return controller.get('rt')!.status === 'ready'; });
  return controller;
}

function setup(): { store: MemoryDeploymentStore; cloud: FakeCloud } {
  now = 1_000_000;
  const cloud = new FakeCloud(() => now);
  clouds.push(cloud);
  return { store: new MemoryDeploymentStore(), cloud };
}

describe('gateway restart with a scale-to-zero replica running', () => {
  it('a deployment used through wake() keeps its replica: the idle clock starts at the restart', async () => {
    const { store, cloud } = setup();
    await readyReplica(store, cloud);
    expect((await store.load()).deployments[0]!.lastRequestAt).toBe(1_000_000);
    now += 10 * 60_000;

    const restarted = controllerOn(store, cloud);
    await restarted.init();
    await restarted.reconcile();
    expect(cloud.stops).toEqual([]);
    expect(restarted.get('rt')!.status).toBe('ready');

    now += 50_000;
    await restarted.reconcile();
    expect(cloud.stops).toEqual([]);

    now += 20_000;
    await restarted.reconcile();
    expect(cloud.stops).toHaveLength(1);
  });

  it('a record with no use on disk (written before wake was persisted) still adopts the running replica', async () => {
    const { store, cloud } = setup();
    await readyReplica(store, cloud);
    const [record] = (await store.load()).deployments;
    await store.saveDeployment({ ...record!, lastRequestAt: null });
    now += 10 * 60_000;

    const restarted = controllerOn(store, cloud);
    await restarted.init();
    await restarted.reconcile();
    await restarted.reconcile();
    expect(cloud.stops).toEqual([]);
    expect(restarted.get('rt')!.status).toBe('ready');

    now += 61_000;
    await restarted.reconcile();
    expect(cloud.stops).toHaveLength(1);
  });

  it('park() still powers the replica off at once, restart or not', async () => {
    const { store, cloud } = setup();
    const controller = await readyReplica(store, cloud);
    await controller.park('rt');
    await controller.reconcile();
    expect(cloud.stops).toHaveLength(1);
  });
});

describe('a parked replica the provider has no stock to power on', () => {
  it('does not block a new replica on the fallback placement, and is not counted as running', async () => {
    const { store, cloud } = setup();
    const spec = { ...SPEC, zone: 'fr-par-2', placements: [{ zone: 'nl-ams-1' }] };
    const controller = await readyReplica(store, cloud, spec);
    await controller.park('rt');
    await controller.reconcile();
    expect(cloud.stops).toHaveLength(1);
    const parked = cloud.stops[0]!;

    cloud.startReplica = async () => { throw new Error('HTTP 412: {"type":"out_of_stock","message":"no more capacity"}'); };
    cloud.failCreateFor = s => (s.zone === 'fr-par-2' ? 'out_of_stock' : null);
    controller.wake('rt');
    await controller.reconcile();
    await until(() => cloud.created.length === 2);
    expect(cloud.created[1]!.spec.zone).toBe('nl-ams-1');
    await until(async () => { await controller.reconcile(); return controller.get('rt')!.status === 'ready'; });
    expect(controller.health().running).toBe(1);
    expect(controller.health().stopped).toBe(1);
    expect(cloud.machines.has(parked)).toBe(true);
    expect(cloud.created).toHaveLength(2);
  });
});
