// Live e2e page driver: the browser SDK against the real gateway + replica (e2e-live.ts).
// window.liveRun({ transport, barge, forceRelay }) — sanitized summary only (no transcript/audio/SDP).
import { audible, epoch, makeMeter, playRemote } from '/meter.js';
import { createRealtimeSession, createWebRtcTransport, createWsTransport } from '/sdk.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(opts = {}, config = {}) {
  const state = { events: [], mic: makeMeter(), clipTurn: null, waiters: [] };
  const sopts = {
    sessionEndpoint: '/api/rt-session',
    getMicStream: async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      state.mic.stream(stream);
      return stream;
    },
    config,
    onEvent: (e) => {
      state.events.push({ ...e, at: epoch() });
      for (const w of [...state.waiters]) if (w.pred(e)) { state.waiters.splice(state.waiters.indexOf(w), 1); w.done(); }
    },
    onRemoteAudio: playRemote,
    s2s: { url: '/api/s2s' },
    storage: null,
  };
  if (opts.transport) sopts.preferredTransports = [opts.transport];
  const webrtcFactory = (c) => {
    const o = c.descriptor?.transports.find((t) => t.type === 'webrtc');
    if (!o || o.type !== 'webrtc') return null;
    const deps = opts.forceRelay ? { RTCPeerConnection: RelayPC } : undefined;
    return createWebRtcTransport(c, o, deps);
  };
  const wsFactory = (c) => {
    const o = c.descriptor?.transports.find((t) => t.type === 'ws');
    return o ? createWsTransport(c, o.url) : null;
  };
  if (opts.forceRelay) sopts.transports = { webrtc: webrtcFactory, ws: wsFactory };
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
  const done = state.events.find(turnDone) ?? state.events.find((e) => e.type === 'audio_start');
  const span = [...state.mic.spans].reverse().find((x) => done && x.end < done.at);
  const turn = state.clipTurn ?? (span ? { at: span.start, ref: span.end, refGap: span.endGap } : null);
  return {
    audible: turn ? audible(turn, state.events, Infinity) : null,
    meter: state.mic.stats,
    transport: s.transport,
    events: state.events.map((e) => ({ ...Object.fromEntries(Object.entries(e).filter(([k]) => KEEP.has(k))), ...(e.type === 'error' ? { message: String(e.message).slice(0, 120) } : {}), at: Math.round(e.at - performance.timeOrigin) })),
    traceId: s.traceId, sessionId: s.sessionId,
    history: s.history.map((m) => m.role),
    interruptMs: state.interruptMs ?? null,
    metrics: { connectMs: s.metrics.connectMs, attempts: s.metrics.attempts, failovers: s.metrics.failovers, lastTurn: s.metrics.lastTurn },
    ...(error ? { error: String(error) } : {}),
  };
}

const turnDone = (e) => e.type === 'done' && !e.empty;

window.liveRun = async (opts = {}) => {
  const state = open(opts, await (await fetch('/config.json')).json());
  try {
    const connected = await state.session.connect();
    state.connectedAs = connected;
    if (connected === 's2s-stream' || connected === 'post') {
      const clip = await (await fetch('/clip.wav')).blob();
      state.clipTurn = { at: epoch() - 1, ref: epoch() };
      await sleep(opts.clipEndSilenceMs ?? 700);
      await state.session.sendTurn(clip);
      await sleep(500);
      return summary(state);
    }
    if (opts.barge) {
      // Speak until the NPC starts answering, then barge in and measure the 'interrupted' latency.
      const speaking = await waitFor(state, (e) => e.type === 'audio_start', 90_000);
      if (!speaking) return summary(state, 'npc audio never started');
      const t0 = epoch();
      state.session.interrupt();
      const got = await waitFor(state, (e) => e.type === 'interrupted', 10_000);
      state.interruptMs = got ? Math.round(epoch() - t0) : null;
      await sleep(800);
      return summary(state);
    }
    await waitFor(state, turnDone, 90_000);
    await sleep(1_500);
    return summary(state);
  } catch (err) {
    return summary(state, err);
  } finally {
    state.session.close();
  }
};

window.liveReady = true;
