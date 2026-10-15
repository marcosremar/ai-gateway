import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { deploymentsFromEnv } from '../../../src/deployments';
import { DeploymentController } from '../../../src/deployments/controller';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { CLASS_GPUS_PER_APP, GPU_CAP_RULE, MAX_GPU_PER_APP } from '../../../src/deployments/spec';
import type { ReplicaMachine } from '../../../src/deployments/types';
import { FakeCloud, until } from './_fake-cloud';

const MIN = 60_000;
const OUTSIDE_CLASS = Date.parse('2026-10-14T10:00:00Z');
const IN_CLASS = Date.parse('2026-10-14T14:41:00Z');
const CLASS_WINDOW = { days: [1, 2, 3, 4], start: '16:40', end: '20:30', timeZone: 'Europe/Paris' };
const GPU = {
  image: 'ghcr.io/me/speech:1', port: 8000, entrypoint: 'bash', args: ['/opt/s2s/start.sh'], provider: 'vast', machineType: 'RTX 3090', maxEurPerHour: 0.3,
  placements: [], idleAction: 'delete',
};
const APP: Record<string, string> = { 'parle-speech': 'parle', 'parle-speech-test': 'parle', 'babelcast-3090': 'babelcast', g: 'solo' };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

const controllers: DeploymentController[] = [];
const clouds: FakeCloud[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.stop();
  for (const c of clouds.splice(0)) await c.closeAll();
});

async function setup(opts: { classGpusPerApp?: Record<string, number> } = {}) {
  const clock = { t: OUTSIDE_CLASS };
  const vast = Object.assign(new FakeCloud(() => clock.t, 'vast'), { marketPriced: true, price: 0.28 });
  const most = new Map<string, number>();
  const create = vast.createReplica.bind(vast);
  vast.createReplica = async (input) => {
    const app = APP[input.spec.name]!;
    const held = [...vast.machines.values()].filter(m => APP[m.machine.deployment] === app).length;
    most.set(app, Math.max(most.get(app) ?? 0, held + 1));
    return create(input);
  };
  const c = new DeploymentController({
    backends: { vast }, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 20, now: () => clock.t,
    maxGpuPerApp: MAX_GPU_PER_APP, ...opts,
  });
  await c.init();
  controllers.push(c);
  clouds.push(vast);
  return { c, vast, clock, most };
}

async function classAndTests() {
  const x = await setup();
  await x.c.put('babelcast-3090', { ...GPU, minReplicas: 1, maxReplicas: 1 }, { app: 'babelcast' });
  await x.c.put('parle-speech', { ...GPU, maxReplicas: 2, warmSchedule: [{ ...CLASS_WINDOW, minReplicas: 2 }] }, { app: 'parle' });
  await x.c.put('parle-speech-test', { ...GPU, maxReplicas: 1, testFor: 'parle-speech' }, { app: 'parle' });
  x.c.start();
  await until(() => x.c.get('babelcast-3090')!.status === 'ready');
  await x.c.warm('parle-speech-test', 1, 720);
  await until(() => x.c.get('parle-speech-test')!.status === 'ready');
  return x;
}

describe(`${GPU_CAP_RULE}`, () => {
  it('the production gateway applies it', () => {
    const env = { VAST_API_KEY: 'v', RAILWAY_ENVIRONMENT_ID: 'e', DEPLOYMENTS_STATE_DIR: mkdtempSync(join(tmpdir(), 'aigw-cap-')) };
    const prod = deploymentsFromEnv(env, { userOf: () => null })!;
    expect((prod.controller as unknown as { opts: { maxGpuPerApp?: number } }).opts.maxGpuPerApp).toBe(1);
    prod.stopJanitor?.();
  });

  it('parle and babelcast each run one GPU at the same time; a second one for parle is refused and the cloud answers', async () => {
    const { c, vast, most } = await classAndTests();
    expect(() => c.wake('parle-speech')).toThrow(/^limite: 1 GPU por app — dono, 14\/10\/2026: app 'parle' already has 1 \(parle-speech-test\)/);
    await expect(c.acquire('parle-speech', { waitMs: 500 })).rejects.toMatchObject({ status: 409, code: 'reserved' });
    await wait(200);
    expect(vast.created.map(x => x.spec.name).sort()).toEqual(['babelcast-3090', 'parle-speech-test']);
    expect(Object.fromEntries(most)).toEqual({ babelcast: 1, parle: 1 });
  });

  it('in the class window parle-speech takes the parle GPU back from the test copy, never two; babelcast keeps its own', async () => {
    const { c, vast, clock, most } = await classAndTests();
    clock.t = IN_CLASS;
    await until(() => c.get('parle-speech')!.replicas.some(r => r.phase === 'ready'), 5000);
    expect(vast.releaseReasons).toContain('class-priority');
    expect(c.get('parle-speech-test')!.replicas).toHaveLength(0);
    await wait(200);
    expect(c.get('parle-speech')!.replicas).toHaveLength(1);
    expect(c.get('parle-speech')!.autoscale.blockedBy).toMatch(/app 'parle' already has 1 \(parle-speech\)/);
    expect(c.get('babelcast-3090')!.replicas).toHaveLength(1);
    await expect(c.warm('parle-speech-test', 1, 30)).rejects.toThrow(/keeps its GPU for 'parle-speech' during the class window/);
    expect(Object.fromEntries(most)).toEqual({ babelcast: 1, parle: 1 });
  });

  it('a warm floor with nothing ready races two offers as one GPU: the first ready stays, the other goes, never a third', async () => {
    const { c, vast } = await setup();
    const slow: string[] = [];
    const create = vast.createReplica.bind(vast);
    let n = 0;
    vast.createReplica = async (input) => {
      const first = ++n === 1;
      const m = await create(input);
      if (first) { vast.machines.get(m.id)!.bootedAt = Date.now() + 60_000; slow.push(m.id); }
      return m;
    };
    await c.put('parle-speech', { ...GPU, maxReplicas: 1, bootRace: 2 }, { app: 'parle' });
    await c.put('parle-speech-test', { ...GPU, maxReplicas: 1, testFor: 'parle-speech' }, { app: 'parle' });
    c.start();
    await c.warm('parle-speech', 1, 60);
    await until(() => c.get('parle-speech')!.replicas.some(r => r.phase === 'ready'));
    await until(() => vast.releaseReasons.includes('race-lost'));
    expect(vast.created.map(x => x.spec.name)).toEqual(['parle-speech', 'parle-speech']);
    expect(vast.released).toEqual(slow);
    await wait(200);
    expect(vast.created).toHaveLength(2);
    expect(vast.machines.size).toBe(1);
    expect(() => c.wake('parle-speech-test')).toThrow(/app 'parle' already has 1/);
  });

  it('regression: the warm floor ends mid-race (a /start shorter than the boot) and the race loser still goes when the first is ready', async () => {
    const { c, vast, clock } = await setup();
    vast.bootMs = 300;
    const slow: string[] = [];
    const create = vast.createReplica.bind(vast);
    let n = 0;
    vast.createReplica = async (input) => {
      const first = ++n === 1;
      const m = await create(input);
      if (first) { vast.machines.get(m.id)!.bootedAt = Date.now() + 60_000; slow.push(m.id); }
      return m;
    };
    await c.put('parle-speech', { ...GPU, maxReplicas: 1, bootRace: 2 }, { app: 'parle' });
    c.start();
    await c.warm('parle-speech', 1, 1);
    await until(() => vast.created.length === 2);
    clock.t += 2 * MIN;
    await until(() => c.get('parle-speech')!.replicas.some(r => r.phase === 'ready'));
    await until(() => vast.releaseReasons.includes('race-lost'), 1500);
    expect(vast.released).toEqual(slow);
    expect(vast.machines.size).toBe(1);
  });

  for (const order of ['after', 'before'] as const) {
    it(`regression: a race with one offer boots it; the second's out_of_stock (${order} the first lands) is no failure`, async () => {
      const { c, vast } = await setup();
      const create = vast.createReplica.bind(vast);
      let n = 0;
      vast.createReplica = async (input) => {
        if (++n === 1) {
          if (order === 'before') await wait(100);
          return create(input);
        }
        if (order === 'after') await wait(100);
        throw new Error('out_of_stock: every vast offer tried was taken (offer 1: no_such_ask)');
      };
      await c.put('parle-speech', { ...GPU, maxReplicas: 1, bootRace: 2 }, { app: 'parle' });
      c.start();
      await c.warm('parle-speech', 1, 60);
      await until(() => c.get('parle-speech')!.replicas.some(r => r.phase === 'ready'));
      expect(vast.created).toHaveLength(1);
      expect(c.get('parle-speech')!.boot.past.filter(b => b.result === 'failed')).toEqual([]);
    });
  }

  it('regression: both racers timing out together is one boot-timeout, not two (no 10-min back-off after the first race)', async () => {
    const { c, vast, clock } = await setup();
    vast.bootMs = 60 * MIN;
    await c.put('parle-speech', { ...GPU, maxReplicas: 1, bootRace: 2, autoRetryStuckBoot: false }, { app: 'parle' });
    c.start();
    await c.warm('parle-speech', 1, 120);
    await until(() => vast.created.length === 2);
    clock.t += 61 * MIN;
    await until(() => vast.releaseReasons.filter(r => r === 'boot-timeout').length === 2);
    await until(() => vast.created.length >= 3, 1500);
  });

  it('CLASS_GPUS_PER_APP { parle: 2 } keeps two parle GPUs in the class window only (off by default)', async () => {
    const { c, clock } = await setup({ classGpusPerApp: { parle: 2 } });
    await c.put('parle-speech', { ...GPU, maxReplicas: 1, warmSchedule: [{ ...CLASS_WINDOW, minReplicas: 1 }] }, { app: 'parle' });
    c.start();
    await wait(200);
    expect(c.get('parle-speech')!.replicas).toHaveLength(0);
    clock.t = IN_CLASS;
    await until(() => c.get('parle-speech')!.replicas.filter(r => r.phase === 'ready').length === 2);
    await wait(200);
    expect(c.get('parle-speech')!.replicas).toHaveLength(2);
    expect(CLASS_GPUS_PER_APP).toEqual({});
  });

  it('a stuck boot is released first and rented again only once the old machine is gone: never two', async () => {
    const { c, vast, clock } = await setup();
    vast.bootMs = 10 * MIN;
    const lingering: ReplicaMachine[] = [];
    const release = vast.releaseReplica.bind(vast);
    vast.releaseReplica = async (m, reason) => { vast.releaseReasons.push(reason); lingering.push(m); };
    await c.put('g', { ...GPU, minReplicas: 1, maxReplicas: 2 }, { app: 'solo' });
    c.start();
    await until(() => c.get('g')!.boot.active.some(b => b.replicaId && b.phase === 'starting'));
    clock.t += 16 * MIN;
    await until(() => lingering.length === 1);
    await wait(300);
    expect(vast.releaseReasons).toEqual(['boot-stuck']);
    expect(vast.created).toHaveLength(1);
    expect(c.get('g')!.autoscale.blockedBy).toMatch(/app 'solo' already has 1 \(g\)/);
    await release(lingering[0]!, 'boot-stuck');
    await until(() => vast.created.length === 2);
    expect(vast.machines.size).toBe(1);
  });
});
