import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentController, DeploymentError, STAGE_STRIKES } from '../../../src/deployments/controller';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { realtimeHealth } from '../../../src/gateway/proxy/health-view';
import { _resetExternalLoad, distinctSessions, noteRefusedSession, reportExternalLoad } from '../../../src/realtime/external-load';
import { createS2SRoute } from '../../../src/s2s/route';
import { fakeStages } from '../s2s/_fakes';
import { FakeCloud, until } from './_fake-cloud';

let now = 0;
const clouds: FakeCloud[] = [];
const servers: Server[] = [];
afterEach(async () => {
  _resetExternalLoad();
  for (const c of clouds.splice(0)) await c.closeAll();
  for (const s of servers.splice(0)) { s.closeAllConnections(); s.close(); }
});

async function speech(over: Record<string, unknown> = {}) {
  now = 1_000_000;
  const cloud = new FakeCloud(() => now);
  clouds.push(cloud);
  const controller = new DeploymentController({
    backend: cloud, store: new MemoryDeploymentStore(), probe: { ready: async () => true }, namespace: 'test', now: () => now,
  });
  await controller.init();
  await controller.put('speech', { profile: 'cpu-echo', minReplicas: 1, maxReplicas: 1, targetInflightPerReplica: 4, ...over });
  await until(async () => { await controller.reconcile(); return controller.get('speech')!.status === 'ready'; });
  const id = controller.get('speech')!.replicas[0].id;
  const sessions = (active: number) => reportExternalLoad('speech', id, active, 8, now);
  return { controller, cloud, id, sessions };
}

async function turn(controller: DeploymentController, traceparent?: string) {
  const fake = fakeStages();
  const route = createS2SRoute({ controller, deployment: 'speech', stagesFor: () => fake.stages, hedgeMs: 2_000 });
  const server = createServer((req, res) => { void route(req, res); });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'a.webm');
  form.set('config', JSON.stringify({ system: 'Seu Jorge', voice: 'br-m-08', language: 'pt' }));
  const started = performance.now();
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/s2s?format=ndjson`, { method: 'POST', body: form, ...(traceparent ? { headers: { traceparent } } : {}) });
  const events = (await res.text()).split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
  return { res, events, ms: performance.now() - started };
}

describe('a replica full of realtime sessions takes no overflow turn', () => {
  it('every realtime slot taken: the /v1/s2s turn is served by the fallback at once, as `saturated`, and the GPU is not touched', async () => {
    const x = await speech();
    x.sessions(8);
    const { res, events, ms } = await turn(x.controller);
    expect(res.status).toBe(200);
    expect(events[0]).toMatchObject({ type: 'route', provider: 'composite', fallback: 'saturated', from: 'deployment:speech' });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(ms).toBeLessThan(1_000);
    expect(x.cloud.machines.get(x.id)!.requests).toBe(0);
    expect(x.controller.hedgeDelayMs('speech', 1_500, 6_000)).toBe(1_500);
  });

  it('the refusal is demand for the autoscaler and never a strike for the stage', async () => {
    const x = await speech();
    x.sessions(8);
    for (let i = 0; i < STAGE_STRIKES + 1; i++) {
      await expect(x.controller.acquire('speech', { waitMs: 0, stage: 's2s' })).rejects.toMatchObject({ code: 'saturated' });
    }
    await x.controller.reconcile();
    const v = x.controller.get('speech')!;
    expect(v.autoscale.load).toBe(4 + STAGE_STRIKES + 1);
    expect(v.replicas[0].stagesOut).toEqual([]);
  });

  it('free realtime slots: the replica serves s2s turns, sessions and leases against one capacity', async () => {
    const x = await speech();
    x.sessions(4);
    const leases = [];
    for (let i = 0; i < 4; i++) leases.push(await x.controller.acquire('speech', { waitMs: 0, stage: 's2s' }));
    await expect(x.controller.acquire('speech', { waitMs: 0, stage: 's2s' })).rejects.toBeInstanceOf(DeploymentError);
    for (const l of leases) l.done('ok');
    x.sessions(0);
    for (let i = 0; i < 6; i++) leases.push(await x.controller.acquire('speech', { waitMs: 0 }));
    await expect(x.controller.acquire('speech', { waitMs: 0 })).rejects.toMatchObject({ code: 'saturated' });
  });

  it('a report the edge stopped refreshing no longer closes the replica', async () => {
    const x = await speech();
    x.sessions(8);
    now += 31_000;
    (await x.controller.acquire('speech', { waitMs: 0, stage: 's2s' })).done('ok');
  });
});

describe('the state is visible, in students', () => {
  it('view and /health details: sessions against slots, refused sessions, and the replica on its way', async () => {
    const x = await speech({ maxReplicas: 2, realtime: {} });
    expect(x.controller.get('speech')!.realtime).toEqual({ active: 0, capacity: 0, refusedSessions: 0, scalingOut: false });
    x.sessions(8);
    noteRefusedSession('speech', 'ana', now);
    noteRefusedSession('speech', 'ana', now);
    noteRefusedSession('speech', 'rui', now);
    x.controller.wake('speech');
    await x.controller.reconcile();
    expect(x.controller.get('speech')!.realtime).toEqual({ active: 8, capacity: 8, refusedSessions: 2, scalingOut: false });
    now += 20_000;
    x.sessions(8);
    x.controller.wake('speech');
    await x.controller.reconcile();
    const v = x.controller.get('speech')!;
    expect(v.realtime).toEqual({ active: 8, capacity: 8, refusedSessions: 2, scalingOut: true });
    expect(realtimeHealth([v])).toEqual([{
      deployment: 'speech', active: 8, capacity: 8, refusedSessions: 2, scalingOut: true, sessions: 0, replicas: 1, desiredReplicas: 2,
      reason: expect.stringMatching(/^load 4 > 75% of 1×4/), blockedBy: null,
    }]);
    now += 5 * 60_000;
    expect(x.controller.get('speech')!.realtime).toMatchObject({ active: 0, refusedSessions: 0 });
  });

  it('a deployment without realtime shows none', async () => {
    const x = await speech();
    expect(x.controller.get('speech')!.realtime).toBeNull();
    expect(realtimeHealth([x.controller.get('speech')!])).toEqual([]);
  });

  it('/v1/s2s: the turns of one session (its traceparent) are one student; refusals still count per request', async () => {
    const x = await speech();
    x.sessions(8);
    const ana = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const anaAgain = '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01';
    await turn(x.controller, ana);
    await turn(x.controller, anaAgain);
    await turn(x.controller, '00-1bf7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    await turn(x.controller);
    expect(distinctSessions('speech', 60_000, now)).toBe(2);
    expect(x.controller.get('speech')!.sessions).toBe(2);
    await x.controller.reconcile();
    expect(x.controller.get('speech')!.autoscale.load).toBe(4 + 4);
    now += 61_000;
    expect(x.controller.get('speech')!.sessions).toBe(0);
  });
});
