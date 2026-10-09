import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentController, DeploymentError } from '../../../src/deployments/controller';
import { activeWindow } from '../../../src/deployments/autoscale';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { SpecError } from '../../../src/deployments/spec';
import { FakeCloud, until } from './_fake-cloud';

const controllers: DeploymentController[] = [];
const clouds: FakeCloud[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) c.stop();
  for (const c of clouds.splice(0)) await c.closeAll();
});

const MONDAY_CLASS = Date.parse('2026-10-05T16:00:00Z');
const CLASS = { days: [1, 2, 3, 4], start: '17:40', end: '20:15', timeZone: 'Europe/Paris', minReplicas: 2 };

async function setup(at: number, maxTotalReplicas = 6) {
  const clock = { t: at };
  const cloud = new FakeCloud(() => clock.t);
  const controller = new DeploymentController({
    backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20,
    maxTotalReplicas, now: () => clock.t,
  });
  controllers.push(controller);
  clouds.push(cloud);
  await controller.init();
  controller.start();
  return { controller, cloud, clock };
}

const refusal = (fn: () => unknown): DeploymentError => {
  try { fn(); } catch (err) { if (err instanceof DeploymentError) return err; throw err; }
  throw new Error('not refused');
};

describe('reserveQuota: a class window keeps a machine type for one deployment', () => {
  it('the window is Mon–Thu 17:40–20:15 Europe/Paris and says when it ends', () => {
    expect(activeWindow([CLASS], MONDAY_CLASS)).toEqual({ replicas: 2, endsAt: Date.parse('2026-10-05T18:15:00Z') });
    expect(activeWindow([CLASS], Date.parse('2026-10-05T15:39:00Z'))).toBeNull();
    expect(activeWindow([CLASS], Date.parse('2026-10-05T18:15:00Z'))).toBeNull();
    expect(activeWindow([CLASS], Date.parse('2026-10-09T16:00:00Z'))).toBeNull();
  });

  it('inside the window another deployment of the same machine type is refused with 409, the reason and the end; the holder is not', async () => {
    const x = await setup(MONDAY_CLASS);
    await x.controller.put('tts', { profile: 'cpu-echo', maxEurPerHour: 2, maxReplicas: 2, reserveQuota: { quota: 2, windows: [CLASS] } });
    await x.controller.put('bench', { profile: 'cpu-echo', maxEurPerHour: 2 });

    const woke = refusal(() => x.controller.wake('bench'));
    expect(woke).toMatchObject({ status: 409, code: 'reserved', retryAfterSeconds: 8100 });
    expect(woke.message).toMatch(/is reserved for deployment 'tts' until 2026-10-05T18:15:00\.000Z \(2 of a quota of 2; other deployments hold 0\): 'bench' may not take one now/);
    await expect(x.controller.acquire('bench', { waitMs: 0 })).rejects.toMatchObject({ status: 409, code: 'reserved' });
    await new Promise(r => setTimeout(r, 120));
    expect(x.cloud.created.filter(c => c.spec.name === 'bench')).toEqual([]);

    x.controller.wake('tts');
    await until(() => x.cloud.created.some(c => c.spec.name === 'tts'), 3000);

    expect(x.controller.capacity('bench')!.reservations).toEqual([{
      holder: 'tts', machineType: x.controller.get('tts')!.spec.machineType, quota: 2, windows: [CLASS],
      active: { replicas: 2, until: '2026-10-05T18:15:00.000Z' },
    }]);
  });

  it('outside the window, or with the holder paused, nothing is refused', async () => {
    const x = await setup(Date.parse('2026-10-05T19:00:00Z'));
    await x.controller.put('tts', { profile: 'cpu-echo', maxEurPerHour: 2, reserveQuota: { quota: 2, windows: [CLASS] } });
    await x.controller.put('bench', { profile: 'cpu-echo', maxEurPerHour: 2 });
    x.controller.wake('bench');
    await until(() => x.cloud.created.some(c => c.spec.name === 'bench'), 3000);
    expect(x.controller.capacity('bench')!.reservations[0]!.active).toBeNull();

    const y = await setup(MONDAY_CLASS);
    await y.controller.put('tts', { profile: 'cpu-echo', maxEurPerHour: 2, paused: true, reserveQuota: { quota: 2, windows: [CLASS] } });
    await y.controller.put('bench', { profile: 'cpu-echo', maxEurPerHour: 2 });
    expect(() => y.controller.wake('bench')).not.toThrow();
  });

  it('a quota larger than the reservation leaves the difference to the others, and no more', async () => {
    const x = await setup(MONDAY_CLASS);
    await x.controller.put('tts', { profile: 'cpu-echo', maxEurPerHour: 2, reserveQuota: { quota: 3, windows: [CLASS] } });
    await x.controller.put('bench', { profile: 'cpu-echo', maxEurPerHour: 2, minReplicas: 1, maxReplicas: 2 });
    await until(() => x.controller.get('bench')!.replicas.length === 1, 3000);
    await x.controller.put('bench', { profile: 'cpu-echo', maxEurPerHour: 2, minReplicas: 2, maxReplicas: 2 });
    await until(() => /is reserved for deployment 'tts'/.test(x.controller.get('bench')!.lastError ?? ''), 3000);
    expect(x.cloud.created.filter(c => c.spec.name === 'bench')).toHaveLength(1);
    expect(x.controller.get('bench')!.lastError).toMatch(/other deployments hold 1/);
  });

  it('the spec is validated: quota at least the largest window, windows in the warmSchedule shape', async () => {
    const x = await setup(MONDAY_CLASS);
    await expect(x.controller.put('a', { profile: 'cpu-echo', reserveQuota: { quota: 1, windows: [CLASS] } })).rejects.toThrow(SpecError);
    await expect(x.controller.put('a', { profile: 'cpu-echo', reserveQuota: { quota: 2, windows: [{ ...CLASS, start: '25:00' }] } }))
      .rejects.toThrow(/reserveQuota\.windows\[0\]\.start must be HH:MM/);
    await expect(x.controller.put('a', { profile: 'cpu-echo', reserveQuota: { quota: 2, windows: [CLASS], zone: 'x' } })).rejects.toThrow(SpecError);
  });
});

describe('replica cap refusal', () => {
  it('names the deployments that hold the slots', async () => {
    const x = await setup(MONDAY_CLASS, 2);
    await x.controller.put('tts', { profile: 'cpu-echo', maxEurPerHour: 2, minReplicas: 2, maxReplicas: 2 });
    await until(() => x.controller.get('tts')!.replicas.length === 2, 3000);
    await x.controller.put('livekit', { profile: 'cpu-echo', maxEurPerHour: 2 });
    x.controller.wake('livekit');
    await until(() => Boolean(x.controller.get('livekit')!.lastError), 3000);
    expect(x.controller.get('livekit')!.lastError).toBe('replica cap reached (2 across all deployments, DEPLOYMENTS_MAX_REPLICAS; held by tts 2)');
  });
});
