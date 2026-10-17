import { afterEach, describe, expect, it } from 'vitest';
import {
  BOOT_LOG_LINES, BootTracker, bootHistoryFile, bootPhaseOf, bootStates, expectedPhaseMinutes, logText, PHASE_DEFAULT_MINUTES, pullLimitMinutes,
  SLOW_PULL_FLOOR_MINUTES, type BootHistory, type BootRecord,
} from '../../../src/deployments/boot-track';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { FakeCloud, until } from './_fake-cloud';

const MIN = 60_000;
const T0 = Date.parse('2026-10-13T10:00:00Z');

describe('boot phases', () => {
  it('maps provider state and probe result to the phase the replica is in', () => {
    expect(bootPhaseOf({ state: 'starting', ip: null }, undefined)).toBe('provisioning');
    expect(bootPhaseOf({ state: 'starting', ip: null, providerStatus: 'loading' }, undefined)).toBe('pulling');
    expect(bootPhaseOf({ state: 'running', ip: null }, undefined)).toBe('provisioning');
    expect(bootPhaseOf({ state: 'running', ip: '1.2.3.4' }, { everReady: false, last: 'down' })).toBe('starting');
    expect(bootPhaseOf({ state: 'running', ip: '1.2.3.4' }, { everReady: false, last: 'busy' })).toBe('loading');
    expect(bootPhaseOf({ state: 'running', ip: '1.2.3.4' }, { everReady: true, last: 'busy' })).toBe('ready');
  });

  it('expects a phase to take its default, or 1.5× the median of past ready boots', () => {
    expect(expectedPhaseMinutes('loading', [])).toBe(PHASE_DEFAULT_MINUTES.loading);
    const past: BootRecord[] = [4, 4, 5].map((m, i) => ({
      replicaId: `r${i}`, startedAt: 0, endedAt: (2 + m) * MIN, result: 'ready', reason: null,
      phases: [{ phase: 'starting', at: 0 }, { phase: 'loading', at: 2 * MIN }, { phase: 'ready', at: (2 + m) * MIN }],
    }));
    expect(expectedPhaseMinutes('loading', past)).toBe(6);
    expect(expectedPhaseMinutes('loading', [{ ...past[0]!, result: 'failed' }])).toBe(PHASE_DEFAULT_MINUTES.loading);
  });

  it('is stuck once the phase passes its expected time, or the whole boot passes the boot timeout', () => {
    const at = (phases: Array<[string, number]>) => [{ replicaId: 'r', phases: phases.map(([phase, ago]) => ({ phase: phase as 'loading', at: T0 - ago * MIN })) }];
    const state = (phases: Array<[string, number]>, timeout = 30) => bootStates(at(phases), [], T0, timeout)[0]!;
    expect(state([['starting', 12], ['loading', 9]]).stuck).toBe(false);
    expect(state([['starting', 12], ['loading', 11]])).toMatchObject({ stuck: true, phase: 'loading', expectedMinutes: 10 });
    expect(state([['provisioning', 31], ['loading', 1]]).stuck).toBe(true);
    expect(bootStates(at([['ready', 1]]), [], T0, 30)).toEqual([]);
  });

  it('a pull slower than the host bandwidth promises is stuck early: 4× its download, at least 8 min, never later than history', () => {
    expect(pullLimitMinutes(15, undefined)).toBe(15);
    expect(pullLimitMinutes(15, 1)).toBe(SLOW_PULL_FLOOR_MINUTES);
    expect(pullLimitMinutes(15, 2.5)).toBe(10);
    expect(pullLimitMinutes(15, 6)).toBe(15);
    const pulling = (minutes: number, expectedPull?: number) => bootStates(
      [{ replicaId: 'r', phases: [{ phase: 'pulling', at: T0 - minutes * MIN }] }], [], T0, 35, () => expectedPull,
    )[0]!;
    // 15/10/2026: two Bulgarian hosts sat 15 min in pulling; a 2000 Mbps host promises the 22.3 GB image in 1.5 min.
    expect(pulling(9, 1.5)).toMatchObject({ stuck: true, expectedMinutes: SLOW_PULL_FLOOR_MINUTES });
    expect(pulling(9).stuck).toBe(false);
    // Poland, 894 Mbps (3.3 min promised), pulled in 10.4 min: kept.
    expect(pulling(10.4, 3.3).stuck).toBe(false);
  });

  it('a history of hosts that had the image cached never limits a fresh pull below SLOW_PULL_FLOOR_MINUTES', () => {
    const cached: BootRecord[] = [0.4, 0.5, 0.6].map((m, i) => ({
      replicaId: `r${i}`, startedAt: 0, endedAt: (m + 3) * MIN, result: 'ready', reason: null,
      phases: [{ phase: 'pulling', at: 0 }, { phase: 'loading', at: m * MIN }, { phase: 'ready', at: (m + 3) * MIN }],
    }));
    expect(expectedPhaseMinutes('pulling', cached)).toBe(SLOW_PULL_FLOOR_MINUTES);
    expect(expectedPhaseMinutes('loading', cached)).toBe(5);
    const fresh = bootStates([{ replicaId: 'r', phases: [{ phase: 'pulling', at: T0 - 2.6 * MIN }] }], cached, T0, 45)[0]!;
    expect(fresh).toMatchObject({ stuck: false, expectedMinutes: SLOW_PULL_FLOOR_MINUTES });
  });
});

describe('BootTracker', () => {
  it('records placing → phases → ready as one boot, keeps the last 5, and the last 100 log lines', () => {
    const t = new BootTracker();
    t.placingStart('d', T0);
    t.phase('d', 'r1', 'provisioning', T0 + 2 * MIN, T0 + 2 * MIN);
    t.phase('d', 'r1', 'provisioning', T0 + 3 * MIN, T0 + 2 * MIN);
    t.phase('d', 'r1', 'loading', T0 + 5 * MIN, T0 + 2 * MIN);
    expect(t.view('d').active).toEqual([{ replicaId: 'r1', phases: [
      { phase: 'placing', at: T0 }, { phase: 'provisioning', at: T0 + 2 * MIN }, { phase: 'loading', at: T0 + 5 * MIN },
    ] }]);
    t.phase('d', 'r1', 'ready', T0 + 9 * MIN, T0 + 2 * MIN);
    expect(t.view('d').active).toEqual([]);
    expect(t.view('d').past[0]).toMatchObject({ replicaId: 'r1', result: 'ready', startedAt: T0, endedAt: T0 + 9 * MIN });
    for (let i = 0; i < 7; i++) { t.placingStart('d', T0); t.placingFailed('d', `out_of_stock ${i}`, T0 + MIN); }
    expect(t.view('d').past.map(p => p.reason)).toEqual(['out_of_stock 6', 'out_of_stock 5', 'out_of_stock 4', 'out_of_stock 3', 'out_of_stock 2']);
    for (let i = 0; i < 150; i++) t.line('d', null, `line ${i}`, T0);
    expect(t.view('d').log).toHaveLength(BOOT_LOG_LINES);
    expect(t.view('d').log.at(-1)!.text).toBe('line 149');
    expect(t.view('other').log).toEqual([]);
  });

  it('a released booting replica is a failed or an interrupted boot', () => {
    const t = new BootTracker();
    t.phase('d', 'a', 'starting', T0, T0);
    t.phase('d', 'b', 'starting', T0, T0);
    t.finish('a', 'boot-timeout', T0 + MIN);
    t.finish('b', 'scale-down', T0 + MIN);
    expect(t.view('d').past.map(p => [p.replicaId, p.result, p.reason])).toEqual([['b', 'interrupted', 'scale-down'], ['a', 'failed', 'boot-timeout']]);
  });

  it('log lines carry scalar fields only, never objects such as env', () => {
    expect(logText('deployments: create failed', { deployment: 'd', id: 'r', error: 'boom', env: { HF_TOKEN: 'x' }, n: 3 })).toBe('create failed error=boom n=3');
  });
});

describe('boot history across a restart', () => {
  const dirs: string[] = [];
  afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }); });

  function booted(t: BootTracker, replica: string, at: number) {
    t.phase('d', replica, 'provisioning', at, at);
    t.phase('d', replica, 'loading', at + 4 * MIN, at);
    t.phase('d', replica, 'ready', at + 9 * MIN, at);
  }

  it('saves the past boots and the log to a file and a new tracker gets them back, newest kept last, capped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'boots-'));
    dirs.push(dir);
    const path = join(dir, 'boot-history.json');
    const before = new BootTracker();
    for (let i = 0; i < 4; i++) booted(before, `r${i}`, T0 + i * 60 * MIN);
    const source = (t: BootTracker) => ({ bootHistory: () => t.history(), restoreBootHistory: (h: Partial<BootHistory>) => t.restore(h) });
    await bootHistoryFile(path, source(before)).save();
    const after = new BootTracker();
    booted(after, 'r-new-1', T0 + 10 * 60 * MIN);
    booted(after, 'r-new-2', T0 + 11 * 60 * MIN);
    await bootHistoryFile(path, source(after)).load();
    const view = after.view('d');
    expect(view.past.map(b => b.replicaId)).toEqual(['r-new-2', 'r-new-1', 'r3', 'r2', 'r1']);
    expect(view.log.at(-1)!.text).toBe('phase ready');
    expect(view.log.length).toBeLessThanOrEqual(BOOT_LOG_LINES);
    expect(expectedPhaseMinutes('loading', view.past)).toBe(8);
    after.restore({ past: { d: 'garbage' as never }, lines: undefined });
    expect(after.view('d').past).toHaveLength(5);
    await bootHistoryFile(join(dir, 'missing.json'), source(new BootTracker())).load();
  });
});

describe('controller boot tracking', () => {
  const controllers: DeploymentController[] = [];
  const clouds: FakeCloud[] = [];
  afterEach(async () => {
    for (const c of controllers.splice(0)) await c.stop();
    for (const c of clouds.splice(0)) await c.closeAll();
  });

  async function make() {
    const cloud = new FakeCloud();
    const c = new DeploymentController({ backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20 });
    await c.init();
    controllers.push(c);
    clouds.push(cloud);
    return { c, cloud };
  }

  it('a boot shows its phases while it runs and lands in the past boots once ready, with the controller lines in the log', async () => {
    const { c, cloud } = await make();
    cloud.bootMs = 400;
    await c.put('g', { image: 'me/app:1', port: 8000, minReplicas: 1 });
    c.start();
    await until(() => (c.get('g')!.boot.active[0]?.phases.length ?? 0) > 0);
    expect(c.get('g')!.boot.active[0]!.stuck).toBe(false);
    await until(() => c.get('g')!.status === 'ready');
    await until(() => c.get('g')!.boot.past.length === 1);
    expect(c.get('g')!.boot.past[0]).toMatchObject({ result: 'ready' });
    expect(c.get('g')!.boot.past[0]!.phases.at(-1)!.phase).toBe('ready');
    expect(c.bootLog('g').map(l => l.text)).toEqual(expect.arrayContaining([expect.stringMatching(/^creating replica/), expect.stringMatching(/^replica ready/)]));
  });

  it('a failed create is a failed boot with the error, and the view says when it retries', async () => {
    const { c, cloud } = await make();
    cloud.failCreate = 'out_of_stock: no offer';
    await c.put('g', { image: 'me/app:1', port: 8000, minReplicas: 1 });
    c.start();
    await until(() => c.get('g')!.boot.past.length === 1);
    expect(c.get('g')!.boot.past[0]).toMatchObject({ replicaId: null, result: 'failed', reason: expect.stringMatching(/out of stock/) });
    expect(c.get('g')!.boot.retryAt).toBeGreaterThan(Date.now());
    expect(c.bootLog('g').some(l => /create failed/.test(l.text))).toBe(true);
  });
});
