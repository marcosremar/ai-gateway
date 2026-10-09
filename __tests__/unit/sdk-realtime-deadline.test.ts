import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRealtimeSession, createS2SStreamTransport, createWsTransport, encodeAudioFrame, trimLeadingSilence, type PcmPlayer,
  type RealtimeEvent, type RealtimeSessionOptions, type RealtimeTransport, type SessionDescriptor, type TelemetryEvent,
  type TransportContext,
} from '../../sdk/browser/realtime/index';
import { encodeAudio, encodeEvent } from '../../src/s2s/frames';
import { edgeRefusal } from './_edge-client-updates';

const LINES = ['Hum, deixa eu ver.', 'Um instante.'];
const ENDPOINT_MS = 700;
const OPENER_MS = 1000;
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const DESCRIPTOR: SessionDescriptor = {
  sessionId: 'rt_deadline', expiresAt: '',
  token: `h.${b64({ cfg: b64({ system: 'S', messages: [], opener: { lines: LINES }, endpoint_ms: ENDPOINT_MS }) })}.s`,
  transports: [{ type: 'webrtc', offerUrl: 'https://gw/v1/realtime/sessions/rt_deadline/offer' }, { type: 'ws', url: 'wss://gw/ws' }],
};

interface Heard { what: string; start: number; end: number }

function queuePlayer(heard: Heard[], name: string): PcmPlayer & { flushes: number } {
  const mine: Heard[] = [];
  let end = 0;
  const push = (what: string, ms: number) => {
    const start = Math.max(performance.now(), end);
    end = start + ms;
    const segment = { what: `${name}:${what}`, start, end };
    heard.push(segment);
    mine.push(segment);
  };
  const player = {
    flushes: 0,
    pushFloat: (samples: Float32Array, rate: number) => { push('clip', (samples.length / rate) * 1000); structuredClone(samples.buffer, { transfer: [samples.buffer] }); },
    pushPcm16: (pcm: Int16Array, rate: number) => push('stream', (pcm.length / rate) * 1000),
    pushEncoded: async () => {},
    flush: () => {
      player.flushes++;
      const now = performance.now();
      for (const s of mine) s.end = Math.max(s.start, Math.min(s.end, now));
      end = now;
    },
    playing: false,
    idle: async () => {},
    close: () => {},
  };
  return player;
}

const overlaps = (heard: Heard[]) => heard.filter(s => s.end > s.start).some((a, i, all) => all.some((b, j) => j > i && a.start < b.end && b.start < a.end));

class FakeWs {
  static last: FakeWs;
  binaryType = 'blob';
  readyState = 0;
  bufferedAmount = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url: string) { FakeWs.last = this; setTimeout(() => { this.readyState = 1; this.onopen?.(); setTimeout(() => this.onmessage?.({ data: '{"type":"ready"}' }), 5); }, 5); }
  send(d: unknown) { if (typeof d === 'string') expect(edgeRefusal(JSON.parse(d))).toBeNull(); this.sent.push(d); }
  close(code = 1000, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
  edge(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
  audio(ms: number) { for (let i = 0; i < ms / 20; i++) this.onmessage?.({ data: encodeAudioFrame(new Int16Array(480).fill(9000)).buffer }); }
  control() { return this.sent.filter((d): d is string => typeof d === 'string').map(d => JSON.parse(d) as { type: string; opener?: unknown }); }
}

function open(extra: Partial<RealtimeSessionOptions> = {}) {
  const events: RealtimeEvent[] = [];
  const telemetry: TelemetryEvent[] = [];
  const heard: Heard[] = [];
  const spoken: string[] = [];
  const players: Record<string, ReturnType<typeof queuePlayer>> = {};
  const player = (name: string) => (players[name] ??= queuePlayer(heard, name));
  const rtc = { ctx: null as TransportContext | null, sent: [] as unknown[] };
  const clipTurns: number[] = [];
  const s = createRealtimeSession({
    sessionEndpoint: async () => DESCRIPTOR,
    getMicStream: async () => ({ getAudioTracks: () => [] }) as unknown as MediaStream,
    onEvent: e => events.push(e), onRemoteAudio: () => {}, storage: null, raceTransports: false,
    preferredTransports: ['ws', 's2s-stream'],
    speak: async (text) => { spoken.push(text); return new ArrayBuffer(8); },
    decodeAudio: async () => ({ samples: new Float32Array((24_000 * OPENER_MS) / 1000).fill(0.5), rate: 24_000 }),
    createPlayer: async () => player('local'),
    telemetry: { send: false, onEvent: e => telemetry.push(e) },
    transports: {
      ws: c => createWsTransport(c, 'wss://gw/ws', {
        WebSocket: FakeWs as unknown as typeof WebSocket, player: async () => player('ws'), capture: async () => ({ stop: () => {} }),
      }),
      webrtc: (c): RealtimeTransport => {
        rtc.ctx = c;
        return { type: 'webrtc', clipBased: false, connect: async () => {}, send: (m) => { expect(edgeRefusal(m)).toBeNull(); rtc.sent.push(m); }, close: () => {} };
      },
      's2s-stream': (c): RealtimeTransport => ({
        type: 's2s-stream', clipBased: true, connect: async () => {}, send: () => {}, close: () => {},
        sendTurn: async () => { clipTurns.push(performance.now()); c.emit({ type: 'done' }); },
      }),
    },
    ...extra,
  });
  return { s, events, telemetry, heard, spoken, players, rtc, clipTurns };
}

async function connected(extra: Partial<RealtimeSessionOptions> = {}) {
  const o = open(extra);
  const connecting = o.s.connect();
  await vi.advanceTimersByTimeAsync(50);
  await connecting;
  await vi.advanceTimersByTimeAsync(0);
  const speechEnd = performance.now();
  const at = (ms: number) => vi.advanceTimersByTimeAsync(speechEnd + ms - performance.now());
  const since = (t: number) => Math.round(t - speechEnd);
  return { ...o, at, since };
}

const openers = (events: RealtimeEvent[]) => events.filter(e => e.type === 'opener' && e.state === 'start');
const find = (telemetry: TelemetryEvent[], event: string) => telemetry.filter(e => e.event === event);

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('first-audio deadline on the learner clock', () => {
  it('uplink stalled 3 s on ws: opener by the deadline, the reply follows once in the same queue, telemetry on the learner clock', async () => {
    const { s, events, telemetry, heard, spoken, at, since } = await connected();
    expect(spoken).toEqual(LINES);
    const ws = FakeWs.last;
    await at(ENDPOINT_MS);
    s.sendEndTurn();
    await at(1999);
    expect(openers(events)).toHaveLength(0);
    await at(2000);
    expect(openers(events)).toEqual([{ type: 'opener', state: 'start', text: LINES[0], index: 0, audio_ms: OPENER_MS, local: true }]);
    expect(ws.control()).toContainEqual({ type: 'config_update', opener: null });
    await at(3700);
    ws.edge({ type: 'deadline_missed', deadline_ms: 2000 });
    ws.edge({ type: 'transcript', text: 'um pão', final: true });
    ws.edge({ type: 'audio_start' });
    ws.audio(400);
    ws.edge({ type: 'metrics', ttfa_ms: 300, first_sound_ms: 300, first_sound_from_speech_ms: 400 });
    ws.edge({ type: 'audio_end' });
    ws.edge({ type: 'done' });
    expect(openers(events)).toHaveLength(1);
    expect(events.filter(e => e.type === 'deadline_missed')).toHaveLength(0);
    expect(events.filter(e => e.type === 'audio_start')).toHaveLength(1);
    expect(events.filter(e => e.type === 'done')).toHaveLength(1);
    expect(heard.map(h => [h.what, since(h.start)])[0]).toEqual(['ws:clip', 2000]);
    expect(since(heard[1]!.start)).toBe(3700);
    expect(overlaps(heard)).toBe(false);
    expect(find(telemetry, 'turn.first_sound')[0]).toMatchObject({ durMs: 2000, attrs: { source: 'client_opener', transport: 'ws', uplinkBufferedBytes: 0 } });
    expect(find(telemetry, 'turn.first_audio')[0]!.attrs).toMatchObject({ fromSpeechMs: 3700 });
    expect(find(telemetry, 'turn.done')[0]!.attrs).toMatchObject({ firstSoundMs: 2000, networkDelayMs: 3300, clientOpener: true });
    expect(s.metrics.lastTurn).toMatchObject({ learner_first_sound_ms: 2000, network_delay_ms: 3300 });
    expect(ws.control().at(-1)).toEqual({ type: 'config_update', opener: { lines: LINES } });
    s.close();
  });

  it('reply arriving while the opener plays queues behind it, and the next stalled turn takes the next line', async () => {
    const { s, events, heard, at, since } = await connected();
    const ws = FakeWs.last;
    await at(ENDPOINT_MS);
    s.sendEndTurn();
    await at(2300);
    ws.edge({ type: 'audio_start' });
    ws.audio(200);
    ws.edge({ type: 'audio_end' });
    ws.edge({ type: 'done' });
    expect(heard.map(h => since(h.start))[1]).toBe(2000 + OPENER_MS);
    expect(overlaps(heard)).toBe(false);
    await at(10_000 + ENDPOINT_MS);
    s.sendEndTurn();
    await at(12_100);
    ws.edge({ type: 'done' });
    await at(20_000 + ENDPOINT_MS);
    s.sendEndTurn();
    await at(22_100);
    expect(openers(events).map(e => (e as { index?: number; audio_ms?: number }))).toMatchObject([
      { index: 0, audio_ms: OPENER_MS }, { index: 1, audio_ms: OPENER_MS }, { index: 0, audio_ms: OPENER_MS },
    ]);
    expect(heard.filter(h => h.what === 'ws:clip').map(h => h.end - h.start)).toEqual([OPENER_MS, OPENER_MS, OPENER_MS]);
    s.close();
  });

  it('a server opener that crosses the local one is dropped on ws: one opener heard, the reply right behind', async () => {
    const { s, events, heard, at } = await connected();
    const ws = FakeWs.last;
    await at(ENDPOINT_MS);
    s.sendEndTurn();
    await at(2100);
    ws.edge({ type: 'opener', state: 'start', text: LINES[1], index: 1, audio_ms: 500 });
    ws.edge({ type: 'opener', state: 'end', index: 1 });
    ws.audio(500);
    ws.edge({ type: 'audio_start' });
    ws.audio(300);
    ws.edge({ type: 'done' });
    expect(openers(events)).toHaveLength(1);
    expect(heard.filter(h => h.what === 'ws:stream').reduce((n, h) => n + h.end - h.start, 0)).toBeCloseTo(300, 5);
    expect(overlaps(heard)).toBe(false);
    s.close();
  });

  it('fast path: audio in time plays as it arrives, no opener, nothing extra sent', async () => {
    const { s, events, telemetry, heard, at, since } = await connected();
    const ws = FakeWs.last;
    await at(ENDPOINT_MS);
    s.sendEndTurn();
    await at(1200);
    ws.edge({ type: 'audio_start' });
    ws.audio(200);
    await at(5000);
    ws.edge({ type: 'done' });
    expect(openers(events)).toHaveLength(0);
    expect(since(heard[0]!.start)).toBe(1200);
    expect(ws.control().map(m => m.type)).toEqual(['end_turn']);
    expect(find(telemetry, 'turn.first_sound')[0]).toMatchObject({ durMs: 1200, attrs: { source: 'reply' } });
    expect(find(telemetry, 'turn.done')[0]!.attrs).toMatchObject({ firstSoundMs: 1200, clientOpener: false });
    s.close();
  });

  it('a server opener in time wins: the client plays none', async () => {
    const { s, events, heard, at } = await connected();
    const ws = FakeWs.last;
    await at(ENDPOINT_MS);
    s.sendEndTurn();
    await at(1800);
    ws.edge({ type: 'opener', state: 'start', text: LINES[0], index: 0, audio_ms: 500 });
    ws.audio(500);
    await at(4000);
    expect(openers(events)).toEqual([{ type: 'opener', state: 'start', text: LINES[0], index: 0, audio_ms: 500 }]);
    expect(heard.every(h => h.what === 'ws:stream')).toBe(true);
    expect(ws.control().map(m => m.type)).toEqual(['end_turn']);
    s.close();
  });

  it('barge-in during the client opener stops it and tells the edge', async () => {
    const { s, events, heard, players, at, since } = await connected();
    const ws = FakeWs.last;
    await at(ENDPOINT_MS);
    s.sendEndTurn();
    await at(2300);
    s.interrupt();
    expect(players.ws!.flushes).toBe(1);
    expect(since(heard[0]!.end)).toBe(2300);
    expect(events.slice(-2)).toEqual([{ type: 'opener', state: 'end', index: 0, local: true }, { type: 'audio_end' }]);
    expect(ws.control().at(-1)).toEqual({ type: 'interrupt' });
    await at(6000);
    expect(openers(events)).toHaveLength(1);
    s.close();
  });

  it('an interrupt before the deadline cancels the opener', async () => {
    const { s, events, at } = await connected();
    await at(ENDPOINT_MS);
    s.sendEndTurn();
    await at(1500);
    s.interrupt();
    await at(5000);
    expect(openers(events)).toHaveLength(0);
    s.close();
  });

  it('webrtc: the opener plays on the local player and is cut when the reply audio starts, never over it', async () => {
    const { s, events, players, heard, rtc, at, since } = await connected({ preferredTransports: ['webrtc'] });
    expect(s.transport).toBe('webrtc');
    await at(ENDPOINT_MS);
    s.sendEndTurn();
    await at(2000);
    expect(heard.map(h => [h.what, since(h.start)])).toEqual([['local:clip', 2000]]);
    expect(rtc.sent).toContainEqual({ type: 'config_update', opener: null });
    await at(2400);
    rtc.ctx!.emit({ type: 'audio_start' });
    expect(players.local!.flushes).toBe(1);
    expect(since(heard[0]!.end)).toBe(2400);
    expect(events.slice(-3).map(e => e.type)).toEqual(['opener', 'audio_end', 'audio_start']);
    rtc.ctx!.emit({ type: 'done' });
    expect(rtc.sent.at(-1)).toEqual({ type: 'config_update', opener: { lines: LINES } });
    s.close();
  });

  it('the transport breaks during the stall: one opener, one done{error}, the turn is not answered twice', async () => {
    const { s, events, clipTurns, at } = await connected();
    const ws = FakeWs.last;
    await at(ENDPOINT_MS);
    s.sendEndTurn();
    await at(2300);
    ws.close(1006, 'stalled');
    await at(6000);
    expect(s.transport).toBe('s2s-stream');
    expect(openers(events)).toHaveLength(1);
    expect(events.filter(e => e.type === 'done')).toEqual([{ type: 'done', error: true }]);
    expect(events.filter(e => e.type === 'error').map(e => (e as { code: string }).code)).toEqual(['turn_lost']);
    expect(clipTurns).toHaveLength(0);
    s.close();
  });

  it('no speak, or no opener lines: no client opener and no timer', async () => {
    const { s, events, spoken, at } = await connected({ speak: undefined });
    await at(ENDPOINT_MS);
    s.sendEndTurn();
    await at(6000);
    expect(spoken).toEqual([]);
    expect(openers(events)).toHaveLength(0);
    s.close();
  });
});

describe('clip rung', () => {
  it('upload stalled: local opener by the deadline, the stream\'s own opener dropped, the reply behind it', async () => {
    const heard: Heard[] = [];
    const events: RealtimeEvent[] = [];
    const pcm = (ms: number) => new Uint8Array(new Int16Array(24 * ms).fill(9000).buffer);
    const body = [
      encodeEvent({ type: 'opener', state: 'start', text: LINES[1], index: 1, audio_ms: 500 }, 'binary'), encodeAudio(pcm(500), 'binary'),
      encodeEvent({ type: 'opener', state: 'end', index: 1 }, 'binary'),
      encodeEvent({ type: 'first_audio' }, 'binary'), encodeAudio(pcm(300), 'binary'),
      encodeEvent({ type: 'done', sentences: 1, spoken: 1 }, 'binary'),
    ];
    const fetchImpl = (async () => {
      await new Promise(r => setTimeout(r, 3000));
      return new Response(new ReadableStream({ start(c) { for (const chunk of body) c.enqueue(chunk); c.close(); } }));
    }) as unknown as typeof fetch;
    const t = createS2SStreamTransport({
      descriptor: null, timeouts: { turnMs: 45_000 }, fetchImpl, traceparent: 'tp', emit: (e: RealtimeEvent) => events.push(e), config: () => ({}),
    } as unknown as TransportContext, { url: '/api/s2s' }, async () => queuePlayer(heard, 'clip'));
    const turn = t.sendTurn!(new Blob(['wav']));
    await vi.advanceTimersByTimeAsync(1300);
    const openerAt = performance.now();
    t.playOpener!(new Float32Array(24_000).fill(0.5), 24_000);
    await vi.advanceTimersByTimeAsync(1700);
    await turn;
    expect(heard.map(h => [h.what, Math.round(h.start - openerAt), Math.round(h.end - h.start)])).toEqual([['clip:clip', 0, 1000], ['clip:stream', 1700, 300]]);
    expect(events.filter(e => e.type === 'opener')).toHaveLength(0);
    expect(events.filter(e => e.type === 'audio_start')).toHaveLength(1);
  });
});

describe('trimLeadingSilence', () => {
  it('keeps 10 ms before the first loud sample', () => {
    const samples = new Float32Array(24_000);
    samples.fill(0.4, 6000);
    expect(trimLeadingSilence(samples, 24_000).length).toBe(24_000 - 6000 + 240);
    expect(trimLeadingSilence(new Float32Array(100), 24_000).length).toBe(100);
  });
});
