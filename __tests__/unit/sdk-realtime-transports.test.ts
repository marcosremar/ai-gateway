/**
 * The two realtime rungs with fake browser APIs: WebSocket (ready handshake, PCM both ways, close → failover) and
 * WebRTC (non-trickle offer through the gateway with the session token and traceparent, connected, DELETE on close).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEOUTS, createWebRtcTransport, createWsTransport, decodeAudioFrame, encodeAudioFrame, type PcmPlayer,
  type RealtimeEvent, type TransportContext,
} from '../../sdk/browser/realtime/index';
import { createLocalTelemetry } from '../../sdk/browser/realtime/telemetry';

function ctx(over: Partial<TransportContext> = {}): TransportContext & { events: RealtimeEvent[]; failures: Error[] } {
  const telemetry = createLocalTelemetry({ send: false });
  const events: RealtimeEvent[] = [];
  const failures: Error[] = [];
  return {
    events, failures,
    descriptor: { sessionId: 'rt_1', token: 'tok', expiresAt: '', transports: [] },
    timeouts: { ...DEFAULT_TIMEOUTS, iceGatherMs: 20, webrtcConnectMs: 200, wsOpenMs: 200, wsReadyMs: 200 },
    fetchImpl: fetch, telemetry, traceparent: telemetry.traceparent,
    mic: async () => ({ getAudioTracks: () => [{ kind: 'audio' }] }) as unknown as MediaStream,
    emit: e => events.push(e), fail: e => failures.push(e), remoteAudio: () => {}, config: () => ({}), dropped: () => {},
    ...over,
  };
}

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
  constructor(readonly url: string, readonly protocols?: string | string[]) { FakeWs.last = this; setTimeout(() => { this.readyState = 1; this.onopen?.(); setTimeout(() => this.onmessage?.({ data: '{"type":"ready"}' }), 5); }, 5); }
  send(d: unknown) { this.sent.push(d); }
  close(code = 1000, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
}

describe('WS rung', () => {
  it('waits for ready, sends 16 kHz frames, plays 24 kHz frames, flushes on interrupt, fails over on close', async () => {
    const played: number[] = [];
    let flushed = 0;
    const player: PcmPlayer = {
      pushPcm16: (pcm, rate) => { played.push(pcm.length, rate); }, pushFloat: () => {}, flush: () => { flushed++; },
      playing: false, idle: async () => {}, pushEncoded: async () => {}, close: () => {},
    };
    let onFrame: ((pcm: Int16Array) => void) | null = null;
    const c = ctx();
    const t = createWsTransport(c, 'wss://gw/v1/realtime/ws?token=tok', {
      WebSocket: FakeWs as unknown as typeof WebSocket,
      player: async () => player,
      capture: async (_s, o) => { onFrame = o.onFrame; expect(o.rate).toBe(16_000); return { stop: () => {} }; },
    });
    await t.connect(new AbortController().signal);
    const ws = FakeWs.last;
    expect(ws.url).toBe(`wss://gw/v1/realtime/ws?traceparent=${encodeURIComponent(c.traceparent)}`);
    expect(ws.protocols).toEqual(['aigw.rt', 'aigw.token.tok']);
    expect(ws.binaryType).toBe('arraybuffer');
    onFrame!(new Int16Array(320));
    expect(Array.from(decodeAudioFrame(ws.sent[0] as Uint8Array)!).length).toBe(320);
    ws.bufferedAmount = 1 << 20;
    onFrame!(new Int16Array(320)); // dropped, not queued
    expect(ws.sent).toHaveLength(1);
    ws.onmessage!({ data: encodeAudioFrame(new Int16Array(480)).buffer });
    expect(played).toEqual([480, 24_000]);
    ws.onmessage!({ data: '{"type":"interrupted"}' });
    expect(flushed).toBe(1);
    t.send({ type: 'end_turn' });
    expect(ws.sent[1]).toBe('{"type":"end_turn"}');
    ws.close(1011, 'edge crashed');
    expect(c.failures[0]!.message).toMatch(/ws closed \(1011 edge crashed\)/);
    expect(c.events.map(e => e.type)).toEqual(['ready', 'interrupted']);
  });

  it('standby (connected behind a clip rung): the microphone is not sent until it goes live', async () => {
    let captures = 0;
    const t = createWsTransport(ctx({ standby: true }), 'wss://gw/v1/realtime/ws?token=tok', {
      WebSocket: FakeWs as unknown as typeof WebSocket, player: async () => ({ close: () => {} }) as unknown as PcmPlayer,
      capture: async () => { captures++; return { stop: () => {} }; },
    });
    await t.connect(new AbortController().signal);
    expect(captures).toBe(0);
    t.goLive!();
    await new Promise(r => setTimeout(r, 5));
    expect(captures).toBe(1);
    t.close();
  });

  it('no ready from the edge: connect rejects', async () => {
    class Mute {
      binaryType = 'blob'; readyState = 0; bufferedAmount = 0;
      onopen: (() => void) | null = null; onerror = null; onmessage = null; onclose = null;
      constructor() { setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 5); }
      send() {}
      close() {}
    }
    const c = ctx({ timeouts: { ...DEFAULT_TIMEOUTS, wsOpenMs: 100, wsReadyMs: 30 } });
    const t = createWsTransport(c, 'wss://x', {
      WebSocket: Mute as unknown as typeof WebSocket, player: async () => ({}) as PcmPlayer, capture: async () => ({ stop: () => {} }),
    });
    await expect(t.connect(new AbortController().signal)).rejects.toThrow(/no ready within 30 ms/);
  });
});

class FakePc extends EventTarget {
  static last: FakePc;
  iceGatheringState = 'gathering';
  connectionState = 'new';
  iceConnectionState = 'new';
  localDescription: { sdp: string } | null = null;
  remote: { type: string; sdp: string } | null = null;
  channel = Object.assign(new EventTarget(), { readyState: 'connecting', send: () => {}, close: () => {}, onmessage: null, onclose: null });
  ontrack = null; onconnectionstatechange = null; oniceconnectionstatechange = null;
  constructor(readonly config: unknown) { super(); FakePc.last = this; }
  addTrack() {}
  addTransceiver() {}
  createDataChannel() { return this.channel; }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\noffer' }; }
  async setLocalDescription(d: { sdp: string }) {
    this.localDescription = d;
    setTimeout(() => { this.iceGatheringState = 'complete'; this.dispatchEvent(new Event('icegatheringstatechange')); }, 5);
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remote = d;
    setTimeout(() => {
      this.connectionState = 'connected';
      this.channel.readyState = 'open';
      this.channel.dispatchEvent(new Event('open'));
      this.dispatchEvent(new Event('connectionstatechange'));
    }, 5);
  }
  async getStats() { return new Map(); }
  close() {}
}

describe('WebRTC rung', () => {
  it('sends the gathered offer with the session token and traceparent, applies the answer, DELETEs the session on close', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return init.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ sdp: 'v=0\r\nanswer', type: 'answer', sessionId: 'rt_1' });
    }) as unknown as typeof fetch;
    const c = ctx({ fetchImpl });
    const t = createWebRtcTransport(c, {
      type: 'webrtc', offerUrl: 'https://gw/v1/realtime/sessions/rt_1/offer',
      iceServers: [{ urls: ['turns:turn.example:443?transport=tcp'], username: 'u', credential: 'p' }],
    }, { RTCPeerConnection: FakePc as unknown as typeof RTCPeerConnection });
    await t.connect(new AbortController().signal);
    expect((FakePc.last.config as { iceServers: unknown[] }).iceServers).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers.traceparent).toBe(c.traceparent);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ sdp: 'v=0\r\noffer', type: 'offer' });
    expect(FakePc.last.remote).toEqual({ type: 'answer', sdp: 'v=0\r\nanswer' });
    t.close();
    expect(calls[1]).toMatchObject({ url: 'https://gw/v1/realtime/sessions/rt_1', init: { method: 'DELETE' } });
  });

  it('an offer refused by the gateway (replica full) rejects connect', async () => {
    const fetchImpl = (async () => Response.json({ error: { code: 'saturated' } }, { status: 503 })) as unknown as typeof fetch;
    const t = createWebRtcTransport(ctx({ fetchImpl }), { type: 'webrtc', offerUrl: 'https://gw/o/offer' }, { RTCPeerConnection: FakePc as unknown as typeof RTCPeerConnection });
    await expect(t.connect(new AbortController().signal)).rejects.toThrow(/HTTP 503 saturated/);
  });
});
