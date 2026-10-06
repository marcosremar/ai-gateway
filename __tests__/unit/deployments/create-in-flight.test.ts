/**
 * A replica being created is not a halted replica.
 *
 * Scaleway lists a new server (state `stopped`) from the moment it exists, while the create call is still uploading
 * user_data and has not powered it on. Production stress 2026-10-06: a reconcile in that window read the server as
 * `halted`, deleted it, and the create then failed with `scaleway HTTP 404 … instance_server` on its own server — four
 * GPU replicas of parle-speech / parle-qwen-tts in a row, each billed for a few seconds and thrown away.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import type { CreateReplicaInput, ReplicaMachine } from '../../../src/deployments/types';
import { FakeCloud, until } from './_fake-cloud';

/** The machine exists (listed `stopped`) before `createReplica` returns; `finish()` ends the configuration. */
class SlowCreateCloud extends FakeCloud {
  finish: (() => void) | null = null;
  override async createReplica(input: CreateReplicaInput): Promise<ReplicaMachine> {
    const made = await super.createReplica(input);
    const fake = this.machines.get(made.id)!;
    fake.machine.state = 'stopped';
    input.onCreated?.(made.id);
    await new Promise<void>((r) => { this.finish = r; });
    // What Scaleway answers when the server was deleted under the create (user_data / poweron).
    if (!this.machines.has(made.id)) throw Object.assign(new Error('scaleway HTTP 404: instance_server not found'), { status: 404 });
    fake.machine.state = 'running';
    return { ...fake.machine };
  }
}

const controllers: DeploymentController[] = [];
const clouds: FakeCloud[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) c.stop();
  for (const c of clouds.splice(0)) await c.closeAll();
});

describe('deployments: a machine still being created', () => {
  it('is neither released as halted nor counted twice while its create call runs', async () => {
    const cloud = new SlowCreateCloud();
    const controller = new DeploymentController({
      backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20, maxTotalReplicas: 6,
    });
    controllers.push(controller);
    clouds.push(cloud);
    await controller.init();
    controller.start();
    await controller.put('s', { image: 'me/app:1', port: 8000, minReplicas: 1, maxReplicas: 1, maxEurPerHour: 2 });

    await until(() => cloud.finish !== null);
    // Several reconciles see the `stopped` machine while the create is still configuring it.
    for (let i = 0; i < 3; i++) await controller.reconcile();
    await new Promise((r) => setTimeout(r, 80));
    expect(cloud.released).toEqual([]);
    expect(cloud.created).toHaveLength(1);

    cloud.finish!();
    await until(() => controller.get('s')?.replicas.some(r => r.phase === 'ready') ?? false);
    expect(controller.get('s')?.lastError ?? null).toBeNull();
    expect(cloud.released).toEqual([]);
    expect(cloud.created).toHaveLength(1);
    expect(controller.get('s')?.replicas).toHaveLength(1);
  });

  it('once its create failed, a server left behind is planned like any other (released, no leak)', async () => {
    const cloud = new SlowCreateCloud();
    const controller = new DeploymentController({
      backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20, maxTotalReplicas: 6,
    });
    controllers.push(controller);
    clouds.push(cloud);
    await controller.init();
    controller.start();
    await controller.put('s', { image: 'me/app:1', port: 8000, minReplicas: 1, maxReplicas: 1, maxEurPerHour: 2 });
    await until(() => cloud.finish !== null);
    const [id] = [...cloud.machines.keys()];
    // The create fails for a reason of its own and its cleanup did not get the server: it stays `stopped` and listed.
    cloud.machines.get(id)!.machine.state = 'stopped';
    const origFinish = cloud.finish!;
    cloud.finish = null;
    const deleted = cloud.machines.get(id)!;
    cloud.machines.delete(id);
    origFinish();
    await until(() => (controller.get('s')?.lastError ?? '').includes('404'));
    cloud.machines.set(id, deleted);
    await until(() => cloud.released.includes(id));
  });
});
