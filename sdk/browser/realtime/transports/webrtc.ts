/**
 * WebRTC rung: browser ↔ GPU replica directly (Opus both ways, events on the "events" data channel), signaled through
 * the gateway (`offerUrl`, session token as Bearer). Non-trickle: the offer goes once ICE gathering completes or after
 * `iceGatherMs` with what was gathered (host + srflx are there within ~100 ms; relay candidates need the TURN round
 * trip). TURN servers come from the session (credentials minted per session by the gateway).
 */
import type { ClientMessage, RealtimeTransport, TransportContext, TransportOffer } from '../types';

type WebRtcOffer = Extract<TransportOffer, { type: 'webrtc' }>;

export interface WebRtcDeps {
  RTCPeerConnection: typeof RTCPeerConnection;
}

function waitIceGathering(pc: RTCPeerConnection, ms: number, signal: AbortSignal): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); signal.removeEventListener('abort', done); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', check);
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

/** `rt.turn.used` when the selected candidate pair goes through a TURN relay (and over which protocol). */
async function reportRelay(pc: RTCPeerConnection, ctx: TransportContext): Promise<void> {
  try {
    const stats = await pc.getStats();
    let pairId: string | undefined;
    stats.forEach((s: { type: string; selectedCandidatePairId?: string }) => { if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId; });
    let localId: string | undefined;
    stats.forEach((s: { type: string; id: string; localCandidateId?: string; state?: string; nominated?: boolean }) => {
      if (s.type === 'candidate-pair' && (s.id === pairId || (!pairId && s.nominated && s.state === 'succeeded'))) localId = s.localCandidateId;
    });
    let local: { candidateType?: string; relayProtocol?: string; protocol?: string } | undefined;
    stats.forEach((s: { id: string; candidateType?: string; relayProtocol?: string; protocol?: string }) => { if (s.id === localId) local = s; });
    if (local?.candidateType === 'relay') ctx.telemetry.emit('rt.turn.used', { attrs: { relayProtocol: local.relayProtocol ?? null, protocol: local.protocol ?? null } });
  } catch { /* stats unavailable */ }
}

export function createWebRtcTransport(ctx: TransportContext, offer: WebRtcOffer, deps?: Partial<WebRtcDeps>): RealtimeTransport {
  const PC = deps?.RTCPeerConnection ?? (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
  let pc: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let connected = false;
  let closing = false;
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const token = ctx.descriptor?.token ?? '';
  const sessionUrl = offer.offerUrl.replace(/\/offer$/, '');

  const failOnce = (why: string) => {
    if (closing || !connected) return;
    closing = true;
    ctx.fail(new Error(`webrtc: ${why}`));
  };

  return {
    type: 'webrtc',
    clipBased: false,
    async connect(signal) {
      if (!PC) throw new Error('RTCPeerConnection is not available');
      pc = new PC({ iceServers: (offer.iceServers ?? ctx.descriptor?.iceServers ?? []) as RTCIceServer[], bundlePolicy: 'max-bundle' });
      const mic = await ctx.mic();
      const tracks = mic.getAudioTracks();
      if (tracks.length) for (const track of tracks) pc.addTrack(track, mic);
      else pc.addTransceiver('audio', { direction: 'recvonly' });
      channel = pc.createDataChannel('events', { ordered: true });
      channel.onmessage = (e: MessageEvent) => {
        try { ctx.emit(JSON.parse(String(e.data))); } catch { /* not JSON: ignored */ }
      };
      channel.onclose = () => failOnce('data channel closed');
      pc.ontrack = (e: RTCTrackEvent) => ctx.remoteAudio(e.streams[0] ?? new MediaStream([e.track]));
      pc.oniceconnectionstatechange = () => {
        const state = pc?.iceConnectionState;
        ctx.telemetry.emit('rt.ice.state', { attrs: { state } });
        if (state === 'failed') ctx.telemetry.emit('rt.ice.failed', { level: 'warn', attrs: { connected } });
      };
      pc.onconnectionstatechange = () => {
        const state = pc?.connectionState;
        if (state === 'failed') failOnce('connection failed');
        else if (state === 'disconnected' && connected && !disconnectTimer) {
          disconnectTimer = setTimeout(() => { disconnectTimer = null; if (pc?.connectionState !== 'connected') failOnce('connection lost'); }, ctx.timeouts.disconnectGraceMs);
        } else if (state === 'connected' && disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
      };
      await pc.setLocalDescription(await pc.createOffer());
      await waitIceGathering(pc, ctx.timeouts.iceGatherMs, signal);
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
      const res = await ctx.fetchImpl(offer.offerUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', traceparent: ctx.traceparent },
        body: JSON.stringify({ sdp: pc.localDescription?.sdp ?? '', type: 'offer' }),
        signal: AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(ctx.timeouts.signalingMs)]) : signal,
      });
      const answer = await res.json().catch(() => null) as { sdp?: string; type?: string; error?: { code?: string } } | null;
      if (!res.ok || !answer?.sdp) throw new Error(`offer refused: HTTP ${res.status}${answer?.error?.code ? ` ${answer.error.code}` : ''}`);
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      await waitConnected(pc, channel, ctx.timeouts.webrtcConnectMs, signal);
      connected = true;
      void reportRelay(pc, ctx);
    },
    send(message: ClientMessage) {
      if (channel?.readyState === 'open') channel.send(JSON.stringify(message));
    },
    close() {
      const wasConnected = connected;
      closing = true;
      connected = false;
      if (disconnectTimer) clearTimeout(disconnectTimer);
      try { channel?.close(); } catch { /* closed */ }
      try { pc?.close(); } catch { /* closed */ }
      ctx.remoteAudio(null);
      // Free the replica's slot now rather than when its ICE times out.
      if (wasConnected && token) {
        void ctx.fetchImpl(sessionUrl, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, traceparent: ctx.traceparent }, keepalive: true }).catch(() => {});
      }
    },
  };
}
