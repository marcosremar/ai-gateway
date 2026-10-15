import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_GPU_POLICY, type GpuPolicy } from '../../../src/config/access-keys';
import { ClientGpu, type GpuStarter } from '../../../src/deployments/client-gpu';
import type { DeploymentView } from '../../../src/deployments/types';

const MIN = 60_000;
const DEV: GpuPolicy = { ...DEFAULT_GPU_POLICY, canStartGpu: true };
const KEY = { keyId: 'key-dev', user: 'parle' };

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

function fakeController(opts: { price?: number; maxEurPerHour?: number; warmSchedule?: unknown[] } = {}) {
  let t = Date.parse('2026-10-10T12:00:00Z');
  const calls: string[] = [];
  const state = { replicas: 0, warm: null as null | { replicas: number; until: string }, lastRequestAt: null as number | null, sessions: 0 };
  const view = (): DeploymentView => ({
    name: 'speech-test', app: 'parle', status: state.replicas ? 'ready' : 'scaled-to-zero', warm: state.warm, sessions: state.sessions, realtime: null,
    lastRequestAt: state.lastRequestAt ? new Date(state.lastRequestAt).toISOString() : null,
    spec: { maxEurPerHour: opts.maxEurPerHour ?? 1, warmSchedule: opts.warmSchedule } as never,
    replicas: Array.from({ length: state.replicas }, (_, i) => ({ id: `r${i}`, phase: 'ready', pricePerHour: opts.price ?? 0.8 })) as never,
  } as unknown as DeploymentView);
  const controller: GpuStarter = {
    get: name => (name === 'speech-test' ? view() : null),
    list: () => [view()],
    warm: async (_name, replicas, untilMinutes) => {
      calls.push(`warm ${replicas} ${Math.round(untilMinutes)}`);
      state.replicas = Math.max(state.replicas, replicas);
      state.warm = { replicas, until: new Date(t + untilMinutes * MIN).toISOString() };
      state.lastRequestAt = t;
      return view();
    },
    park: async () => { calls.push('park'); state.replicas = 0; state.warm = null; state.lastRequestAt = null; return view(); },
  };
  return { controller, calls, state, now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('client GPU start (owner, 10/10/2026): a client turns a GPU on on purpose, for a while, under a daily cap', () => {
  it('start keeps one GPU up for the minutes asked, then parks it once idle for the short idle', async () => {
    const f = fakeController();
    const gpu = new ClientGpu(f.controller, { now: f.now });
    const out = await gpu.start(KEY, DEV, 'speech-test', 30);
    expect(f.calls).toEqual(['warm 1 30']);
    expect(out).toMatchObject({ deployment: 'speech-test', idleMinutes: 10, capEur: 5 });
    f.advance(29 * MIN);
    await gpu.tick();
    expect(f.calls).not.toContain('park');
    f.advance(2 * MIN);
    await gpu.tick();
    expect(f.calls).toContain('park');
    expect(gpu.report().running).toEqual([]);
  });

  it('a GPU still in use at the end of the window stays until it is idle for startIdleMinutes', async () => {
    const f = fakeController();
    const gpu = new ClientGpu(f.controller, { now: f.now });
    await gpu.start(KEY, DEV, 'speech-test', 30);
    f.advance(28 * MIN);
    f.state.lastRequestAt = f.now();
    f.advance(3 * MIN);
    await gpu.tick();
    expect(f.calls).not.toContain('park');
    f.advance(8 * MIN);
    await gpu.tick();
    expect(f.calls).toContain('park');
  });

  it('extend adds minutes to the window of the same key; without a start it is a 404', async () => {
    const f = fakeController();
    const gpu = new ClientGpu(f.controller, { now: f.now });
    await expect(gpu.start(KEY, DEV, 'speech-test', 10, true)).rejects.toMatchObject({ status: 404 });
    await gpu.start(KEY, DEV, 'speech-test', 30);
    f.advance(20 * MIN);
    const out = await gpu.start(KEY, DEV, 'speech-test', 30, true);
    expect(out.until).toBe(new Date(f.now() + 40 * MIN).toISOString());
    expect(f.calls).toEqual(['warm 1 30', 'warm 1 40']);
    f.advance(35 * MIN);
    await gpu.tick();
    expect(f.calls).not.toContain('park');
    f.advance(10 * MIN);
    await gpu.tick();
    expect(f.calls).toContain('park');
  });

  it('the daily cap refuses a start with 402 and says what to do', async () => {
    const f = fakeController({ maxEurPerHour: 2 });
    const gpu = new ClientGpu(f.controller, { now: f.now });
    await expect(gpu.start(KEY, DEV, 'speech-test', 180)).rejects.toMatchObject({ status: 402, message: expect.stringMatching(/cap €5.*raise gpuDailyEur/) });
    expect(f.calls).toEqual([]);
    await expect(gpu.start(KEY, { ...DEV, gpuDailyEur: null }, 'speech-test', 180)).resolves.toBeTruthy();
  });

  it('spend is counted from the running replicas, and reaching the cap parks the GPU before the window ends', async () => {
    const f = fakeController({ price: 3, maxEurPerHour: 1 });
    const gpu = new ClientGpu(f.controller, { now: f.now });
    await gpu.start(KEY, DEV, 'speech-test', 120);
    f.advance(60 * MIN);
    await gpu.tick();
    expect(gpu.spentToday('key-dev')).toBeCloseTo(3, 5);
    expect(f.calls).not.toContain('park');
    f.advance(40 * MIN);
    await gpu.tick();
    expect(f.calls).toContain('park');
    expect(gpu.report('parle').spentEur['key-dev']).toBe(5);
    expect(gpu.report('other').spentEur).toEqual({});
  });

  it('never parks a GPU the class needs: a warm schedule, an active session, or another warm window keep it', async () => {
    const scheduled = fakeController({ warmSchedule: [{ start: '00:00', end: '23:59', minReplicas: 1, timeZone: 'UTC' }] });
    const a = new ClientGpu(scheduled.controller, { now: scheduled.now });
    await a.start(KEY, DEV, 'speech-test', 10);
    scheduled.advance(30 * MIN);
    await a.tick();
    expect(scheduled.calls).not.toContain('park');

    const session = fakeController();
    const b = new ClientGpu(session.controller, { now: session.now });
    await b.start(KEY, DEV, 'speech-test', 10);
    session.state.sessions = 1;
    session.advance(30 * MIN);
    await b.tick();
    expect(session.calls).not.toContain('park');

    const classWarm = fakeController();
    classWarm.state.replicas = 2;
    classWarm.state.warm = { replicas: 2, until: new Date(classWarm.now() + 120 * MIN).toISOString() };
    const c = new ClientGpu(classWarm.controller, { now: classWarm.now });
    await c.start(KEY, DEV, 'speech-test', 10);
    expect(classWarm.calls).toEqual(['warm 2 120']);
    classWarm.advance(30 * MIN);
    await c.tick();
    expect(classWarm.calls).not.toContain('park');
  });

  it('spend and running starts survive a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aigw-cgpu-'));
    dirs.push(dir);
    const f = fakeController({ price: 1 });
    const first = new ClientGpu(f.controller, { now: f.now, path: join(dir, 'client-gpu.json') });
    await first.start(KEY, DEV, 'speech-test', 60);
    f.advance(30 * MIN);
    await first.tick();
    const second = new ClientGpu(f.controller, { now: f.now, path: join(dir, 'client-gpu.json') });
    await second.load();
    expect(second.spentToday('key-dev')).toBeCloseTo(0.5, 5);
    expect(second.report().running).toHaveLength(1);
  });

  it('minutes must be 1–240', async () => {
    const f = fakeController();
    const gpu = new ClientGpu(f.controller, { now: f.now });
    for (const bad of [0, 241, 1.5, '30', undefined]) await expect(gpu.start(KEY, DEV, 'speech-test', bad)).rejects.toMatchObject({ status: 400 });
    await expect(gpu.start(KEY, DEV, 'nope', 10)).rejects.toMatchObject({ status: 404 });
  });
});

describe('start lands on the test copy for a capped key', () => {
  function twoDeployments() {
    const calls: string[] = [];
    const view = (name: string, extra: Record<string, unknown> = {}) => ({
      name, app: 'parle', status: 'scaled-to-zero', warm: null, sessions: 0, realtime: null, lastRequestAt: null, replicas: [],
      spec: { maxEurPerHour: name === 'parle-speech' ? 2 : 0.9, ...extra },
    } as unknown as DeploymentView);
    const all = [view('parle-speech'), view('parle-speech-test', { testFor: 'parle-speech' })];
    const controller: GpuStarter = {
      get: name => all.find(d => d.name === name) ?? null,
      list: () => all,
      warm: async (name, replicas, minutes) => { calls.push(`warm ${name} ${replicas} ${Math.round(minutes)}`); return all.find(d => d.name === name)!; },
      park: async name => all.find(d => d.name === name)!,
    };
    return { controller, calls };
  }

  it('a capped (dev) key asking for the production GPU gets the test copy; the class client (no cap) gets production', async () => {
    const { controller, calls } = twoDeployments();
    const gpu = new ClientGpu(controller);
    expect((await gpu.start(KEY, DEV, 'parle-speech', 30)).deployment).toBe('parle-speech-test');
    expect((await gpu.start({ keyId: 'env-parle', user: 'parle' }, { ...DEV, gpuDailyEur: null }, 'parle-speech', 30)).deployment).toBe('parle-speech');
    expect(calls).toEqual(['warm parle-speech-test 1 30', 'warm parle-speech 1 30']);
  });
});
