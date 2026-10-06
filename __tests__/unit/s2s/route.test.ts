import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { DeploymentError } from '../../../src/deployments/controller';
import { createS2SRoute } from '../../../src/s2s/route';
import { loopbackStages } from '../../../src/s2s/loopback-stages';
import { decodeAll, fakeStages, replicaFrames, sleep, type FakeStagesOptions } from './_fakes';

type ReplicaScript = (res: ServerResponse) => Promise<void>;

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise(r => s.close(r)); } });

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function harness(opts: {
  replica?: ReplicaScript; deployment?: 'ready' | 'cold' | 'paused' | 'absent'; stages?: FakeStagesOptions; hedgeMs?: number;
}) {
  const leases: Array<{ failed?: boolean }> = [];
  const woken: string[] = [];
  let replicaHits = 0;
  const replicaHost = opts.replica ? await listen((req, res) => {
    replicaHits++;
    expect(req.headers['x-aigw-token']).toBe('tok');
    req.resume();
    req.on('end', () => { void opts.replica!(res); });
  }) : '127.0.0.1:1';
  const state = opts.deployment ?? 'ready';
  const controller = {
    get: (name: string) => (state === 'absent' || name !== 'parle-speech' ? null : ({ name } as never)),
    wake: (name: string) => { woken.push(name); return null as never; },
    acquire: async () => {
      if (state === 'cold') throw new DeploymentError(503, "deployment 'parle-speech': replicas are starting", 30);
      if (state === 'paused') throw new DeploymentError(409, "deployment 'parle-speech' is paused");
      const lease = { machine: { ip: replicaHost } as never, token: 'tok', done: (failed?: boolean) => { leases.push({ failed }); } };
      return lease;
    },
  };
  const fake = fakeStages(opts.stages);
  const route = createS2SRoute({ controller, deployment: 'parle-speech', stagesFor: () => fake.stages, hedgeMs: opts.hedgeMs ?? 2_000 });
  const host = await listen((req, res) => { void route(req, res); });
  async function call(query = '', custom?: FormData) {
    const form = custom ?? new FormData();
    if (!custom) {
      form.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'a.webm');
      form.set('config', JSON.stringify({ system: 'Seu Jorge', voice: 'br-m-08', language: 'pt' }));
    }
    const res = await fetch(`http://${host}/v1/s2s${query}`, { method: 'POST', body: form });
    return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
  }
  return { call, calls: fake.calls, leases, woken, replicaHits: () => replicaHits };
}

const writeFrames = (res: ServerResponse, frames: Uint8Array[], delayMs = 0) => async () => {
  res.writeHead(200, { 'Content-Type': 'application/x-aigw-s2s' });
  for (const f of frames) { if (delayMs) await sleep(delayMs); res.write(f); }
  res.end();
};

describe('POST /v1/s2s routing', () => {
  it('ready speech-stack replica: its stream passes through, no composed stage is called, lease released ok', async () => {
    const h = await harness({ replica: res => writeFrames(res, replicaFrames('Oi!', ['Bom dia, querida!', 'Pão quentinho.']))() });
    const { res, bytes } = await h.call();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-aigw-s2s');
    const { events, audio } = decodeAll(bytes);
    expect(events[0]).toEqual({ type: 'route', provider: 'deployment:parle-speech' });
    expect(events.map(e => e.type)).toEqual(['route', 'transcript', 'sentence', 'sentence', 'done']);
    expect(audio).toBe('Bom dia, querida!Pão quentinho.');
    expect(h.calls).toEqual([]);
    expect(h.leases).toEqual([{ failed: false }]);
  });

  it('cold deployment: woken for the next turns, this turn answered by the composed pipeline at once', async () => {
    const h = await harness({ deployment: 'cold' });
    const { events, audio } = decodeAll((await h.call()).bytes);
    expect(events[0]).toMatchObject({ type: 'route', provider: 'composite', fallback: 'cold', from: 'deployment:parle-speech' });
    expect(h.woken).toEqual(['parle-speech']);
    expect(audio).toBe('Bom dia, querida!Aqui está o seu pão.');
    expect(h.calls.map(c => c.stage)).toEqual(['stt', 'llm', 'tts', 'tts']);
  });

  it('absent or paused deployment: composed pipeline, reason reported', async () => {
    for (const [deployment, reason] of [['absent', 'not_found'], ['paused', 'paused']] as const) {
      const h = await harness({ deployment });
      const { events } = decodeAll((await h.call()).bytes);
      expect(events[0]).toMatchObject({ provider: 'composite', fallback: reason });
    }
  });

  it('slow primary (no transcript before the hedge): the composed pipeline wins, the replica is cut', async () => {
    const h = await harness({
      hedgeMs: 50,
      replica: async res => { res.writeHead(200); await sleep(1_000); writeFrames(res, replicaFrames('tarde', ['Tarde demais.']))(); },
    });
    const t0 = performance.now();
    const { events, audio } = decodeAll((await h.call()).bytes);
    expect(performance.now() - t0).toBeLessThan(900);
    expect(events[0]).toMatchObject({ type: 'route', provider: 'composite', fallback: 'slow' });
    expect(events.some(e => e.type === 'route' && e.provider === 'deployment:parle-speech')).toBe(false);
    expect(audio).toBe('Bom dia, querida!Aqui está o seu pão.');
  });

  it('primary breaks after its transcript: the composed pipeline resumes at the LLM (no second STT)', async () => {
    const h = await harness({
      replica: async res => {
        res.writeHead(200);
        res.write(replicaFrames('Quero dois pães.', [])[0]);
        await sleep(10);
        res.destroy();
      },
    });
    const { events, audio } = decodeAll((await h.call()).bytes);
    expect(events.map(e => e.type).slice(0, 3)).toEqual(['route', 'transcript', 'route']);
    expect(events[2]).toMatchObject({ provider: 'composite', fallback: 'resumed' });
    expect(h.calls.some(c => c.stage === 'stt')).toBe(false);
    expect(h.calls.find(c => c.stage === 'llm')?.text).toBe('Quero dois pães.');
    expect(audio.length).toBeGreaterThan(0);
    expect(h.leases).toEqual([{ failed: true }]);
  });

  it('primary breaks after audio started: partial error + done, nothing voiced twice', async () => {
    const frames = replicaFrames('Oi!', ['Bom dia, querida!', 'Nunca chega.']);
    const h = await harness({
      replica: async res => {
        res.writeHead(200);
        for (const f of frames.slice(0, 3)) res.write(f);
        await sleep(10);
        res.destroy();
      },
    });
    const { events, audio } = decodeAll((await h.call()).bytes);
    expect(audio).toBe('Bom dia, querida!');
    expect(events.slice(-2)).toMatchObject([{ type: 'error', partial: true }, { type: 'done', partial: true }]);
    expect(h.calls).toEqual([]);
  });

  it('replica error event before audio: resumed or restarted on the composed pipeline', async () => {
    const h = await harness({ replica: async res => {
      res.writeHead(200);
      res.end(Buffer.from((await import('../../../src/s2s/frames')).encodeEvent({ type: 'error', message: 'CUDA OOM' }, 'binary')));
    } });
    const { events, audio } = decodeAll((await h.call()).bytes);
    expect(events.find(e => e.type === 'route' && e.provider === 'composite')).toMatchObject({ fallback: 'error' });
    expect(audio).toBe('Bom dia, querida!Aqui está o seu pão.');
  });

  it('nothing can answer before the first byte: a real 503 provider_unavailable', async () => {
    const h = await harness({ deployment: 'absent', stages: { failSttWith: 'stt HTTP 503: no provider for parle-stt' } });
    const { res, bytes } = await h.call();
    expect(res.status).toBe(503);
    const body = JSON.parse(new TextDecoder().decode(bytes)) as { error: { type: string; message: string } };
    expect(body.error.type).toBe('provider_unavailable');
    expect(body.error.message).toMatch(/no provider for parle-stt/);
  });

  it('JSON turn (speak_field) skips a primary that does not voice JSON yet; goes to it once enabled', async () => {
    const h = await harness({ replica: res => writeFrames(res, replicaFrames('Oi!', ['Bom dia!']))() });
    const form = () => {
      const f = new FormData();
      f.set('file', new Blob([new Uint8Array([1])], { type: 'audio/webm' }), 'a.webm');
      f.set('config', JSON.stringify({ voice: 'br-m-08', speak_field: 'utterance', response_format: { type: 'json_object' } }));
      return f;
    };
    const { events } = decodeAll((await h.call('', form())).bytes);
    expect(events[0]).toMatchObject({ provider: 'composite', fallback: 'unsupported' });
    expect(h.replicaHits()).toBe(0);
  });

  it('?format=ndjson: one JSON per line, audio base64', async () => {
    const h = await harness({ replica: res => writeFrames(res, replicaFrames('Oi!', ['Bom dia, querida!']))() });
    const { res, bytes } = await h.call('?format=ndjson');
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    const lines = new TextDecoder().decode(bytes).trim().split('\n').map(l => JSON.parse(l));
    expect(lines[0]).toEqual({ type: 'route', provider: 'deployment:parle-speech' });
    const audio = lines.find(l => l.type === 'audio');
    expect(Buffer.from(audio.pcm, 'base64').toString()).toBe('Bom dia, querida!');
  });

  it('the request names the deployment and models; none → composed only, and a missing model is a 503', async () => {
    let fetched = 0;
    const fetchImpl = (async () => { fetched++; return new Response('{}'); }) as unknown as typeof fetch;
    const route = createS2SRoute({
      controller: null,
      stagesFor: (_req, config) => loopbackStages({ baseUrl: 'http://gw', authorization: 'Bearer k', fetchImpl, models: config.models }),
    });
    const host = await listen((req, res) => { void route(req, res); });
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array([1])]), 'a.webm');
    form.set('config', JSON.stringify({ system: 'x', language: 'pt' }));
    const res = await fetch(`http://${host}/v1/s2s?format=ndjson`, { method: 'POST', body: form });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('no stt model');
    expect(fetched).toBe(0);
  });

  it('bad request: 400 without a file, and bad config JSON', async () => {
    const fake = fakeStages();
    const route = createS2SRoute({ controller: null, deployment: 'parle-speech', stagesFor: () => fake.stages });
    const host = await listen((req, res) => { void route(req, res); });
    const noFile = new FormData();
    noFile.set('config', '{}');
    expect((await fetch(`http://${host}/v1/s2s`, { method: 'POST', body: noFile })).status).toBe(400);
    const badConfig = new FormData();
    badConfig.set('file', new Blob([new Uint8Array([1])]), 'a.webm');
    badConfig.set('config', '{not json');
    expect((await fetch(`http://${host}/v1/s2s`, { method: 'POST', body: badConfig })).status).toBe(400);
    expect(fake.calls).toEqual([]);
  });
});
