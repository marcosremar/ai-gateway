import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploymentController } from '../../../src/deployments/controller';
import { DECLARED_DEPLOYMENTS, DeclaredDeploymentReconciler } from '../../../src/deployments/declared';
import { HttpReplicaProbe } from '../../../src/deployments/http';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { BUILTIN_PROFILES } from '../../../src/deployments/profiles';
import { buildSpec } from '../../../src/deployments/spec';
import { EUR_TO_USD, VastDeploymentBackend } from '../../../src/deployments/vast-backend';
import { AppError, AppRegistry, MemoryAppStore } from '../../../src/deployments/apps';
import { placementsOf } from '../../../src/deployments/placements';
import { createOpsAlerts, type OpsAlert } from '../../../src/telemetry/ops-alerts';
import { FakeCloud, until } from './_fake-cloud';

const NAME = 'babelcast-3090';
const HOUR = 60 * 60_000;
const decl = DECLARED_DEPLOYMENTS.find(d => d.name === NAME)!;
const controllers: DeploymentController[] = [];
const clouds: FakeCloud[] = [];
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

afterEach(async () => {
  for (const c of controllers.splice(0)) await c.stop();
  for (const c of clouds.splice(0)) await c.closeAll();
});

async function setup(log?: (msg: string, data?: Record<string, unknown>) => void) {
  const clock = { t: Date.parse('2026-10-13T10:00:00Z') };
  const now = () => clock.t;
  const scaleway = new FakeCloud(now);
  const vast = new FakeCloud(now, 'vast');
  vast.marketPriced = true;
  vast.price = 0.18;
  const controller = new DeploymentController({
    backends: { scaleway, vast }, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test',
    reconcileMs: 20, pinnedIdleMaxMs: HOUR, now, ...(log ? { log } : {}),
  });
  await controller.init();
  controllers.push(controller);
  clouds.push(scaleway, vast);
  const reconciler = new DeclaredDeploymentReconciler({ target: controller, env: {}, declarations: [decl] });
  return { controller, scaleway, vast, clock, reconciler };
}

describe('babelcast-3090 (owner, 13/10/2026): one pinned RTX 3090 on Vast for babelcast and the agents tests', () => {
  it('is declared on Vast only, at most €0.30/h (owner, 15/10/2026), pinned by minReplicas at creation, owned by babelcast', async () => {
    const x = await setup();
    expect((await x.reconciler.reconcile())[0].state).toBe('applied');
    const spec = x.controller.specOf(NAME)!;
    expect(spec).toMatchObject({
      provider: 'vast', machineType: 'RTX 3090', minReplicas: 1, maxReplicas: 1, idleMinutes: 60, idleAction: 'delete',
      testFor: 'babelcast-speech', image: 'ghcr.io/marcosremar/speech-stack:20261011-0200',
    });
    expect(spec.maxEurPerHour).toBeLessThanOrEqual(0.3);
    expect(placementsOf(spec).map(p => p.provider)).toEqual(['vast']);
    expect(spec.warmSchedule).toBeUndefined();
    expect(x.controller.get(NAME)!.app).toBe('babelcast');
  });

  it('wakes to one replica by itself, parks after 60 min with no request, and the next request wakes it', async () => {
    const x = await setup();
    await x.reconciler.reconcile();
    x.controller.start();
    await until(() => x.controller.get(NAME)!.status === 'ready');
    expect(x.vast.created).toHaveLength(1);
    expect(x.scaleway.created).toHaveLength(0);
    expect(x.controller.get(NAME)!.pinned).toEqual({ idleMinutes: 60, parked: false });
    expect(x.controller.get(NAME)!.replicas[0]).toMatchObject({ provider: 'vast', pricePerHour: 0.18 });

    x.clock.t += 59 * 60_000;
    await wait(100);
    expect(x.vast.released).toHaveLength(0);

    x.clock.t += 2 * 60_000;
    await until(() => x.vast.released.length === 1);
    expect(x.controller.get(NAME)!.pinned).toEqual({ idleMinutes: 60, parked: true });
    await wait(100);
    expect(x.vast.created).toHaveLength(1);

    const lease = await x.controller.acquire(NAME, { waitMs: 3000 });
    lease.done();
    expect(x.vast.created).toHaveLength(2);
    expect(x.controller.get(NAME)!.pinned!.parked).toBe(false);
  });

  it('the operator toggle owns minReplicas: unpinned stays unpinned, the declared fields still come back', async () => {
    const x = await setup();
    await x.reconciler.reconcile();
    await x.controller.put(NAME, { minReplicas: 0, maxEurPerHour: 0.5 });
    expect((await x.reconciler.reconcile())[0].state).toBe('applied');
    expect(x.controller.specOf(NAME)).toMatchObject({ minReplicas: 0, maxEurPerHour: 0.3 });
    expect(x.controller.get(NAME)!.pinned).toBeNull();
    expect((await x.reconciler.reconcile())[0].state).toBe('in_sync');
  });

  it('with no offer it backs off instead of respawning, and alerts once', async () => {
    const alerts: OpsAlert[] = [];
    const ops = createOpsAlerts(a => alerts.push(a));
    const x = await setup((msg, data) => ops.fromDeploymentLog(msg, data));
    const create = vi.spyOn(x.vast, 'createReplica');
    x.vast.failCreate = 'out_of_stock: no vast offer for RTX 3090 under €0.19/h near FR';
    await x.reconciler.reconcile();
    x.controller.start();
    await until(() => create.mock.calls.length === 1);
    await wait(300);
    expect(create).toHaveBeenCalledTimes(1);
    expect(x.controller.get(NAME)!.autoscale.blockedBy).toMatch(/out of stock|back-off|retry/i);
    x.clock.t += 61_000;
    await until(() => create.mock.calls.length === 2);
    await wait(300);
    expect(create).toHaveBeenCalledTimes(2);
    await wait(10);
    expect(alerts.map(a => a.event)).toEqual(['deployment.out_of_stock']);
  });

  it('with no Vast credit it waits 10 min between tries and raises the credit alert', async () => {
    const alerts: OpsAlert[] = [];
    const ops = createOpsAlerts(a => alerts.push(a));
    const x = await setup((msg, data) => ops.fromDeploymentLog(msg, data));
    const create = vi.spyOn(x.vast, 'createReplica');
    x.vast.failCreate = 'insufficient_credit: Vast credit $0.40 is below the floor $1; top up the Vast account';
    await x.reconciler.reconcile();
    x.controller.start();
    await until(() => create.mock.calls.length === 1);
    x.clock.t += 9 * 60_000;
    await wait(300);
    expect(create).toHaveBeenCalledTimes(1);
    x.clock.t += 2 * 60_000;
    await until(() => create.mock.calls.length === 2);
    await wait(10);
    expect(alerts.map(a => a.event)).toEqual(['provider.credit_exhausted']);
  });
});

describe('babelcast-3090 price cap', () => {
  const profiles = new Map(BUILTIN_PROFILES.map(p => [p.name, p]));
  const spec = buildSpec(NAME, { profile: 'speech-stack', image: decl.image!.default, ...decl.spec, minReplicas: 1 }, { profiles });

  it('searches and rents only RTX 3090 offers at or under €0.30/h', async () => {
    const offers = [
      { id: 1, machine_id: 11, geolocation: 'Paris, FR', dph_total: 0.4, reliability2: 0.99, inet_down: 900, gpu_name: 'RTX 3090', cuda_max_good: 13 },
      { id: 2, machine_id: 12, geolocation: 'Lyon, FR', dph_total: 0.3, reliability2: 0.99, inet_down: 900, gpu_name: 'RTX 3090', cuda_max_good: 13 },
    ];
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/current/')) return new Response('{"credit": 20}');
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith('/bundles/')) return new Response(JSON.stringify({ offers }));
      return new Response(JSON.stringify({ success: true, new_contract: 9 }));
    };
    const backend = new VastDeploymentBackend('vast-key', { fetch: fetchImpl, now: () => 1_000 });
    const machine = await backend.createReplica({ spec, replicaToken: 'x'.repeat(32), cloudInit: '', namespace: 'prod' });
    expect(calls[0].body).toMatchObject({ gpu_name: { in: ['RTX 3090'] } });
    expect((calls[0].body!.dph_total as { lte: number }).lte).toBeLessThanOrEqual(0.3 * EUR_TO_USD);
    expect(calls[1].url).toMatch(/\/asks\/2\/$/);
    expect(machine.pricePerHour!).toBeLessThanOrEqual(0.3);
  });
});

describe('student audio never reaches babelcast-3090', () => {
  const appOf = (d: string) => (d === NAME || d === 'babelcast-speech' ? 'babelcast' : d.startsWith('parle-') ? 'parle' : null);
  const route = (deployment: string) => ({ stt: { 'parle-stt': [{ provider: 'deployment', deployment, model: 'whisper-large-v3-turbo' }] } });

  it('no route of parle may name it, not even one an admin sends', async () => {
    const apps = new AppRegistry(new MemoryAppStore());
    const err = await apps.putRoutes('parle', route(NAME), { appOf }).catch(e => e as AppError);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(403);
    expect(apps.get('parle')).toBeNull();
    await expect(apps.putRoutes('parle', route('parle-speech'), { appOf })).resolves.toBeTruthy();
  });

  it('babelcast routes it first and keeps its chain and the cloud behind it', async () => {
    const apps = new AppRegistry(new MemoryAppStore());
    const { routes } = await apps.putRoutes('babelcast', {
      stt: { 'babelcast-stt': [
        { provider: 'deployment', deployment: NAME, model: 'whisper-large-v3-turbo' },
        { provider: 'deployment', deployment: 'babelcast-speech', model: 'whisper-large-v3-turbo' },
      ] },
    }, { appOf });
    const chain = routes.stt!['babelcast-stt'].map(e => (e.provider === 'deployment' ? `deployment:${e.deployment}` : e.provider));
    expect(chain.slice(0, 2)).toEqual([`deployment:${NAME}`, 'deployment:babelcast-speech']);
    expect(chain.slice(2)).toContain('openrouter');
  });

  it('no parle declaration places a replica on it (parle rents its own RTX 3090 since 14/10/2026), and it is no test copy of a parle deployment', () => {
    for (const d of DECLARED_DEPLOYMENTS.filter(x => x.app === 'parle' || x.name.startsWith('parle-'))) {
      expect(JSON.stringify(d)).not.toContain(NAME);
    }
    expect(decl.app).toBe('babelcast');
    expect(String(decl.spec.testFor).startsWith('parle-')).toBe(false);
  });
});
