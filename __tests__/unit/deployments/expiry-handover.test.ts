/**
 * A Vast host is rented until its owner's contract ends, and then it is taken away whatever it serves. The gateway
 * never rents a host ending within a day, and hands a replica over before its host ends: replacement created first,
 * the old one serving until the new one is ready, then drained and released. A caller of the deployment never sees it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentController } from '../../../src/deployments/controller';
import { EXPIRY_HANDOVER_MS, MIN_HOST_LEFT_MS, isExpiring, vastEndsAt } from '../../../src/deployments/expiry';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { planReplicas, type ObservedReplica } from '../../../src/deployments/planner';
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';
import { buildSpec } from '../../../src/deployments/spec';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import type { DeploymentSpec } from '../../../src/deployments/types';
import { VastDeploymentBackend } from '../../../src/deployments/vast-backend';
import { FakeCloud, until } from './_fake-cloud';

const MIN = 60_000;
const NOW = 1_800_000_000_000;

describe('vastEndsAt', () => {
  it('reads end_date in seconds (or ms), falls back to duration, null when unknown', () => {
    expect(vastEndsAt(1_800_003_600, undefined, NOW)).toBe(1_800_003_600_000);
    expect(vastEndsAt('1800003600.5', undefined, NOW)).toBe(1_800_003_600_500);
    expect(vastEndsAt(1_800_003_600_000, undefined, NOW)).toBe(1_800_003_600_000);
    expect(vastEndsAt(null, 7200, NOW)).toBe(NOW + 7_200_000);
    expect(vastEndsAt(undefined, undefined, NOW)).toBeNull();
    expect(vastEndsAt(0, -1, NOW)).toBeNull();
  });

  it('isExpiring only inside the handover window, never without an end date', () => {
    expect(isExpiring({ expiresAt: NOW + EXPIRY_HANDOVER_MS - 1 }, NOW)).toBe(true);
    expect(isExpiring({ expiresAt: NOW + EXPIRY_HANDOVER_MS }, NOW)).toBe(false);
    expect(isExpiring({}, NOW)).toBe(false);
    expect(isExpiring({ expiresAt: null }, NOW)).toBe(false);
  });
});

function spec(over: Partial<DeploymentSpec> = {}): DeploymentSpec {
  return { ...buildSpec('tts', { image: 'a/b:1', port: 8000, minReplicas: 1, maxReplicas: 1 }, { profiles: new Map() }), ...over };
}

function replica(id: string, over: Partial<ObservedReplica> & { expiresAt?: number; ready?: boolean } = {}): ObservedReplica {
  const { expiresAt, ready = true, ...rest } = over;
  return {
    machine: {
      id, deployment: 'tts', ip: '1.2.3.4', state: 'running', createdAt: NOW - 5 * MIN, zone: 'x', machineType: 'RTX 5090',
      pricePerHour: 0.4, ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
    everReady: ready, readyNow: ready, failures: 0, inflight: 0, ...rest,
  };
}

const base = { inflight: 0, waiting: 0, lastRequestAt: NOW - MIN, aboveSince: null, now: NOW };

describe('planReplicas: handover before the host ends', () => {
  it('an expiring replica gets its replacement at once, even at maxReplicas, and keeps serving meanwhile', () => {
    const plan = planReplicas({ ...base, spec: spec(), replicas: [replica('old', { expiresAt: NOW + 40 * MIN })] });
    expect(plan.create).toBe(1);
    expect(plan.release).toEqual([]);
  });

  it('keeps it while the replacement boots, releases it as expiring once the replacement is ready and it is drained', () => {
    const old = replica('old', { expiresAt: NOW + 40 * MIN });
    const booting = replica('new', { ready: false });
    expect(planReplicas({ ...base, spec: spec(), replicas: [old, booting] })).toMatchObject({ create: 0, release: [] });
    const ready = replica('new');
    expect(planReplicas({ ...base, spec: spec(), replicas: [{ ...old, inflight: 2 }, ready] }).release).toEqual([]);
    expect(planReplicas({ ...base, spec: spec(), replicas: [old, ready] }).release).toEqual([{ id: 'old', reason: 'expiring' }]);
  });

  it('a host ending later than the window is a normal replica', () => {
    const plan = planReplicas({ ...base, spec: spec(), replicas: [replica('a', { expiresAt: NOW + 3 * 3_600_000 })] });
    expect(plan).toMatchObject({ create: 0, release: [] });
  });

  it('idle (desired 0): an expiring replica just goes', () => {
    const plan = planReplicas({ ...base, lastRequestAt: null, spec: spec({ minReplicas: 0 }), replicas: [replica('old', { expiresAt: NOW + MIN })] });
    expect(plan.release.map(r => r.id)).toEqual(['old']);
  });
});

describe('VastDeploymentBackend: never rents a host ending within a day', () => {
  it('skips an offer ending in less than 24 h, keeps one with no end date, records expiresAt', async () => {
    const now = 1_000_000_000_000;
    const offers = [
      { id: 1, machine_id: 1, geolocation: 'Paris, FR', dph_total: 0.3, reliability2: 0.99, inet_down: 900, gpu_name: 'RTX 5090',
        end_date: (now + MIN_HOST_LEFT_MS - 3_600_000) / 1000 },
      { id: 2, machine_id: 2, geolocation: 'Paris, FR', dph_total: 0.4, reliability2: 0.99, inet_down: 900, gpu_name: 'RTX 5090',
        end_date: (now + 3 * 86_400_000) / 1000 },
    ];
    const rented: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ offers }));
      if (init?.method !== 'PUT') return new Response('{}');
      rented.push(url);
      return new Response(JSON.stringify({ success: true, new_contract: 9 }));
    };
    const backend = new VastDeploymentBackend('k', { fetch: fetchImpl, now: () => now });
    const vast = buildSpec('s', {
      provider: 'vast', image: 'vllm/vllm-omni:v0.28.0', bootScript: 'true', port: 8010, machineType: 'RTX 5090', maxEurPerHour: 0.5,
    }, { profiles: new Map(BUILTIN_PROFILES.map(p => [p.name, p])) });
    const machine = await backend.createReplica({ spec: vast, replicaToken: 'abcdefghijklmnopqrstuvwxyz012345', cloudInit: '', namespace: 'p' });
    expect(rented).toEqual(['https://console.vast.ai/api/v0/asks/2/']);
    expect(machine.expiresAt).toBe(now + 3 * 86_400_000);
  });
});

const controllers: DeploymentController[] = [];
const clouds: FakeCloud[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) c.stop();
  for (const c of clouds.splice(0)) await c.closeAll();
});

describe('controller: the handover is invisible to the caller', () => {
  it('serves from the old replica until the new is ready, then routes to the new one and releases the old', async () => {
    const cloud = new FakeCloud(Date.now, 'scaleway');
    cloud.bootMs = 0;
    const controller = new DeploymentController({
      backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20, maxTotalReplicas: 6,
    });
    controllers.push(controller);
    clouds.push(cloud);
    await controller.init();
    controller.start();
    await controller.put('s', { image: 'me/app:1', port: 8000, minReplicas: 1, maxReplicas: 1, maxEurPerHour: 2 });
    await until(() => controller.get('s')?.replicas.some(r => r.phase === 'ready') ?? false);
    const [oldId] = [...cloud.machines.keys()];

    // The provider now says the host ends in 30 min; the replacement boots slowly.
    cloud.machines.get(oldId)!.machine.expiresAt = Date.now() + 30 * MIN;
    cloud.bootMs = 400;
    await until(() => cloud.machines.size === 2);
    const during = await controller.acquire('s', { waitMs: 1000 });
    expect(during.machine.id).toBe(oldId);
    during.done();
    expect(cloud.released).toEqual([]);

    await until(() => controller.get('s')?.replicas.filter(r => r.phase === 'ready').length === 2 || !cloud.machines.has(oldId), 5000);
    await until(() => !cloud.machines.has(oldId), 5000);
    expect(cloud.releaseReasons).toEqual(['expiring']);
    const after = await controller.acquire('s', { waitMs: 1000 });
    expect(after.machine.id).not.toBe(oldId);
    after.done();
    expect(controller.get('s')?.replicas).toHaveLength(1);
  });
});
