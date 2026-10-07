/**
 * The reserved IP and firewall of a deleted exposed deployment: the release still owed survives a gateway restart, a
 * release that keeps failing stays visible, and a deployment created again under the same name takes its network back.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DeploymentController } from '../../../src/deployments/controller';
import { FileDeploymentStore, MemoryDeploymentStore } from '../../../src/deployments/store';
import type { DeploymentStore } from '../../../src/deployments/types';
import { FakeCloud } from './_fake-cloud';

const NETWORK = { zone: 'fr-par-2', ipId: 'ip-rtc', ip: '51.15.0.1', groupId: 'sg-rtc' };
const SPEC = { profile: 'cpu-echo', zone: NETWORK.zone, minReplicas: 0, exposure: { ports: [{ protocol: 'tcp', port: 443 }] } };

const clouds: FakeCloud[] = [];
afterEach(async () => { for (const c of clouds.splice(0)) await c.closeAll(); });

function controllerOn(store: DeploymentStore, cloud: FakeCloud, now: () => number = Date.now) {
  clouds.push(cloud);
  return new DeploymentController({ backend: cloud, store, probe: { ready: async () => true }, namespace: 'test', now });
}

async function seeded(store: DeploymentStore): Promise<void> {
  const setup = controllerOn(store, new FakeCloud());
  await setup.init();
  await setup.put('rtc', SPEC);
  const [record] = (await store.load()).deployments;
  await store.saveDeployment({ ...record!, network: NETWORK });
}

function failingCloud(message = 'HTTP 409: ip is attached'): FakeCloud {
  const cloud = new FakeCloud();
  cloud.releaseNetwork = async () => { throw new Error(message); };
  return cloud;
}

describe('network release after DELETE', () => {
  it('a gateway restarted before the release went through resumes it from the store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aigw-netrel-'));
    try {
      await seeded(FileDeploymentStore.inDir(dir));
      const before = controllerOn(FileDeploymentStore.inDir(dir), failingCloud());
      await before.init();
      expect(await before.remove('rtc')).toBe(true);
      await before.reconcile();
      expect(before.pendingNetworkReleases()).toMatchObject([{ deployment: 'rtc', ip: '51.15.0.1', lastError: 'HTTP 409: ip is attached' }]);

      const cloud = new FakeCloud();
      const after = controllerOn(FileDeploymentStore.inDir(dir), cloud);
      await after.init();
      expect(after.list()).toEqual([]);
      expect(after.pendingNetworkReleases()).toMatchObject([{ deployment: 'rtc', ip: '51.15.0.1', attempts: 0 }]);
      await after.reconcile();
      expect(cloud.releasedNetworks).toEqual(['ip-rtc']);
      expect(after.pendingNetworkReleases()).toEqual([]);
      expect((await FileDeploymentStore.inDir(dir).load()).networkReleases).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a release that keeps failing stays listed with its attempts and error, and is still retried', async () => {
    const store = new MemoryDeploymentStore();
    await seeded(store);
    let now = 1_000_000;
    const cloud = failingCloud();
    const controller = controllerOn(store, cloud, () => now);
    await controller.init();
    await controller.remove('rtc');
    for (let i = 0; i < 30; i++) { now += 20_000; await controller.reconcile(); }
    const [pending] = controller.pendingNetworkReleases();
    expect(pending).toMatchObject({ deployment: 'rtc', zone: NETWORK.zone, lastError: 'HTTP 409: ip is attached' });
    expect(pending!.attempts).toBeGreaterThanOrEqual(10);
    expect(pending!.attempts).toBeLessThan(15);
    expect((await store.load()).networkReleases).toHaveLength(1);

    const real = new FakeCloud();
    cloud.releaseNetwork = real.releaseNetwork.bind(real);
    now += 5 * 60_000;
    await controller.reconcile();
    expect(real.releasedNetworks).toEqual(['ip-rtc']);
    expect(controller.pendingNetworkReleases()).toEqual([]);
  });

  it('the deployment created again under the same name takes the network back instead of losing it to the release', async () => {
    const store = new MemoryDeploymentStore();
    await seeded(store);
    const cloud = failingCloud();
    const controller = controllerOn(store, cloud);
    await controller.init();
    await controller.remove('rtc');
    await controller.put('rtc', SPEC);
    expect(controller.pendingNetworkReleases()).toEqual([]);
    expect(controller.get('rtc')!.publicIp).toBe('51.15.0.1');
    const state = await store.load();
    expect(state.networkReleases).toEqual([]);
    expect(state.deployments[0]!.network).toEqual(NETWORK);
  });
});
