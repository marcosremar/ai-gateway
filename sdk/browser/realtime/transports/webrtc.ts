/**
 * WebRTC rung: browser ↔ GPU replica directly (Opus both ways, events on the "events" data channel), signaled through
 * the gateway (`offerUrl`, session token as Bearer). Non-trickle: the offer goes at the first server-reflexive or relay
 * candidate (relay only under `iceTransportPolicy: 'relay'`), when ICE gathering completes, or after `iceGatherMs` with
 * what was gathered. TURN servers come from the session (credentials minted per session by the gateway).
 */
import type { ClientMessage, RealtimeTransport, TransportContext, TransportOffer } from '../types';

type WebRtcOffer = Extract<TransportOffer, { type: 'webrtc' }>;

export interface WebRtcDeps {
  RTCPeerConnection: typeof RTCPeerConnection;
}

function waitIceGathering(pc: RTCPeerConnection, ms: number, signal: AbortSignal, relayOnly: boolean): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      pc.removeEventListener('icecandidate', onCandidate);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const onCandidate = (e: Event) => {
      const c = (e as RTCPeerConnectionIceEvent).candidate;
      const type = c ? c.type ?? / typ (\w+)/.exec(c.candidate)?.[1] : null;
      if (!c || type === 'relay' || (type === 'srflx' && !relayOnly)) done();
    };
    const timer = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('icecandidate', onCandidate);
    signal.addEventListener('abort', done);
  });
}

function waitConnected(pc: RTCPeerConnection, channel: RTCDataChannel, ms: number, signal: AbortSignal): Promise<void> {
  const ok = () => channel.readyState === 'open' && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed');
  if (ok()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      pc.removeEventListener('connectionstatechange', check);
      pc.removeEventListener('iceconnectionstatechange', check);
      channel.removeEventListener('open', check);
      signal.removeEventListener('abort', onAbort);
    };
    const check = () => {
      if (ok()) { cleanup(); resolve(); return; }
      if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') { cleanup(); reject(new Error('ICE failed')); }
    };
    const onAbort = () => { cleanup(); reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`not connected within ${ms} ms`)); }, ms);
    pc.addEventListener('connectionstatechange', check);
    pc.addEventListener('iceconnectionstatechange', check);
    channel.addEventListener('open', check);
    signal.addEventListener('abort', onAbort);
  });
}

/**
 * `rt.ice.selected` for every connected session: which pair carries the media (local/remote candidate type — host is
 * the direct path, relay went through TURN —, protocol, RTT); plus `rt.turn.used` when the browser's side is a relay.
 */
async function reportRelay(pc: RTCPeerConnection, ctx: TransportContext): Promise<void> {
  try {
    type Stat = { type: string; id: string; selectedCandidatePairId?: string; localCandidateId?: string; remoteCandidateId?: string; state?: string;
      nominated?: boolean; currentRoundTripTime?: number; candidateType?: string; relayProtocol?: string; protocol?: string };
    const stats = await pc.getStats();
    const all: Stat[] = [];
    stats.forEach((s: Stat) => { all.push(s); });
    const pairId = all.find(s => s.type === 'transport' && s.selectedCandidatePairId)?.selectedCandidatePairId;
    const pair = all.find(s => s.type === 'candidate-pair' && (s.id === pairId || (!pairId && s.nominated && s.state === 'succeeded')));
    const local = all.find(s => s.id === pair?.localCandidateId);
    const remote = all.find(s => s.id === pair?.remoteCandidateId);
    ctx.telemetry.emit('rt.ice.selected', { attrs: {
      local: local?.candidateType ?? null, remote: remote?.candidateType ?? null, protocol: local?.protocol ?? null,
      relayProtocol: local?.relayProtocol ?? null,
      rttMs: typeof pair?.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null,
    } });
    if (local?.candidateType === 'relay') ctx.telemetry.emit('rt.turn.used', { attrs: { relayProtocol: local.relayProtocol ?? null, protocol: local.protocol ?? null } });
  } catch { /* stats unavailable */ }
}

export function setPlayoutDelay(receiver: RTCRtpReceiver | undefined, ms: number): 'jitterBufferTarget' | 'playoutDelayHint' | null {
  const r = receiver as { jitterBufferTarget?: number | null; playoutDelayHint?: number | null } | undefined;
  if (!r) return null;
  try {
    if ('jitterBufferTarget' in r) { r.jitterBufferTarget = ms; return 'jitterBufferTarget'; }
    if ('playoutDelayHint' in r) { r.playoutDelayHint = ms / 1000; return 'playoutDelayHint'; }
  } catch {
    return null;
  }
  return null;
}

const isRed = (c: { mimeType: string }) => c.mimeType.toLowerCase() === 'audio/red';

export function preferRedundantAudio(pc: RTCPeerConnection): void {
  try {
    const codecs = (globalThis as { RTCRtpSender?: typeof RTCRtpSender }).RTCRtpSender?.getCapabilities?.('audio')?.codecs ?? [];
    if (!codecs.some(isRed)) return;
    for (const t of pc.getTransceivers?.() ?? []) t.setCodecPreferences?.([...codecs.filter(isRed), ...codecs.filter(c => !isRed(c))]);
  } catch { /* the browser keeps its own order */ }
}

interface Link {
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
  heldMic?: { sender: RTCRtpSender; track: MediaStreamTrack };
}

export function createWebRtcTransport(ctx: TransportContext, offer: WebRtcOffer, deps?: Partial<WebRtcDeps>): RealtimeTransport {
  const PC = deps?.RTCPeerConnection ?? (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
  const opened = new Set<Link>();
  let link: Link | null = null;
  let connected = false;
  let answered = false;
  let live = !ctx.standby;
  let closing = false;
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnecting = false;
  const token = ctx.descriptor?.token ?? '';
  const sessionUrl = offer.offerUrl.replace(/\/offer$/, '');

  const failOnce = (why: string) => {
    if (closing || !connected) return;
    closing = true;
    ctx.fail(new Error(`webrtc: ${why}`));
  };

  const negotiate = async (conn: RTCPeerConnection, signal: AbortSignal) => {
    await conn.setLocalDescription(await conn.createOffer());
    await waitIceGathering(conn, ctx.timeouts.iceGatherMs, signal, offer.iceTransportPolicy === 'relay');
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    const res = await ctx.fetchImpl(offer.offerUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', traceparent: ctx.traceparent },
      body: JSON.stringify({ sdp: conn.localDescription?.sdp ?? '', type: 'offer' }),
      signal: AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(ctx.timeouts.signalingMs)]) : signal,
    });
    const answer = await res.json().catch(() => null) as { sdp?: string; type?: string; error?: { code?: string } } | null;
    if (!res.ok || !answer?.sdp) throw new Error(`offer refused: HTTP ${res.status}${answer?.error?.code ? ` ${answer.error.code}` : ''}`);
    answered = true;
    await conn.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  };

  const release = (l: Link) => {
    if (!opened.delete(l)) return;
    l.channel.onmessage = null;
    l.channel.onclose = null;
    l.pc.ontrack = null;
    l.pc.oniceconnectionstatechange = null;
    l.pc.onconnectionstatechange = null;
    try { l.channel.close(); } catch { /* closed */ }
    try { l.pc.close(); } catch { /* closed */ }
  };

  const open = async (signal: AbortSignal, connectMs: number): Promise<Link> => {
    const pc = new PC!({
      iceServers: (offer.iceServers ?? ctx.descriptor?.iceServers ?? []) as RTCIceServer[], bundlePolicy: 'max-bundle',
      ...(offer.iceTransportPolicy ? { iceTransportPolicy: offer.iceTransportPolicy } : {}),
    });
    const l: Link = { pc, channel: pc.createDataChannel('events', { ordered: true }) };
    opened.add(l);
    try {
      const mic = await ctx.mic();
      const tracks = mic.getAudioTracks();
      if (!tracks.length) pc.addTransceiver('audio', { direction: 'recvonly' });
      else if (live) for (const track of tracks) pc.addTrack(track, mic);
      else l.heldMic = { sender: pc.addTransceiver('audio', { direction: 'sendrecv' }).sender, track: tracks[0]! };
      preferRedundantAudio(pc);
      l.channel.onmessage = (e: MessageEvent) => {
        try { ctx.emit(JSON.parse(String(e.data))); } catch { /* not JSON: ignored */ }
      };
      pc.ontrack = (e: RTCTrackEvent) => {
        setPlayoutDelay(e.receiver, ctx.playoutDelayMs ?? 0);
        ctx.remoteAudio(e.streams[0] ?? new MediaStream([e.track]));
      };
      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        ctx.telemetry.emit('rt.ice.state', { attrs: { state } });
        if (state === 'failed') ctx.telemetry.emit('rt.ice.failed', { level: 'warn', attrs: { connected } });
      };
      await negotiate(pc, signal);
      await waitConnected(pc, l.channel, connectMs, signal);
      if (closing) throw new Error('closed');
      return l;
    } catch (err) {
      release(l);
      throw err;
    }
  };

  const adopt = (l: Link) => {
    if (disconnectTimer) clearTimeout(disconnectTimer);
    disconnectTimer = null;
    link = l;
    l.channel.onclose = () => failOnce('data channel closed');
    l.pc.onconnectionstatechange = () => {
      const state = l.pc.connectionState;
      if (state === 'failed') void reconnect();
      else if (state === 'disconnected' && !disconnectTimer) {
        disconnectTimer = setTimeout(() => { disconnectTimer = null; if (l.pc.connectionState !== 'connected') void reconnect(); }, ctx.timeouts.disconnectGraceMs);
      } else if (state === 'connected' && disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
    };
    void reportRelay(l.pc, ctx);
  };

  const reconnect = async () => {
    if (reconnecting || closing || !connected) return;
    reconnecting = true;
    const started = performance.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error(`no path within ${ctx.timeouts.iceRestartMs} ms`)), ctx.timeouts.iceRestartMs);
    try {
      const next = await open(abort.signal, ctx.timeouts.iceRestartMs);
      const previous = link;
      adopt(next);
      if (previous) release(previous);
      ctx.telemetry.emit('rt.ice.restart', { durMs: performance.now() - started, attrs: { ok: true } });
    } catch (err) {
      ctx.telemetry.emit('rt.ice.restart', { level: 'warn', durMs: performance.now() - started, attrs: { ok: false } });
      failOnce(`ice restart failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
      reconnecting = false;
    }
  };

  return {
    type: 'webrtc',
    clipBased: false,
    async connect(signal) {
      if (!PC) throw new Error('RTCPeerConnection is not available');
      const l = await open(signal, ctx.timeouts.webrtcConnectMs);
      connected = true;
      adopt(l);
    },
    send(message: ClientMessage) {
      if (link?.channel.readyState === 'open') link.channel.send(JSON.stringify(message));
    },
    goLive() {
      live = true;
      const held = link?.heldMic;
      if (held) void held.sender.replaceTrack(held.track);
    },
    close() {
      closing = true;
      connected = false;
      if (disconnectTimer) clearTimeout(disconnectTimer);
      for (const l of [...opened]) release(l);
      ctx.remoteAudio(null);
      // Free the replica's slot now rather than when its ICE times out.
      if (answered && token) {
        answered = false;
        void ctx.fetchImpl(sessionUrl, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, traceparent: ctx.traceparent }, keepalive: true }).catch(() => {});
      }
    },
  };
}
