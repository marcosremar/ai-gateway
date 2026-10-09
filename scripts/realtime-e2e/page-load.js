import { audible, epoch, makeMeter, output, playRemote, rtcSummary } from '/meter.js';
import { createRealtimeSession, createWsTransport } from '/sdk.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEEP = [
  'type', 'state', 'final', 'code', 'empty', 'filtered', 'interrupted', 'error', 'ttfa_ms', 'stt_ms', 'llm_ttft_ms', 'tts_ttfb_ms',
  'index', 'audio_ms', 'deadline_ms', 'deadline_missed', 'first_sound_ms', 'tts_retries', 'local',
  'out_first_pull_ms', 'rtp_first_sent_ms', 'rtp_late_p50_ms', 'rtp_late_p95_ms', 'rtp_late_max_ms', 'uplink_lost_ms',
];
const SDK_TURN_EVENTS = ['turn.first_sound', 'turn.done'];
const MIN_CLIP_MS = 300;

window.loadRun = async ({ durationMs, turnTimeoutMs, transport, turnEveryMs, clipEndSilenceMs, uplinkStallMs = 0, uplinkStallEvery = 3, clientDeadline = false }) => {
  const events = [];
  const clipTurns = [];
  const micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const mic = makeMeter();
  mic.stream(micStream);
  const sinceVoice = () => epoch() - (mic.spans[mic.spans.length - 1]?.end ?? 0);
  const stalled = { utterances: 0, posts: 0, quiet: true, held: null };
  class StalledWebSocket extends WebSocket {
    send(data) {
      const quiet = sinceVoice() >= clipEndSilenceMs;
      if (!quiet && stalled.quiet && stalled.utterances++ % uplinkStallEvery === 0) stalled.held = [];
      stalled.quiet = quiet;
      if (stalled.held && sinceVoice() >= uplinkStallMs) {
        for (const late of stalled.held) super.send(late);
        stalled.held = null;
      }
      if (stalled.held) stalled.held.push(data);
      else super.send(data);
    }
  }
  const stalledFetch = async (url, init) => {
    if (String(url).startsWith('/api/s2s') && stalled.posts++ % uplinkStallEvery === 0) await sleep(uplinkStallMs);
    return fetch(url, init);
  };
  const speak = async (text) => {
    const res = await fetch('/api/speak', { method: 'POST', body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error(`speak answered HTTP ${res.status}`);
    return res.arrayBuffer();
  };
  const session = createRealtimeSession({
    sessionEndpoint: '/api/rt-session',
    getMicStream: async () => micStream,
    onEvent: (e) => {
      if (e.type === 'reply_delta' || (e.type === 'transcript' && !e.final)) return;
      events.push({ ...Object.fromEntries(KEEP.filter((k) => k in e).map((k) => [k, e[k]])), at: epoch(), chars: typeof e.text === 'string' ? e.text.length : 0 });
    },
    onRemoteAudio: playRemote,
    s2s: { url: '/api/s2s' },
    config: await (await fetch('/config.json')).json(),
    storage: null,
    telemetry: { onEvent: (t) => { if (SDK_TURN_EVENTS.includes(t.event)) events.push({ type: t.event, at: epoch(), ms: t.durMs ?? null, ...t.attrs }); } },
    ...(transport ? { preferredTransports: [transport] } : {}),
    ...(clientDeadline ? { speak } : {}),
    ...(uplinkStallMs ? {
      fetchImpl: stalledFetch,
      transports: { ws: (c) => { const o = c.descriptor?.transports.find((t) => t.type === 'ws'); return o ? createWsTransport(c, o.url, { WebSocket: StalledWebSocket }) : null; } },
    } : {}),
  });
  let endedSpan = null;
  const endTurns = clientDeadline ? setInterval(() => {
    const last = mic.spans[mic.spans.length - 1];
    if (!last || last === endedSpan || sinceVoice() < clipEndSilenceMs) return;
    endedSpan = last;
    session.sendEndTurn();
  }, 20) : null;
  let error = null;
  let connectedAt = Infinity;
  let endAt = Infinity;
  try {
    await session.connect();
    connectedAt = epoch();
    const end = connectedAt + durationMs;
    endAt = end;
    if (session.transport === 's2s-stream' || session.transport === 'post') {
      const clip = await (await fetch('/clip.wav')).blob();
      for (let next = connectedAt + 1000; next + clipEndSilenceMs < end; next += turnEveryMs) {
        await sleep(next - epoch());
        const turn = { at: epoch() - 1, ref: epoch() };
        clipTurns.push(turn);
        await sleep(clipEndSilenceMs);
        await Promise.race([session.sendTurn(clip), sleep(turnTimeoutMs)]);
      }
    }
    await sleep(end - epoch());
    const doneSince = () => events.some((e) => e.type === 'done' && e.at > (mic.spans[mic.spans.length - 1]?.end ?? 0));
    for (let waited = 0; !clipTurns.length && mic.spans.length && !doneSince() && waited < turnTimeoutMs; waited += 100) await sleep(100);
    await sleep(500);
  } catch (err) {
    error = String(err);
  }
  const voiced = mic.spans.reduce((out, s) => {
    const last = out[out.length - 1];
    if (last && s.start - last.end < clipEndSilenceMs) Object.assign(last, { end: s.end, endGap: s.endGap });
    else out.push({ ...s });
    return out;
  }, []);
  const spoken = clipTurns.length ? clipTurns
    : voiced.filter((s) => s.start > connectedAt + 100 && s.start < endAt && s.end - s.start >= MIN_CLIP_MS).map((s) => ({ at: s.start, ref: s.end, refGap: s.endGap }));
  const turns = spoken.map((turn, i) => {
    const until = spoken[i + 1]?.at ?? Infinity;
    return { at: turn.at, speechEnd: turn.ref, events: events.filter((e) => e.at >= turn.at && e.at < until), ...audible(turn, events, until) };
  });
  const summary = {
    transport: session.transport, connectMs: session.metrics.connectMs, error, turns,
    attempts: session.metrics.attempts.map((a) => ({ at: 0, type: a.type, ok: a.ok, ms: a.ms, reason: a.error })),
    meter: { mic: mic.stats, output: output.stats, rtc: rtcSummary() },
  };
  clearInterval(endTurns);
  session.close();
  return summary;
};

window.loadReady = true;
