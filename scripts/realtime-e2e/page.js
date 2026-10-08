// The learner's page of the e2e: the browser SDK as an app would use it (session from the app's backend, no gateway key).
import { createRealtimeSession } from '/sdk.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let current = null;

function meter(state) {
  return (stream) => {
    if (!stream) return;
    // Chrome only feeds a remote WebRTC track to WebAudio while a media element plays it.
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
  state.session = createRealtimeSession({
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
    ...opts,
  });
  return state;
}

function waitFor(state, pred, ms) {
  if (state.events.some(pred)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const w = { pred, done: () => { clearTimeout(t); resolve(true); } };
    const t = setTimeout(() => { state.waiters.splice(state.waiters.indexOf(w), 1); resolve(false); }, ms);
    state.waiters.push(w);
  });
}

function summary(state, error) {
  const s = state.session;
  return {
    transport: s.transport, events: state.events.map((e) => ({ ...e, ...(e.text ? { text: String(e.text).slice(0, 80) } : {}) })),
    loudFrames: state.loudFrames, traceId: s.traceId, sessionId: s.sessionId, history: s.history,
    metrics: { connectMs: s.metrics.connectMs, attempts: s.metrics.attempts, failovers: s.metrics.failovers, lastTurn: s.metrics.lastTurn },
    ttfaBrowserMs: state.firstLoudAt !== null && state.vadEndAt !== null ? Math.round(state.firstLoudAt - state.vadEndAt) : null,
    ...(error ? { error: String(error) } : {}),
  };
}

const turnDone = (e) => e.type === 'done' && !e.empty;

/** 16 kHz mono WAV: what the voice SDK would record as one learner turn on the clip rungs. */
function toneWav() {
  const sr = 16000, n = Math.round(sr * 1.5), pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    pcm[i] = i < sr * 1.2 ? Math.round(32767 * (0.25 * Math.sin(2 * Math.PI * 210 * t) + 0.1 * Math.sin(4 * Math.PI * 210 * t))) : 0;
  }
  const head = new DataView(new ArrayBuffer(44));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) head.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); head.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVEfmt ');
  head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, 1, true); head.setUint32(24, sr, true);
  head.setUint32(28, sr * 2, true); head.setUint16(32, 2, true); head.setUint16(34, 16, true); str(36, 'data');
  head.setUint32(40, pcm.byteLength, true);
  return new Blob([head, pcm.buffer], { type: 'audio/wav' });
}

window.e2eRun = async (opts) => {
  const state = open(opts);
  try {
    await state.session.connect();
    await waitFor(state, turnDone, 25_000);
    await sleep(1_500); // the rest of the NPC audio
    return summary(state);
  } catch (err) {
    return summary(state, err);
  } finally {
    clearInterval(state.meterTimer);
    state.session.close();
  }
};

window.e2eStart = async (opts) => {
  current = open(opts);
  try {
    await current.session.connect();
    await waitFor(current, turnDone, 25_000);
    return summary(current);
  } catch (err) {
    return summary(current, err);
  }
};

window.e2eAfterFailover = async () => {
  const state = current;
  try {
    const moved = await waitFor(state, (e) => e.type === 'transport' && e.reason === 'failover' && e.transport === 's2s-stream', 25_000);
    if (!moved) return summary(state, 'no failover to s2s-stream');
    const before = state.events.length;
    await state.session.sendTurn(toneWav());
    await waitFor({ ...state, events: state.events.slice(before), waiters: state.waiters }, turnDone, 20_000);
    await sleep(300);
    const s = summary(state);
    s.events = s.events.slice(before);
    return s;
  } catch (err) {
    return summary(state, err);
  } finally {
    clearInterval(state.meterTimer);
    state.session.close();
  }
};

window.e2eReady = true;
