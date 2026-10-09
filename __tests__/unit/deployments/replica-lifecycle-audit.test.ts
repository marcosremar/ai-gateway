import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { MAX_HOURS_GRACE_MS, planReplicas, type ObservedReplica } from '../../../src/deployments/planner';
import { buildSpec } from '../../../src/deployments/spec';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import type { CreateReplicaInput, DeploymentSpec, ReplicaMachine } from '../../../src/deployments/types';
import { FakeCloud, until } from './_fake-cloud';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 100 * HOUR;

const controllers: DeploymentController[] = [];
const clouds: FakeCloud[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) c.stop();
  for (const c of clouds.splice(0)) await c.closeAll();
});

function ttsSpec(over: Partial<DeploymentSpec> = {}): DeploymentSpec {
  return {
    ...buildSpec('tts', { image: 'a/b:1', port: 8000 }, { profiles: new Map() }),
    minReplicas: 0, maxReplicas: 2, minActiveReplicas: 2, idleMinutes: 15, bootTimeoutMinutes: 45, maxHours: 4, ...over,
  };
}

function observed(id: string, createdAt: number, over: Partial<ObservedReplica> = {}): ObservedReplica {
  return {
    machine: { id, deployment: 'tts', ip: '1.2.3.4', state: 'running', createdAt, zone: 'fr-par-2', machineType: 'L4-1-24G', pricePerHour: 0.79 },
    everReady: true, readyNow: true, failures: 0, inflight: 0, ...over,
  };
}

const plan = (replicas: ObservedReplica[], over: Partial<Parameters<typeof planReplicas>[0]> = {}) => planReplicas({
  spec: ttsSpec(), now: NOW, inflight: 0, waiting: 0, lastRequestAt: NOW - 1000, aboveSince: null, replicas, ...over,
});

describe('#4 maxHours recycles one replica at a time and never the last one serving', () => {
  const aged = NOW - 4 * HOUR - MIN;
  const overdue = NOW - 4 * HOUR - MAX_HOURS_GRACE_MS - MIN;

  it('two aged idle replicas with no replacement ready: both kept, one replacement created', () => {
    const p = plan([observed('a', aged), observed('b', aged - 1000)]);
    expect(p.release).toEqual([]);
    expect(p.create).toBe(1);
  });

  it('once a replacement is ready, the oldest aged idle replica goes, and only it', () => {
    const p = plan([observed('a', aged), observed('b', aged - 1000), observed('new', NOW - 10 * MIN)]);
    expect(p.release).toEqual([{ id: 'b', reason: 'max-hours' }]);
  });

  it('past the grace, one of two overdue idle replicas goes even without a replacement (quota), the other keeps serving', () => {
    const p = plan([observed('a', overdue), observed('b', overdue - 1000)]);
    expect(p.release).toEqual([{ id: 'b', reason: 'max-hours' }]);
  });

  it('an overdue replica with requests in flight is not released', () => {
    const p = plan([observed('a', overdue, { inflight: 2 }), observed('b', overdue - 1000, { inflight: 1 })], { inflight: 3 });
    expect(p.release).toEqual([]);
  });

  it('the only replica, overdue and idle, is kept while the deployment is active', () => {
    const p = plan([observed('a', overdue)], { spec: ttsSpec({ maxReplicas: 1, minActiveReplicas: 1 }) });
    expect(p.release).toEqual([]);
    expect(p.create).toBe(1);
  });

  it('an aged replica is released at once when the deployment went idle', () => {
    const p = plan([observed('a', aged)], { lastRequestAt: NOW - HOUR });
    expect(p.release).toEqual([{ id: 'a', reason: 'max-hours' }]);
  });

  it('new requests go to the younger replica while an aged one waits for its replacement', async () => {
    let t = Date.now();
    const now = () => t;
    const cloud = new FakeCloud(now);
    clouds.push(cloud);
    const controller = new DeploymentController({
      backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20, maxTotalReplicas: 6, now,
    });
    controllers.push(controller);
    await controller.init();
    controller.start();
    await controller.put('tts', { profile: 'cpu-echo', maxReplicas: 2, minActiveReplicas: 2, targetInflightPerReplica: 4, idleMinutes: 600, maxHours: 0.25 });
    controller.wake('tts');
    await until(() => controller.get('tts')!.replicas.filter(r => r.phase === 'ready').length === 2);
    cloud.bootMs = 60_000;
    const [old, young] = [...cloud.machines.values()];
    old.machine.createdAt = t - 16 * MIN;
    t += 1;
    controller.wake('tts');
    await until(() => cloud.created.length === 3);
    const served = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const lease = await controller.acquire('tts', { waitMs: 0 });
      served.add(lease.machine.id);
      lease.done(false);
    }
    expect([...served]).toEqual([young.machine.id]);
    expect(cloud.releaseReasons).toEqual([]);
  });
});

describe('#5 a replica adopted after a restart', () => {
  it('counts its boot timeout from the restart, not from its creation', () => {
    const booting = { everReady: false, readyNow: false };
    const kept = plan([observed('adopted', NOW - HOUR, { ...booting, bootStartedAt: NOW - 10 * MIN })], { spec: ttsSpec({ maxReplicas: 1, minActiveReplicas: 1 }) });
    expect(kept.release).toEqual([]);
    const stuck = plan([observed('adopted', NOW - HOUR, { ...booting, bootStartedAt: NOW - 46 * MIN })], { spec: ttsSpec({ maxReplicas: 1, minActiveReplicas: 1 }) });
    expect(stuck.release).toEqual([{ id: 'adopted', reason: 'boot-timeout' }]);
  });
});

describe('#8 a replica that never becomes ready', () => {
  it('is replaced only while requests arrive, and the retries back off', async () => {
    let t = Date.now();
    const now = () => t;
    const cloud = new FakeCloud(now);
    cloud.bootMs = Number.POSITIVE_INFINITY;
    clouds.push(cloud);
    const controller = new DeploymentController({
      backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20, maxTotalReplicas: 6, now,
    });
    controllers.push(controller);
    await controller.init();
    controller.start();
    await controller.put('broken', { profile: 'cpu-echo', maxReplicas: 1, bootTimeoutMinutes: 45, idleMinutes: 15 });
    controller.wake('broken');
    await until(() => cloud.created.length === 1);

    t += 46 * MIN;
    await until(() => cloud.releaseReasons.length === 1);
    await new Promise(r => setTimeout(r, 200));
    expect(cloud.created.length).toBe(1);

    controller.wake('broken');
    await until(() => cloud.created.length === 2);
    t += 46 * MIN;
    controller.wake('broken');
    await until(() => cloud.releaseReasons.length === 2);
    controller.wake('broken');
    await new Promise(r => setTimeout(r, 200));
    expect(cloud.created.length).toBe(2);
    expect(controller.get('broken')!.lastError).toMatch(/boot-timeout 2 times in a row/);

    t += 11 * MIN;
    controller.wake('broken');
    await until(() => cloud.created.length === 3);
    expect(cloud.releaseReasons).toEqual(['boot-timeout', 'boot-timeout']);
  });
});

class QuotaCloud extends FakeCloud {
  quota = 1;
  stoppingMsAfterRelease = 400;
  private gone = new Map<string, ReplicaMachine>();

  override async createReplica(input: CreateReplicaInput): Promise<ReplicaMachine> {
    if (this.machines.size + this.gone.size >= this.quota) throw new Error('quota exceeded: cp_servers_type_L4_1_24G');
    return super.createReplica(input);
  }

  override async listReplicas(): Promise<ReplicaMachine[]> {
    return [...(await super.listReplicas()), ...[...this.gone.values()].map(m => ({ ...m, state: 'stopping' }))];
  }

  override async releaseReplica(machine: ReplicaMachine, reason?: string): Promise<void> {
    const known = this.machines.get(machine.id)?.machine ?? this.gone.get(machine.id);
    await super.releaseReplica(machine, reason);
    if (!known || this.gone.has(machine.id)) return;
    this.gone.set(machine.id, { ...known });
    setTimeout(() => this.gone.delete(machine.id), this.stoppingMsAfterRelease);
  }
}

describe('#13 a released machine the provider is still stopping', () => {
  it('is not released again, and its replacement is created as soon as it is gone, without the create back-off', async () => {
    const cloud = new QuotaCloud();
    clouds.push(cloud);
    const controller = new DeploymentController({
      backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20, maxTotalReplicas: 6,
    });
    controllers.push(controller);
    await controller.init();
    controller.start();
    await controller.put('tts', { profile: 'cpu-echo', maxReplicas: 1, idleMinutes: 15 });
    controller.wake('tts');
    await until(() => controller.get('tts')!.status === 'ready');
    const [first] = [...cloud.machines.values()];
    first.machine.state = 'stopped';

    await until(() => controller.get('tts')!.replicas.some(r => r.id !== first.machine.id && r.phase === 'ready'), 2500);
    expect(cloud.released.filter(id => id === first.machine.id)).toHaveLength(1);
    expect(cloud.created).toHaveLength(2);
  });
});
