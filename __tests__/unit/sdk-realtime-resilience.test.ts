/**
 * Connection speed and resilience of the realtime SDK with fake browser APIs: when the WebRTC offer leaves, the playout
 * delay of the receiver, pre-connecting, recovering a reply cut by an upstream error, and surviving a network change.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TIMEOUTS, createRealtimeSession, createWebRtcTransport, setPlayoutDelay, type PcmPlayer, type RealtimeEvent, type RealtimeSessionOptions,
  type SessionDescriptor, type TelemetryEvent, type TransportContext, type TransportOffer,
} from '../../sdk/browser/realtime/index';
import { createLocalTelemetry } from '../../sdk/browser/realtime/telemetry';
import { edgeRefusal } from './_edge-client-updates';

type Calls = Array<{ url: string; init: RequestInit; at: number }>;

function ctx(over: Partial<TransportContext> = {}) {
  const telemetry = createLocalTelemetry({ send: false });
  const events: RealtimeEvent[] = [];
  const failures: Error[] = [];
  const calls: Calls = [];
  const started = performance.now();
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, at: performance.now() - started });
    return init.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ sdp: 'v=0\r\nanswer', type: 'answer' });
  }) as unknown as typeof fetch;
  const c: TransportContext = {
    descriptor: { sessionId: 'rt_1', token: 'tok', expiresAt: '', transports: [] },
    timeouts: { ...DEFAULT_TIMEOUTS, iceGatherMs: 150, webrtcConnectMs: 200, disconnectGraceMs: 10 },
    fetchImpl, telemetry, traceparent: telemetry.traceparent,
    mic: async () => ({ getAudioTracks: () => [{ kind: 'audio' }] }) as unknown as MediaStream,
    emit: e => events.push(e), fail: e => failures.push(e), remoteAudio: () => {}, config: () => ({}), dropped: () => {},
    ...over,
  };
  return { c, events, failures, calls };
}

class FakePc extends EventTarget {
  static last: FakePc;
  static candidates: Array<[number, string | null]> = [];
  static reconnects = true;
  static made = 0;
  index = FakePc.made++;
  closed = false;
  iceGatheringState = 'new';
  connectionState = 'new';
  iceConnectionState = 'new';
  localDescription: { sdp: string } | null = null;
  offers: unknown[] = [];
  answers = 0;
  sent: unknown[] = [];
  channel = Object.assign(new EventTarget(), {
    readyState: 'connecting', send: (d: string) => { expect(edgeRefusal(JSON.parse(d))).toBeNull(); this.sent.push(JSON.parse(d)); }, close: () => {},
    onmessage: null as ((e: { data: string }) => void) | null, onclose: null as (() => void) | null,
  });
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  constructor(readonly config: { iceTransportPolicy?: string }) { super(); FakePc.last = this; }
  addTrack() {}
  addTransceiver() {}
  createDataChannel() { return this.channel; }
  async createOffer(options?: unknown) { this.offers.push(options); return { type: 'offer', sdp: 'v=0\r\n' }; }
  async setLocalDescription(d: { sdp: string }) {
    this.localDescription = { sdp: d.sdp };
    setTimeout(() => { this.iceGatheringState = 'gathering'; }, 0);
    for (const [at, type] of FakePc.candidates) {
      setTimeout(() => {
        if (type === null) { this.iceGatheringState = 'complete'; this.dispatchEvent(new Event('icegatheringstatechange')); return; }
        this.localDescription!.sdp += `a=candidate:1 1 udp 1 192.0.2.1 9 typ ${type}\r\n`;
        this.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: { type, candidate: `candidate:1 1 udp 1 192.0.2.1 9 typ ${type}` } }));
      }, at);
    }
  }
  async setRemoteDescription() {
    this.answers++;
    if (this.index === 0 || FakePc.reconnects) setTimeout(() => this.state('connected'), 5);
  }
  state(state: string) {
    this.connectionState = state;
    this.iceConnectionState = state;
    if (state === 'connected') { this.channel.readyState = 'open'; this.channel.dispatchEvent(new Event('open')); }
    this.dispatchEvent(new Event('connectionstatechange'));
    this.onconnectionstatechange?.();
  }
  edge(event: Record<string, unknown>) { this.channel.onmessage?.({ data: JSON.stringify(event) }); }
  async getStats() { return new Map(); }
  close() { this.closed = true; }
}

const OFFER = { type: 'webrtc' as const, offerUrl: 'https://gw/v1/realtime/sessions/rt_1/offer' };
const DESCRIPTOR: SessionDescriptor = { sessionId: 'rt_1', token: 'tok', expiresAt: '', transports: [OFFER, { type: 'ws', url: 'wss://gw/ws' }] };

const refuseReoffer = { on: false };

function session(extra: Partial<RealtimeSessionOptions> = {}) {
  const events: RealtimeEvent[] = [];
  const telemetry: TelemetryEvent[] = [];
  const counts = { admissions: 0, mics: 0 };
  const deleted: string[] = [];
  const offers: string[] = [];
  const wsSent: unknown[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (init.method === 'DELETE') { deleted.push(url); return new Response(null, { status: 204 }); }
    offers.push((JSON.parse(String(init.body)) as { sdp: string }).sdp);
    return offers.length > 1 && refuseReoffer.on ? Response.json({ error: { code: 'unauthorized' } }, { status: 401 }) : Response.json({ sdp: 'v=0\r\nanswer', type: 'answer' });
  }) as unknown as typeof fetch;
  const s = createRealtimeSession({
    sessionEndpoint: async () => { counts.admissions++; return DESCRIPTOR; },
    getMicStream: async () => { counts.mics++; return { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream; },
    onEvent: e => events.push(e), onRemoteAudio: () => {}, storage: null, fetchImpl, raceTransports: false,
    timeouts: { iceGatherMs: 50, webrtcConnectMs: 200, disconnectGraceMs: 10, iceRestartMs: 80 },
    transports: {
      webrtc: c => createWebRtcTransport(c, OFFER, { RTCPeerConnection: FakePc as unknown as typeof RTCPeerConnection }),
      ws: () => ({ type: 'ws', clipBased: false, connect: async () => {}, send: (m) => { wsSent.push(m); }, close: () => {} }),
    },
    telemetry: { send: false, onEvent: e => telemetry.push(e) },
    ...extra,
  });
  return { s, events, telemetry, counts, offers, wsSent, deleted };
}

function webrtc(c: TransportContext, offer: Partial<Extract<TransportOffer, { type: 'webrtc' }>> = {}) {
  return createWebRtcTransport(c, { type: 'webrtc', offerUrl: 'https://gw/v1/realtime/sessions/rt_1/offer', ...offer }, { RTCPeerConnection: FakePc as unknown as typeof RTCPeerConnection });
}

const sentSdp = (calls: Calls, i = 0) => (JSON.parse(String(calls[i]!.init.body)) as { sdp: string }).sdp;

describe('WebRTC offer timing', () => {
  it('sends the offer at the first server-reflexive candidate, not at the gathering ceiling', async () => {
    FakePc.candidates = [[5, 'host'], [15, 'srflx'], [100, 'relay'], [120, null]];
    const { c, calls } = ctx();
    const t = webrtc(c);
    await t.connect(new AbortController().signal);
    expect(calls[0]!.at).toBeLessThan(90);
    expect(sentSdp(calls)).toMatch(/typ host[\s\S]*typ srflx/);
    expect(sentSdp(calls)).not.toMatch(/typ relay/);
    t.close();
  });

  it('relay-only policy waits for the relay candidate', async () => {
    FakePc.candidates = [[5, 'srflx'], [60, 'relay'], [140, null]];
    const { c, calls } = ctx();
    const t = webrtc(c, { iceTransportPolicy: 'relay' });
    await t.connect(new AbortController().signal);
    expect(FakePc.last.config.iceTransportPolicy).toBe('relay');
    expect(calls[0]!.at).toBeGreaterThanOrEqual(55);
    expect(calls[0]!.at).toBeLessThan(130);
    expect(sentSdp(calls)).toMatch(/typ relay/);
    t.close();
  });

  it('a host-only network sends what was gathered at the ceiling; gathering complete sends at once', async () => {
    FakePc.candidates = [[5, 'host']];
    const slow = ctx();
    const a = webrtc(slow.c);
    await a.connect(new AbortController().signal);
    expect(slow.calls[0]!.at).toBeGreaterThanOrEqual(145);
    expect(sentSdp(slow.calls)).toMatch(/typ host/);
    a.close();

    FakePc.candidates = [[5, 'host'], [10, null]];
    const fast = ctx();
    const b = webrtc(fast.c);
    await b.connect(new AbortController().signal);
    expect(fast.calls[0]!.at).toBeLessThan(90);
    b.close();
  });
});

describe('playout delay', () => {
  it('uses jitterBufferTarget (ms), else playoutDelayHint (s), and never throws without either', () => {
    const modern = { jitterBufferTarget: null as number | null, playoutDelayHint: null as number | null };
    expect(setPlayoutDelay(modern as unknown as RTCRtpReceiver, 40)).toBe('jitterBufferTarget');
    expect(modern).toEqual({ jitterBufferTarget: 40, playoutDelayHint: null });
    const legacy = { playoutDelayHint: null as number | null };
    expect(setPlayoutDelay(legacy as unknown as RTCRtpReceiver, 40)).toBe('playoutDelayHint');
    expect(legacy.playoutDelayHint).toBe(0.04);
    expect(setPlayoutDelay({} as RTCRtpReceiver, 40)).toBeNull();
    expect(setPlayoutDelay(undefined, 40)).toBeNull();
    const strict = { set jitterBufferTarget(_: number) { throw new RangeError('out of range'); }, get jitterBufferTarget() { return 0; } };
    expect(setPlayoutDelay(strict as unknown as RTCRtpReceiver, 9999)).toBeNull();
  });

  it('the receiver of the remote track gets the session value, 0 ms by default', async () => {
    FakePc.candidates = [[1, null]];
    for (const [playoutDelayMs, want] of [[undefined, 0], [60, 60]] as const) {
      const { c } = ctx({ playoutDelayMs });
      const t = webrtc(c);
      await t.connect(new AbortController().signal);
      const receiver = { jitterBufferTarget: null as number | null };
      FakePc.last.ontrack!({ receiver, streams: [{}], track: {} });
      expect(receiver.jitterBufferTarget).toBe(want);
      t.close();
    }
  });
});

describe('pre-connect', () => {
  it('connect() pays admission, transport and microphone once and stays idle: no end_turn, no turn, no history', async () => {
    FakePc.candidates = [[1, 'srflx']];
    const { s, events, telemetry, counts } = session();
    expect(await s.connect()).toBe('webrtc');
    const pc = FakePc.last;
    await new Promise(r => setTimeout(r, 60));
    expect(counts).toEqual({ admissions: 1, mics: 1 });
    expect(pc.sent).toEqual([]);
    expect(s.history).toEqual([]);
    expect(telemetry.filter(e => e.event.startsWith('turn.'))).toEqual([]);
    expect(events.map(e => e.type)).toEqual(['transport']);

    s.sendEndTurn();
    pc.edge({ type: 'transcript', text: 'Bom dia', final: true });
    pc.edge({ type: 'reply', text: 'Olá!' });
    pc.edge({ type: 'done' });
    expect(pc.sent).toEqual([{ type: 'end_turn' }]);
    expect(counts).toEqual({ admissions: 1, mics: 1 });
    expect(s.history).toEqual([{ role: 'user', content: 'Bom dia' }, { role: 'assistant', content: 'Olá!' }]);
    expect(telemetry.filter(e => e.event === 'turn.done')).toHaveLength(1);
    s.close();
  });
});

function fakePlayer() {
  const played: string[] = [];
  let release: (() => void) | null = null;
  let flushed = 0;
  const player: PcmPlayer = {
    pushPcm16: () => {}, pushFloat: () => {}, playing: false, close: () => {},
    pushEncoded: async (data) => { played.push(new TextDecoder().decode(data)); },
    idle: () => new Promise<void>((resolve) => { release = resolve; }),
    flush: () => { flushed++; release?.(); },
  };
  return { player, played, finish: () => release?.(), flushes: () => flushed };
}

const audioOf = (text: string) => new TextEncoder().encode(`audio<${text}>`).buffer as ArrayBuffer;

async function failingReply(extra: Partial<RealtimeSessionOptions>) {
  FakePc.candidates = [[1, 'srflx']];
  const out = session(extra);
  await out.s.connect();
  const pc = FakePc.last;
  out.s.sendEndTurn();
  pc.edge({ type: 'transcript', text: 'Um pão, por favor', final: true });
  pc.edge({ type: 'reply_delta', text: 'Claro! São dois reais. Mais alguma coisa?' });
  pc.edge({ type: 'reply', text: 'Claro! São dois reais. Mais alguma coisa?' });
  pc.edge({ type: 'audio_start' });
  return { ...out, pc };
}

const types = (events: RealtimeEvent[]) => events.map(e => e.type).filter(t => t !== 'transport');

describe('reply cut by an upstream error', () => {
  it('error after sentence 1 of 3: sentences 2–3 are spoken once, in order, and the turn ends done without error', async () => {
    const p = fakePlayer();
    const spoken: string[] = [];
    const { s, events, telemetry, pc } = await failingReply({
      speak: async (text) => { spoken.push(text); return audioOf(text); }, createPlayer: async () => p.player,
    });
    pc.edge({ type: 'error', code: 'upstream', message: 'tts 503', unspoken: 'São dois reais. Mais alguma coisa?' });
    pc.edge({ type: 'audio_end' });
    expect(p.played).toEqual([]);
    pc.edge({ type: 'done', error: true });
    await vi.waitFor(() => expect(p.played).toEqual(['audio<São dois reais. Mais alguma coisa?>']));
    expect(types(events)).toEqual(['transcript', 'reply_delta', 'reply', 'audio_start', 'audio_end', 'audio_start', 'recovered']);
    p.finish();
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: 'done' }));
    expect(types(events)).toEqual(['transcript', 'reply_delta', 'reply', 'audio_start', 'audio_end', 'audio_start', 'recovered', 'audio_end', 'done']);
    expect(spoken).toEqual(['São dois reais. Mais alguma coisa?']);
    expect(s.history).toEqual([{ role: 'user', content: 'Um pão, por favor' }, { role: 'assistant', content: 'Claro! São dois reais. Mais alguma coisa?' }]);
    expect(telemetry.filter(e => e.event === 'turn.recovered')).toHaveLength(1);
    expect(telemetry.filter(e => e.event === 'turn.done')).toHaveLength(1);
    expect(telemetry.filter(e => e.event === 'error')).toHaveLength(0);
    expect(JSON.stringify(telemetry)).not.toMatch(/reais|pão/);
    s.close();
  });

  it('a truncated stream (clip rung) with a known remainder is recovered the same way', async () => {
    const p = fakePlayer();
    const { s, events, pc } = await failingReply({ speak: async (text) => audioOf(text), createPlayer: async () => p.player });
    pc.edge({ type: 'error', code: 'truncated', message: 's2s stream ended without done', unspoken: 'São dois reais.' });
    pc.edge({ type: 'done', error: true });
    await vi.waitFor(() => expect(p.played).toEqual(['audio<São dois reais.>'])); // before: only code `upstream` was recovered
    p.finish();
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: 'done' }));
    expect(events.some(e => e.type === 'error')).toBe(false);
    s.close();
  });

  it('no cut point from the edge, or no speak: the error and done{error} reach the page as before', async () => {
    const spoken: string[] = [];
    const a = await failingReply({ speak: async (text) => { spoken.push(text); return audioOf(text); }, createPlayer: async () => fakePlayer().player });
    a.pc.edge({ type: 'error', code: 'upstream', message: 'llm 500' });
    a.pc.edge({ type: 'done', error: true });
    expect(a.events.slice(-2)).toEqual([{ type: 'error', code: 'upstream', message: 'llm 500' }, { type: 'done', error: true }]);
    expect(spoken).toEqual([]);
    a.s.close();

    const b = await failingReply({});
    b.pc.edge({ type: 'error', code: 'upstream', message: 'tts 503', unspoken: 'São dois reais.' });
    b.pc.edge({ type: 'done', error: true });
    expect(types(b.events).slice(-2)).toEqual(['error', 'done']);
    expect(b.events.some(e => e.type === 'recovered')).toBe(false);
    b.s.close();
  });

  it('the recovery itself fails: one error, one done{error}, no second attempt', async () => {
    let calls = 0;
    const { s, events, telemetry, pc } = await failingReply({
      speak: async () => { calls++; throw new Error('tts relay 502'); }, createPlayer: async () => fakePlayer().player,
    });
    pc.edge({ type: 'error', code: 'upstream', message: 'tts 503', unspoken: 'São dois reais.' });
    pc.edge({ type: 'done', error: true });
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: 'done', error: true }));
    await new Promise(r => setTimeout(r, 20));
    expect(calls).toBe(1);
    expect(events.filter(e => e.type === 'error')).toHaveLength(1);
    expect(events.filter(e => e.type === 'done')).toHaveLength(1);
    expect(events.some(e => e.type === 'recovered')).toBe(false);
    expect(telemetry.filter(e => e.event === 'turn.done')).toHaveLength(1);
    s.close();
  });

  it('barge-in during the recovered audio stops it: interrupted, one done, nothing sent to the edge', async () => {
    const p = fakePlayer();
    const { s, events, pc } = await failingReply({ speak: async (text) => audioOf(text), createPlayer: async () => p.player });
    pc.edge({ type: 'error', code: 'upstream', message: 'tts 503', unspoken: 'São dois reais.' });
    pc.edge({ type: 'done', error: true });
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: 'recovered' }));
    s.interrupt();
    await new Promise(r => setTimeout(r, 20));
    expect(p.flushes()).toBe(1);
    expect(types(events).slice(-2)).toEqual(['interrupted', 'done']);
    expect(events.filter(e => e.type === 'done')).toHaveLength(1);
    expect(pc.sent).toEqual([{ type: 'end_turn' }]);
    s.close();
  });
});

describe('network change during a WebRTC session', () => {
  afterEach(() => { refuseReoffer.on = false; FakePc.reconnects = true; });

  async function live() {
    FakePc.candidates = [[2, 'srflx'], [4, null]];
    FakePc.made = 0;
    const out = session();
    await out.s.connect();
    const pc = FakePc.last;
    pc.edge({ type: 'transcript', text: 'Bom dia', final: true });
    pc.edge({ type: 'reply', text: 'Olá!' });
    pc.edge({ type: 'done' });
    return { ...out, pc };
  }

  const restarts = (telemetry: TelemetryEvent[]) => telemetry.filter(e => e.event === 'rt.ice.restart').map(e => e.attrs?.ok);

  it('disconnected past the grace: a fresh peer connection re-offers on the same session, the old one is closed, nothing shown to the page', async () => {
    const { s, events, telemetry, counts, offers, deleted, pc } = await live();
    pc.state('disconnected');
    await vi.waitFor(() => expect(restarts(telemetry)).toEqual([true]));
    const next = FakePc.last;
    expect(next).not.toBe(pc);
    expect(pc.closed).toBe(true);
    expect(next.closed).toBe(false);
    expect([pc.offers, next.offers]).toEqual([[undefined], [undefined]]);
    expect(offers).toHaveLength(2);
    expect(offers[1]).toMatch(/typ srflx/);
    expect(deleted).toEqual([]);
    s.updateHistory([]);
    expect([pc.sent, next.sent]).toEqual([[], [{ type: 'config_update', messages: [] }]]);
    expect(counts.admissions).toBe(1);
    expect(s.transport).toBe('webrtc');
    expect(s.metrics.failovers).toBe(0);
    expect(types(events)).toEqual(['transcript', 'reply', 'done']);
    expect(s.history).toEqual([{ role: 'user', content: 'Bom dia' }, { role: 'assistant', content: 'Olá!' }]);
    s.close();
  });

  it('a blip that heals inside the grace restarts nothing; failed restarts at once', async () => {
    const { s, telemetry, offers, pc } = await live();
    pc.state('disconnected');
    pc.state('connected');
    await new Promise(r => setTimeout(r, 30));
    expect(offers).toHaveLength(1);
    pc.state('failed');
    await vi.waitFor(() => expect(restarts(telemetry)).toEqual([true]));
    expect(offers).toHaveLength(2);
    s.close();
  });

  it('the restart is refused, or finds no path within iceRestartMs: WebSocket with a new session and the history', async () => {
    for (const mode of ['refused', 'no path'] as const) {
      refuseReoffer.on = mode === 'refused';
      FakePc.reconnects = mode === 'refused';
      const { s, events, telemetry, counts, wsSent, pc } = await live();
      pc.state('failed');
      await vi.waitFor(() => expect(s.transport).toBe('ws'));
      expect(restarts(telemetry)).toEqual([false]);
      expect(counts.admissions).toBe(2);
      expect(wsSent).toEqual([{ type: 'config_update', messages: [{ role: 'user', content: 'Bom dia' }, { role: 'assistant', content: 'Olá!' }] }]);
      expect(events.at(-1)).toEqual({ type: 'transport', transport: 'ws', reason: 'failover', from: 'webrtc' });
      expect(events.some(e => e.type === 'error')).toBe(false);
      expect(s.metrics.failovers).toBe(1);
      s.close();
    }
  });

  it('a drop in the middle of a turn: the restart keeps the turn, and its reply lands once in the history', async () => {
    const { s, events, telemetry, pc } = await live();
    s.sendEndTurn();
    pc.edge({ type: 'transcript', text: 'Um pão', final: true });
    pc.state('disconnected');
    await vi.waitFor(() => expect(restarts(telemetry)).toEqual([true]));
    pc.edge({ type: 'reply', text: 'from the closed peer connection' });
    FakePc.last.edge({ type: 'reply', text: 'Claro!' });
    FakePc.last.edge({ type: 'done' });
    expect(s.history.slice(2)).toEqual([{ role: 'user', content: 'Um pão' }, { role: 'assistant', content: 'Claro!' }]);
    expect(events.some(e => e.type === 'error')).toBe(false);
    expect(telemetry.filter(e => e.event === 'turn.done')).toHaveLength(2);
    s.close();
  });

  it('a drop in the middle of a turn with no path back: the turn ends once with turn_lost, the user message is replayed once', async () => {
    refuseReoffer.on = true;
    const { s, events, wsSent, pc } = await live();
    s.sendEndTurn();
    pc.edge({ type: 'transcript', text: 'Um pão', final: true });
    pc.state('failed');
    await vi.waitFor(() => expect(s.transport).toBe('ws'));
    expect(types(events).slice(-3)).toEqual(['transcript', 'error', 'done']);
    expect(events.filter(e => e.type === 'error')).toMatchObject([{ code: 'turn_lost' }]);
    expect(events.at(-2)).toEqual({ type: 'done', error: true });
    expect((wsSent[0] as { messages: unknown[] }).messages).toEqual([
      { role: 'user', content: 'Bom dia' }, { role: 'assistant', content: 'Olá!' }, { role: 'user', content: 'Um pão' },
    ]);
    s.sendEndTurn();
    expect(wsSent.at(-1)).toEqual({ type: 'end_turn' });
    s.close();
  });
});
