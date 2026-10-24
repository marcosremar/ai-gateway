import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { VastDeploymentBackend, type VastAccountInstance } from '../../../src/deployments/vast-backend';
import { sweepVerdicts, VastSweep, vastSweepFromEnv } from '../../../src/deployments/vast-sweep';
import { createOpsAlerts, type OpsAlert } from '../../../src/telemetry/ops-alerts';

// Owner, 24/10/2026: undeclared Vast instances left stopped bill their disk forever (54045930, `voice-gpu@dev`, 20 days).
const H = 3_600_000;
const NOW = 1_000 * H;
const limits = { stoppedMaxMs: 24 * H, destroy: true, minCreditUsd: 1 };

const inst = (id: string, label: string, state: string): VastAccountInstance => ({
  id, label, state, providerStatus: state, createdAt: NOW - 500 * H, gpu: 'RTX A4500', usdPerHour: 0.14, diskUsdPerHour: 0.0167,
});

const verdictOf = (i: VastAccountInstance, stoppedHours: number | null, creditUsd: number | null = 10) =>
  sweepVerdicts({ instances: [i], stoppedSince: new Map(stoppedHours === null ? [] : [[i.id, NOW - stoppedHours * H]]), creditUsd, now: NOW, limits })[0];

describe('sweepVerdicts', () => {
  it('destroys an undeclared instance stopped 25 h, waits at 23 h', () => {
    expect(verdictOf(inst('a', 'voice-gpu@dev', 'stopped'), 25).action).toBe('destroy');
    expect(verdictOf(inst('a', 'voice-gpu@dev', 'exited'), 25).action).toBe('destroy');
    expect(verdictOf(inst('a', 'voice-gpu@dev', 'stopped'), 23).action).toBe('none');
  });

  it('leaves a stopped declared instance to its gateway (12 h rule)', () => {
    expect(verdictOf(inst('d', 'aigw:prod:parle-speech', 'stopped'), 25).action).toBe('none');
    expect(verdictOf(inst('m', 'aigw-m:prod:abc', 'stopped'), 25).action).toBe('none');
  });

  it('never touches a label with keep', () => {
    expect(verdictOf(inst('k', 'voice-gpu@dev:keep', 'stopped'), 500).action).toBe('none');
    expect(verdictOf(inst('k', 'KEEP', 'stopped'), 500, 0).action).toBe('none');
    expect(verdictOf(inst('k', 'keeper', 'stopped'), 25).action).toBe('destroy');
  });

  it('only alerts on a running undeclared instance, never destroys a running one', () => {
    expect(verdictOf(inst('r', 'voice-gpu@dev', 'running'), null).action).toBe('alert');
    expect(verdictOf(inst('r', '', 'starting'), null, 0).action).toBe('alert');
    expect(verdictOf(inst('r', 'aigw:prod:x', 'running'), null, 0).action).toBe('none');
  });

  it('without credit destroys every stopped instance at once, declared or not', () => {
    expect(verdictOf(inst('a', 'voice-gpu@dev', 'stopped'), 0, 0).action).toBe('destroy');
    expect(verdictOf(inst('d', 'aigw:prod:parle-speech', 'stopped'), 0, 0.5).action).toBe('destroy');
    expect(verdictOf(inst('d', 'aigw:prod:parle-speech', 'stopped'), 0, null).action).toBe('none');
  });
});

describe('vastSweepFromEnv', () => {
  it('is a dry run unless VAST_SWEEP_DESTROY=1', () => {
    expect(vastSweepFromEnv({})).toMatchObject({ on: true, destroy: false, stoppedMaxMs: 24 * H });
    expect(vastSweepFromEnv({ VAST_SWEEP_DESTROY: '1', VAST_SWEEP_STOPPED_HOURS: '0.1' })).toMatchObject({ destroy: true, stoppedMaxMs: 24 * H });
    expect(vastSweepFromEnv({ VAST_SWEEP: '0' }).on).toBe(false);
  });
});

function fakeVast(account: { credit: number; instances: Array<Record<string, unknown>> }) {
  const calls: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const path = url.replace('https://console.vast.ai/api/v0', '');
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/users/current/') return new Response(JSON.stringify({ credit: account.credit }));
    if (path === '/instances/' && (init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ instances: account.instances }));
    const del = /^\/instances\/(\d+)\/$/.exec(path);
    if (del && init?.method === 'DELETE') {
      account.instances = account.instances.filter(i => String(i.id) !== del[1]);
      return new Response('{}');
    }
    if (del && init?.method === 'PUT') return new Response(JSON.stringify({ success: true }));
    return new Response('not found', { status: 404 });
  };
  return { calls, backend: new VastDeploymentBackend('k', { fetch, now: () => NOW }) };
}

const raw = (id: number, label: string, actual: string, intended: string) => ({
  id, label, actual_status: actual, intended_status: intended, gpu_name: 'RTX A4500', dph_total: 0.139, storage_total_cost: 0.0167, start_date: (NOW - 480 * H) / 1000,
});

describe('VastSweep over a fake Vast API', () => {
  it('dry run: lists the stopped undeclared instance as «would destroy» and deletes nothing', async () => {
    const account = { credit: 0, instances: [raw(54045930, 'voice-gpu@dev', 'offline', 'stopped'), raw(7, 'aigw:prod:parle-speech', 'running', 'running')] };
    const { backend, calls } = fakeVast(account);
    const logs: Array<[string, Record<string, unknown> | undefined]> = [];
    const sweep = new VastSweep({ vast: backend, limits: { ...limits, destroy: false }, now: () => NOW, log: (m, d) => logs.push([m, d]) });
    const result = await sweep.run();
    expect(result.verdicts.find(v => v.id === '54045930')).toMatchObject({ action: 'destroy', declared: false, diskUsdPerDay: 0.4 });
    expect(result.destroyed).toEqual([]);
    expect(calls.some(c => c.startsWith('DELETE'))).toBe(false);
    expect(logs.filter(([m]) => m === 'vast-sweep: would destroy instance').map(([, d]) => d?.id)).toEqual(['54045930']);
    expect(logs.filter(([m]) => m === 'vast-sweep: no credit')).toHaveLength(1);
    expect(backend.creditIssue()).not.toBeNull();
  });

  it('destroy on: deletes only the stopped one, the running one stays; logs before and after', async () => {
    const account = { credit: 0, instances: [raw(54045930, 'voice-gpu@dev', 'offline', 'stopped'), raw(8, 'someone', 'running', 'running')] };
    const { backend, calls } = fakeVast(account);
    const logs: string[] = [];
    const sweep = new VastSweep({ vast: backend, limits, now: () => NOW, log: m => logs.push(m) });
    const result = await sweep.run();
    expect(result.destroyed).toEqual(['54045930']);
    expect(calls.filter(c => c.startsWith('DELETE'))).toEqual(['DELETE /instances/54045930/']);
    expect(account.instances.map(i => i.id)).toEqual([8]);
    expect(logs).toEqual(expect.arrayContaining(['vast-sweep: destroying instance', 'vast-sweep: instance destroyed', 'vast-sweep: undeclared instance running']));
    expect(logs.indexOf('vast-sweep: destroying instance')).toBeLessThan(logs.indexOf('vast-sweep: instance destroyed'));
  });

  it('with credit, keeps the stopped clock across a restart (state file) and destroys after 24 h', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'vast-sweep-')), 'vast-sweep.json');
    const account = { credit: 50, instances: [raw(1, 'old-script', 'exited', 'stopped')] };
    let now = NOW;
    const make = () => new VastSweep({ vast: fakeVast(account).backend, limits, statePath, now: () => now });
    expect((await make().run()).destroyed).toEqual([]);
    now += 25 * H;
    expect((await make().run()).destroyed).toEqual(['1']);
  });

  it('alerts the missing credit once, not on every cycle', async () => {
    const account = { credit: 0, instances: [raw(9, 'aigw:prod:x', 'running', 'running')] };
    const logs: string[] = [];
    const sweep = new VastSweep({ vast: fakeVast(account).backend, limits, now: () => NOW, log: m => logs.push(m) });
    await sweep.run();
    await sweep.run();
    expect(logs.filter(m => m === 'vast-sweep: no credit')).toHaveLength(1);
  });
});

describe('Vast power-on without credit', () => {
  it('startReplica refuses with insufficient_credit before calling /start', async () => {
    const { backend, calls } = fakeVast({ credit: 0, instances: [] });
    await expect(backend.startReplica({ id: '5' } as never)).rejects.toThrow(/insufficient_credit/);
    expect(calls.some(c => c.startsWith('PUT'))).toBe(false);
  });
});

describe('ops alerts for the credit and the sweep', () => {
  it('sends the Vast credit alert once until the credit is back', () => {
    const sent: OpsAlert[] = [];
    let t = NOW;
    const alerts = createOpsAlerts(a => { sent.push(a); }, () => t);
    alerts.fromDeploymentLog('vast-sweep: no credit', { provider: 'vast', balanceUsd: 0 });
    t += 5 * H;
    alerts.fromDeploymentLog('deployments: create failed', { deployment: 'x', error: 'insufficient_credit: Vast credit $0.00' });
    alerts.fromDeploymentLog('deployments: provider credit exhausted', { provider: 'vast' });
    return Promise.resolve().then(() => Promise.resolve()).then(() => {
      expect(sent.filter(a => a.event === 'provider.credit_exhausted')).toHaveLength(1);
      alerts.fromDeploymentLog('deployments: provider credit back', { provider: 'vast' });
      alerts.fromDeploymentLog('deployments: provider credit exhausted', { provider: 'vast' });
    }).then(() => Promise.resolve()).then(() => {
      expect(sent.filter(a => a.event === 'provider.credit_exhausted')).toHaveLength(2);
    });
  });

  it('turns sweep logs into alerts keyed by instance', async () => {
    const sent: OpsAlert[] = [];
    const alerts = createOpsAlerts(a => { sent.push(a); }, () => NOW);
    alerts.fromDeploymentLog('vast-sweep: destroying instance', { id: '54045930' });
    alerts.fromDeploymentLog('vast-sweep: instance destroyed', { id: '54045930' });
    alerts.fromDeploymentLog('vast-sweep: would destroy instance', { id: '1' });
    alerts.fromDeploymentLog('vast-sweep: would destroy instance', { id: '1' });
    await new Promise(r => setTimeout(r, 0));
    expect(sent.map(a => `${a.event}|${a.key}`)).toEqual(['vast.destroying|54045930', 'vast.destroyed|54045930', 'vast.would_destroy|1']);
  });
});
