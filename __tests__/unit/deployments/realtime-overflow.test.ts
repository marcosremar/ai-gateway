import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentController, DeploymentError, STAGE_STRIKES } from '../../../src/deployments/controller';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { _resetExternalLoad, reportExternalLoad } from '../../../src/realtime/external-load';
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

async function speech() {
  now = 1_000_000;
  const cloud = new FakeCloud(() => now);
  clouds.push(cloud);
  const controller = new DeploymentController({
    backend: cloud, store: new MemoryDeploymentStore(), probe: { ready: async () => true }, namespace: 'test', now: () => now,
  });
  await controller.init();
  await controller.put('speech', { profile: 'cpu-echo', minReplicas: 1, maxReplicas: 1, targetInflightPerReplica: 4 });
  await until(async () => { await controller.reconcile(); return controller.get('speech')!.status === 'ready'; });
  const id = controller.get('speech')!.replicas[0].id;
  const sessions = (active: number) => reportExternalLoad('speech', id, active, 8, now);
  return { controller, cloud, id, sessions };
}

async function turn(controller: DeploymentController) {
  const fake = fakeStages();
  const route = createS2SRoute({ controller, deployment: 'speech', stagesFor: () => fake.stages, hedgeMs: 2_000 });
  const server = createServer((req, res) => { void route(req, res); });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'a.webm');
  form.set('config', JSON.stringify({ system: 'Seu Jorge', voice: 'br-m-08', language: 'pt' }));
  const started = performance.now();
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/s2s?format=ndjson`, { method: 'POST', body: form });
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
