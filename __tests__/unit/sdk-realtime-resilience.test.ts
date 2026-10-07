/**
 * Connection speed and resilience of the realtime SDK with fake browser APIs: when the WebRTC offer leaves, the playout
 * delay of the receiver, pre-connecting, recovering a reply cut by an upstream error, and surviving a network change.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEOUTS, createRealtimeSession, createWebRtcTransport, setPlayoutDelay, type RealtimeEvent, type RealtimeSessionOptions,
  type SessionDescriptor, type TelemetryEvent, type TransportContext, type TransportOffer,
} from '../../sdk/browser/realtime/index';
import { createLocalTelemetry } from '../../sdk/browser/realtime/telemetry';

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
  iceGatheringState = 'new';
  connectionState = 'new';
  iceConnectionState = 'new';
  localDescription: { sdp: string } | null = null;
  offers: unknown[] = [];
  answers = 0;
  sent: unknown[] = [];
  channel = Object.assign(new EventTarget(), {
    readyState: 'connecting', send: (d: string) => { this.sent.push(JSON.parse(d)); }, close: () => {},
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
    this.iceGatheringState = 'gathering';
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
    setTimeout(() => this.state('connected'), 5);
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
  close() {}
}

const OFFER = { type: 'webrtc' as const, offerUrl: 'https://gw/v1/realtime/sessions/rt_1/offer' };
const DESCRIPTOR: SessionDescriptor = { sessionId: 'rt_1', token: 'tok', expiresAt: '', transports: [OFFER, { type: 'ws', url: 'wss://gw/ws' }] };

function session(extra: Partial<RealtimeSessionOptions> = {}) {
  const events: RealtimeEvent[] = [];
  const telemetry: TelemetryEvent[] = [];
  const counts = { admissions: 0, mics: 0 };
  const fetchImpl = (async (_url: string, init: RequestInit) => (
    init.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ sdp: 'v=0\r\nanswer', type: 'answer' })
  )) as unknown as typeof fetch;
  const s = createRealtimeSession({
    sessionEndpoint: async () => { counts.admissions++; return DESCRIPTOR; },
    getMicStream: async () => { counts.mics++; return { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream; },
    onEvent: e => events.push(e), onRemoteAudio: () => {}, storage: null, fetchImpl,
    timeouts: { iceGatherMs: 50, webrtcConnectMs: 200, disconnectGraceMs: 10 },
    transports: { webrtc: c => createWebRtcTransport(c, OFFER, { RTCPeerConnection: FakePc as unknown as typeof RTCPeerConnection }) },
    telemetry: { send: false, onEvent: e => telemetry.push(e) },
    ...extra,
  });
  return { s, events, telemetry, counts };
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
