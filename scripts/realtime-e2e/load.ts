/**
 * Load and bad-network harness for the realtime voice path (docs/realtime.md § Load harness): N simulated students, each
 * holding one realtime session and speaking a clip on a duty cycle, measured from the end of their speech to the first
 * audio of the reply, under a named network profile. Against the local fake stack (no GPU; Linux + root, as e2e.ts):
 *
 *   EDGE_PYTHON=/path/to/venv/bin/python bun scripts/realtime-e2e/load.ts --n 20 --rtc 8 --profile campus-slow
 *
 * or against a real gateway and deployment (as e2e-live.ts; any OS for --profile clean, Linux + root for the others):
 *
 *   GW=https://gw KEY=<app key> DEP=parle-speech RT_CONFIG='{"system":"…","messages":[],"voice":"lia"}' \
 *     bun scripts/realtime-e2e/load.ts --n 100 --rtc 30 --clip turn.wav --profile campus-slow
 *
 *   --n 20            students (lightweight clients)        --rtc 0          how many of them start the ladder at WebRTC
 *   --chrome 0        real Chrome sessions alongside        --rtc-procs      aiortc processes (default 1 per 8)
 *   --chrome-transports webrtc,ws,s2s-stream   rung forced on each Chrome session, round robin ('' = the SDK's ladder)
 *   --clip-end-silence 700   ms the Chrome clip rung waits after the speech before it posts the clip
 *   --s2s 0           how many of them post each turn to /v1/s2s instead (no session; the clock starts at the request
 *                     minus --clip-end-silence, the endpointing a page adds)   --no-wake   they send X-Gateway-No-Wake: 1
 *   --ramp 30         seconds over which students arrive    --duration 180   seconds each student talks
 *   --turn-every 15   seconds between turns                 --jitter 5       ± seconds
 *   --clip-s 1.4      length of the tone clip               --clip file.wav  real speech instead (PCM16 mono WAV)
 *   --profile clean   clean | campus-slow | udp-blocked | lossy | flap
 *   --replicas 2 --cap 16   fake stack only: replicas and RT_MAX_SESSIONS of each
 *   --p50 1500 --p95 2000 --max-bad 1   the target: first-audio ms and failures + truncations in %
 *   --turn-timeout 30 --trunc-ratio 0.75 --ms-per-char 0 --turn udp|tcp --out <dir>
 *
 * Fake model knobs (env): FAKE_STT_MS, FAKE_LLM_TTFT_MS, FAKE_LLM_TOKEN_MS, FAKE_TTS_TTFB_MS, FAKE_TTS_DROP_EVERY=N with
 * FAKE_TTS_DROP_MODE=empty|abort, FAKE_TTS_SILENT=1. Writes <out>/report.json, prints a summary and a PASS/FAIL line; exit 0 pass, 1 fail,
 * 2 the harness itself failed.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { cpus, loadavg, tmpdir } from 'os';
import { join } from 'path';
import type { ClientConfig, ClientResult, Turn } from './load-client';
import { HOST_IP, NS_EXEC, PROFILES, netDown, netState, netUp } from './net-shape';

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const num = (name: string, fallback: number) => Number(opt(name) ?? fallback);

const REAL_GW = process.env.GW ?? '';
const N = num('n', 20);
const RTC = Math.min(N, num('rtc', 0));
const S2S = Math.min(N - RTC, num('s2s', 0));
const CHROME = num('chrome', 0);
const PROFILE = opt('profile') ?? 'clean';
const REPLICAS = num('replicas', 2);
const CAP = num('cap', 16);
const TARGET = { p50: num('p50', 1500), p95: num('p95', 2000), maxBadPct: num('max-bad', 1) };
const TRUNC_RATIO = num('trunc-ratio', 0.75);
const MS_PER_CHAR = num('ms-per-char', 0);
const DEP = process.env.DEP ?? (REAL_GW ? 'parle-speech' : 'speech-load');
const WORK = opt('out') ?? mkdtempSync(join(tmpdir(), 'aigw-rt-load-'));
const LOG = join(WORK, 'load.log');
const LINUX_ROOT = process.platform === 'linux' && process.getuid?.() === 0;

mkdirSync(WORK, { recursive: true });
const log = (line: string) => appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(200); }
  throw new Error(`timed out waiting for ${what}`);
}
const round = (x: number, digits = 0) => Math.round(x * 10 ** digits) / 10 ** digits;

interface ReplicaSample { at: number; load: number; replicas: Array<{ id: string; phase: string; state: string; machineType: string; pricePerHour: number | null }> }
type View = { replicas?: Array<{ id: string; phase: string; providerState: string; machineType: string; pricePerHour: number | null }> };

function outcome(t: Turn): { result: 'ok' | 'failed' | 'truncated'; why: string } {
  const failed = (why: string) => ({ result: 'failed' as const, why });
  const truncated = (why: string) => ({ result: 'truncated' as const, why });
  if (t.skipped) return failed(t.skipped.split(':').slice(0, 2).join(':'));
  const ev = (type: string) => t.events.find(e => e.type === type);
  const done = ev('done');
  const error = ev('error');
  const heard = t.audioMs < 0 ? Boolean(ev('audio_start')) : t.firstLoud !== null;
  if (t.client === 's2s' && done && !heard && !done.empty && (error || ev('sentence_failed'))) return failed(`error:${String((error ?? ev('sentence_failed'))?.code ?? 'unknown')}`);
  if (!done) return heard ? truncated(t.lost ? 'lost_after_audio' : 'no_done_after_audio') : failed(t.lost ? 'session_lost' : 'timeout');
  if (error || done.error) return heard ? truncated(`error_after_audio:${String(error?.code ?? 'unknown')}`) : failed(`error:${String(error?.code ?? 'unknown')}`);
  if (done.interrupted) return heard ? truncated('interrupted') : failed('interrupted');
  if (done.empty || done.filtered) return failed(done.filtered ? 'filtered' : 'empty');
  if (!heard || t.audioMs === 0) return failed('no_audio');
  if (done.missing_audio) return truncated(`missing_audio:${String(ev('sentence_failed')?.code ?? 'unknown')}`);
  if (!ev('audio_end')) return truncated('no_audio_end');
  return { result: 'ok', why: '' };
}

function dist(values: number[], attempted = values.length) {
  const xs = [...values].sort((a, b) => a - b);
  const pct = (p: number) => (xs.length ? Math.round(xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]) : null);
  const share = (ms: number) => (attempted ? round((100 * xs.filter(x => x <= ms).length) / attempted, 1) : null);
  return { n: xs.length, p10: pct(10), p50: pct(50), p90: pct(90), p95: pct(95), p99: pct(99), max: pct(100), le1000: share(1000), le1500: share(1500), le2000: share(2000), le3000: share(3000), le5000: share(5000) };
}
const count = (keys: string[]) => keys.reduce<Record<string, number>>((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {});

function buildReport(client: ClientResult, samples: ReplicaSample[], flaps: Array<{ at: number; down: boolean }>, cfg: ClientConfig) {
  const judged = client.turns.map(t => ({
    t, ...outcome(t), key: t.client === 'chrome' ? `chrome:${t.transport}` : t.transport ?? 'none',
    latency: t.firstLoud !== null && t.speechEnd !== null ? t.firstLoud - t.speechEnd : null,
    chars: Number(t.events.find(e => e.type === 'reply')?.chars ?? 0),
  }));
  const rates: Record<string, number> = {};
  for (const kind of ['ws', 'rtc', 's2s', 'chrome']) {
    const clean = judged.filter(j => j.t.client === kind && j.result === 'ok' && j.chars > 0 && j.t.audioMs > 0);
    const sorted = clean.map(j => j.t.audioMs / j.chars).sort((a, b) => a - b);
    const reference = MS_PER_CHAR || (sorted.length >= 5 ? sorted[Math.floor(sorted.length * 0.9)] : 0);
    if (!reference) continue;
    rates[kind] = round(reference, 1);
    for (const j of clean) if (j.t.audioMs / j.chars < TRUNC_RATIO * reference) { j.result = 'truncated'; j.why = 'short_audio'; }
  }
  const attempted = judged.length;
  const bad = (result: string) => judged.filter(j => j.result === result).length;
  const pctOf = (n: number) => (attempted ? round((100 * n) / attempted, 2) : 0);
  const withLatency = (js: typeof judged) => js.filter(j => j.latency !== null && j.result !== 'failed').map(j => j.latency as number);
  const keys = [...new Set(judged.map(j => j.key))].filter(k => k !== 'none').sort();
  const all = dist(withLatency(judged), attempted);
  const replicaOf = new Map(client.students.map(st => [st.id, st.replica ?? '']));
  const byReplica = Object.fromEntries([...new Set(replicaOf.values())].filter(Boolean).sort().map((id) => {
    const js = judged.filter(j => replicaOf.get(j.t.student) === id);
    return [id, { students: [...replicaOf.values()].filter(r => r === id).length, ...dist(withLatency(js), js.length) }];
  }));
  const metric = (name: string) => judged.map(j => Number(j.t.events.find(e => e.type === 'metrics')?.[name])).filter(x => Number.isFinite(x));
  const attempts = client.students.flatMap(s => s.attempts);
  const admissions = client.students.flatMap(s => s.admissions);
  const t0 = client.startedAt;
  const step = 5_000;
  const timeline = Array.from({ length: Math.ceil((client.endedAt - t0) / step) }, (_, i) => {
    const inBucket = (at: number) => at >= t0 + i * step && at < t0 + (i + 1) * step;
    const sessions = client.samples.filter(s => inBucket(s.at));
    const replicas = samples.filter(s => inBucket(s.at)).at(-1)?.replicas;
    return {
      t: (i * step) / 1000, sessions: Math.max(0, ...sessions.map(s => s.sessions)), webrtc: Math.max(0, ...sessions.map(s => s.webrtc)),
      ws: Math.max(0, ...sessions.map(s => s.ws)), rejections: admissions.filter(a => a.status !== 200 && inBucket(a.at)).length,
      replicas: replicas?.length ?? null, ready: replicas?.filter(r => r.phase === 'ready').length ?? null,
      linkDown: flaps.some(f => f.down && inBucket(f.at)),
    };
  });
  let eur = 0;
  let unpriced = false;
  const machineHours: Record<string, number> = {};
  for (let i = 1; i < samples.length; i++) {
    const hours = (samples[i].at - samples[i - 1].at) / 3_600_000;
    for (const r of samples[i - 1].replicas.filter(x => x.state !== 'stopped')) {
      machineHours[r.machineType] = (machineHours[r.machineType] ?? 0) + hours;
      if (r.pricePerHour == null) unpriced = true;
      eur += hours * (r.pricePerHour ?? 0);
    }
  }
  const field = (js: typeof judged, name: 'audibleMs' | 'receivedMs' | 'heardAfterReceivedMs' | 'audibleFromVadEndMs' | 'meterErrorMs') => dist(js.map(j => j.t[name]).filter((x): x is number => typeof x === 'number'));
  const audible = Object.fromEntries(keys.filter(k => k.startsWith('chrome:')).map((k) => {
    const js = judged.filter(j => j.key === k);
    const heard = field(js, 'audibleMs');
    const light = dist(withLatency(judged.filter(j => j.key === k.slice(7))));
    return [k.slice(7), {
      turns: js.length, audibleMs: heard, receivedMs: field(js, 'receivedMs'), heardAfterReceivedMs: field(js, 'heardAfterReceivedMs'),
      audibleFromVadEndMs: field(js, 'audibleFromVadEndMs'), meterErrorMs: field(js.filter(j => j.t.audibleMs != null), 'meterErrorMs'), noAudibleAudio: js.filter(j => j.t.audibleMs == null && !j.t.overlap).length,
      overlapped: js.filter(j => j.t.overlap).length, lightweightMs: light,
      offsetMs: heard.p50 !== null && light.p50 !== null ? heard.p50 - light.p50 : null,
      spreadMs: heard.p90 !== null && heard.p10 !== null ? heard.p90 - heard.p10 : null,
    }];
  }));
  const posted = judged.filter(j => j.t.client === 's2s');
  const evs = (type: string) => posted.flatMap(j => j.t.events.filter(e => e.type === type));
  const first = (j: typeof judged[number], type: string, name: string) => Number(j.t.events.find(e => e.type === type)?.[name]);
  const finite = (xs: number[]) => dist(xs.filter(x => Number.isFinite(x)));
  const served = (type: string) => count(evs(type).map(e => `${String(e.provider)}${e.fallback ? ` (fallback ${String(e.fallback)})` : ''}`));
  const s2s = {
    endpointingMs: cfg.clipEndSilenceMs,
    fromRequestMs: {
      firstFrame: dist(posted.filter(j => j.t.firstFrame !== null).map(j => (j.t.firstFrame as number) - (j.t.speechEnd as number) - cfg.clipEndSilenceMs), posted.length),
      firstLoud: dist(posted.filter(j => j.latency !== null).map(j => (j.latency as number) - cfg.clipEndSilenceMs), posted.length),
    },
    stageMs: {
      stt: finite(posted.map(j => first(j, 'transcript', 'stt_ms'))),
      llmFirstToken: finite(posted.map(j => first(j, 'llm_first_token', 'at_ms') - first(j, 'transcript', 'stt_ms'))),
      ttsFirstByte: finite(posted.map(j => first(j, 'first_audio', 'at_ms') - first(j, 'sentence', 'cut_at_ms'))),
      total: finite(posted.map(j => first(j, 'done', 'total_ms'))),
    },
    servedBy: { route: served('route'), stt: served('transcript'), llm: served('llm_first_token'), ttsFirst: served('first_audio'), ttsAny: count(evs('audio_format').map(e => String(e.provider))) },
    errors: count([...evs('error'), ...evs('sentence_failed')].map(e => `${e.type}:${String(e.code ?? 'unknown')}`)),
    refused: count(posted.filter(j => j.t.skipped).map(j => String(j.t.skipped))),
    usage: {
      sttTurns: evs('transcript').length, llmTurns: evs('llm_first_token').length, sentences: evs('sentence').length,
      replyChars: evs('reply').reduce((n, e) => n + Number(e.chars), 0), audioS: round(posted.reduce((n, j) => n + j.t.audioMs, 0) / 1000, 1),
    },
  };
  const checks = [
    { name: 'first audio p50 ms', value: all.p50, limit: TARGET.p50, ok: all.p50 !== null && all.p50 <= TARGET.p50 },
    { name: 'first audio p95 ms', value: all.p95, limit: TARGET.p95, ok: all.p95 !== null && all.p95 <= TARGET.p95 },
    { name: 'failures + truncations %', value: pctOf(bad('failed') + bad('truncated')), limit: TARGET.maxBadPct, ok: attempted > 0 && pctOf(bad('failed') + bad('truncated')) <= TARGET.maxBadPct },
  ];
  return {
    pass: checks.every(c => c.ok), checks, target: TARGET,
    run: {
      mode: REAL_GW ? 'real' : 'fake', gateway: REAL_GW || null, deployment: DEP, profile: PROFILE, shaping: LINUX_ROOT ? PROFILES[PROFILE] : null,
      students: N, rtc: RTC, s2s: S2S, chrome: CHROME, chromeTransports: cfg.chromeTransports, clipEndSilenceMs: cfg.clipEndSilenceMs, rampS: cfg.rampS, durationS: cfg.durationS, turnEveryS: cfg.turnEveryS, jitterS: cfg.jitterS,
      clip: cfg.clip ?? `tone ${cfg.clipS} s`, ...(REAL_GW ? {} : { replicas: REPLICAS, capPerReplica: CAP }),
      fake: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('FAKE_'))),
    },
    turns: {
      attempted, ok: bad('ok'), failed: bad('failed'), truncated: bad('truncated'), failurePct: pctOf(bad('failed')), truncationPct: pctOf(bad('truncated')),
      why: count(judged.filter(j => j.why).map(j => `${j.result}:${j.why}`)), audioMsPerChar: rates,
    },
    firstAudioMs: { all, byReplica, byTransport: Object.fromEntries(keys.map(k => [k, dist(withLatency(judged.filter(j => j.key === k)), judged.filter(j => j.key === k).length)])) },
    audible, meters: client.meters, ...(posted.length ? { s2s } : {}),
    wsFirstFrameMs: dist(judged.filter(j => j.t.firstFrame !== null && j.t.speechEnd !== null).map(j => (j.t.firstFrame as number) - (j.t.speechEnd as number))),
    edge: { ttfaMs: dist(metric('ttfa_ms')), sttMs: dist(metric('stt_ms')), llmTtftMs: dist(metric('llm_ttft_ms')), ttsTtfbMs: dist(metric('tts_ttfb_ms')) },
    connect: {
      sessionMs: Object.fromEntries(['webrtc', 'ws'].map(k => [k, dist(client.students.filter(s => s.transport === k && s.connectMs !== null).map(s => s.connectMs as number))])),
      attempts: count(attempts.map(a => `${a.type}:${a.ok ? 'ok' : `failed:${String(a.reason).split(':')[0]}`}`)),
      pairs: count(attempts.filter(a => a.pair).map(a => { const p = a.pair as { local: string; remote: string }; return `${p.local}/${p.remote}`; })),
      reconnects: client.students.reduce((n, s) => n + s.reconnects, 0),
      neverConnected: client.students.filter(s => s.transport === null).length,
    },
    admission: {
      ok: admissions.filter(a => a.status === 200).length, ms: dist(admissions.filter(a => a.status === 200).map(a => a.ms)),
      rejected: count(admissions.filter(a => a.status !== 200).map(a => `${a.status}:${a.code}`)),
      retryAfterS: [...new Set(admissions.map(a => a.retryAfter).filter(x => x !== null))],
    },
    timeline,
    replicas: { min: Math.min(...samples.map(s => s.replicas.length)), max: Math.max(...samples.map(s => s.replicas.length)) },
    cost: REAL_GW ? { machineHours: Object.fromEntries(Object.entries(machineHours).map(([k, v]) => [k, round(v, 4)])), eur: round(eur, 4), unpriced } : null,
    generator: {
      saturated: client.mic.frames > 0 && (client.mic.late / client.mic.frames > 0.01 || client.mic.maxLagMs > 500),
      cpus: cpus().length, loadAvgMax: round(Math.max(0, ...samples.map(s => s.load)), 2), micFrames: client.mic.frames,
      micLatePct: client.mic.frames ? round((100 * client.mic.late) / client.mic.frames, 2) : 0, micMaxLagMs: client.mic.maxLagMs, uplinkDropped: client.mic.dropped,
    },
    raw: { students: client.students, turns: judged.map(j => ({ ...j.t, result: j.result, why: j.why, latencyMs: j.latency === null ? null : Math.round(j.latency) })) },
  };
}

function summary(r: ReturnType<typeof buildReport>): string {
  const d = (name: string, x: ReturnType<typeof dist>) => `  ${name.padEnd(14)} n=${x.n} p50 ${x.p50} p90 ${x.p90} p95 ${x.p95} p99 ${x.p99} max ${x.max} | ≤1.0 s ${x.le1000} % ≤1.5 s ${x.le1500} % ≤2.0 s ${x.le2000} % ≤3.0 s ${x.le3000} % ≤5.0 s ${x.le5000} %`;
  const kv = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  const every = r.timeline.filter((_, i) => i % 3 === 0);
  return [
    `load: ${r.run.students} students (${r.run.rtc} start at webrtc, ${r.run.s2s} post to /v1/s2s, ${r.run.students - r.run.rtc - r.run.s2s} ws only, ${r.run.chrome} chrome) profile=${r.run.profile} `
      + `${REAL_GW ? `gateway ${REAL_GW} deployment ${DEP}` : `fake stack ${REPLICAS} replicas × ${CAP} sessions`}, ${r.run.durationS} s each + ${r.run.rampS} s ramp, turn every ${r.run.turnEveryS}±${r.run.jitterS} s`,
    `turns: ${r.turns.attempted} attempted, ${r.turns.ok} ok, ${r.turns.failed} failed (${r.turns.failurePct} %), ${r.turns.truncated} truncated (${r.turns.truncationPct} %) — ${kv(r.turns.why)}`,
    'first audio, ms from the last voiced sample sent to the first non-silent audio received (shares over all attempted turns):',
    d('all', r.firstAudioMs.all),
    ...Object.entries(r.firstAudioMs.byTransport).map(([k, x]) => d(k, x)),
    ...Object.entries(r.firstAudioMs.byReplica).map(([k, x]) => `${d(`rep ${k.slice(-8)}`, x)} (${x.students} students)`),
    ...(r.s2s ? [
      `s2s, ms from the request (the numbers above start ${r.s2s.endpointingMs} ms earlier, at the end of the speech: the page's endpointing):`,
      d('first frame', r.s2s.fromRequestMs.firstFrame), d('first loud', r.s2s.fromRequestMs.firstLoud),
      ...Object.entries(r.s2s.stageMs).map(([k, x]) => `  ${k.padEnd(14)} n=${x.n} p50 ${x.p50} p90 ${x.p90} p95 ${x.p95} p99 ${x.p99} max ${x.max}`),
      ...Object.entries(r.s2s.servedBy).map(([k, m]) => `  ${k.padEnd(14)} ${kv(m)}`),
      `  errors: ${kv(r.s2s.errors)}; refused: ${kv(r.s2s.refused)}; usage: ${kv(r.s2s.usage)}`,
    ] : []),
    ...(Object.keys(r.audible).length ? ['audible in Chrome, ms from the reference to the first loud 20 ms at the page output (received = audio_start event):'] : []),
    ...Object.entries(r.audible).map(([k, a]) => `  ${k.padEnd(11)} n=${a.audibleMs.n}/${a.turns} audible p50 ${a.audibleMs.p50} p95 ${a.audibleMs.p95} | received p50 ${a.receivedMs.p50} | heard − received p50 ${a.heardAfterReceivedMs.p50}`
      + ` | from vad end p50 ${a.audibleFromVadEndMs.p50} | lightweight p50 ${a.lightweightMs.p50} → offset ${a.offsetMs} ms (audible p10–p90 spread ${a.spreadMs} ms) | meter error ≤ p50 ${a.meterErrorMs.p50} max ${a.meterErrorMs.max} ms | no audible audio ${a.noAudibleAudio}, overlapped ${a.overlapped}`),
    `  ws first frame p50 ${r.wsFirstFrameMs.p50} p95 ${r.wsFirstFrameMs.p95}; edge's own ttfa (after its endpointing) p50 ${r.edge.ttfaMs.p50} p95 ${r.edge.ttfaMs.p95}; stt ${r.edge.sttMs.p50} llm ${r.edge.llmTtftMs.p50} tts ${r.edge.ttsTtfbMs.p50}`,
    `connect: webrtc n=${r.connect.sessionMs.webrtc.n} p50 ${r.connect.sessionMs.webrtc.p50} p95 ${r.connect.sessionMs.webrtc.p95} ms, ws n=${r.connect.sessionMs.ws.n} p50 ${r.connect.sessionMs.ws.p50} p95 ${r.connect.sessionMs.ws.p95} ms`
      + ` — attempts: ${kv(r.connect.attempts)}; ICE pairs: ${kv(r.connect.pairs)}; reconnects ${r.connect.reconnects}; never connected ${r.connect.neverConnected}`,
    `admission: ${r.admission.ok} ok (p50 ${r.admission.ms.p50} ms), rejected: ${kv(r.admission.rejected)}${r.admission.retryAfterS.length ? ` (Retry-After ${r.admission.retryAfterS.join('/')} s)` : ''}`,
    `timeline t:sessions/rejections/replicas ${every.map(b => `${b.t}:${b.sessions}/${b.rejections}/${b.replicas ?? '?'}${b.linkDown ? '↓' : ''}`).join(' ')}`,
    `generator: load avg max ${r.generator.loadAvgMax} on ${r.generator.cpus} cpus, mic frames late ${r.generator.micLatePct} % (max lag ${r.generator.micMaxLagMs} ms), uplink frames dropped ${r.generator.uplinkDropped}`
      + (r.generator.saturated ? ' — SATURATED: this machine could not keep the simulated microphones in real time, the numbers of this run are not valid' : ''),
    r.cost ? `cost: ${kv(Object.fromEntries(Object.entries(r.cost.machineHours).map(([k, v]) => [`${k} machine-h`, v])))}, €${r.cost.eur} for the run window${r.cost.unpriced ? ' (some replicas had no price)' : ''}` : 'cost: n/a (fake stack)',
    `${r.pass ? 'PASS' : 'FAIL'} ${r.checks.map(c => `${c.name} ${c.value} ${c.ok ? '≤' : '>'} ${c.limit}`).join(', ')}`,
  ].join('\n');
}

if (!PROFILES[PROFILE]) throw new Error(`unknown profile '${PROFILE}' (${Object.keys(PROFILES).join(', ')})`);
if (!LINUX_ROOT && (!REAL_GW || PROFILE !== 'clean')) throw new Error('the fake stack and every profile but clean need Linux and root (netns, tc, iptables)');
const others = Bun.spawnSync(['pgrep', '-af', 'realtime-e2e/(e2e|load)\\.ts']).stdout.toString().split('\n')
  .filter(l => /^\d+ \S*bun /.test(l) && Number(l.split(' ')[0]) !== process.pid);
if (LINUX_ROOT && others.length) throw new Error(`another realtime-e2e run is in progress: ${others.join(' | ')}`);

let exitCode = 2;
let stack: { stop: () => Promise<void> } | null = null;
let child: ReturnType<typeof Bun.spawn> | null = null;
let sampler: ReturnType<typeof setInterval> | null = null;
const samples: ReplicaSample[] = [];
const flaps: Array<{ at: number; down: boolean }> = [];
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child?.kill());
try {
  if (LINUX_ROOT) {
    writeFileSync(join(WORK, 'net-before.txt'), netState());
    netUp(PROFILE, Boolean(REAL_GW), (down) => flaps.push({ at: Date.now(), down }));
    writeFileSync(join(WORK, 'net-during.txt'), netState());
    process.env.RT_UDP_BIND = HOST_IP;
  }
  let gw = REAL_GW;
  let key = process.env.KEY ?? process.env.SANDBOX_TOKEN ?? '';
  let config = JSON.parse(process.env.RT_CONFIG ?? '{"system":"Você é a padeira da esquina. Responda curto, uma frase.","messages":[],"voice":"default","fallback_voice":"default"}');
  let view = async (): Promise<View | null> => {
    const r = await fetch(`${REAL_GW}/v1/deployments/${DEP}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5_000) });
    const body = await r.json() as View & { deployment?: View };
    return r.ok ? body.deployment ?? body : null;
  };
  if (!REAL_GW) {
    process.env.LOG_LEVEL ??= 'warn';
    const { startLocalStack } = await import('./local-stack');
    const local = await startLocalStack({
      python: process.env.EDGE_PYTHON || 'python3', work: WORK, keys: ['key-parle:parle', 'key-admin:admin'], deployment: DEP, maxSessions: CAP,
      maxTotalReplicas: REPLICAS, hostname: '0.0.0.0', realtimeEnv: { REALTIME_STUN_URLS: '' }, modelScript: join(import.meta.dir, 'fake_model.py'), log,
    });
    stack = local;
    local.startCoturn();
    await local.controller.put(DEP, { profile: 'speech-stack', minReplicas: REPLICAS, maxReplicas: REPLICAS, realtime: { maxSessions: CAP } }, { app: 'parle' });
    const ready = () => (local.controller.get(DEP)?.replicas ?? []).filter(r => r.phase === 'ready');
    await until(`${REPLICAS} ready replicas`, () => ready().length >= REPLICAS, 120_000);
    for (const r of ready()) {
      await local.cloud.edgeReady(r.id);
      await until(`${r.id} net path`, async () => (await local.cloud.edgeStatus(r.id)).net.path !== 'unknown', 60_000);
    }
    gw = `http://${HOST_IP}:${local.gwPort}`;
    key = 'key-parle';
    config = { system: 'Você é a padeira. Responda curto.', messages: [], voice: 'br-m-08' };
    view = async () => local.controller.get(DEP);
  }
  const cfg: ClientConfig = {
    gw, key, deployment: DEP, config, students: N, rtc: RTC, s2s: S2S, noWake: argv.includes('--no-wake'), chrome: CHROME,
    chromeTransports: (opt('chrome-transports') ?? 'webrtc,ws,s2s-stream').split(','), clipEndSilenceMs: num('clip-end-silence', 700), rtcProcs: num('rtc-procs', Math.ceil(RTC / 8)),
    rampS: num('ramp', 30), durationS: num('duration', 180), turnEveryS: num('turn-every', 15), jitterS: num('jitter', 5), burst: argv.includes('--burst'), clipS: num('clip-s', 1.4),
    clip: opt('clip') ?? null, turnTimeoutS: num('turn-timeout', 30), turn: (opt('turn') ?? (PROFILE === 'udp-blocked' ? 'tcp' : 'udp')) as 'udp' | 'tcp',
    python: process.env.EDGE_PYTHON || 'python3', chromePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    work: WORK, out: join(WORK, 'client.json'),
  };
  writeFileSync(join(WORK, 'client-config.json'), JSON.stringify({ ...cfg, key: '' }));
  const sample = async () => {
    const v = await view().catch(() => null);
    samples.push({ at: Date.now(), load: loadavg()[0], replicas: (v?.replicas ?? []).map(r => ({ id: r.id, phase: r.phase, state: r.providerState, machineType: r.machineType, pricePerHour: r.pricePerHour })) });
  };
  await sample();
  sampler = setInterval(() => void sample(), 2_000);
  console.log(`running ${N} students for ${cfg.rampS + cfg.durationS} s (profile ${PROFILE}); work dir ${WORK}`);
  child = Bun.spawn([...(LINUX_ROOT ? NS_EXEC : []), process.execPath, join(import.meta.dir, 'load-client.ts'), join(WORK, 'client-config.json')], { stdout: 'inherit', stderr: 'inherit', env: { ...process.env, LOAD_KEY: key } });
  await child.exited;
  clearInterval(sampler);
  await sample();
  const report = buildReport(JSON.parse(readFileSync(cfg.out, 'utf8')) as ClientResult, samples, flaps, cfg);
  writeFileSync(join(WORK, 'report.json'), JSON.stringify(report, null, 2));
  console.log(summary(report));
  console.log(`report: ${join(WORK, 'report.json')}`);
  exitCode = report.pass ? 0 : 1;
} catch (err) {
  console.log(`ERROR ${(err as Error).message}`);
  log(`ERROR ${(err as Error).stack}`);
} finally {
  if (sampler) clearInterval(sampler);
  child?.kill('SIGKILL');
  if (LINUX_ROOT) netDown();
  await stack?.stop();
  if (LINUX_ROOT) {
    writeFileSync(join(WORK, 'net-after.txt'), netState());
    const restored = readFileSync(join(WORK, 'net-before.txt'), 'utf8') === netState();
    console.log(`network: ${restored ? 'tc, iptables and netns are as before the run' : `LEFTOVER — compare ${WORK}/net-before.txt and net-after.txt`}`);
  }
  process.exit(exitCode);
}
