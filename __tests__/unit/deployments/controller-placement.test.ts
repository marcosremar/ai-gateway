/**
 * Controller over several backends: the placement ladder (`candidates`) and per-provider listing failures.
 * Fake clouds only (in-process replicas), no provider API.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { reapIfGatewayDown } from '../../../src/deployments/reaper';
import { DEFAULT_MAX_RTT_EXCESS_MS, gateDecision, gateNote, RTT_GATE_BUDGET_MS } from '../../../src/deployments/rtt-gate';
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
    scaleway.failCreateFor = (spec) => (spec.zone === 'nl-ams-1' ? 'scaleway: out_of_stock (HTTP 412)' : null);
    const controller = await make({ scaleway });
    await controller.put('tts', {
      image: 'me/app:1', port: 8000, minReplicas: 1,
      candidates: [
        { zone: 'pl-waw-2', machineType: 'L4-1-24G', maxEurPerHour: 1 },
        { zone: 'nl-ams-1', machineType: 'L4-1-24G', maxEurPerHour: 1 },
        { zone: 'fr-par-2', machineType: 'L4-1-24G', maxEurPerHour: 1 },
      ],
    });
    await until(() => controller.get('tts')!.status === 'ready');
    const view = controller.get('tts')!;
    expect(view.replicas).toEqual([expect.objectContaining({ zone: 'fr-par-2', machineType: 'L4-1-24G' })]);
    // Same price: band 0 (nl-ams, fr-par) before pl-waw (~1370 km), caller order inside the band; nl-ams was out of stock.
    expect(view.lastPlacement).toBe('scaleway L4-1-24G@fr-par-2 (€0.01/h) near FR; skipped: L4-1-24G out of stock in nl-ams-1');
    expect(scaleway.created.map(c => c.spec.zone)).toEqual(['fr-par-2']);
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

describe('RTT gate (Vast)', () => {
  const gpu = { ...vastScript, provider: 'vast', machineType: 'RTX 5090', minReplicas: 1 };

  it('a host at 60 ms is released as too-far and the next one (20 ms) is kept; the view shows rttMs', async () => {
    const vast = new FakeCloud(Date.now, 'vast');
    vast.marketPriced = true;
    const rtts = [60, 20];
    const measured = new Map<string, number>();
    vast.measureRtt = async (m) => {
      if (!measured.has(m.id)) measured.set(m.id, rtts.shift() ?? 20);
      return measured.get(m.id)!;
    };
    const controller = await make({ vast });
    await controller.put('gpu', gpu);
    await until(() => controller.get('gpu')!.status === 'ready');
    expect(vast.created).toHaveLength(2);
    expect(vast.releaseReasons).toEqual(['too-far']);
    const view = controller.get('gpu')!;
    expect(view.replicas).toEqual([expect.objectContaining({ rttMs: 20, phase: 'ready' })]);
    expect(view.lastPlacement).toMatch(/^vast RTX 5090 \(≤ €1\/h\); earlier: host .*RTT 60 ms > maxRttMs 35: released \(too-far\); RTT 20 ms ≤ maxRttMs 35: kept$/);
    // Passed once = never measured again.
    const calls = measured.size;
    await controller.reconcile();
    await controller.reconcile();
    expect(measured.size).toBe(calls);
  });

  it('records the too-far decision in lastPlacement, and honours a spec maxRttMs', async () => {
    const vast = new FakeCloud(Date.now, 'vast');
    vast.marketPriced = true;
    vast.measureRtt = async () => 60;
    const controller = await make({ vast });
    await controller.put('gpu', { ...gpu, maxRttMs: 50 });
    await until(() => vast.releaseReasons.filter(r => r === 'too-far').length >= 2);
    // The next create keeps the earlier decision visible.
    await until(() => /earlier: .*RTT 60 ms > maxRttMs 50: released \(too-far\)/.test(controller.get('gpu')!.lastPlacement ?? ''));
  });

  it('no RTT answer within the budget counts as too far; before it, the replica just waits (not served)', async () => {
    let offset = 0;
    const clock = () => Date.now() + offset;
    const vast = new FakeCloud(clock, 'vast');
    vast.marketPriced = true;
    vast.measureRtt = async () => { throw new Error('probe failed'); };
    const controller = new DeploymentController({
      backends: { vast }, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', now: clock,
    });
    await controller.init();
    controllers.push(controller);
    clouds.push(vast);
    await controller.put('gpu', gpu);
    await until(() => vast.machines.size === 1);
    await controller.reconcile();
    expect(controller.get('gpu')!.replicas[0]).toMatchObject({ phase: 'booting', rttMs: null });
    expect(vast.released).toEqual([]);
    offset += 5 * 60_000 + 1;
    await controller.reconcile();
    expect(vast.releaseReasons).toEqual(['too-far']);
    expect(controller.get('gpu')!.lastPlacement).toMatch(/no RTT answer > maxRttMs 35: released \(too-far\)/);
  });

  it('with a baseline the gate is relative: the live French host (42 ms, Paris at 45) is kept, remembered, and both numbers show', async () => {
    const vast = new FakeCloud(Date.now, 'vast');
    vast.marketPriced = true;
    vast.placementNote = 'offer 2 of 9: Paris, FR, $0.548/h; better-ranked offers passed over: offer 7 (Zurich, CH, $0.5/h): not available';
    vast.measureRtt = async () => 42;
    vast.measureBaselineRtt = async near => ({ anchor: `anchor-${near}`, rttMs: 45 });
    const remembered: Array<[string, number]> = [];
    vast.recordRtt = (m, rtt) => { remembered.push([m.id, rtt]); };
    const controller = await make({ vast });
    await controller.put('gpu', gpu);
    await until(() => controller.get('gpu')!.status === 'ready');
    const view = controller.get('gpu')!;
    expect(vast.releaseReasons).toEqual([]);
    expect(view.replicas).toEqual([expect.objectContaining({ rttMs: 42, rttBaselineMs: 45 })]);
    expect(view.lastPlacement).toBe('vast RTX 5090 (≤ €1/h); offer 2 of 9: Paris, FR, $0.548/h; better-ranked offers passed over: '
      + 'offer 7 (Zurich, CH, $0.5/h): not available; RTT 42 ms, baseline 45 ms (anchor-FR): −3 ms ≤ maxRttExcessMs 20: kept');
    expect(remembered).toEqual([[view.replicas[0].id, 42]]);
  });

  it('a host far over the baseline is released; a failed baseline probe falls back to the absolute rule, it never opens the gate', async () => {
    const vast = new FakeCloud(Date.now, 'vast');
    vast.marketPriced = true;
    vast.measureRtt = async () => 80;
    vast.measureBaselineRtt = async () => ({ anchor: 's3.fr-par.scw.cloud', rttMs: 45 });
    const controller = await make({ vast });
    await controller.put('gpu', gpu);
    await until(() => vast.releaseReasons.includes('too-far'));
    await until(() => /RTT 80 ms, baseline 45 ms \(s3\.fr-par\.scw\.cloud\): \+35 ms > maxRttExcessMs 20: released \(too-far\)/.test(controller.get('gpu')!.lastPlacement ?? ''));

    const blind = new FakeCloud(Date.now, 'vast');
    blind.marketPriced = true;
    blind.measureRtt = async () => 42;
    blind.measureBaselineRtt = async () => { throw new Error('anchor unreachable'); };
    const second = await make({ vast: blind });
    await second.put('gpu', gpu);
    await until(() => blind.releaseReasons.includes('too-far'));
    await until(() => /RTT 42 ms > maxRttMs 35: released \(too-far\)/.test(second.get('gpu')!.lastPlacement ?? ''));
  });

  it('gateDecision: relative to the baseline, bounded by maxRttMs when the spec sets it, absolute without a baseline', () => {
    const at = { firstSeenAt: 0, now: 1_000 };
    expect(gateDecision({ ...at, rttMs: 42, baselineMs: 45 })).toBe('pass');
    expect(gateDecision({ ...at, rttMs: 42 })).toBe('too-far');
    expect(gateDecision({ ...at, rttMs: 42, baselineMs: null })).toBe('too-far');
    expect(gateDecision({ ...at, rttMs: 55, baselineMs: 40 })).toBe('pass');
    expect(gateDecision({ ...at, rttMs: 60, baselineMs: 40 })).toBe('pass');
    expect(gateDecision({ ...at, rttMs: 61, baselineMs: 40 })).toBe('too-far');
    expect(gateDecision({ ...at, rttMs: 55, baselineMs: 40, maxExcessMs: 10 })).toBe('too-far');
    expect(gateDecision({ ...at, rttMs: 55, baselineMs: 40, maxRttMs: 50 })).toBe('too-far');
    expect(gateDecision({ ...at, rttMs: 55, baselineMs: 40, maxRttMs: 120 })).toBe('pass');
    expect(gateDecision({ ...at, rttMs: 55, maxRttMs: 120 })).toBe('pass');
    expect(gateDecision({ ...at, rttMs: null, baselineMs: 40 })).toBe('wait');
    expect(gateDecision({ firstSeenAt: 0, now: RTT_GATE_BUDGET_MS, rttMs: null, baselineMs: 40 })).toBe('too-far');
    expect(gateNote({ ...at, rttMs: 55, baselineMs: 40, anchor: 'a', maxRttMs: 50 })).toBe('RTT 55 ms, baseline 40 ms (a): +15 ms ≤ maxRttExcessMs 20, maxRttMs 50');
    expect(DEFAULT_MAX_RTT_EXCESS_MS).toBe(20);
  });

  it('the offers preview shows the gate in force, the baseline measured now and the verdict of known hosts', async () => {
    const vast = new FakeCloud(Date.now, 'vast');
    vast.marketPriced = true;
    const row = { rank: 1, wouldTry: true, offerId: 1, machineId: 1, location: 'Paris, FR', distanceKm: 0, usdPerHour: 0.5, effectiveUsdPerHour: 0.5,
      reliability: 0.99, inetDownMbps: 900, inetUpMbps: 900, cudaMax: 13, directPorts: 60, gpu: 'RTX 5090' };
    vast.previewOffers = async () => [{ ...row, knownRttMs: 42 }, { ...row, rank: 2, knownRttMs: 70 }, { ...row, rank: 3, knownRttMs: null }];
    vast.measureBaselineRtt = async () => ({ anchor: 's3.fr-par.scw.cloud', rttMs: 45 });
    const controller = await make({ vast });
    await controller.put('gpu', { ...gpu, minReplicas: 0 });
    const preview = (await controller.offers('gpu'))!;
    expect(preview.gate).toEqual({ near: 'FR', rule: 'relative', anchor: 's3.fr-par.scw.cloud', baselineMs: 45, maxRttExcessMs: 20, maxRttMs: null });
    expect(preview.offers.map(o => o.gateVerdict)).toEqual(['pass', 'too-far', null]);
    vast.measureBaselineRtt = async () => null;
    expect((await controller.offers('gpu'))!.gate).toEqual({ near: 'FR', rule: 'absolute', anchor: null, baselineMs: null, maxRttExcessMs: 20, maxRttMs: 35 });
  });

  it('Scaleway replicas are not gated (no measureRtt)', async () => {
    const scaleway = new FakeCloud();
    const controller = await make({ scaleway });
    await controller.put('scw', { image: 'me/app:1', port: 8000, minReplicas: 1 });
    await until(() => controller.get('scw')!.status === 'ready');
    expect(controller.get('scw')!.replicas[0].rttMs).toBeNull();
  });
});
