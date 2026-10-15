import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TIMEOUTS, createRealtimeSession, createWebRtcTransport, createWsTransport, type PcmPlayer, type RealtimeEvent, type RealtimeSessionOptions,
  type SessionDescriptor, type StorageLike, type TelemetryEvent, type TransportContext, type TransportType,
} from '../../sdk/browser/realtime/index';

const BASE = 'https://gw/v1/realtime/sessions/rt_up';
const DESCRIPTOR: SessionDescriptor = {
  sessionId: 'rt_up', expiresAt: '', token: 'tok',
  transports: [{ type: 'webrtc', offerUrl: `${BASE}/offer`, iceUrl: `${BASE}/ice` }, { type: 'ws', url: 'wss://gw/v1/realtime/ws?token=tok' }, { type: 's2s-stream', url: '/v1/s2s' }],
};
const TIMEOUTS = { iceGatherMs: 20, signalingMs: 100, webrtcConnectMs: 100, upgradeConnectMs: 1500, upgradeTries: 2, upgradeBackoffMs: 30, upgradeMs: 4000, wsOpenMs: 100, wsReadyMs: 100 };
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

type Plan = number | 'fail' | 'never';

class SlowPc extends EventTarget {
  static plan: Plan[] = [];
  static all: SlowPc[] = [];
  iceGatheringState = 'complete';
  connectionState = 'new';
  iceConnectionState = 'new';
  localDescription = { sdp: 'v=0\r\na=candidate:1 1 udp 1 10.0.0.2 5000 typ host' };
  closed = false;
  sender = { replaced: 0, replaceTrack: async () => { this.sender.replaced++; } };
  channel = Object.assign(new EventTarget(), { readyState: 'connecting', send: () => {}, close: () => {}, onmessage: null, onclose: null });
  ontrack: ((e: unknown) => void) | null = null;
  onicecandidate: ((e: unknown) => void) | null = null;
  onconnectionstatechange = null;
  oniceconnectionstatechange = null;
  constructor() { super(); SlowPc.all.push(this); }
  addTrack() {}
  addTransceiver() { return { sender: this.sender }; }
  createDataChannel() { return this.channel; }
  async createOffer() { return { type: 'offer', sdp: this.localDescription.sdp }; }
  async setLocalDescription() {}
  async setRemoteDescription() {
    const plan = SlowPc.plan.shift() ?? 'never';
    if (plan === 'never') return;
    setTimeout(() => {
      if (this.closed) return;
      this.connectionState = plan === 'fail' ? 'failed' : 'connected';
      if (plan !== 'fail') { this.channel.readyState = 'open'; this.channel.dispatchEvent(new Event('open')); }
      this.dispatchEvent(new Event('connectionstatechange'));
    }, plan === 'fail' ? 20 : plan);
  }
  late(candidate: string) { this.onicecandidate?.({ candidate: { candidate, toJSON: () => ({ candidate, sdpMid: '0' }) } }); }
  async getStats() { return new Map(); }
  close() { this.closed = true; }
}

class ReadyWs {
  static last: ReadyWs;
  static opens = true;
  readyState = 0;
  bufferedAmount = 0;
  binaryType = 'blob';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor() {
    ReadyWs.last = this;
    setTimeout(() => {
      if (!ReadyWs.opens) { this.onerror?.(); return; }
      this.readyState = 1;
      this.onopen?.();
      this.say({ type: 'ready' });
    }, 2);
  }
  say(event: RealtimeEvent | { type: 'ready' }) { this.onmessage?.({ data: JSON.stringify(event) }); }
  send(d: unknown) { if (typeof d === 'string') this.sent.push(d); }
  close(code = 1000, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
}

function rig(plan: Plan[], extra: Partial<RealtimeSessionOptions> = {}) {
  SlowPc.plan = plan;
  SlowPc.all = [];
  const data = new Map<string, string>();
  const storage: StorageLike = { getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: k => { data.delete(k); } };
  const events: RealtimeEvent[] = [];
  const telemetry: TelemetryEvent[] = [];
  const remote: Array<MediaStream | null> = [];
  const calls: string[] = [];
  const player = { pushPcm16: () => {}, pushFloat: () => {}, flush: () => {}, close: () => {} } as unknown as PcmPlayer;
  const s = createRealtimeSession({
    sessionEndpoint: async () => DESCRIPTOR,
    getMicStream: async () => ({ getAudioTracks: () => [{ kind: 'audio', label: 'mic' }] }) as unknown as MediaStream,
    onEvent: e => events.push(e), onRemoteAudio: stream => remote.push(stream), storage, networkKey: () => 'net',
    timeouts: TIMEOUTS, s2s: { url: '/app/s2s' }, telemetry: { send: false, onEvent: e => telemetry.push(e) },
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url.replace(BASE, '') || '/'}`);
      return init.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ sdp: 'v=0\r\nanswer', type: 'answer' });
    }) as unknown as typeof fetch,
    transports: {
      webrtc: c => createWebRtcTransport(c, DESCRIPTOR.transports[0] as never, { RTCPeerConnection: SlowPc as unknown as typeof RTCPeerConnection }),
      ws: c => createWsTransport(c, 'wss://gw/ws', { WebSocket: ReadyWs as unknown as typeof WebSocket, player: async () => player, capture: async () => ({ stop: () => {} }) }),
      's2s-stream': (c: TransportContext) => ({ type: 's2s-stream' as TransportType, clipBased: true, connect: async () => { void c; }, send: () => {}, close: () => {} }),
    },
    ...extra,
  });
  const names = (event: string) => telemetry.filter(e => e.event === event).map(e => e.attrs);
  const winner = () => (data.size ? (JSON.parse([...data.values()][0]!) as { type: string }).type : null);
  return { s, events, telemetry, remote, calls, names, winner };
}

afterEach(() => { ReadyWs.opens = true; });

describe('WebRTC behind a serving WebSocket: a patient background attempt', () => {
  it('a connection that needs four times the foreground budget still comes up, and takes over only once the turn in flight is over', async () => {
    const r = rig([400]);
    expect(await r.s.connect()).toBe('ws');
    await pause(250);
    r.s.sendEndTurn();
    ReadyWs.last.say({ type: 'transcript', text: 'Um pão', final: true });
    ReadyWs.last.say({ type: 'audio_start' });
    await vi.waitFor(() => expect(SlowPc.all[0]!.connectionState).toBe('connected'));
    await pause(450);
    expect([r.s.transport, SlowPc.all[0]!.sender.replaced, r.remote]).toEqual(['ws', 0, []]);
    ReadyWs.last.say({ type: 'reply', text: 'Claro!' });
    ReadyWs.last.say({ type: 'audio_end' });
    ReadyWs.last.say({ type: 'done' });
    await vi.waitFor(() => expect(r.s.transport).toBe('webrtc'));
    expect([SlowPc.all.length, SlowPc.all[0]!.sender.replaced, ReadyWs.last.readyState]).toEqual([1, 1, 3]);
    expect(r.events.filter(e => e.type === 'done' || e.type === 'error')).toEqual([{ type: 'done' }]);
    expect(r.s.history).toEqual([{ role: 'user', content: 'Um pão' }, { role: 'assistant', content: 'Claro!' }]);
    expect(r.calls).toEqual(['POST /offer']);
    r.s.close();
  });

  it('a first try that fails is tried again on the same edge session after the backoff, without a DELETE in between', async () => {
    const r = rig(['fail', 50]);
    expect(await r.s.connect()).toBe('ws');
    await vi.waitFor(() => expect(r.s.transport).toBe('webrtc'), { timeout: 3000 });
    expect(SlowPc.all.map(pc => pc.closed)).toEqual([true, false]);
    expect(r.calls).toEqual(['POST /offer', 'POST /offer']);
    expect(r.names('rt.webrtc.retry')).toEqual([{ attempt: 1, reason: 'ICE failed' }]);
    expect(r.events.some(e => e.type === 'error')).toBe(false);
    r.s.close();
  });

  it('an upgrade that never connects is silent to the learner: no error, no audio, every peer connection closed, the edge session freed, WS keeps serving', async () => {
    const r = rig(['never', 'never'], { timeouts: { ...TIMEOUTS, upgradeConnectMs: 120 } });
    expect(await r.s.connect()).toBe('ws');
    SlowPc.all[0]!.ontrack?.({ receiver: {}, streams: [{} as MediaStream] });
    await vi.waitFor(() => expect(r.calls).toEqual(['POST /offer', 'POST /offer', 'DELETE /']), { timeout: 3000 });
    expect(SlowPc.all.map(pc => [pc.closed, pc.sender.replaced])).toEqual([[true, 0], [true, 0]]);
    expect([r.s.transport, r.remote.filter(Boolean), r.winner()]).toEqual(['ws', [], 'ws']);
    expect(r.events.filter(e => e.type === 'error' || e.type === 'transport')).toEqual([{ type: 'transport', transport: 'ws', reason: 'connected' }]);
    expect(r.names('rt.ladder.fallback')).toMatchObject([{ from: 'webrtc', to: 'ws', reason: 'not connected within 120 ms' }]);
    r.s.sendEndTurn();
    ReadyWs.last.say({ type: 'transcript', text: 'Um pão', final: true });
    ReadyWs.last.say({ type: 'done' });
    expect(r.events.at(-1)).toEqual({ type: 'done' });
    expect(ReadyWs.last.sent.map(m => (JSON.parse(m) as { type: string }).type)).toEqual(['end_turn']);
    r.s.close();
  });

  it('no WS and no WebRTC within the foreground budget: the learner goes down the ladder at once, the slow attempt is closed', async () => {
    ReadyWs.opens = false;
    const r = rig([3000]);
    const started = performance.now();
    expect(await r.s.connect()).toBe('s2s-stream');
    expect(performance.now() - started).toBeLessThan(600);
    expect(SlowPc.all.map(pc => pc.closed)).toEqual([true]);
    r.s.close();
  });
});

describe('WebRTC forced (no WS on the ladder)', () => {
  it('gets the patient budget, since nothing else can serve the learner', async () => {
    const r = rig([400], { preferredTransports: ['webrtc'] });
    expect(await r.s.connect()).toBe('webrtc');
    expect(r.events.some(e => e.type === 'error')).toBe(false);
    r.s.close();
  });

  it('reports a clear error after its own budget and leaves nothing open', async () => {
    const r = rig(['never', 'never'], { preferredTransports: ['webrtc'], timeouts: { ...TIMEOUTS, upgradeConnectMs: 120 } });
    await expect(r.s.connect()).rejects.toThrow(/webrtc: not connected within 120 ms/);
    expect(r.events.filter(e => e.type === 'error')).toEqual([{ type: 'error', code: 'no_transport', message: 'no transport connected (webrtc: not connected within 120 ms)' }]);
    expect(SlowPc.all.map(pc => pc.closed)).toEqual([true, true]);
    expect(r.calls).toEqual(['POST /offer', 'POST /offer', 'DELETE /']);
    expect(r.events.at(-1)).toMatchObject({ type: 'closed' });
  });

  it('with a clip rung below it keeps the tight budget', async () => {
    const r = rig([400], { preferredTransports: ['webrtc', 's2s-stream'] });
    expect(await r.s.connect()).toBe('s2s-stream');
    r.s.close();
  });
});

describe('trickle ICE over the signalling route (TCP)', () => {
  it('a candidate gathered after the offer left is posted once the edge has the session, in order; one already in the offer is not', async () => {
    SlowPc.plan = [30];
    SlowPc.all = [];
    const posted: Array<[string, unknown]> = [];
    let answer: (r: Response) => void = () => {};
    const c = {
      descriptor: DESCRIPTOR, timeouts: { ...DEFAULT_TIMEOUTS, ...TIMEOUTS }, traceparent: '00-a-b-01',
      telemetry: { emit: () => {} }, mic: async () => ({ getAudioTracks: () => [{ kind: 'audio' }] }),
      emit: () => {}, fail: () => {}, remoteAudio: () => {}, config: () => ({}), dropped: () => {},
      fetchImpl: (url: string, init: RequestInit) => {
        posted.push([url.replace(BASE, ''), JSON.parse(String(init.body ?? 'null'))]);
        return url.endsWith('/offer') ? new Promise<Response>((resolve) => { answer = resolve; }) : Promise.resolve(Response.json({ ok: true }));
      },
    } as unknown as TransportContext;
    const t = createWebRtcTransport(c, DESCRIPTOR.transports[0] as never, { RTCPeerConnection: SlowPc as unknown as typeof RTCPeerConnection });
    const connecting = t.connect(new AbortController().signal);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    const pc = SlowPc.all[0]!;
    pc.late('candidate:1 1 udp 1 10.0.0.2 5000 typ host');
    pc.late('candidate:2 1 udp 1 203.0.113.9 6000 typ srflx');
    expect(posted).toHaveLength(1);
    answer(Response.json({ sdp: 'v=0\r\nanswer', type: 'answer' }));
    await connecting;
    pc.late('candidate:3 1 udp 1 198.51.100.4 7000 typ relay');
    expect(posted.slice(1)).toEqual([
      ['/ice', { candidate: { candidate: 'candidate:2 1 udp 1 203.0.113.9 6000 typ srflx', sdpMid: '0' } }],
      ['/ice', { candidate: { candidate: 'candidate:3 1 udp 1 198.51.100.4 7000 typ relay', sdpMid: '0' } }],
    ]);
    t.close();
    pc.late('candidate:4 1 udp 1 198.51.100.4 7001 typ relay');
    expect(posted.filter(([url]) => url === '/ice')).toHaveLength(2);
  });
});
