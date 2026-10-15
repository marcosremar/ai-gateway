import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { freshStuckRetry, noteStuckRetry, stuckVerdict, wantedNow, STUCK_RETRY_COOLDOWN_MS, STUCK_RETRY_MAX } from '../../../src/deployments/stuck-retry';
import { deploymentLogToTelemetry } from '../../../src/telemetry/gateway-events';
import { setGatewayTelemetrySink } from '../../../src/telemetry/emit';
import { createOpsAlerts, type OpsAlert } from '../../../src/telemetry/ops-alerts';
import { opsAlertMail } from '../../../src/telemetry/alert-email';
import type { TelemetryEvent } from '../../../src/telemetry/contract';
import type { CreditIssue, DeploymentRecord } from '../../../src/deployments/types';
import { FakeCloud, until } from './_fake-cloud';

const MIN = 60_000;
const T0 = Date.parse('2026-10-13T10:00:00Z');

describe('stuck boot retry: the decision', () => {
  const record = (over: Partial<DeploymentRecord['spec']> = {}, rest: Partial<Pick<DeploymentRecord, 'warm' | 'lastRequestAt'>> = {}) => ({
    spec: { paused: false, minReplicas: 0, idleMinutes: 15, warmSchedule: [], ...over } as unknown as DeploymentRecord['spec'], lastRequestAt: null, ...rest,
  });
  const idle = { waiting: 0, inflight: 0 };

  it('is wanted only while something asks for it: a waiting request, a pin, the class window, a warm window or a recent request', () => {
    expect(wantedNow(record(), idle, T0)).toBe(false);
    expect(wantedNow(record(), { waiting: 1, inflight: 0 }, T0)).toBe(true);
    expect(wantedNow(record({ minReplicas: 1 }), idle, T0)).toBe(true);
    expect(wantedNow(record({ minReplicas: 1, paused: true }), idle, T0)).toBe(false);
    expect(wantedNow(record({ warmSchedule: [{ start: '00:00', end: '23:59', minReplicas: 1 }] }), idle, T0)).toBe(true);
    expect(wantedNow(record({}, { warm: { replicas: 1, until: T0 + MIN } }), idle, T0)).toBe(true);
    expect(wantedNow(record({}, { lastRequestAt: T0 - 5 * MIN }), idle, T0)).toBe(true);
    expect(wantedNow(record({}, { lastRequestAt: T0 - 20 * MIN }), idle, T0)).toBe(false);
  });

  it('retries at most STUCK_RETRY_MAX times per stuck episode, with a cooldown, never when off, unwanted or refused', () => {
    const state = freshStuckRetry();
    const stuck = { replicaId: 'r1', phase: 'pulling', phaseMinutes: 18 } as never;
    const verdict = (over: Partial<Parameters<typeof stuckVerdict>[0]> = {}) => stuckVerdict({ enabled: true, wanted: true, state, refusal: null, now: T0, ...over });
    expect(verdict({ enabled: false })).toBe('off');
    expect(verdict({ wanted: false })).toBe('unwanted');
    expect(verdict({ refusal: 'monthly budget spent' })).toBe('refused');
    expect(verdict()).toBe('retry');
    noteStuckRetry(state, stuck, 'Lyon, FR', T0);
    expect(verdict({ now: T0 + STUCK_RETRY_COOLDOWN_MS - 1 })).toBe('cooldown');
    expect(verdict({ now: T0 + STUCK_RETRY_COOLDOWN_MS })).toBe('retry');
    for (let i = 1; i < STUCK_RETRY_MAX; i++) noteStuckRetry(state, stuck, 'Paris, FR', T0 + i * STUCK_RETRY_COOLDOWN_MS);
    expect(state.attempts.map(a => a.attempt)).toEqual(Array.from({ length: STUCK_RETRY_MAX }, (_, i) => i + 1));
    expect(verdict({ now: T0 + 60 * MIN })).toBe('exhausted');
  });
});

describe('stuck boot retry: the controller', () => {
  const controllers: DeploymentController[] = [];
  const clouds: FakeCloud[] = [];
  afterEach(async () => {
    setGatewayTelemetrySink(null);
    for (const c of controllers.splice(0)) await c.stop();
    for (const c of clouds.splice(0)) await c.closeAll();
  });

  async function make(credit: CreditIssue | null = null) {
    const clock = { now: T0 };
    const cloud = new FakeCloud(() => clock.now);
    cloud.bootMs = 10 * MIN;
    const events: string[] = [];
    const create = cloud.createReplica.bind(cloud);
    cloud.createReplica = async (input) => { events.push('create'); return create(input); };
    const release = cloud.releaseReplica.bind(cloud);
    cloud.releaseReplica = async (m, reason) => { events.push(`release:${reason}`); return release(m, reason); };
    Object.assign(cloud, { creditIssue: () => credit });
    const logs: Array<[string, Record<string, unknown>]> = [];
    const c = new DeploymentController({
      backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20,
      now: () => clock.now, log: (msg, data) => logs.push([msg, data ?? {}]),
    });
    await c.init();
    controllers.push(c);
    clouds.push(cloud);
    return { c, cloud, clock, events, logs };
  }

  const booting = (c: DeploymentController) => until(() => c.get('g')!.boot.active.some(b => b.replicaId && b.phase === 'starting'));

  it('releases a stuck replica first, rents again on another offer, STUCK_RETRY_MAX times at most, then alerts once', async () => {
    const { c, cloud, clock, events, logs } = await make();
    await c.put('g', { image: 'me/app:1', port: 8000, minReplicas: 1 });
    c.start();
    await booting(c);
    const first = c.get('g')!.boot.active.find(b => b.replicaId)!.replicaId!;
    clock.now += 16 * MIN;
    await until(() => events.filter(e => e === 'create').length === 2 && c.get('g')!.boot.retries?.[0]?.next !== null);
    expect(events.slice(0, 3)).toEqual(['create', 'release:boot-stuck', 'create']);
    const [retry] = c.get('g')!.boot.retries!;
    expect(retry).toMatchObject({ replicaId: first, phase: 'starting', attempt: 1, minutes: 16 });
    expect(retry!.next!.replicaId).not.toBe(first);
    expect(c.get('g')!.boot.past[0]).toMatchObject({ replicaId: first, result: 'failed', reason: 'boot-stuck' });
    for (let n = 3; n <= STUCK_RETRY_MAX + 1; n++) {
      await booting(c);
      clock.now += 16 * MIN;
      await until(() => events.filter(e => e === 'create').length === n);
    }
    await booting(c);
    clock.now += 16 * MIN;
    await until(() => logs.some(([m]) => m === 'deployments: stuck boot retries exhausted'));
    await new Promise(r => setTimeout(r, 150));
    expect(events.filter(e => e === 'release:boot-stuck')).toHaveLength(STUCK_RETRY_MAX);
    expect(events.filter(e => e === 'create')).toHaveLength(STUCK_RETRY_MAX + 1);
    expect(logs.filter(([m]) => m === 'deployments: stuck boot retries exhausted')).toHaveLength(1);
    expect(c.get('g')!.boot.retriesExhausted).toBe(true);
    expect(cloud.releaseReasons.filter(r => r === 'boot-stuck')).toHaveLength(STUCK_RETRY_MAX);
    expect(logs.find(([m]) => m === 'deployments: stuck boot, releasing to retry')![1]).toMatchObject({ deployment: 'g', id: first, attempt: 1, of: STUCK_RETRY_MAX });
    clock.now += 15 * MIN;
    await until(() => cloud.releaseReasons.includes('boot-timeout'));
    expect(cloud.releaseReasons.filter(r => r === 'boot-stuck')).toHaveLength(STUCK_RETRY_MAX);
  });

  it('does not retry when the provider is out of credit, nor when the deployment turned it off', async () => {
    const broke = await make({ provider: 'scaleway', message: 'saldo abaixo do piso', balanceUsd: 0.2, floorUsd: 1, since: T0, at: T0 });
    await broke.c.put('g', { image: 'me/app:1', port: 8000, minReplicas: 1 });
    broke.c.start();
    await booting(broke.c);
    broke.clock.now += 16 * MIN;
    await until(() => /automatic retry refused: scaleway: saldo abaixo do piso/.test(broke.c.get('g')!.lastError ?? ''));
    expect(broke.events).toEqual(['create']);
    const off = await make();
    await off.c.put('g', { image: 'me/app:1', port: 8000, minReplicas: 1, autoRetryStuckBoot: false });
    off.c.start();
    await booting(off.c);
    off.clock.now += 16 * MIN;
    await new Promise(r => setTimeout(r, 200));
    expect(off.events).toEqual(['create']);
    expect(off.c.get('g')!.spec.autoRetryStuckBoot).toBe(false);
  });

  it('makes each step an activity event and the exhausted one an urgent e-mail', () => {
    const seen: TelemetryEvent[] = [];
    setGatewayTelemetrySink(e => seen.push(e));
    deploymentLogToTelemetry('deployments: stuck boot, releasing to retry', { deployment: 'g', id: 'r1', phase: 'pulling', attempt: 1 });
    deploymentLogToTelemetry('deployments: stuck boot retried on another offer', { deployment: 'g', id: 'r2', where: 'Paris, FR' });
    deploymentLogToTelemetry('deployments: stuck boot retries exhausted', { deployment: 'g', id: 'r3', attempts: 2 });
    expect(seen.map(e => [e.event, e.level])).toEqual([['replica.stuck_retry', 'warn'], ['replica.stuck_retried', 'info'], ['replica.stuck_exhausted', 'error']]);
    const sent: OpsAlert[] = [];
    createOpsAlerts(a => { sent.push(a); }).fromDeploymentLog('deployments: stuck boot retries exhausted', { deployment: 'g', id: 'r3', phase: 'pulling', minutes: 18, attempts: 2 });
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(sent.map(a => a.event)).toEqual(['deployment.stuck_boot']);
      expect(opsAlertMail(sent[0]!)).toMatchObject({ level: 'urgent' });
      expect(opsAlertMail(sent[0]!)!.body).toContain('"autoRetryStuckBoot": false');
      resolve();
    }, 0));
  });
});

describe('stuck boot retry on the GPU detail page', () => {
  it('shows each retry as «travou em X → liberada → nova tentativa em Y» and when they ran out', async () => {
    const { demoSnapshot } = await import('../../__fixtures__/admin-snapshot');
    const { renderGpuDetail } = await import('../../../src/admin-page/pages');
    const s = demoSnapshot(T0, 'bad');
    const html = renderGpuDetail('n', s, 'speech-stack-test', { now: T0, csrf: 'c', actor: 'marcos', message: null, app: null })!;
    expect(html).toContain('Novas tentativas automáticas');
    expect(html).toContain(`travou em carregando modelos (16 min) em fr-par-2 → liberada → nova tentativa 1/${STUCK_RETRY_MAX} em nl-ams-1 (nl-ams-1/b2c4)`);
    expect(html).toContain('tentativas esgotadas');
  });
});
