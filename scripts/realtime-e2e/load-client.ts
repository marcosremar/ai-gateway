import { spawn, type ChildProcess } from 'child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import type { Browser } from 'playwright';
import { openMicPage, startAppBackend } from './app-page';
import { clip16k, concat, resample, rms, silence, tone, voiced, wav } from './clip';

export interface ClientConfig {
  gw: string; key: string; deployment: string; config: Record<string, unknown>;
  students: number; rtc: number; chrome: number; chromeTransports: string[]; clipEndSilenceMs: number; rtcProcs: number;
  rampS: number; durationS: number; turnEveryS: number; jitterS: number; burst?: boolean; clipS: number; clip: string | null; turnTimeoutS: number;
  turn: 'udp' | 'tcp'; python: string; chromePath: string; work: string; out: string;
}
export interface TurnEvent { type: string; at: number; [k: string]: unknown }
export interface Turn {
  student: number; client: 'ws' | 'rtc' | 'chrome'; transport: string | null; at: number;
  speechEnd: number | null; firstFrame: number | null; firstLoud: number | null; audioMs: number;
  events: TurnEvent[]; lost: string | null; skipped: string | null;
  overlap?: boolean; audibleMs?: number | null; receivedMs?: number | null; heardAfterReceivedMs?: number | null; audibleFromVadEndMs?: number | null; meterErrorMs?: number;
}
export interface StudentRecord {
  id: number; client: Turn['client']; startedAt: number; transport: string | null; connectMs: number | null; reconnects: number;
  admissions: Array<{ at: number; status: number; code: string; retryAfter: number | null; ms: number }>;
  attempts: Array<{ at: number; type: string; ok: boolean; ms: number; reason?: string; pair?: unknown }>;
}
export interface ClientResult {
  startedAt: number; endedAt: number; students: StudentRecord[]; turns: Turn[];
  samples: Array<{ at: number; sessions: number; webrtc: number; ws: number }>;
  mic: { frames: number; late: number; maxLagMs: number; dropped: number };
  meters: Array<{ student: number; transport: string | null; mic: unknown; output: unknown }>;
}

interface Descriptor {
  sessionId: string; token: string; iceServers?: unknown[];
  transports: Array<{ type: string; url?: string; offerUrl?: string; iceServers?: unknown[] }>;
}
interface Session {
  transport: 'webrtc' | 'ws';
  turn: Turn | null;
  lost: string | null;
  wake: (() => void) | null;
  say(): void;
  settle(): Promise<void>;
  close(): void;
}

const cfg: ClientConfig = { ...JSON.parse(readFileSync(process.argv[2], 'utf8')), key: process.env.LOAD_KEY ?? '' };
const LOG = join(cfg.work, 'client.log');
const log = (line: string) => appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
const now = () => performance.timeOrigin + performance.now();
const sleep = (ms: number) => new Promise(r => setTimeout(r, Math.max(0, ms)));
const FRAME = 320;
const FRAME_MS = 20;
const LOUD = 0.02;
const KEEP = ['type', 'state', 'final', 'code', 'empty', 'filtered', 'interrupted', 'error', 'ttfa_ms', 'stt_ms', 'llm_ttft_ms', 'tts_ttfb_ms'];
const UPLINK_BACKLOG = 64 * 1024;

const clip = cfg.clip ? clip16k(cfg.clip) : voiced(tone(cfg.clipS, 16000));
const clipS = clip.length / 16000;
function audioFrame(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(1 + FRAME * 2);
  out[0] = 0x01;
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 1);
  return out;
}
const QUIET = audioFrame(new Int16Array(FRAME));
const CLIP_FRAMES = Array.from({ length: Math.ceil(clip.length / FRAME) }, (_, i) => audioFrame(clip.subarray(i * FRAME, (i + 1) * FRAME)));
const CLIP_PCM = join(cfg.work, 'clip.pcm');
writeFileSync(CLIP_PCM, Buffer.from(clip.buffer, clip.byteOffset, clip.byteLength));

const result: ClientResult = { startedAt: now(), endedAt: 0, students: [], turns: [], samples: [], mic: { frames: 0, late: 0, maxLagMs: 0, dropped: 0 }, meters: [] };
const live = new Set<Session>();
const tickers = new Set<() => void>();
setInterval(() => { for (const tick of tickers) tick(); }, 5);

function slim(e: Record<string, unknown>, at: number): TurnEvent | null {
  if (typeof e.type !== 'string' || e.type === 'reply_delta' || e.type === 'pong' || (e.type === 'transcript' && !e.final)) return null;
  return { ...Object.fromEntries(KEEP.filter(k => k in e).map(k => [k, e[k]])), type: e.type, at, chars: typeof e.text === 'string' ? e.text.length : Number(e.chars ?? 0) };
}
function onEvent(s: Session, e: TurnEvent | null): void {
  if (!e) return;
  s.turn?.events.push(e);
  if (e.type === 'done') s.wake?.();
}
function onLost(s: Session, reason: string): void {
  if (s.lost) return;
  s.lost = reason;
  live.delete(s);
  s.wake?.();
}
const endSession = (desc: Descriptor) => void fetch(`${cfg.gw}/v1/realtime/sessions/${desc.sessionId}`, {
  method: 'DELETE', headers: { Authorization: `Bearer ${desc.token}` }, signal: AbortSignal.timeout(5_000),
}).catch(() => {});

function openWs(url: string, desc: Descriptor): Promise<Session> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    let connected = false;
    let speaking = -1;
    let sent = 0;
    let t0 = 0;
    const tick = () => {
      while (ws.readyState === 1 && t0 + sent * FRAME_MS <= now()) {
        const lag = now() - (t0 + sent * FRAME_MS);
        result.mic.frames++;
        if (lag > 2 * FRAME_MS) result.mic.late++;
        result.mic.maxLagMs = Math.max(result.mic.maxLagMs, Math.round(lag));
        const frame = speaking >= 0 ? CLIP_FRAMES[speaking++] : QUIET;
        if (ws.bufferedAmount > UPLINK_BACKLOG) result.mic.dropped++;
        else ws.send(frame);
        if (speaking >= CLIP_FRAMES.length) {
          speaking = -1;
          if (s.turn) s.turn.speechEnd = now();
        }
        sent++;
      }
    };
    const s: Session = {
      transport: 'ws', turn: null, lost: null, wake: null,
      say: () => { speaking = 0; },
      settle: async () => {},
      close: () => { tickers.delete(tick); live.delete(s); try { ws.close(1000, 'client closed'); } catch { log('ws close failed'); } endSession(desc); },
    };
    const fail = (why: string) => {
      if (connected) return onLost(s, why);
      clearTimeout(timer);
      try { ws.close(); } catch { log('ws close failed'); }
      reject(new Error(why));
    };
    const timer = setTimeout(() => fail('no ready within 6000 ms'), 6_000);
    ws.onerror = () => fail('ws error');
    ws.onclose = (e) => { tickers.delete(tick); fail(`ws closed (${e.code})`); };
    ws.onmessage = (m) => {
      const at = now();
      if (typeof m.data === 'string') {
        const e = JSON.parse(m.data) as Record<string, unknown>;
        if (e.type === 'ready' && !connected) {
          connected = true;
          clearTimeout(timer);
          t0 = now();
          tickers.add(tick);
          resolve(s);
        }
        return onEvent(s, slim(e, at));
      }
      const t = s.turn;
      const data = m.data as ArrayBuffer;
      if (!t || t.speechEnd === null || new Uint8Array(data, 0, 1)[0] !== 0x01) return;
      t.firstFrame ??= at;
      t.audioMs += (data.byteLength - 1) / 48;
      if (t.firstLoud === null && rms(new Int16Array(data.slice(1, 1 + ((data.byteLength - 1) & ~1)))) > LOUD) t.firstLoud = at;
    };
  });
}

type RtcMessage = { id: number; ev: string; t: number; [k: string]: unknown };
const rtcProcs: ChildProcess[] = [];
const rtcHandlers = new Map<number, (m: RtcMessage) => void>();
let rtcSeq = 0;
function rtcSend(id: number, msg: Record<string, unknown>): void {
  rtcProcs[id % rtcProcs.length].stdin!.write(`${JSON.stringify({ ...msg, id })}\n`);
}
function startRtcProcs(): void {
  for (let i = 0; i < (cfg.rtc > 0 ? cfg.rtcProcs : 0); i++) {
    const p = spawn(cfg.python, [join(import.meta.dir, 'load_rtc.py'), CLIP_PCM], { stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: p.stdout! }).on('line', (line) => {
      if (!line.startsWith('{')) return log(`[rtc ${i}] ${line}`);
      const m = JSON.parse(line) as RtcMessage;
      rtcHandlers.get(m.id)?.(m);
    });
    createInterface({ input: p.stderr! }).on('line', (line) => log(`[rtc ${i}] ${line}`));
    rtcProcs.push(p);
  }
}

function openRtc(offer: Descriptor['transports'][number], desc: Descriptor, attempt: StudentRecord['attempts'][number]): Promise<Session> {
  return new Promise((resolve, reject) => {
    const id = rtcSeq++;
    let audio: ((m: RtcMessage) => void) | null = null;
    const s: Session = {
      transport: 'webrtc', turn: null, lost: null, wake: null,
      say: () => rtcSend(id, { op: 'say' }),
      settle: async () => {
        await sleep(400);
        const m = await new Promise<RtcMessage | null>((got) => { audio = got; rtcSend(id, { op: 'audio' }); setTimeout(() => got(null), 1_000); });
        if (s.turn && m && typeof m.first === 'number' && typeof m.last === 'number') s.turn.audioMs = m.last - m.first + FRAME_MS;
      },
      close: () => { live.delete(s); rtcHandlers.delete(id); rtcSend(id, { op: 'close' }); endSession(desc); },
    };
    const timer = setTimeout(() => { rtcHandlers.delete(id); rtcSend(id, { op: 'close' }); reject(new Error('worker: no answer within 12 s')); }, 12_000);
    rtcHandlers.set(id, (m) => {
      if (m.ev === 'connected') { clearTimeout(timer); attempt.pair = m.pair; resolve(s); }
      else if (m.ev === 'failed') { clearTimeout(timer); rtcHandlers.delete(id); reject(new Error(`${String(m.stage)}: ${String(m.error)}`)); }
      else if (m.ev === 'event') onEvent(s, slim(m.event as Record<string, unknown>, m.t));
      else if (m.ev === 'speech_end') { if (s.turn) s.turn.speechEnd = m.t; }
      else if (m.ev === 'loud') { if (s.turn && s.turn.speechEnd !== null) s.turn.firstLoud ??= m.t; }
      else if (m.ev === 'audio') audio?.(m);
      else if (m.ev === 'lost') onLost(s, String(m.reason));
    });
    rtcSend(id, { op: 'open', offerUrl: offer.offerUrl, token: desc.token, iceServers: offer.iceServers ?? desc.iceServers ?? [], turn: cfg.turn });
  });
}

async function connect(rec: StudentRecord): Promise<{ session: Session } | { why: string; retryMs: number }> {
  const want = rec.client === 'rtc' ? ['webrtc', 'ws'] : ['ws'];
  const t0 = now();
  let status = 0;
  let code = 'network';
  let retryAfter: number | null = null;
  let desc: Descriptor | null = null;
  try {
    const r = await fetch(`${cfg.gw}/v1/realtime/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ config: { ...cfg.config, deployment: cfg.deployment }, transports: want }), signal: AbortSignal.timeout(10_000),
    });
    const body = await r.json().catch(() => null) as (Descriptor & { error?: { code?: string } | string; code?: string }) | null;
    status = r.status;
    retryAfter = Number(r.headers.get('retry-after')) || null;
    code = r.ok ? 'ok' : String((typeof body?.error === 'object' ? body.error.code : null) ?? body?.code ?? r.status);
    if (r.ok) desc = body;
  } catch (err) {
    code = (err as Error).name === 'TimeoutError' ? 'timeout' : 'network';
  }
  rec.admissions.push({ at: t0, status, code, retryAfter, ms: Math.round(now() - t0) });
  if (!desc) return { why: `admission:${code}`, retryMs: Math.min(Math.max(retryAfter ?? 2, 1), 30) * 1000 };
  let why = 'connect:no transport offered';
  for (const type of want) {
    const offer = desc.transports.find(t => t.type === type);
    if (!offer) continue;
    const attempt: StudentRecord['attempts'][number] = { at: now(), type, ok: false, ms: 0 };
    rec.attempts.push(attempt);
    try {
      const session = type === 'webrtc' ? await openRtc(offer, desc, attempt) : await openWs(offer.url!, desc);
      attempt.ok = true;
      attempt.ms = Math.round(now() - attempt.at);
      rec.transport = type;
      rec.connectMs ??= Math.round(now() - t0);
      live.add(session);
      return { session };
    } catch (err) {
      attempt.ms = Math.round(now() - attempt.at);
      attempt.reason = (err as Error).message;
      why = `connect:${type}:${attempt.reason}`;
    }
  }
  endSession(desc);
  return { why, retryMs: 2_000 };
}

async function speak(session: Session, turn: Turn): Promise<void> {
  session.turn = turn;
  turn.transport = session.transport;
  session.say();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, (clipS + cfg.turnTimeoutS) * 1000);
    session.wake = () => { clearTimeout(timer); resolve(); };
  });
  session.wake = null;
  if (turn.events.some(e => e.type === 'done')) await session.settle();
  turn.lost = session.lost;
  session.turn = null;
}

async function student(id: number): Promise<void> {
  const rec: StudentRecord = { id, client: id < cfg.rtc ? 'rtc' : 'ws', startedAt: 0, transport: null, connectMs: null, reconnects: 0, admissions: [], attempts: [] };
  result.students.push(rec);
  await sleep((id / cfg.students) * cfg.rampS * 1000);
  rec.startedAt = now();
  const end = rec.startedAt + cfg.durationS * 1000;
  let session: Session | null = null;
  let why = 'connecting';
  let tried: () => void = () => {};
  const firstTry = new Promise<void>((r) => { tried = r; });
  const connector = (async () => {
    while (now() < end) {
      if (session && !session.lost) { await sleep(200); continue; }
      if (session) { session.close(); session = null; rec.reconnects++; }
      const r = await connect(rec);
      tried();
      if ('session' in r) session = r.session;
      else { why = r.why; await sleep(Math.min(r.retryMs, end - now())); }
    }
  })();
  await firstTry;
  let next = cfg.burst ? result.startedAt + (cfg.rampS + 10) * 1000 : now() + (1 + Math.random() * cfg.turnEveryS) * 1000;
  while (next + clipS * 1000 < end) {
    await sleep(next - now());
    const turn: Turn = { student: id, client: rec.client, transport: null, at: now(), speechEnd: null, firstFrame: null, firstLoud: null, audioMs: 0, events: [], lost: null, skipped: null };
    result.turns.push(turn);
    const s = session as Session | null;
    if (!s || s.lost) turn.skipped = s?.lost ? `lost:${s.lost}` : why;
    else await speak(s, turn);
    next = Math.max(next + (cfg.turnEveryS + (Math.random() * 2 - 1) * cfg.jitterS) * 1000, now() + 1_000);
  }
  await sleep(end - now());
  await connector;
  (session as Session | null)?.close();
}

const browsers: Browser[] = [];
async function chromeStudents(): Promise<void> {
  if (!cfg.chrome) return;
  const config = { ...cfg.config, deployment: cfg.deployment };
  const app = await startAppBackend({
    gw: cfg.gw, key: cfg.key, pageFile: 'page-load.js', config: () => config,
    files: { '/config.json': { type: 'application/json', body: JSON.stringify(config) }, '/clip.wav': { type: 'audio/wav', body: wav(clip, 16000) } },
  });
  const mic = join(cfg.work, 'chrome-mic.wav');
  const clip48 = resample(clip, 16000, 48000);
  writeFileSync(mic, wav(concat(silence(0.5, 48000), clip48, silence(Math.max(1, cfg.turnEveryS - 0.5 - clipS), 48000)), 48000));
  await Promise.all(Array.from({ length: cfg.chrome }, async (_, i) => {
    const id = cfg.students + i;
    const rec: StudentRecord = { id, client: 'chrome', startedAt: now(), transport: null, connectMs: null, reconnects: 0, admissions: [], attempts: [] };
    result.students.push(rec);
    try {
      const { page } = await openMicPage({ chrome: cfg.chromePath, mic, url: app.url, readyFlag: 'loadReady', log, browsers });
      const run = await page.evaluate(
        (o) => (window as unknown as { loadRun: (o: unknown) => Promise<{ transport: string | null; connectMs: number | null; attempts: StudentRecord['attempts']; error?: string; turns: Turn[]; meter: { mic: unknown; output: unknown } }> }).loadRun(o),
        {
          durationMs: (cfg.rampS + cfg.durationS) * 1000, turnTimeoutMs: cfg.turnTimeoutS * 1000, turnEveryMs: cfg.turnEveryS * 1000,
          clipEndSilenceMs: cfg.clipEndSilenceMs, transport: cfg.chromeTransports[i % cfg.chromeTransports.length] || null,
        },
      );
      rec.transport = run.transport;
      rec.connectMs = run.connectMs;
      rec.attempts = run.attempts;
      if (run.error) log(`chrome ${id}: ${run.error}`);
      result.meters.push({ student: id, transport: run.transport, ...run.meter });
      for (const t of run.turns) result.turns.push({ ...t, student: id, client: 'chrome', transport: run.transport, firstFrame: null, lost: null, skipped: null });
    } catch (err) {
      log(`chrome ${id}: ${(err as Error).message}`);
      rec.attempts.push({ at: now(), type: 'chrome', ok: false, ms: 0, reason: (err as Error).message.slice(0, 120) });
    }
  }));
  app.close();
}

startRtcProcs();
const sampler = setInterval(() => {
  const sessions = [...live];
  result.samples.push({ at: now(), sessions: sessions.length, webrtc: sessions.filter(s => s.transport === 'webrtc').length, ws: sessions.filter(s => s.transport === 'ws').length });
  if (result.samples.length % 10 === 0) console.log(`  t+${Math.round((now() - result.startedAt) / 1000)}s sessions ${sessions.length} turns ${result.turns.length}`);
}, 1_000);
try {
  await Promise.all([...Array.from({ length: cfg.students }, (_, i) => student(i)), chromeStudents()]);
} finally {
  clearInterval(sampler);
  for (const b of browsers) await b.close().catch(() => {});
  for (const p of rtcProcs) { p.stdin!.end(); p.kill('SIGKILL'); }
  result.endedAt = now();
  writeFileSync(cfg.out, JSON.stringify(result));
  process.exit(0);
}
