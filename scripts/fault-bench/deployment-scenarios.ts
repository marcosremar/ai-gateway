/**
 * Fault bench, deployment scenarios (2026-10-07): the REAL DeploymentController, inference providers and s2s route,
 * in process, over a fake cloud whose replicas are scripted HTTP servers (replica-cloud.ts). serve.ts cannot run a
 * controller without a real cloud key, so these scenarios drive the same code paths it mounts, directly.
 *
 *   S1  a replica dies mid-answer: chat (stream), TTS (streamed body), s2s after transcript, s2s after audio
 *   S3c the controller restarts: state from the store, machines adopted, no duplicate create, `stopping` left alone
 *   S6  burst of cold requests: replica cap, € ceiling, `stopping` kept, no create storm after a list failure
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeploymentController, type ControllerOptions } from '../../src/deployments/controller';
import { HttpReplicaProbe } from '../../src/deployments/http';
import { FileDeploymentStore, MemoryDeploymentStore } from '../../src/deployments/store';
import { DeploymentLLMProvider, DeploymentTTSProvider } from '../../src/deployments/inference-providers';
import { CircuitBreakerRegistry } from '../../src/gateway/providers/cloud/circuit-breaker';
import { CooldownTracker } from '../../src/gateway/providers/cloud/fallback';
import { OpenAICompatLLMProvider } from '../../src/gateway/providers/cloud/openai-compat/openai-compat-llm';
import { handleChatCompletions } from '../../src/gateway/proxy/routes/chat-completions';
import { handleAudioSpeech } from '../../src/gateway/proxy/routes/audio-speech';
import { createS2SRoute } from '../../src/s2s/route';
import { encodeAudio, encodeEvent, FrameDecoder, type S2SEvent } from '../../src/s2s/frames';
import type { StageClient } from '../../src/s2s/composite';
import type { FakeUpstream } from './fake-upstream';
import { fakeKey } from './gateway';
import { ReplicaCloud, until } from './replica-cloud';

export type Record_ = (item: string, check: string, verdict: 'PASS' | 'FAIL' | 'INFO' | 'N/A', evidence: string) => void;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const now = () => performance.now();

async function controllerOn(cloud: ReplicaCloud, opts: Partial<ControllerOptions> = {}) {
  const controller = new DeploymentController({
    backend: cloud, store: new MemoryDeploymentStore(), probe: new HttpReplicaProbe(1000), namespace: 'bench', reconcileMs: 100,
    maxTotalReplicas: 6, maxEurPerHour: 6,
    ...(process.env.BENCH_LOG ? { log: (m: string, d?: Record<string, unknown>) => console.log(Date.now() % 100000, m, JSON.stringify(d ?? {}).slice(0, 160)) } : {}), ...opts,
  });
  await controller.init();
  controller.start();
  return controller;
}

const DEP = { profile: 'cpu-echo', minReplicas: 1, maxReplicas: 1, maxEurPerHour: 2 };

/** What the controller knows of the deployment: in-flight leases and each replica's phase. */
function state(controller: DeploymentController, name: string) {
  const v = controller.get(name)!;
  return { inflight: v.inflight, replicas: v.replicas.map(r => `${r.id.split(':').pop()}=${r.phase}/${r.inflight}`).join(','), status: v.status };
}

/** Would the next request be handed the same replica right away (the dead one not marked yet)? */
async function nextLeaseGoesTo(controller: DeploymentController, name: string): Promise<string | null> {
  try {
    const lease = await controller.acquire(name, { waitMs: 0 });
    lease.done(false);
    return lease.machine.id;
  } catch { return null; }
}

const s2sStages = (calls: string[]): StageClient => ({
  async transcribe() { calls.push('stt'); return { text: 'ouvido pelo composto', provider: 'fake', fallback: null }; },
  async chatStream(messages) {
    calls.push(`llm:${messages[messages.length - 1].content}`);
    async function* d() { for (const t of ['Bom ', 'dia ', 'de novo.']) { await sleep(5); yield t; } }
    return { deltas: d(), provider: 'fake', fallback: null };
  },
  async speak(text) {
    calls.push(`tts:${text}`);
    async function* b() { yield new TextEncoder().encode(text); }
    return { body: b(), contentType: 'audio/pcm', provider: 'fake', fallback: null };
  },
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

function decode(bytes: Uint8Array) {
  const frames = new FrameDecoder().push(bytes);
  const events = frames.filter(f => f.kind === 'event').map(f => (f as { event: S2SEvent }).event);
  const audio = new TextDecoder().decode(Buffer.concat(frames.filter(f => f.kind === 'audio').map(f => Buffer.from((f as { pcm: Uint8Array }).pcm))));
  return { events, audio };
}

// ── S1 ──────────────────────────────────────────────────────────────────────

export async function scenario1(fake: FakeUpstream, record: Record_): Promise<void> {
  // 1a — chat stream: the replica dies after sending part of its answer.
  {
    const cloud = new ReplicaCloud();
    const controller = await controllerOn(cloud);
    try {
      await controller.put('parle-speech', DEP);
      controller.wake('parle-speech');
      await until(() => controller.get('parle-speech')!.status === 'ready', 5000);
      const dead = [...cloud.replicas.keys()][0];
      // No periodic reconcile from here: only the request path may mark the dead replica (a probe would hide it).
      controller.stop();
      cloud.app = async (req, res, _body, machine) => {
        if (!req.url?.includes('/chat/completions')) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"id":"x","choices":[{"index":0,"message":{"role":"assistant","content":"Olá, primeira par');
        await sleep(50);
        void cloud.crash(machine.id);
      };
      process.env.FAULT_BENCH_OR_KEY = fakeKey('or');
      const or = new OpenAICompatLLMProvider({ providerId: 'openrouter', baseURL: `${fake.url}/or`, envKey: 'FAULT_BENCH_OR_KEY' });
      fake.reset();
      const breakers = new CircuitBreakerRegistry();
      const t0 = now();
      const res = await handleChatCompletions(
        { method: 'POST', url: '/v1/chat/completions', headers: {}, rawBody: Buffer.alloc(0), body: { model: 'parle-llm', stream: true, messages: [{ role: 'user', content: 'oi s1a' }] } },
        {}, undefined, undefined, undefined, undefined, undefined,
        { chatRoutes: { 'parle-llm': [{ providerId: 'deployment:parle-speech', provider: new DeploymentLLMProvider(controller, 'parle-speech'), model: 'qwen' }, { providerId: 'openrouter', provider: or, model: 'a' }] }, circuitBreakers: breakers, cooldownTracker: new CooldownTracker() },
      );
      const text = res.stream ? await new Response(res.stream).text() : JSON.stringify(res.body);
      const ms = Math.round(now() - t0);
      const after = state(controller, 'parle-speech');
      const next = await nextLeaseGoesTo(controller, 'parle-speech');
      const content = [...text.matchAll(/"content":"([^"]*)"/g)].map(m => m[1]).join('');
      record('S1a', 'chat stream, replica dies mid-body: client gets the fallback answer, nothing of the replica',
        res.status === 200 && !content.includes('primeira') && text.includes('[DONE]') && res.headers?.['X-Gateway-Fallback-From'] === 'deployment:parle-speech' ? 'PASS' : 'FAIL',
        `status=${res.status} served=${res.headers?.['X-Gateway-Provider']} fallback=${res.headers?.['X-Gateway-Fallback']} content=${JSON.stringify(content)} in ${ms}ms`);
      record('S1a', 'chat: lease released, dead replica not handed to the next request', after.inflight === 0 && next !== dead ? 'PASS' : 'FAIL',
        `right after: inflight=${after.inflight} replicas=${after.replicas}; next acquire → ${next === dead ? `the SAME dead replica ${dead}` : next ?? 'none (marked)'}`);
      controller.start();
      const replaced = await until(() => cloud.released.some(r => r.id === dead) && controller.get('parle-speech')!.status === 'ready', 8000);
      record('S1a', 'chat: dead replica released as unhealthy and replaced', replaced ? 'PASS' : 'FAIL',
        `released=${JSON.stringify(cloud.released)} created=${cloud.created.length} state=${JSON.stringify(state(controller, 'parle-speech'))}`);
    } finally { controller.stop(); await cloud.closeAll(); }
  }

  // 1a' — TTS streamed from the replica: dies after the audio started.
  {
    const cloud = new ReplicaCloud();
    const controller = await controllerOn(cloud);
    try {
      await controller.put('parle-tts', DEP);
      controller.wake('parle-tts');
      await until(() => controller.get('parle-tts')!.status === 'ready', 5000);
      const dead = [...cloud.replicas.keys()][0];
      // No periodic reconcile from here: only the request path may mark the dead replica (a probe would hide it).
      controller.stop();
      let inflightMidStream = -1;
      cloud.app = async (req, res, _b, machine) => {
        if (!req.url?.includes('/audio/speech')) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'audio/wav' });
        for (let i = 0; i < 5; i++) { res.write(Buffer.alloc(2000, i)); await sleep(40); }
        inflightMidStream = controller.get('parle-tts')!.inflight;
        void cloud.crash(machine.id);
      };
      const t0 = now();
      const res = await handleAudioSpeech(
        { method: 'POST', url: '/v1/audio/speech', headers: {}, rawBody: Buffer.alloc(0), body: { model: 'parle-tts', input: 'Olá', voice: 'v', response_format: 'wav' } },
        { 'parle-tts': [{ providerId: 'deployment:parle-tts', provider: new DeploymentTTSProvider(controller, 'parle-tts'), model: 'tts' }] },
        undefined, new CircuitBreakerRegistry(),
      );
      let bytes = 0;
      let cut = '';
      try {
        const body = res.stream ?? (res.body instanceof Uint8Array ? new Response(res.body).body : null);
        if (body) { const r = (body as ReadableStream<Uint8Array>).getReader(); for (;;) { const { value, done } = await r.read(); if (done) break; bytes += value.length; } }
      } catch (err) { cut = (err as Error).message; }
      const ms = Math.round(now() - t0);
      const after = state(controller, 'parle-tts');
      const next = await nextLeaseGoesTo(controller, 'parle-tts');
      record('S1a\'', 'TTS stream, replica dies after 10 kB: the client sees the cut (not a clean end)', cut !== '' ? 'PASS' : 'FAIL',
        `status=${res.status} received ${bytes} B then ${cut ? `error "${cut.slice(0, 80)}"` : 'a CLEAN END (truncated audio looks complete)'} in ${ms}ms`);
      // Since #46 ("busy is not dead") a failure right after the replica served (here: the voice-catalog call) marks it
      // busy, not suspect: the next acquire may still get it until a probe fails. Reported, not judged.
      record('S1a\'', 'TTS: lease held while the audio streams and released after (reuse of the dead replica: #46 busy policy)',
        inflightMidStream === 1 && after.inflight === 0 ? 'PASS' : 'FAIL',
        `inflight while streaming=${inflightMidStream} (1 expected); after: inflight=${after.inflight} ${after.replicas}; next acquire → ${next === dead ? 'the SAME dead replica' : next ?? 'none'}`);
    } finally { controller.stop(); await cloud.closeAll(); }
  }

  // 1b / 1c — s2s: dies after the transcript (before audio) / after audio started.
  for (const when of ['transcript', 'audio'] as const) {
    const cloud = new ReplicaCloud();
    const controller = await controllerOn(cloud);
    const host = { url: '', server: null as Server | null };
    try {
      await controller.put('parle-speech', DEP);
      controller.wake('parle-speech');
      await until(() => controller.get('parle-speech')!.status === 'ready', 5000);
      const dead = [...cloud.replicas.keys()][0];
      // No periodic reconcile from here: only the request path may mark the dead replica (a probe would hide it).
      controller.stop();
      cloud.app = async (req, res, _b, machine) => {
        if (!req.url?.startsWith('/v1/s2s')) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/x-aigw-s2s' });
        res.write(encodeEvent({ type: 'transcript', text: 'Quero dois pães.', stt_ms: 10 }, 'binary'));
        if (when === 'audio') {
          res.write(encodeEvent({ type: 'sentence', text: 'Claro, querida!' }, 'binary'));
          res.write(encodeAudio(new TextEncoder().encode('Claro, querida!'), 'binary'));
        }
        await sleep(40);
        void cloud.crash(machine.id);
      };
      const calls: string[] = [];
      const route = createS2SRoute({ controller, deployment: 'parle-speech', stagesFor: () => s2sStages(calls), hedgeMs: 5_000 });
      const h = await listen((req, res) => { void route(req, res); });
      Object.assign(host, h);
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'a.webm');
      form.set('config', JSON.stringify({ language: 'pt' }));
      const t0 = now();
      const res = await fetch(`${h.url}/v1/s2s`, { method: 'POST', body: form });
      const { events, audio } = decode(new Uint8Array(await res.arrayBuffer()));
      const ms = Math.round(now() - t0);
      const after = state(controller, 'parle-speech');
      const next = await nextLeaseGoesTo(controller, 'parle-speech');
      const types = events.map(e => (e.type === 'route' ? `route(${e.provider}${e.fallback ? `/${e.fallback}` : ''})` : e.type)).join(' ');
      if (when === 'transcript') {
        const ok = events.some(e => e.type === 'route' && e.fallback === 'resumed') && !calls.includes('stt')
          && calls.includes('llm:Quero dois pães.') && audio === 'Bom dia de novo.' && events[events.length - 1]?.type === 'done';
        record('S1b', 's2s, replica dies after transcript: composed resumes at the LLM with that transcript', ok ? 'PASS' : 'FAIL',
          `status=${res.status} events=[${types}] audio=${JSON.stringify(audio)} stages=${JSON.stringify(calls)} in ${ms}ms`);
      } else {
        const tail = events.slice(-2).map(e => `${e.type}${e.partial ? '(partial)' : ''}`).join(',');
        const ok = tail === 'error(partial),done(partial)' && audio === 'Claro, querida!' && calls.length === 0;
        record('S1c', 's2s, replica dies after audio started: in-band error + done, nothing voiced twice', ok ? 'PASS' : 'FAIL',
          `status=${res.status} events=[${types}] audio=${JSON.stringify(audio)} stages=${JSON.stringify(calls)} in ${ms}ms`);
      }
      record(when === 'transcript' ? 'S1b' : 'S1c', 's2s: lease released and marked failed (dead replica not handed out next)',
        after.inflight === 0 && next !== dead ? 'PASS' : 'FAIL', `inflight=${after.inflight} replicas=${after.replicas}; next acquire → ${next === dead ? 'the SAME dead replica' : next ?? 'none (marked)'}`);
    } finally {
      controller.stop();
      host.server?.closeAllConnections();
      host.server?.close();
      await cloud.closeAll();
    }
  }
}

// ── S3c: controller restart ─────────────────────────────────────────────────

export async function scenario3Controller(record: Record_): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'aigw-bench-store-'));
  const cloud = new ReplicaCloud();
  cloud.stoppingMs = 1500;
  const mk = async () => {
    const c = new DeploymentController({
      backend: cloud, store: FileDeploymentStore.inDir(dir), probe: new HttpReplicaProbe(1000), namespace: 'bench', reconcileMs: 100,
      maxTotalReplicas: 6, maxEurPerHour: 6,
    });
    await c.init();
    c.start();
    return c;
  };
  try {
    const a = await mk();
    await a.put('live', { ...DEP, maxReplicas: 2 });
    await a.put('park', { profile: 'cpu-echo', minReplicas: 0, maxReplicas: 1, idleMinutes: 1, idleAction: 'stop', maxEurPerHour: 2 });
    a.wake('live');
    a.wake('park');
    await until(() => a.get('live')!.status === 'ready' && a.get('park')!.status === 'ready', 5000);
    // In-flight requests on the old process (leases never returned: the process dies under them).
    const held = await Promise.all([1, 2, 3].map(() => a.acquire('live', { waitMs: 0 })));
    await a.park('park');
    await until(() => cloud.stops.length === 1, 3000);
    const createdBefore = cloud.created.length;
    const parkId = cloud.stops[0];
    a.stop(); // the process dies: no cleanup, leases never released
    void held;
    const b = await mk();
    await sleep(1200); // ~12 reconciles, while the stop is still `stopping` (1.5 s)
    const midState = cloud.replicas.get(parkId)?.machine.state;
    const releasedMid = cloud.released.map(r => r.id);
    await until(() => cloud.replicas.get(parkId)?.machine.state === 'stopped', 3000);
    await sleep(500);
    const live = b.get('live');
    const park = b.get('park');
    record('S3c', 'restart: deployments recovered from the store, machines adopted, no duplicate create',
      !!live && !!park && cloud.created.length === createdBefore && live.status === 'ready' ? 'PASS' : 'FAIL',
      `after restart: live=${live?.status} (${live?.replicas.length} replicas) park=${park?.status}; creates before=${createdBefore} after=${cloud.created.length}; cloud running=${cloud.running()}`);
    record('S3c', 'restart: leases of the dead process are not leaked (inflight starts at 0)', live?.inflight === 0 ? 'PASS' : 'FAIL',
      `old process held 3 leases; new process inflight=${live?.inflight}, replica inflight=${live?.replicas.map(r => r.inflight)}`);
    record('S3c', 'restart while a replica is `stopping`: not deleted, ends parked', !releasedMid.includes(parkId) && !cloud.released.some(r => r.id === parkId)
      && cloud.replicas.get(parkId)?.machine.state === 'stopped' ? 'PASS' : 'FAIL',
      `state seen mid-adoption=${midState}; released=${JSON.stringify(cloud.released)}; final=${cloud.replicas.get(parkId)?.machine.state}; stopped count=${b.health().stopped}`);
    b.stop();
  } finally {
    await cloud.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── S6: spend / cap guards under a burst ────────────────────────────────────

export async function scenario6(record: Record_): Promise<void> {
  // 6a — 300 cold requests at once across 3 deployments: only allowed replicas, € ceiling, no storm.
  {
    const cloud = new ReplicaCloud();
    cloud.price = 1.0;
    cloud.createMs = 300;
    const controller = await controllerOn(cloud, { maxTotalReplicas: 4, maxEurPerHour: 2.5 });
    try {
      for (const n of ['d1', 'd2', 'd3']) await controller.put(n, { profile: 'cpu-echo', minReplicas: 0, maxReplicas: 3, maxEurPerHour: 2 });
      const t0 = now();
      const results = await Promise.allSettled(Array.from({ length: 300 }, (_, i) => controller.acquire(['d1', 'd2', 'd3'][i % 3], { waitMs: 3000 })));
      for (const r of results) if (r.status === 'fulfilled') r.value.done(false);
      const ok = results.filter(r => r.status === 'fulfilled').length;
      await sleep(800);
      const burn = controller.health().eurPerHour;
      record('S6a', '300 cold requests on 3 deployments: replicas within cap 4 and €2.5/h ceiling (price €1/h)',
        cloud.created.length <= 2 && cloud.running() <= 2 && burn <= 2.5 ? 'PASS' : 'FAIL',
        `created=${cloud.created.length} running=${cloud.running()} max concurrent creates=${cloud.maxConcurrentCreates} burn=€${burn}/h; ${ok}/300 served within 3 s in ${Math.round(now() - t0)}ms; lastError d3=${controller.get('d3')!.lastError?.slice(0, 120)}`);
    } finally { controller.stop(); await cloud.closeAll(); }
  }

  // 6b — a `stopping` replica under the burst: not deleted, not counted as running.
  {
    const cloud = new ReplicaCloud();
    cloud.price = 1.0;
    cloud.stoppingMs = 1500;
    const controller = await controllerOn(cloud, { maxTotalReplicas: 2, maxEurPerHour: 2.5 });
    try {
      await controller.put('park', { profile: 'cpu-echo', minReplicas: 0, maxReplicas: 1, idleMinutes: 1, idleAction: 'stop', maxEurPerHour: 2 });
      await controller.put('hot', { profile: 'cpu-echo', minReplicas: 0, maxReplicas: 2, maxEurPerHour: 2 });
      controller.wake('park');
      await until(() => controller.get('park')!.status === 'ready', 5000);
      await controller.park('park');
      await until(() => cloud.stops.length === 1, 3000);
      const parkId = cloud.stops[0];
      const results = await Promise.allSettled(Array.from({ length: 100 }, () => controller.acquire('hot', { waitMs: 2500 })));
      for (const r of results) if (r.status === 'fulfilled') r.value.done(false);
      const wasStopping = cloud.replicas.get(parkId)?.machine.state === 'stopping';
      await until(() => cloud.replicas.get(parkId)?.machine.state !== 'stopping', 4000);
      await sleep(500);
      record('S6b', 'burst while a replica is `stopping`: it is not deleted and ends parked',
        !cloud.released.some(r => r.id === parkId) && cloud.replicas.get(parkId)?.machine.state === 'stopped' ? 'PASS' : 'FAIL',
        `released=${JSON.stringify(cloud.released)} park was stopping during the burst=${wasStopping}, now ${cloud.replicas.get(parkId)?.machine.state}; list calls=${cloud.listCalls} stops=${cloud.stops} starts=${cloud.starts} hot created=${cloud.created.length - 1} running=${cloud.running()} burn=€${controller.health().eurPerHour}/h`);
    } finally { controller.stop(); await cloud.closeAll(); }
  }

  // 6c — the list fails during the burst: nothing is created; once it answers, only what is needed.
  {
    const cloud = new ReplicaCloud();
    cloud.price = 0.5;
    cloud.createMs = 100;
    const controller = await controllerOn(cloud, { maxTotalReplicas: 6, maxEurPerHour: 6 });
    try {
      await controller.put('d', { profile: 'cpu-echo', minReplicas: 0, maxReplicas: 2, maxEurPerHour: 2 });
      await sleep(300);
      cloud.failList = true;
      const listsBefore = cloud.listCalls;
      const burst = Promise.allSettled(Array.from({ length: 200 }, () => controller.acquire('d', { waitMs: 1500 })));
      await sleep(1000);
      const createdWhileFailing = cloud.created.length;
      const listCallsWhileFailing = cloud.listCalls - listsBefore;
      cloud.failList = false;
      const results = await burst;
      for (const r of results) if (r.status === 'fulfilled') r.value.done(false);
      await sleep(1000);
      record('S6c', 'list failing during a 200-request burst: no create; after it answers, ≤ maxReplicas (2)',
        createdWhileFailing === 0 && cloud.created.length <= 2 && cloud.maxConcurrentCreates <= 2 ? 'PASS' : 'FAIL',
        `created while failing=${createdWhileFailing} (list calls in 1 s: ${listCallsWhileFailing}); after recovery created=${cloud.created.length} max concurrent creates=${cloud.maxConcurrentCreates}; listError shown=${controller.health().listError ?? 'none'}`);
    } finally { controller.stop(); await cloud.closeAll(); }
  }
}

// ── S2 (own GPU part): the deployment AND the cloud fallback are down ───────

export async function scenario2Deployment(fake: FakeUpstream, record: Record_): Promise<void> {
  process.env.FAULT_BENCH_OR_KEY = fakeKey('or');
  const or = new OpenAICompatLLMProvider({ providerId: 'openrouter', baseURL: `${fake.url}/or`, envKey: 'FAULT_BENCH_OR_KEY' });
  for (const gpu of ['crashed', 'cold'] as const) {
    const cloud = new ReplicaCloud();
    const controller = await controllerOn(cloud);
    try {
      await controller.put('parle-speech', { ...DEP, minReplicas: 0 });
      if (gpu === 'crashed') {
        controller.wake('parle-speech');
        await until(() => controller.get('parle-speech')!.status === 'ready', 5000);
        controller.stop();
        await cloud.crash([...cloud.replicas.keys()][0]);
      } else controller.stop();
      fake.reset();
      fake.setFaults({ a: { kind: 'status', status: 503 }, b: { kind: 'status', status: 503 } });
      const t0 = now();
      const res = await handleChatCompletions(
        { method: 'POST', url: '/v1/chat/completions', headers: {}, rawBody: Buffer.alloc(0), body: { model: 'parle-llm', messages: [{ role: 'user', content: `oi ${gpu}` }] } },
        {}, undefined, undefined, undefined, undefined, undefined,
        { chatRoutes: { 'parle-llm': [
          { providerId: 'deployment:parle-speech', provider: new DeploymentLLMProvider(controller, 'parle-speech'), model: 'qwen' },
          { providerId: 'openrouter', provider: or, model: 'a' }, { providerId: 'openrouter', provider: or, model: 'b' },
        ] }, circuitBreakers: new CircuitBreakerRegistry(), cooldownTracker: new CooldownTracker() },
      );
      const ms = Math.round(now() - t0);
      const msg = (res.body as { error?: { message?: string } })?.error?.message ?? '';
      const reason = gpu === 'crashed' ? /deployment:parle-speech.*(unreachable|502)/ : /deployment:parle-speech.*503/;
      record('S2-GPU', `own GPU ${gpu} + OpenRouter 503: chat answers a fast 503 naming both`, res.status === 503 && reason.test(msg) && /openrouter/.test(msg) && ms < 2000 ? 'PASS' : 'FAIL',
        `status=${res.status} in ${ms}ms, upstream calls=${fake.log().length}; message: ${msg.slice(0, 260)}; deployment now ${controller.get('parle-speech')!.status}${gpu === 'cold' ? ` (woken: creates=${cloud.created.length})` : ''}`);
    } finally { controller.stop(); await cloud.closeAll(); }
  }
  // s2s: the speech-stack replica is dead and every stage chain is down.
  {
    const cloud = new ReplicaCloud();
    const controller = await controllerOn(cloud);
    let host: Server | null = null;
    try {
      await controller.put('parle-speech', DEP);
      controller.wake('parle-speech');
      await until(() => controller.get('parle-speech')!.status === 'ready', 5000);
      controller.stop();
      await cloud.crash([...cloud.replicas.keys()][0]);
      const stages: StageClient = {
        async transcribe() { throw new Error('stt HTTP 503: No provider available for stt model "parle-stt": openrouter failed (HTTP 503); groq failed (HTTP 503)'); },
        async chatStream() { throw new Error('not reached'); },
        async speak() { throw new Error('not reached'); },
      };
      const route = createS2SRoute({ controller, deployment: 'parle-speech', stagesFor: () => stages });
      const h = await listen((req, res) => { void route(req, res); });
      host = h.server;
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'a.webm');
      form.set('config', JSON.stringify({ language: 'pt' }));
      const t0 = now();
      const res = await fetch(`${h.url}/v1/s2s`, { method: 'POST', body: form });
      const text = await res.text();
      const ms = Math.round(now() - t0);
      record('S2-GPU', 'own GPU dead + stage chains down: s2s is a real 503 provider_unavailable, fast, with the reasons',
        res.status === 503 && /provider_unavailable/.test(text) && /openrouter/.test(text) && ms < 2000 ? 'PASS' : 'FAIL',
        `status=${res.status} in ${ms}ms body=${text.slice(0, 260)}; replica afterwards: ${state(controller, 'parle-speech').replicas}`);
    } finally { controller.stop(); host?.closeAllConnections(); host?.close(); await cloud.closeAll(); }
  }
}
