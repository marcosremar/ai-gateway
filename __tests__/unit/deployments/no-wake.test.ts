/**
 * No-wake mode (src/gateway/proxy/no-wake.ts). Regression of 2026-10-07: one STT request to the app route `parle-stt`
 * (primary `deployment:parle-speech`, cloud fallback) woke a €1.47/h L40S, because a cold primary is woken "for the
 * next turns". With `X-Gateway-No-Wake: 1` (or a key user in GATEWAY_NO_WAKE_USERS) the cold deployment is skipped
 * as `cold`, the cloud fallback answers, and no machine is created; a ready replica is still used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createProxyServer } from '../../../src/gateway/proxy/server';
import { DeploymentController, DeploymentError } from '../../../src/deployments/controller';
import { createDeploymentRoutes, HttpReplicaProbe } from '../../../src/deployments/http';
import { DeploymentSTTProvider } from '../../../src/deployments/inference-providers';
import { MemoryDeploymentStore } from '../../../src/deployments/store';
import { createS2SRoute } from '../../../src/s2s/route';
import { _resetSttCache } from '../../../src/gateway/proxy/routes/audio-transcriptions';
import {
  _resetNoWakeStats, headerAsksNoWake, noWakeActive, noWakeStats, requestIsNoWake, runNoWake,
} from '../../../src/gateway/proxy/no-wake';
import type { STTProvider } from '../../../src/gateway/providers/cloud/types';
import { FakeCloud, until } from './_fake-cloud';
import { fakeStages } from '../s2s/_fakes';

const KEY = 'tester-key-0123456789';
const BATCH = 'batch-key-0123456789';
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Harness { cloud: FakeCloud; controller: DeploymentController; server: Server; base: string; cloudStt: { transcribe: ReturnType<typeof vi.fn> }; woken: string[] }

async function harness(): Promise<Harness> {
  const cloud = new FakeCloud();
  const controller = new DeploymentController({
    backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'test', reconcileMs: 30,
  });
  await controller.init();
  controller.start();
  await controller.put('parle-speech', { profile: 'cpu-echo', minReplicas: 0 });
  const woken: string[] = [];
  const wake = controller.wake.bind(controller);
  controller.wake = (name: string) => { woken.push(name); return wake(name); };
  const cloudStt = { providerId: 'groq', isConfigured: () => true, transcribe: vi.fn(async () => ({ text: 'olá do groq' })) };
  const deploymentStt = new DeploymentSTTProvider(controller, 'parle-speech');
  const handler = createDeploymentRoutes({ controller, isAdmin: () => true, userOf: () => 'owner' });
  const s2s = createS2SRoute({ controller, deployment: 'parle-speech', stagesFor: () => fakeStages().stages });
  const server = createProxyServer({
    apiKeys: [`${KEY}:tester`, `${BATCH}:batch`],
    providers: {
      chat: {}, tts: {},
      stt: { 'parle-stt': [
        { providerId: 'deployment:parle-speech', provider: deploymentStt as STTProvider },
        { providerId: 'groq', provider: cloudStt as unknown as STTProvider, model: 'whisper-large-v3' },
      ] },
    } as never,
    prefixRoutes: [{ prefix: '/v1/deployments', handler }],
    customRoutes: [{ method: 'POST', path: '/v1/s2s', handler: s2s }],
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return { cloud, controller, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, cloudStt, woken };
}

function stt(h: Harness, headers: Record<string, string> = {}, key = KEY, audio = 'RIFF-fake-audio') {
  const form = new FormData();
  form.set('file', new Blob([audio], { type: 'audio/wav' }), 'a.wav');
  form.set('model', 'parle-stt');
  return fetch(`${h.base}/v1/audio/transcriptions`, { method: 'POST', body: form, headers: { authorization: `Bearer ${key}`, ...headers } });
}

let h: Harness;
const env = process.env.GATEWAY_NO_WAKE_USERS;
beforeEach(async () => { _resetSttCache(); _resetNoWakeStats(); h = await harness(); });
afterEach(async () => {
  if (env === undefined) delete process.env.GATEWAY_NO_WAKE_USERS; else process.env.GATEWAY_NO_WAKE_USERS = env;
  h.controller.stop();
  h.server.closeAllConnections();
  await new Promise<void>(r => h.server.close(() => r()));
});

describe('no-wake: request flag', () => {
  it('parses the header and GATEWAY_NO_WAKE_USERS', () => {
    expect(headerAsksNoWake('1')).toBe(true);
    expect(headerAsksNoWake(' TRUE ')).toBe(true);
    expect(headerAsksNoWake('0')).toBe(false);
    expect(headerAsksNoWake(undefined)).toBe(false);
    expect(requestIsNoWake(undefined, 'batch', { GATEWAY_NO_WAKE_USERS: 'qa, batch' })).toBe(true);
    expect(requestIsNoWake(undefined, 'site', { GATEWAY_NO_WAKE_USERS: 'qa, batch' })).toBe(false);
    expect(noWakeActive()).toBe(false);
    expect(runNoWake(() => noWakeActive())).toBe(true);
  });
});

describe('no-wake: STT route with a cold deployment primary (the 2026-10-07 L40S wake)', () => {
  it('without the flag a cold primary is woken (the behaviour no-wake opts out of)', async () => {
    const res = await stt(h);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-fallback')).toBe('cold');
    await until(() => h.cloud.created.length === 1, 2000);
    expect(h.woken).toEqual(['parle-speech']);
  });

  it('X-Gateway-No-Wake: 1 → cloud fallback answers, code cold, nothing created, idle clock untouched', async () => {
    const res = await stt(h, { 'X-Gateway-No-Wake': '1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'olá do groq' });
    expect(res.headers.get('x-gateway-provider')).toBe('groq:whisper-large-v3');
    expect(res.headers.get('x-gateway-fallback')).toBe('cold');
    expect(res.headers.get('x-gateway-fallback-from')).toBe('deployment:parle-speech');
    await wait(200); // several reconcile ticks
    expect(h.cloud.created).toHaveLength(0);
    expect(h.woken).toEqual([]);
    expect(h.controller.get('parle-speech')!.lastRequestAt).toBeNull();
    expect(h.controller.get('parle-speech')!.status).toBe('scaled-to-zero');
  });

  it('GATEWAY_NO_WAKE_USERS: every request of that key user is no-wake, others are not', async () => {
    process.env.GATEWAY_NO_WAKE_USERS = 'batch';
    expect((await stt(h, {}, BATCH)).status).toBe(200);
    await wait(200);
    expect(h.cloud.created).toHaveLength(0);
    expect(h.woken).toEqual([]);
  });

  it('a cached answer does not prewarm the deployment in no-wake mode', async () => {
    process.env.GATEWAY_NO_WAKE_USERS = 'batch';
    expect((await stt(h, {}, BATCH, 'same-audio')).status).toBe(200);
    const hit = await stt(h, {}, BATCH, 'same-audio');
    expect(hit.headers.get('x-cache')).toBe('HIT');
    await wait(200);
    expect(h.cloud.created).toHaveLength(0);
    expect(h.woken).toEqual([]);
  });

  it('a READY replica is still used in no-wake mode', async () => {
    h.controller.wake('parle-speech');
    await until(() => h.controller.get('parle-speech')!.status === 'ready', 3000);
    const res = await stt(h, { 'X-Gateway-No-Wake': '1' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-provider')).toBe('deployment:parle-speech');
    expect(h.cloudStt.transcribe).not.toHaveBeenCalled();
  });

  it('/health counts the no-wake skips', async () => {
    await stt(h, { 'X-Gateway-No-Wake': '1' });
    const health = await (await fetch(`${h.base}/health`)).json() as { noWake: { skips: number } };
    expect(health.noWake.skips).toBe(1);
    expect(noWakeStats().skips).toBe(1);
  });
});

describe('no-wake: invoke and s2s', () => {
  it('invoke answers 503 cold at once and does not wake the deployment', async () => {
    const res = await fetch(`${h.base}/v1/deployments/parle-speech/invoke/anything`, {
      method: 'POST', body: '{}', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'X-Gateway-No-Wake': '1' },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'cold', noWake: true });
    expect(res.headers.get('retry-after')).toBe('30');
    await wait(200);
    expect(h.cloud.created).toHaveLength(0);
    expect(h.controller.get('parle-speech')!.lastRequestAt).toBeNull();
  });

  it('/v1/s2s goes composed and does not wake the speech-stack deployment', async () => {
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'a.webm');
    form.set('config', JSON.stringify({ system: 'x', voice: 'v', language: 'pt' }));
    const res = await fetch(`${h.base}/v1/s2s?format=ndjson`, { method: 'POST', body: form, headers: { authorization: `Bearer ${KEY}`, 'X-Gateway-No-Wake': '1' } });
    expect(res.status).toBe(200);
    const first = JSON.parse((await res.text()).split('\n')[0]!) as Record<string, unknown>;
    expect(first).toMatchObject({ type: 'route', provider: 'composite', fallback: 'cold' });
    await wait(200);
    expect(h.cloud.created).toHaveLength(0);
    expect(h.woken).toEqual([]);
  });
});

describe('no-wake: DeploymentController.acquire', () => {
  it('noWake with no ready replica: 503 at once, no create, lastRequestAt untouched', async () => {
    const t0 = Date.now();
    const err = await h.controller.acquire('parle-speech', { noWake: true, waitMs: 5_000 }).catch(e => e);
    expect(err).toBeInstanceOf(DeploymentError);
    expect((err as DeploymentError).status).toBe(503);
    expect(Date.now() - t0).toBeLessThan(1000);
    await wait(150);
    expect(h.cloud.created).toHaveLength(0);
    expect(h.controller.get('parle-speech')!.lastRequestAt).toBeNull();
  });
});
