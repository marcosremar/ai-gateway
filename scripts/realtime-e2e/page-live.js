// Live e2e page driver: the browser SDK against the real gateway + replica (e2e-live.ts).
// window.liveRun({ transport, barge, forceRelay, voiceAfter }) — sanitized summary only (no transcript/audio/SDP).
import { createRealtimeSession, createWebRtcTransport, createWsTransport } from '/sdk.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function meter(state) {
  return (stream) => {
    if (!stream) return;
    const el = new Audio();
    el.srcObject = stream;
    el.muted = true;
    void el.play().catch(() => {});
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    state.meterTimer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      if (Math.sqrt(s / buf.length) > 0.02) {
        state.loudFrames++;
        if (state.firstLoudAt === null) state.firstLoudAt = performance.now();
      }
    }, 20);
  };
}

function open(opts = {}) {
  const state = { events: [], loudFrames: 0, firstLoudAt: null, vadEndAt: null, meterTimer: null, waiters: [] };
  const sopts = {
    sessionEndpoint: '/api/rt-session',
    getMicStream: () => navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    }),
    onEvent: (e) => {
      state.events.push(e);
      if (e.type === 'vad' && e.state === 'end' && state.vadEndAt === null) state.vadEndAt = performance.now();
      for (const w of [...state.waiters]) if (w.pred(e)) { state.waiters.splice(state.waiters.indexOf(w), 1); w.done(); }
    },
    onRemoteAudio: meter(state),
    s2s: { url: '/api/s2s' },
    storage: null,
  };
  if (opts.transport) sopts.preferredTransports = [opts.transport];
  // Capture the live transport so the page can send raw control frames (config_update with a clone voice).
  const grab = (t) => { state.liveTransport = t; return t; };
  const webrtcFactory = (c) => {
    const o = c.descriptor?.transports.find((t) => t.type === 'webrtc');
    if (!o || o.type !== 'webrtc') return null;
    const deps = opts.forceRelay ? { RTCPeerConnection: RelayPC } : undefined;
    return grab(createWebRtcTransport(c, o, deps));
  };
  const wsFactory = (c) => {
    const o = c.descriptor?.transports.find((t) => t.type === 'ws');
    return o ? grab(createWsTransport(c, o.url)) : null;
  };
  if (opts.forceRelay || opts.voiceAfter) sopts.transports = { webrtc: webrtcFactory, ws: wsFactory };
  state.session = createRealtimeSession(sopts);
  return state;
}

// A browser on a UDP-blocked network: ICE only gathers relay candidates (real TURN allocation).
const RelayPC = class extends RTCPeerConnection {
  constructor(cfg) { super({ ...cfg, iceTransportPolicy: 'relay' }); }
};

function waitFor(state, pred, ms) {
  if (state.events.some(pred)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const w = { pred, done: () => { clearTimeout(t); resolve(true); } };
    const t = setTimeout(() => { state.waiters.splice(state.waiters.indexOf(w), 1); resolve(false); }, ms);
    state.waiters.push(w);
  });
}

const KEEP = new Set(['type', 'state', 'final', 'code', 'interrupted', 'filtered', 'empty', 'transport', 'reason', 'from', 'ttfa_ms', 'stt_ms', 'llm_ttft_ms', 'tts_ttfb_ms', 'turnId', 'sessionId', 'traceId']);
function summary(state, error) {
  const s = state.session;
  return {
    transport: s.transport,
    events: state.events.map((e) => Object.fromEntries(Object.entries(e).filter(([k]) => KEEP.has(k)))),
    loudFrames: state.loudFrames, traceId: s.traceId, sessionId: s.sessionId,
    history: s.history.map((m) => m.role),
    interruptMs: state.interruptMs ?? null,
    metrics: { connectMs: s.metrics.connectMs, attempts: s.metrics.attempts, failovers: s.metrics.failovers, lastTurn: s.metrics.lastTurn },
    ttfaBrowserMs: state.firstLoudAt !== null && state.vadEndAt !== null ? Math.round(state.firstLoudAt - state.vadEndAt) : null,
    ...(error ? { error: String(error) } : {}),
  };
}

const turnDone = (e) => e.type === 'done' && !e.empty;

window.liveRun = async (opts = {}) => {
  const state = open(opts);
  try {
    const connected = await state.session.connect();
    state.connectedAs = connected;
    if (opts.voiceAfter && state.liveTransport) {
      state.liveTransport.send({ type: 'config_update', voice: opts.voiceAfter.voice, ...(opts.voiceAfter.fallback_voice ? { fallback_voice: opts.voiceAfter.fallback_voice } : {}) });
      state.voiceSent = true;
    }
    if (opts.barge) {
      // Speak until the NPC starts answering, then barge in and measure the 'interrupted' latency.
      const speaking = await waitFor(state, (e) => e.type === 'audio_start', 90_000);
      if (!speaking) return summary(state, 'npc audio never started');
      const t0 = performance.now();
      state.session.interrupt();
      const got = await waitFor(state, (e) => e.type === 'interrupted', 10_000);
      state.interruptMs = got ? Math.round(performance.now() - t0) : null;
      await sleep(800);
      return summary(state);
    }
    await waitFor(state, turnDone, 90_000);
    await sleep(1_500);
    return summary(state);
  } catch (err) {
    return summary(state, err);
  } finally {
    clearInterval(state.meterTimer);
    state.session.close();
  }
};

window.liveReady = true;
