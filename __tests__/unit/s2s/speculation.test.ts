import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { runComposite } from '../../../src/s2s/composite';
import { createS2SRoute } from '../../../src/s2s/route';
import { resetSpeculations, speculationCounts, startSpeculation, takeSpeculation, wavMs } from '../../../src/s2s/speculation';
import { setGatewayTelemetrySink } from '../../../src/telemetry/emit';
import { decodeAll, fakeStages, sleep, wav, type FakeStagesOptions } from './_fakes';

const servers: Server[] = [];
const telemetry: Array<{ event: string; attrs?: Record<string, unknown> }> = [];

beforeEach(() => { telemetry.length = 0; setGatewayTelemetrySink(e => telemetry.push(e as never)); });
afterEach(async () => {
  resetSpeculations();
  setGatewayTelemetrySink(null);
  vi.useRealTimers();
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise(r => s.close(r)); }
});

const clip = (ms: number) => wav(new Uint8Array(32 * ms).fill(7), 16_000);
const SYSTEM = { system: 'Seu Jorge', language: 'pt', endpoint_ms: 700 };
const events = (name: string) => telemetry.filter(e => e.event === name);

async function harness(stages: FakeStagesOptions = {}, lease = false) {
  const fake = fakeStages(stages);
  const admitted: boolean[] = [];
  const controller = lease ? {
    get: () => ({ name: 'parle-speech' } as never), wake: () => null as never,
    acquire: async () => ({ machine: { ip: '127.0.0.1:1', id: 'r' } as never, token: 't', done: () => {} }),
  } : null;
  const route = createS2SRoute({
    controller: controller as never, ...(lease ? { deployment: 'parle-speech' } : {}), stagesFor: () => fake.stages,
    admit: (_req, _config, requested, charge = true) => { admitted.push(charge); return { ok: true, deployment: requested.deployment }; },
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => { void route(req, res); });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/s2s`;
  const post = async (config: Record<string, unknown>, audio?: Uint8Array, type = 'audio/wav') => {
    const form = new FormData();
    if (audio) form.set('file', new Blob([new Uint8Array(audio)], { type }), 'turn.wav');
    form.set('config', JSON.stringify({ ...SYSTEM, ...config }));
    const res = await fetch(url, { method: 'POST', body: form, headers: { Authorization: 'Bearer app-key' } });
    return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
  };
  const json = async (config: Record<string, unknown>, audio?: Uint8Array, type?: string) => {
    const { res, bytes } = await post(config, audio, type);
    return { status: res.status, body: JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> };
  };
  const stage = (name: string) => fake.calls.filter(c => c.stage === name);
  return { post, json, stage, admitted };
}

describe('s2s speculation', () => {
  it('pause → speculative STT → silence completes: the answer starts without a second STT', async () => {
    const h = await harness({ sttMs: 40 });
    const started = await h.json({ speculation: { id: 't1.0', turn: 't1', action: 'start' } }, clip(2000));
    expect(started).toEqual({ status: 202, body: { speculative: true } });
    await sleep(80);
    expect(h.stage('llm')).toHaveLength(1);
    expect(h.stage('tts')).toHaveLength(0);
    const { res, bytes } = await h.post({ speculation: { id: 't1.0' } }, clip(2300));
    const out = decodeAll(bytes);
    expect(res.status).toBe(200);
    expect(h.stage('stt')).toHaveLength(1);
    expect(h.stage('llm')).toHaveLength(1);
    const transcript = out.events.find(e => e.type === 'transcript')!;
    expect(transcript).toMatchObject({ text: 'Bom dia, eu queria um pão.', speculative: true });
    expect(transcript.at_ms as number).toBeLessThan(30);
    expect(transcript.lead_ms as number).toBeGreaterThanOrEqual(80);
    expect(out.events.find(e => e.type === 'done')).toMatchObject({ speculation: 'hit', reply: 'Bom dia, querida! Aqui está o seu pão.' });
    expect(out.audio).toBe('Bom dia, querida!Aqui está o seu pão.');
    expect(h.admitted).toEqual([false, true]);
    expect(events('s2s.stt_speculative')).toHaveLength(1);
    expect(events('s2s.stt_speculative_discarded')).toHaveLength(0);
    expect(speculationCounts).toMatchObject({ started: 1, committed: 1, discarded: 0 });
  });

  it('the commit arrives while the speculative STT still runs: it waits for that one', async () => {
    const h = await harness({ sttMs: 120 });
    await h.json({ speculation: { id: 'a', action: 'start' } }, clip(2000));
    const out = decodeAll((await h.post({ speculation: { id: 'a' } }, clip(2000))).bytes);
    expect(h.stage('stt')).toHaveLength(1);
    expect(out.events.find(e => e.type === 'done')).toMatchObject({ speculation: 'hit' });
  });

  it('pause → speech resumes: everything speculative is cancelled and nothing was sent', async () => {
    const h = await harness({ sttMs: 60 });
    const started = await h.post({ speculation: { id: 'r', action: 'start' } }, clip(1500));
    expect(started.res.headers.get('content-type')).toContain('application/json');
    expect(await h.json({ speculation: { id: 'r', action: 'cancel' } })).toEqual({ status: 200, body: { cancelled: true } });
    await sleep(100);
    expect(h.stage('stt')[0].signal!.aborted).toBe(true);
    expect(h.stage('llm')).toHaveLength(0);
    expect(h.stage('tts')).toHaveLength(0);
    expect(events('s2s.stt_speculative_discarded').map(e => e.attrs?.reason)).toEqual(['cancelled']);
    const out = decodeAll((await h.post({ speculation: { id: 'r' } }, clip(4000))).bytes);
    expect(h.stage('stt')).toHaveLength(2);
    expect(out.events.find(e => e.type === 'done')).not.toHaveProperty('speculation');
    expect(h.admitted).toEqual([false, true]);
  });

  it('the final clip is longer and heard differently: the LLM is restarted and no audio of the first leaks', async () => {
    const h = await harness({ heard: ['Eu queria', 'Eu queria dois pães, por favor.'], reply: asked => (asked === 'Eu queria' ? 'Queria o quê, meu bem?' : 'Dois pães saindo!'), sttMs: 10 });
    await h.json({ speculation: { id: 'm', action: 'start' } }, clip(1000));
    await sleep(60);
    const out = decodeAll((await h.post({ speculation: { id: 'm' } }, clip(4000))).bytes);
    expect(h.stage('stt')).toHaveLength(2);
    expect(h.stage('llm').map(c => c.text)).toEqual(['Eu queria', 'Eu queria dois pães, por favor.']);
    expect(h.stage('llm')[0].signal!.aborted).toBe(true);
    expect(h.stage('tts').map(c => c.text)).toEqual(['Dois pães saindo!']);
    expect(out.audio).toBe('Dois pães saindo!');
    expect(out.events.find(e => e.type === 'transcript')).toMatchObject({ text: 'Eu queria dois pães, por favor.', speculative: false });
    expect(out.events.find(e => e.type === 'done')).toMatchObject({ speculation: 'miss' });
    expect(events('s2s.stt_speculative_discarded').map(e => e.attrs?.reason)).toEqual(['mismatch']);
  });

  it('a longer final clip heard with the same words keeps the speculative LLM', async () => {
    const h = await harness({ heard: ['bom dia eu queria um pão', 'Bom dia, eu queria um pão.'], sttMs: 10 });
    await h.json({ speculation: { id: 's', action: 'start' } }, clip(1000));
    await sleep(40);
    const out = decodeAll((await h.post({ speculation: { id: 's' } }, clip(4000))).bytes);
    expect(h.stage('stt')).toHaveLength(2);
    expect(h.stage('llm')).toHaveLength(1);
    expect(out.events.find(e => e.type === 'transcript')).toMatchObject({ text: 'Bom dia, eu queria um pão.', speculative: false });
    expect(out.events.find(e => e.type === 'done')).toMatchObject({ speculation: 'llm' });
  });

  it('caps: short clip, unknown container, and at most two per turn', async () => {
    const h = await harness();
    expect((await h.json({ speculation: { id: 'c0', turn: 'c', action: 'start' } }, clip(300))).body).toEqual({ speculative: false, reason: 'short' });
    expect((await h.json({ speculation: { id: 'c0', turn: 'c', action: 'start' } }, new Uint8Array(4000), 'audio/webm')).body).toEqual({ speculative: false, reason: 'format' });
    expect((await h.json({ speculation: { id: 'c1', turn: 'c', action: 'start' } }, clip(1000))).body).toEqual({ speculative: true });
    expect((await h.json({ speculation: { id: 'c2', turn: 'c', action: 'start' } }, clip(1500))).body).toEqual({ speculative: true });
    expect((await h.json({ speculation: { id: 'c3', turn: 'c', action: 'start' } }, clip(2000))).body).toEqual({ speculative: false, reason: 'turn_cap' });
    await sleep(30);
    expect(h.stage('stt')).toHaveLength(2);
    expect(speculationCounts).toMatchObject({ started: 2, refused: 3 });
    expect(events('s2s.stt_speculative_refused').map(e => e.attrs?.reason)).toEqual(['short', 'format', 'turn_cap']);
  });

  it('a seat on the primary takes the turn: the speculation is discarded', async () => {
    const h = await harness({}, true);
    await h.json({ speculation: { id: 'p', action: 'start' } }, clip(1000));
    await h.post({ speculation: { id: 'p' } }, clip(1000));
    expect(events('s2s.stt_speculative_discarded').map(e => e.attrs?.reason)).toEqual(['primary']);
  });

  it('a speculation nobody commits expires and is counted as discarded', () => {
    vi.useFakeTimers();
    const fake = fakeStages({ sttMs: 10_000 });
    const config = { system: 'x' };
    expect(startSpeculation({ owner: 'k', ref: { id: 'e' }, stages: fake.stages, audio: clip(1000), contentType: 'audio/wav', config })).toEqual({ speculative: true });
    vi.advanceTimersByTime(3_999);
    expect(speculationCounts.discarded).toBe(0);
    vi.advanceTimersByTime(2);
    expect(speculationCounts.discarded).toBe(1);
    expect(fake.calls[0].signal!.aborted).toBe(true);
    expect(takeSpeculation('k', 'e', clip(1000), 700)).toBeNull();
    expect(events('s2s.stt_speculative_discarded').map(e => e.attrs?.reason)).toEqual(['expired']);
  });

  it('a speculative STT that used its time is not run again by the turn; one that failed at once is', async () => {
    const turn = async (failedAfterMs: number) => {
      resetSpeculations();
      const fake = fakeStages({ failSttWith: 'stt HTTP 503: timed out' });
      let clock = 0;
      startSpeculation({ owner: 'k', ref: { id: 'f' }, stages: fake.stages, audio: clip(1000), contentType: 'audio/wav', config: {}, now: () => clock });
      clock = failedAfterMs;
      await sleep(20);
      const speculation = takeSpeculation('k', 'f', clip(1000), 700)!;
      const run = runComposite({
        stages: fake.stages, audio: clip(1000), contentType: 'audio/wav', config: {}, signal: new AbortController().signal,
        emitEvent: () => {}, emitAudio: () => {}, skipDeadline: true, speculation,
      });
      await expect(run).rejects.toThrow('timed out');
      return fake.calls.filter(c => c.stage === 'stt').length;
    };
    expect(await turn(3_000)).toBe(1);
    expect(await turn(200)).toBe(2);
  });

  it('another key cannot commit a speculation; the tail allowed is the endpointing plus slack', () => {
    const fake = fakeStages();
    const start = (id: string) => startSpeculation({ owner: 'k', ref: { id }, stages: fake.stages, audio: clip(1000), contentType: 'audio/wav', config: {} });
    start('x');
    expect(takeSpeculation('other', 'x', clip(1000), 700)).toBeNull();
    expect(takeSpeculation('k', 'x', clip(2100), 700)!.same).toBe(true);
    start('y');
    expect(takeSpeculation('k', 'y', clip(2101), 700)!.same).toBe(false);
    expect(wavMs(clip(1000))).toBe(1000);
  });
});
