/**
 * Controller over several backends: the placement ladder (`candidates`) and per-provider listing failures.
 * Fake clouds only (in-process replicas), no provider API.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { reapIfGatewayDown } from '../../../src/deployments/reaper';
import { FakeCloud, until } from './_fake-cloud';

const controllers: DeploymentController[] = [];
const clouds: FakeCloud[] = [];

async function make(backends: { scaleway?: FakeCloud; vast?: FakeCloud }): Promise<DeploymentController> {
  const controller = new DeploymentController({
    backends, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 50,
  });
  await controller.init();
  controller.start();
  controllers.push(controller);
  clouds.push(...Object.values(backends).filter((c): c is FakeCloud => !!c));
  return controller;
}

afterEach(async () => {
  for (const c of controllers.splice(0)) c.stop();
  for (const c of clouds.splice(0)) await c.closeAll();
});

const vastScript = { image: 'vllm/vllm-omni:v0.28.0', bootScript: 'serve', port: 8010 };

describe('placement ladder', () => {
  it('walks the candidates: out_of_stock on the first, lands on the second, and says so', async () => {
    const scaleway = new FakeCloud();
    scaleway.failCreateFor = (spec) => (spec.zone === 'fr-par-2' ? 'scaleway: out_of_stock (HTTP 412)' : null);
    const controller = await make({ scaleway });
    await controller.put('tts', {
      image: 'me/app:1', port: 8000, minReplicas: 1,
      candidates: [
        { zone: 'nl-ams-1', machineType: 'L4-1-24G', maxEurPerHour: 1 },
        { zone: 'fr-par-2', machineType: 'L4-1-24G', maxEurPerHour: 1 },
      ],
    });
    await until(() => controller.get('tts')!.status === 'ready');
    const view = controller.get('tts')!;
    expect(view.replicas).toEqual([expect.objectContaining({ zone: 'nl-ams-1', machineType: 'L4-1-24G' })]);
    // fr-par-2 ranked first (France), failed out of stock, nl-ams-1 took it.
    expect(view.lastPlacement).toBe('scaleway L4-1-24G@nl-ams-1 (€0.01/h) near FR; skipped: L4-1-24G out of stock in fr-par-2');
    expect(scaleway.created.map(c => c.spec.zone)).toEqual(['nl-ams-1']);
  });

  it('skips a candidate over its cap by catalog price and lands on Vast', async () => {
    const scaleway = new FakeCloud();
    scaleway.priceFor = () => 0.9;
    const vast = new FakeCloud(Date.now, 'vast');
    vast.marketPriced = true;
    const controller = await make({ scaleway, vast });
    await controller.put('speech', {
      ...vastScript, minReplicas: 1,
      candidates: [
        { zone: 'fr-par-2', machineType: 'L4-1-24G', maxEurPerHour: 0.8 },
        { provider: 'vast', machineType: 'RTX 5090', maxEurPerHour: 0.6 },
      ],
    });
    await until(() => controller.get('speech')!.status === 'ready');
    const view = controller.get('speech')!;
    expect(view.lastPlacement).toBe('vast RTX 5090 (≤ €0.6/h) near FR; skipped: L4-1-24G costs €0.9/h in fr-par-2, above maxEurPerHour €0.8');
    expect(vast.created).toHaveLength(1);
    expect(vast.created[0].spec).toMatchObject({ provider: 'vast', machineType: 'RTX 5090', maxEurPerHour: 0.6, gpu: true });
    expect(vast.created[0].cloudInit).toBe(''); // Vast builds its own init from spec + token
    expect(scaleway.created).toHaveLength(0);
  });

  it('a credential error stops the walk (no burning through the ladder) and is recorded', async () => {
    const scaleway = new FakeCloud();
    scaleway.failCreateFor = () => 'HTTP 401 unauthorized';
    const controller = await make({ scaleway });
    await controller.put('tts', {
      image: 'me/app:1', port: 8000, minReplicas: 1,
      candidates: [{ zone: 'fr-par-2', machineType: 'L4-1-24G', maxEurPerHour: 1 }, { zone: 'fr-par-1', machineType: 'L4-1-24G', maxEurPerHour: 1 }],
    });
    await until(() => controller.get('tts')!.lastPlacement !== null);
    expect(controller.get('tts')!.lastPlacement).toMatch(/^failed at scaleway L4-1-24G@fr-par-2: HTTP 401/);
    expect(controller.get('tts')!.lastError).toMatch(/HTTP 401/);
  });

  it('placements go through the same walk, in the given order, and record lastPlacement too', async () => {
    const scaleway = new FakeCloud();
    scaleway.failCreateFor = (spec) => (spec.zone === 'fr-par-2' ? 'scaleway HTTP 412: {"type":"out_of_stock"}' : null);
    const controller = await make({ scaleway });
    // pl-waw-2 is listed before fr-par-1 and is tried first: placements are never re-ranked.
    await controller.put('tts', { image: 'me/app:1', port: 8000, minReplicas: 1, placements: [{ zone: 'pl-waw-2' }, { zone: 'fr-par-1' }] });
    await until(() => controller.get('tts')!.status === 'ready');
    expect(controller.get('tts')!.lastPlacement).toBe('scaleway L4-1-24G@pl-waw-2 (€0.01/h); skipped: L4-1-24G out of stock in fr-par-2');
    expect(scaleway.created.map(c => c.spec.zone)).toEqual(['pl-waw-2']);
  });

  it('without candidates nothing changes: one place, catalog price checked, same errors', async () => {
    const scaleway = new FakeCloud();
    scaleway.price = 2;
    const controller = await make({ scaleway });
    await controller.put('tts', { image: 'me/app:1', port: 8000, minReplicas: 1 });
    await until(() => controller.get('tts')!.lastError !== null);
    expect(controller.get('tts')!.lastError).toBe('create: L4-1-24G costs €2/h in fr-par-2, above maxEurPerHour €1');
    expect(scaleway.created).toHaveLength(0);
  });
});

describe('several backends', () => {
  it('one provider failing to list keeps the other provider running and its own machines remembered', async () => {
    const scaleway = new FakeCloud();
    const vast = new FakeCloud(Date.now, 'vast');
    vast.marketPriced = true;
    const controller = await make({ scaleway, vast });
    await controller.put('scw', { image: 'me/app:1', port: 8000, minReplicas: 1 });
    await controller.put('gpu', { ...vastScript, provider: 'vast', machineType: 'RTX 5090', minReplicas: 1 });
    await until(() => controller.get('scw')!.status === 'ready' && controller.get('gpu')!.status === 'ready');

    vast.failList = true;
    await controller.reconcile();
    expect(controller.health().listError).toBe('vast: vast list failed');
    // Vast's replica is still known (not forgotten, not re-created) and Scaleway keeps reconciling.
    expect(controller.get('gpu')!.replicas).toHaveLength(1);
    await controller.put('scw', { minReplicas: 2, maxReplicas: 2 });
    await until(() => controller.get('scw')!.replicas.length === 2);
    expect(vast.created).toHaveLength(1);
    expect(vast.released).toEqual([]);

    vast.failList = false;
    await controller.reconcile();
    expect(controller.health().listError).toBeNull();
    expect(controller.get('gpu')!.replicas).toHaveLength(1);
  });

  it('every backend failing to list touches nothing', async () => {
    const scaleway = new FakeCloud();
    scaleway.failList = true;
    const controller = await make({ scaleway });
    await controller.put('scw', { image: 'me/app:1', port: 8000, minReplicas: 1 });
    await controller.reconcile();
    expect(scaleway.created).toHaveLength(0);
    expect(controller.health().listError).toBe('scaleway: scaleway list failed');
  });

  it('releases a machine through the backend that owns it, and orphans on each provider', async () => {
    const scaleway = new FakeCloud();
    const vast = new FakeCloud(Date.now, 'vast');
    vast.marketPriced = true;
    const controller = await make({ scaleway, vast });
    await controller.put('gpu', { ...vastScript, provider: 'vast', machineType: 'RTX 5090', minReplicas: 1 });
    await until(() => controller.get('gpu')!.status === 'ready');
    const id = controller.get('gpu')!.replicas[0].id;
    await controller.remove('gpu');
    expect(vast.released).toEqual([id]);
    expect(scaleway.released).toEqual([]);
  });
});

describe('reaper over several backends', () => {
  it('reaps both providers, and one failing to list does not spare the other', async () => {
    const machine = (id: string) => ({ id, deployment: 'x', ip: null, state: 'running', createdAt: 0, zone: '', machineType: '', pricePerHour: null });
    const released: string[] = [];
    const r = await reapIfGatewayDown({
      namespace: 'prod', now: () => 3_600_000, sleep: async () => {}, gatewayUp: async () => false,
      backends: [
        { provider: 'scaleway', listReplicas: async () => { throw new Error('scaleway down'); }, releaseReplica: async () => {} },
        { provider: 'vast', listReplicas: async () => [machine('v1')], releaseReplica: async (m) => { released.push(m.id); } },
      ],
    });
    expect(released).toEqual(['v1']);
    expect(r).toMatchObject({ gatewayUp: false, seen: 1, released: ['v1'], failed: ['list:scaleway'] });
  });
});
