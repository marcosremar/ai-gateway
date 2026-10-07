/**
 * A replica whose container still answers its health check while one stage (TTS, …) is wedged: repeated failures of
 * that stage on that replica take it out of rotation for that stage, for a cool-down; the other replica, the other
 * stages and the caller's fallback carry on.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentController, DeploymentError, STAGE_COOLDOWN_MS, STAGE_STRIKES, type LeaseOutcome } from '../../../src/deployments/controller';
import { DeploymentTTSProvider } from '../../../src/deployments/inference-providers';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { FakeCloud, until } from './_fake-cloud';

let now = 0;
const clouds: FakeCloud[] = [];
afterEach(async () => { for (const c of clouds.splice(0)) await c.closeAll(); });

async function ready(replicas: number): Promise<{ controller: DeploymentController; ids: string[]; logs: string[] }> {
  now = 1_000_000;
  const cloud = new FakeCloud(() => now);
  clouds.push(cloud);
  const logs: string[] = [];
  const controller = new DeploymentController({
    backend: cloud, store: new MemoryDeploymentStore(), probe: { ready: async () => true }, namespace: 'test', now: () => now,
    log: msg => logs.push(msg),
  });
  await controller.init();
  await controller.put('speech', { profile: 'cpu-echo', minReplicas: replicas, maxReplicas: replicas });
  await until(async () => { await controller.reconcile(); return controller.get('speech')!.replicas.filter(r => r.phase === 'ready').length === replicas; });
  return { controller, ids: controller.get('speech')!.replicas.map(r => r.id).sort(), logs };
}

async function end(controller: DeploymentController, stage: string, outcome: LeaseOutcome, only?: string, ms = 0): Promise<string> {
  const others = controller.get('speech')!.replicas.map(r => r.id).filter(id => only !== undefined && id !== only);
  const lease = await controller.acquire('speech', { waitMs: 0, stage, exclude: new Set(others) });
  now += ms;
  lease.done(outcome);
  return lease.machine.id;
}

const outOf = (controller: DeploymentController, id: string) => controller.get('speech')!.replicas.find(r => r.id === id)!.stagesOut;

describe('stage out of rotation per replica', () => {
  it('repeated TTS failures on one replica send TTS to the other; its other stages keep serving; a success after the cool-down clears it', async () => {
    const { controller, ids: [a, b], logs } = await ready(2);
    for (let i = 0; i < STAGE_STRIKES - 1; i++) await end(controller, 'tts', 'timeout', a);
    expect(outOf(controller, a!)).toEqual([]);
    await end(controller, 'tts', 'errored', a);
    expect(outOf(controller, a!)).toEqual(['tts']);
    expect(controller.get('speech')!.replicas.every(r => r.phase === 'ready')).toBe(true);
    expect(logs).toContain('deployments: stage out of rotation');

    for (let i = 0; i < 6; i++) expect(await end(controller, 'tts', 'ok')).toBe(b);
    expect(await end(controller, 'stt', 'ok', a)).toBe(a);

    now += STAGE_COOLDOWN_MS;
    expect(outOf(controller, a!)).toEqual([]);
    await end(controller, 'tts', 'failed', a);
    expect(outOf(controller, a!)).toEqual(['tts']);
    now += STAGE_COOLDOWN_MS;
    await end(controller, 'tts', 'ok', a);
    expect(outOf(controller, a!)).toEqual([]);
    expect(logs).toContain('deployments: stage back in rotation');
    await end(controller, 'tts', 'timeout', a);
    expect(outOf(controller, a!)).toEqual([]);
  });

  it('with the stage out on every ready replica the request is refused at once as stage_out, other stages are not', async () => {
    const { controller, ids: [a] } = await ready(1);
    for (let i = 0; i < STAGE_STRIKES; i++) await end(controller, 'tts', 'timeout', a);
    const refused = await controller.acquire('speech', { waitMs: 0, stage: 'tts' }).catch(err => err as DeploymentError);
    expect(refused).toBeInstanceOf(DeploymentError);
    expect(refused).toMatchObject({ status: 503, code: 'stage_out', retryAfterSeconds: 30 });
    expect(await end(controller, 'chat', 'ok')).toBe(a);
    expect(controller.get('speech')!.autoscale.load).toBe(0);
    now += STAGE_COOLDOWN_MS;
    expect(await end(controller, 'tts', 'ok')).toBe(a);
  });

  it('a hedge loser counts once it waited the hedge delay; a quick cancel, a 429 and a caller cancel never do', async () => {
    const { controller, ids: [a] } = await ready(1);
    controller.hedgeDelayMs('speech', 1_500, 3_000);
    for (let i = 0; i < STAGE_STRIKES + 2; i++) {
      await end(controller, 'tts', 'abandoned', a, 200);
      await end(controller, 'tts', 'cancelled', a, 5_000);
      await end(controller, 'tts', 'overloaded', a, 5_000);
    }
    expect(outOf(controller, a!)).toEqual([]);
    for (let i = 0; i < STAGE_STRIKES; i++) await end(controller, 'tts', 'abandoned', a, 1_600);
    expect(outOf(controller, a!)).toEqual(['tts']);
  });

  it('a lease without a stage is never refused or counted', async () => {
    const { controller, ids: [a] } = await ready(1);
    for (let i = 0; i < STAGE_STRIKES + 2; i++) {
      const lease = await controller.acquire('speech', { waitMs: 0 });
      lease.done('errored');
    }
    expect(outOf(controller, a!)).toEqual([]);
  });
});

describe('deployment TTS provider on a replica whose TTS answers 500', () => {
  it('after the strikes the provider falls back at once (circuit_open) without calling the replica', async () => {
    const { controller } = await ready(1);
    let calls = 0;
    const provider = new DeploymentTTSProvider(controller, 'speech', {
      fetchImpl: (async (url: string) => {
        if (url.endsWith('/refs/voices.json')) return new Response('', { status: 404 });
        calls++;
        return new Response('boom', { status: 500 });
      }) as typeof fetch,
    });
    const speak = () => provider.synthesize({ input: 'oi', model: 'm', voice: 'v' } as never).catch(err => err as { gatewayCode?: string });
    for (let i = 0; i < STAGE_STRIKES; i++) expect(await speak()).toMatchObject({ gatewayCode: '5xx' });
    expect(calls).toBe(STAGE_STRIKES);
    expect(await speak()).toMatchObject({ gatewayCode: 'circuit_open', skipRetry: true });
    expect(calls).toBe(STAGE_STRIKES);
  });
});
