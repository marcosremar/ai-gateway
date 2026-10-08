import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TIMEOUTS, createRealtimeSession, createWebRtcTransport, createWsTransport, type PcmPlayer, type RealtimeEvent, type RealtimeSessionOptions,
  type RealtimeTransport, type SessionDescriptor, type StorageLike, type TelemetryEvent, type TransportContext, type TransportType,
} from '../../sdk/browser/realtime/index';

const DESCRIPTOR: SessionDescriptor = {
  sessionId: 'rt_race', expiresAt: '', token: 'tok',
  transports: [{ type: 'webrtc', offerUrl: 'https://gw/v1/realtime/sessions/rt_race/offer' }, { type: 'ws', url: 'wss://gw/v1/realtime/ws?token=tok' }, { type: 's2s-stream', url: '/v1/s2s' }],
};
const FAST = { ...DEFAULT_TIMEOUTS, iceGatherMs: 200, signalingMs: 200, webrtcConnectMs: 200, wsOpenMs: 300, wsReadyMs: 300, upgradeMs: 60 };
const WINNER = 'aigw-rt:winner:net';
const TURN = [{ role: 'user', content: 'Um pão' }, { role: 'assistant', content: 'Claro!' }];
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

function memoryStorage(): StorageLike & { winner(): string | null } {
  const data = new Map<string, string>();
  return {
    getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: k => { data.delete(k); },
    winner: () => (data.has(WINNER) ? (JSON.parse(data.get(WINNER)!) as { type: string }).type : null),
  };
}

function rig(extra: Partial<RealtimeSessionOptions> = {}, storage = memoryStorage()) {
  const log: string[] = [];
  const sent: Array<[TransportType, unknown]> = [];
  const ctxs: Partial<Record<TransportType, TransportContext>> = {};
  const settle: Partial<Record<TransportType, { up(): void; down(): void }>> = {};
  const events: RealtimeEvent[] = [];
  const telemetry: TelemetryEvent[] = [];
  const audio: Array<MediaStream | null> = [];
  const counts = { admissions: 0, mics: 0 };
  const fake = (type: TransportType) => (c: TransportContext): RealtimeTransport => {
    ctxs[type] = c;
    return {
      type, clipBased: type === 's2s-stream',
      connect: (signal) => new Promise<void>((resolve, reject) => {
        log.push(`try:${type}`);
        settle[type] = { up: resolve, down: () => reject(new Error(`${type} refused`)) };
        signal.addEventListener('abort', () => reject(signal.reason as Error));
        if (type === 's2s-stream') resolve();
      }),
      send: (m) => { sent.push([type, m]); },
      goLive: () => { log.push(`live:${type}`); },
      close: () => { log.push(`close:${type}`); },
    };
  };
  const s = createRealtimeSession({
    sessionEndpoint: async () => { counts.admissions++; return DESCRIPTOR; },
    getMicStream: async () => { counts.mics++; return {} as MediaStream; },
    onEvent: e => events.push(e), onRemoteAudio: stream => audio.push(stream),
    storage, networkKey: () => 'net', timeouts: FAST, s2s: { url: '/app/s2s' },
    transports: { webrtc: fake('webrtc'), ws: fake('ws'), 's2s-stream': fake('s2s-stream') },
    telemetry: { send: false, onEvent: e => telemetry.push(e) },
    ...extra,
  });
  const tried = async (...types: TransportType[]) => { await vi.waitFor(() => expect(types.every(t => settle[t])).toBe(true)); };
  const turnOnWs = () => {
    s.sendEndTurn();
    ctxs.ws!.emit({ type: 'transcript', text: 'Um pão', final: true });
    ctxs.ws!.emit({ type: 'audio_start' });
    ctxs.ws!.emit({ type: 'reply', text: 'Claro!' });
    ctxs.ws!.emit({ type: 'audio_end' });
    ctxs.ws!.emit({ type: 'done' });
  };
  const of = (event: string) => telemetry.filter(e => e.event === event).map(e => e.attrs);
  return { s, log, sent, ctxs, settle, events, telemetry, audio, counts, storage, tried, turnOnWs, of };
}

const transports = (events: RealtimeEvent[]) => events.filter(e => e.type === 'transport');

describe('session start: WS and WebRTC raced', () => {
  it('WS is ready first: the session starts on it at once; WebRTC connects while idle and takes over with the history replayed once', async () => {
    const r = rig();
    const connecting = r.s.connect();
    await r.tried('webrtc', 'ws');
    r.settle.ws!.up();
    expect(await connecting).toBe('ws');
    expect(r.log).toEqual(['try:webrtc', 'try:ws']);
    expect(r.storage.winner()).toBeNull();
    r.turnOnWs();
    const before = r.s.history;
    expect(before).toEqual(TURN);
    const stream = {} as MediaStream;
    r.ctxs.webrtc!.emit({ type: 'ready' });
    r.ctxs.webrtc!.remoteAudio(stream);
    expect([r.events.some(e => e.type === 'ready'), r.audio]).toEqual([false, []]);

    r.settle.webrtc!.up();
    await vi.waitFor(() => expect(r.s.transport).toBe('webrtc'));
    expect(r.log).toEqual(['try:webrtc', 'try:ws', 'close:ws', 'live:webrtc']);
    expect(r.sent.filter(([t]) => t === 'webrtc')).toEqual([['webrtc', { type: 'config_update', messages: TURN }]]);
    expect(r.s.history).toEqual(before);
    expect(r.audio).toEqual([stream]);
    expect(transports(r.events)).toEqual([
      { type: 'transport', transport: 'ws', reason: 'connected' }, { type: 'transport', transport: 'webrtc', reason: 'upgrade', from: 'ws' },
    ]);
    expect(r.of('rt.ladder.ok')).toEqual([{ transport: 'ws', reason: 'connected', upgrading: true }]);
    expect(r.of('rt.ladder.upgrade')).toEqual([{ from: 'ws', to: 'webrtc', reason: 'upgrade' }]);
    expect(r.events.some(e => e.type === 'error')).toBe(false);
    expect(r.counts).toEqual({ admissions: 1, mics: 0 });
    expect([r.s.metrics.transport, r.s.metrics.failovers, r.storage.winner()]).toEqual(['webrtc', 0, 'webrtc']);

    r.s.sendEndTurn();
    r.s.updateHistory([{ role: 'user', content: '(nota)' }]);
    expect(r.sent.slice(-2)).toEqual([['webrtc', { type: 'end_turn' }], ['webrtc', { type: 'config_update', messages: [{ role: 'user', content: '(nota)' }] }]]);
    r.s.close();
    expect(r.log.filter(l => l.startsWith('close'))).toEqual(['close:ws', 'close:webrtc']);
  });

  it('WebRTC connects in the middle of a turn: the switch waits for the turn and its audio to end, the turn is neither lost nor doubled', async () => {
    const r = rig();
    const connecting = r.s.connect();
    await r.tried('webrtc', 'ws');
    r.settle.ws!.up();
    await connecting;
    r.ctxs.ws!.emit({ type: 'vad', state: 'start' });
    r.settle.webrtc!.up();
    await pause(250);
    expect(r.s.transport).toBe('ws');
    r.ctxs.ws!.emit({ type: 'vad', state: 'end' });
    r.ctxs.ws!.emit({ type: 'transcript', text: 'Um pão', final: true });
    r.ctxs.ws!.emit({ type: 'audio_start' });
    r.ctxs.ws!.emit({ type: 'reply', text: 'Claro!' });
    await pause(250);
    expect([r.s.transport, r.log.includes('close:ws'), r.log.includes('live:webrtc')]).toEqual(['ws', false, false]);
    r.ctxs.ws!.emit({ type: 'audio_end' });
    r.ctxs.ws!.emit({ type: 'done' });
    const ended = performance.now();
    expect(r.s.transport).toBe('ws');
    await vi.waitFor(() => expect(r.s.transport).toBe('webrtc'));
    expect(performance.now() - ended).toBeGreaterThanOrEqual(290);
    expect(r.s.history).toEqual(TURN);
    expect(r.sent).toEqual([['webrtc', { type: 'config_update', messages: TURN }]]);
    expect(r.events.filter(e => e.type === 'done')).toEqual([{ type: 'done' }]);
    expect(r.events.some(e => e.type === 'error')).toBe(false);
    expect(r.telemetry.filter(e => e.event === 'turn.done')).toHaveLength(1);
    r.s.close();
  });

  it('a pending end_turn of the client VAD and a too-short utterance the edge drops both hold the switch, then let it go', async () => {
    const r = rig();
    const connecting = r.s.connect();
    await r.tried('webrtc', 'ws');
    r.settle.ws!.up();
    await connecting;
    r.s.sendEndTurn();
    r.settle.webrtc!.up();
    await pause(450);
    expect(r.s.transport).toBe('ws');
    r.ctxs.ws!.emit({ type: 'done', empty: true });
    r.ctxs.ws!.emit({ type: 'vad', state: 'start' });
    r.ctxs.ws!.emit({ type: 'vad', state: 'end' });
    await pause(1500);
    expect(r.s.transport).toBe('ws');
    await vi.waitFor(() => expect(r.s.transport).toBe('webrtc'), { timeout: 1500 });
    r.s.close();
  });

  it('WebRTC never connects: the attempt stops at the bound, the session stays on WS with no error, and the next session skips WebRTC', async () => {
    const r = rig();
    const connecting = r.s.connect();
    await r.tried('webrtc', 'ws');
    r.settle.ws!.up();
    expect(await connecting).toBe('ws');
    await vi.waitFor(() => expect(r.log).toContain('close:webrtc'));
    expect(r.of('rt.ladder.fallback')).toEqual([{ from: 'webrtc', to: 'ws', reason: 'webrtc not connected within 60 ms of the start on ws' }]);
    r.settle.webrtc!.up();
    r.turnOnWs();
    await pause(450);
    expect([r.s.transport, r.s.metrics.failovers, r.storage.winner()]).toEqual(['ws', 0, 'ws']);
    expect(r.log).toEqual(['try:webrtc', 'try:ws', 'close:webrtc']);
    expect(r.events.some(e => e.type === 'error')).toBe(false);
    expect(transports(r.events)).toHaveLength(1);
    r.s.close();

    const next = rig({}, r.storage);
    const again = next.s.connect();
    await next.tried('ws');
    next.settle.ws!.up();
    expect(await again).toBe('ws');
    expect(next.log).toEqual(['try:ws']);
    expect(next.of('rt.ladder.ok')).toEqual([{ transport: 'ws', reason: 'connected', upgrading: false }]);
    next.s.close();
  });

  it('WebRTC is ready first: it carries the session from the start and the WS attempt is cancelled', async () => {
    const r = rig();
    const connecting = r.s.connect();
    await r.tried('webrtc', 'ws');
    r.settle.webrtc!.up();
    expect(await connecting).toBe('webrtc');
    await vi.waitFor(() => expect(r.log).toEqual(['try:webrtc', 'try:ws', 'live:webrtc', 'close:ws']));
    r.settle.ws!.up();
    await pause(50);
    expect(transports(r.events)).toEqual([{ type: 'transport', transport: 'webrtc', reason: 'connected' }]);
    expect(r.of('rt.ladder.upgrade')).toEqual([]);
    expect(r.storage.winner()).toBe('webrtc');
    r.ctxs.webrtc!.emit({ type: 'transcript', text: 'Um pão', final: true });
    expect(r.s.history).toEqual([TURN[0]]);
    r.s.close();
  });

  it('WebRTC and WS both fail: the clip rung as before, and with no rung left the error names every attempt', async () => {
    const r = rig();
    const connecting = r.s.connect();
    await r.tried('webrtc', 'ws');
    r.settle.webrtc!.down();
    r.settle.ws!.down();
    expect(await connecting).toBe('s2s-stream');
    expect([r.log.slice(0, 2), r.log.slice(2, 4).sort(), r.log.slice(4)]).toEqual([['try:webrtc', 'try:ws'], ['close:webrtc', 'close:ws'], ['try:s2s-stream']]);
    expect(r.s.metrics.attempts.map(a => [a.type, a.ok])).toEqual([['webrtc', false], ['ws', false], ['s2s-stream', true]]);
    expect(r.storage.winner()).toBe('s2s-stream');
    r.s.close();

    const none = rig({ preferredTransports: ['webrtc', 'ws'] });
    const failing = none.s.connect();
    await none.tried('webrtc', 'ws');
    none.settle.ws!.down();
    none.settle.webrtc!.down();
    await expect(failing).rejects.toThrow(/no transport connected \(ws: ws refused; webrtc: webrtc refused\)/);
    expect(none.events.map(e => e.type)).toEqual(['error', 'closed']);
  });

  it('WS fails first and WebRTC connects: WebRTC alone carries the session, no clip rung is tried', async () => {
    const r = rig();
    const connecting = r.s.connect();
    await r.tried('webrtc', 'ws');
    r.settle.ws!.down();
    await pause(20);
    r.settle.webrtc!.up();
    expect(await connecting).toBe('webrtc');
    expect(r.log).toEqual(['try:webrtc', 'try:ws', 'close:ws', 'live:webrtc']);
    r.s.close();
  });

  it('race off, or WS preferred: the sequential ladder as before', async () => {
    const off = rig({ raceTransports: false, timeouts: { ...FAST, iceGatherMs: 10, signalingMs: 10, webrtcConnectMs: 10 } });
    const connecting = off.s.connect();
    await off.tried('ws');
    expect(off.log).toEqual(['try:webrtc', 'close:webrtc', 'try:ws']);
    off.settle.ws!.up();
    expect(await connecting).toBe('ws');
    await pause(100);
    expect([off.s.transport, off.storage.winner(), off.of('rt.ladder.upgrade')]).toEqual(['ws', 'ws', []]);
    off.s.close();

    const wsFirst = rig({ preferredTransports: ['ws', 'webrtc'] });
    const second = wsFirst.s.connect();
    await wsFirst.tried('ws');
    wsFirst.settle.ws!.up();
    expect(await second).toBe('ws');
    expect(wsFirst.log).toEqual(['try:ws']);
    wsFirst.s.close();
  });

  it('the WS breaks while WebRTC is still connecting: the session waits for WebRTC instead of a clip rung; a turn in flight ends once', async () => {
    const r = rig({ timeouts: { ...FAST, upgradeMs: 500 } });
    const connecting = r.s.connect();
    await r.tried('webrtc', 'ws');
    r.settle.ws!.up();
    await connecting;
    r.s.sendEndTurn();
    r.ctxs.ws!.emit({ type: 'transcript', text: 'Um pão', final: true });
    r.ctxs.ws!.fail(new Error('ws closed (1006)'));
    await pause(30);
    expect(r.s.transport).toBeNull();
    r.settle.webrtc!.up();
    await vi.waitFor(() => expect(r.s.transport).toBe('webrtc'));
    expect(r.log).toEqual(['try:webrtc', 'try:ws', 'close:ws', 'live:webrtc']);
    expect(r.events.filter(e => e.type === 'error')).toMatchObject([{ code: 'turn_lost' }]);
    expect(r.events.filter(e => e.type === 'done')).toEqual([{ type: 'done', error: true }]);
    expect(r.sent.at(-1)).toEqual(['webrtc', { type: 'config_update', messages: [TURN[0]] }]);
    expect(transports(r.events).at(-1)).toEqual({ type: 'transport', transport: 'webrtc', reason: 'failover', from: 'ws' });
    expect([r.counts.admissions, r.s.metrics.failovers]).toEqual([1, 1]);
    r.s.close();

    const both = rig({ timeouts: { ...FAST, upgradeMs: 500 } });
    const start = both.s.connect();
    await both.tried('webrtc', 'ws');
    both.settle.ws!.up();
    await start;
    both.ctxs.ws!.fail(new Error('ws closed (1006)'));
    both.settle.webrtc!.down();
    await vi.waitFor(() => expect(both.s.transport).toBe('s2s-stream'));
    expect(both.storage.winner()).toBe('s2s-stream');
    both.s.close();
  });

  it('a standby WebRTC that dies before the switch is dropped quietly; closing the session closes both transports', async () => {
    const r = rig();
    const connecting = r.s.connect();
    await r.tried('webrtc', 'ws');
    r.settle.ws!.up();
    await connecting;
    r.s.sendEndTurn();
    r.settle.webrtc!.up();
    await pause(20);
    r.ctxs.webrtc!.fail(new Error('webrtc: data channel closed'));
    expect(r.log).toEqual(['try:webrtc', 'try:ws', 'close:webrtc']);
    r.ctxs.ws!.emit({ type: 'done', empty: true });
    await pause(450);
    expect([r.s.transport, r.s.metrics.failovers, r.events.some(e => e.type === 'error')]).toEqual(['ws', 0, false]);
    r.s.close();

    const closing = rig();
    const start = closing.s.connect();
    await closing.tried('webrtc', 'ws');
    closing.settle.ws!.up();
    await start;
    closing.s.sendEndTurn();
    closing.settle.webrtc!.up();
    await pause(20);
    closing.s.close();
    expect(closing.log.slice(2).sort()).toEqual(['close:webrtc', 'close:ws']);
    await pause(450);
    expect(closing.log).not.toContain('live:webrtc');

    const early = rig();
    const pending = early.s.connect();
    await early.tried('webrtc', 'ws');
    early.settle.ws!.up();
    await pending;
    early.s.close();
    await vi.waitFor(() => expect(early.log.slice(2).sort()).toEqual(['close:webrtc', 'close:ws']));
  });
});

class StandbyPc extends EventTarget {
  static last: StandbyPc;
  static connects = true;
  iceGatheringState = 'complete';
  connectionState = 'new';
  iceConnectionState = 'new';
  localDescription = { sdp: 'v=0\r\noffer' };
  calls: string[] = [];
  channel = Object.assign(new EventTarget(), { readyState: 'connecting', send: () => {}, close: () => {}, onmessage: null, onclose: null });
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange = null;
  oniceconnectionstatechange = null;
  constructor() { super(); StandbyPc.last = this; }
  addTrack() { this.calls.push('addTrack'); }
  addTransceiver(kind: string, init: { direction: string }) {
    this.calls.push(`addTransceiver:${kind}:${init.direction}`);
    return { sender: { replaceTrack: async (track: { label: string }) => { this.calls.push(`replaceTrack:${track.label}`); } } };
  }
  createDataChannel() { return this.channel; }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\noffer' }; }
  async setLocalDescription() {}
  async setRemoteDescription() {
    if (StandbyPc.connects) setTimeout(() => {
      this.connectionState = 'connected';
      this.channel.readyState = 'open';
      this.channel.dispatchEvent(new Event('open'));
      this.dispatchEvent(new Event('connectionstatechange'));
    }, 30);
  }
  async getStats() { return new Map(); }
  close() { this.calls.push('close'); }
}

class ReadyWs {
  static last: ReadyWs;
  readyState = 0;
  bufferedAmount = 0;
  binaryType = 'blob';
  frames = 0;
  onopen: (() => void) | null = null;
  onerror = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor() { ReadyWs.last = this; setTimeout(() => { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: '{"type":"ready"}' }); }, 2); }
  send(d: unknown) { if (typeof d !== 'string') this.frames++; }
  close(code = 1000, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
}

describe('the race with the real transports', () => {
  it('one microphone: WS captures it until the switch, the standby peer connection gets the track only then; the WS capture and player stop first', async () => {
    const order: string[] = [];
    const calls: Array<[string, string]> = [];
    let micFrame: ((frame: Int16Array) => void) | null = null;
    let mics = 0;
    const player = { pushPcm16: () => {}, flush: () => {}, close: () => { order.push('ws player closed'); } } as unknown as PcmPlayer;
    const remote: Array<MediaStream | null> = [];
    const s = createRealtimeSession({
      sessionEndpoint: async () => DESCRIPTOR,
      getMicStream: async () => { mics++; return { getAudioTracks: () => [{ kind: 'audio', label: 'mic' }] } as unknown as MediaStream; },
      onEvent: () => {}, onRemoteAudio: stream => remote.push(stream), storage: null, telemetry: false,
      timeouts: { iceGatherMs: 20, webrtcConnectMs: 200 },
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push([init.method ?? 'GET', url]);
        return init.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ sdp: 'v=0\r\nanswer', type: 'answer' });
      }) as unknown as typeof fetch,
      transports: {
        webrtc: c => createWebRtcTransport(c, DESCRIPTOR.transports[0] as never, { RTCPeerConnection: StandbyPc as unknown as typeof RTCPeerConnection }),
        ws: c => createWsTransport(c, 'wss://gw/ws', {
          WebSocket: ReadyWs as unknown as typeof WebSocket, player: async () => player,
          capture: async (_stream, o) => { micFrame = o.onFrame; return { stop: () => { micFrame = null; order.push('ws capture stopped'); } }; },
        }),
      },
    });
    expect(await s.connect()).toBe('ws');
    const pc = StandbyPc.last;
    await vi.waitFor(() => expect(pc.calls).toEqual(['addTransceiver:audio:sendrecv']));
    micFrame!(new Int16Array(320));
    expect(ReadyWs.last.frames).toBe(1);
    const stream = {} as MediaStream;
    pc.ontrack!({ receiver: {}, streams: [stream] });
    expect(remote).toEqual([]);

    await vi.waitFor(() => expect(s.transport).toBe('webrtc'));
    pc.calls.unshift(...order);
    expect(pc.calls).toEqual(['ws capture stopped', 'ws player closed', 'addTransceiver:audio:sendrecv', 'replaceTrack:mic']);
    expect([micFrame, ReadyWs.last.readyState, mics]).toEqual([null, 3, 1]);
    expect(remote).toEqual([stream]);
    expect(calls).toEqual([['POST', 'https://gw/v1/realtime/sessions/rt_race/offer']]);
    s.close();
    expect(calls.at(-1)).toEqual(['DELETE', 'https://gw/v1/realtime/sessions/rt_race']);
  });

  it('a WebRTC attempt given up after its offer was answered frees the edge session (DELETE) though it never connected', async () => {
    const calls: string[] = [];
    const c = {
      descriptor: DESCRIPTOR, timeouts: { ...DEFAULT_TIMEOUTS, iceGatherMs: 20, webrtcConnectMs: 500 }, traceparent: '00-a-b-01', standby: true,
      telemetry: { emit: () => {} }, mic: async () => ({ getAudioTracks: () => [{ kind: 'audio' }] }),
      emit: () => {}, fail: () => {}, remoteAudio: () => {}, config: () => ({}), dropped: () => {},
      fetchImpl: async (_url: string, init: RequestInit) => { calls.push(init.method!); return init.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ sdp: 'v=0\r\nanswer' }); },
    } as unknown as TransportContext;
    const t = createWebRtcTransport(c, DESCRIPTOR.transports[0] as never, { RTCPeerConnection: StandbyPc as unknown as typeof RTCPeerConnection });
    const abort = new AbortController();
    StandbyPc.connects = false;
    const connecting = t.connect(abort.signal).catch((e: Error) => e.message).finally(() => { StandbyPc.connects = true; });
    await vi.waitFor(() => expect(calls).toEqual(['POST']));
    abort.abort(new Error('webrtc not connected within the bound'));
    t.close();
    expect(await connecting).toBe('webrtc not connected within the bound');
    expect(calls).toEqual(['POST', 'DELETE']);
    expect(StandbyPc.last.calls).toEqual(['addTransceiver:audio:sendrecv', 'close']);
  });
});
