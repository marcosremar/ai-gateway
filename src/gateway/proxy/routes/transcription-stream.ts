/**
 * `GET /v1/audio/transcriptions/stream` — streaming STT (WebSocket) of an STT alias on its own GPU deployment: the
 * speech-stack's `/ws/audio-stream` (Whisper large-v3 float16, the caller's vocabulary prompt on every decode).
 * Contract: docs/api/stt-stream.md.
 *
 *   wss://<gateway>/v1/audio/transcriptions/stream?model=babelcast-stt&language=pt[&prompt=…][&chunk_size=1]
 *        [&window=20][&silence=0.9][&wait_ms=0]          Authorization: Bearer <app key | activation key>
 *   client → gateway  binary: Int16 LE PCM, 16 kHz mono (any frame size ≤ 256 KiB)
 *                     text:   {"type":"config","prompt":"…"|null,"language":"fr"}   (any time; a prompt ≤ 4000 chars)
 *                             {"type":"flush"}                                      (end of utterance / of the stream)
 *                             {"type":"ping"}                                       (→ {"type":"pong"})
 *   gateway → client  text:   {"type":"ready","model","provider":"deployment:<name>","engine","language","prompt_chars"}
 *                             {"type":"partial","utterance",  "text","stable","end_ms"}
 *                             {"type":"final","utterance","text","reason","start_ms","end_ms","audio_ms",…}
 *                             {"type":"config",…} (ack of a client config) · {"type":"error","code","message"}
 *
 * Admission is the batch route's (`POST /v1/audio/transcriptions`) and happens BEFORE the handshake, so every refusal is
 * a plain HTTP answer with the OpenAI-shaped error the batch route would give — the app falls back to batch on any of
 * them: the proxy's key check (401), rate limit and per-user slot (429); the device gate; the app's own aliases and
 * daily budget (`AppLimits.check`, 403 / 429); an activation key's account quota (`audioSeconds`, 402 / 429); the alias
 * must have a `deployment:` link (404 `no_streaming_backend`); a ready replica (503 `gpu_not_ready` with Retry-After —
 * a cold deployment is woken by the attempt unless no-wake applies, exactly as a batch call would); the replica must
 * answer `{"type":"ready"}` (an image without the streaming protocol: 502 `stream_unsupported`; a replica still loading
 * Whisper closes 1013: 503 `gpu_not_ready`).
 *
 * While it runs: the audio is metered as it streams (activation keys: `audioSeconds` every 15 s, so a monthly quota
 * crossed mid-stream ends it with 1008 `quota_exceeded`; the app's daily request budget: one request per started minute
 * of audio). The stream holds one lease of the replica (inflight for the autoscaler) and ends with an `error` frame and a
 * close code the client can act on: 1013 `gpu_lost` (replica gone or failed: reconnect or fall back to batch), 1008
 * (budget/quota), 1000 `idle` (no frame for `idleMs`) or `session_limit` (`maxSessionMs`), 1009 (frame too large),
 * 1002 (protocol error).
 *
 * The batch route's hallucination filter applies to every `final` (its metadata — `avg_logprob`, `no_speech_prob`,
 * `compression_ratio`, `speech_ms` — comes from the replica): an invented final arrives with `text: ""` and `filtered`
 * (reason codes, never text). Query `filter_hallucinations=false` opts out (QA), as the batch route's form field.
 */
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { DeploymentController } from '../../../deployments/controller';
import { DeploymentError, type Lease } from '../../../deployments/controller-state';
import { replicaBase } from '../../../deployments/http';
import { replicaTls } from '../../../deployments/replica-tls';
import { OP, WsFrameParser, WsProtocolError, closePayload, encodeFrame, handshakeResponse } from '../../../realtime/ws-frames';
import { defaultUpstream, type UpstreamFactory } from '../../../realtime/ws-relay';
import { outgoingTraceHeaders } from '../../../telemetry/trace-context';
import { noWakeActive, recordNoWakeSkip } from '../no-wake';
import { applySttFilter, filterEnabled, requestOptsOut } from './stt-filter';

export const STT_STREAM_PATH = '/v1/audio/transcriptions/stream';

/** PCM16 mono 16 kHz. */
const BYTES_PER_SECOND = 32_000;
const MAX_CLIENT_MESSAGE = 256 * 1024;
const MAX_UPSTREAM_TEXT = 64 * 1024;
export const MAX_QUERY_PROMPT_CHARS = 2000;
export const MAX_PROMPT_CHARS = 4000;
const MAX_WAIT_MS = 30_000;
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const KEEPALIVE_MS = 20_000;
/** Activation-key usage is recorded every this many seconds of audio (and checked against the monthly quota). */
const METER_EVERY_SECONDS = 15;
const LANGUAGE_RE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?$/;

/** A refusal: HTTP status and the OpenAI-shaped error (`AppLimitDenial` and the accounts' errors have this shape). */
export interface StreamDenial {
  status: number;
  message: string;
  type?: string;
  code?: string;
  retryAfterSeconds?: number;
}

/** Activation-key metering of one stream (src/accounts `streamMeter`). */
export interface StreamMeter {
  /** Adds streamed audio to the account; a denial (monthly quota crossed) ends the stream. */
  add(audioSeconds: number): StreamDenial | null;
  /** The stream ended: counts it as one STT request. */
  end(): void;
}

export interface StreamSummary {
  userId: string;
  model: string;
  deployment: string;
  replica: string;
  audioSeconds: number;
  durationMs: number;
  finals: number;
  closeCode: number;
  reason: string;
  from: 'client' | 'upstream' | 'gateway';
}

export interface TranscriptionStreamDeps {
  controller: Pick<DeploymentController, 'acquire'> | null;
  /** The `deployment:` links of an STT alias's chain, in order ([] = the alias has none, or is unknown). */
  deploymentsOf: (model: string) => string[];
  /** The authenticated gateway user (the proxy already refused unknown keys). */
  userOf: (req: IncomingMessage) => string | null;
  isAdmin: (userId: string) => boolean;
  /** The batch route's app limits: alias check + one request of the daily budget (`AppLimits.check(userId, 'stt', {model})`). */
  admit?: (userId: string, model: string) => StreamDenial | null;
  /** More requests of the app's daily budget while the stream runs (one per started minute of audio). */
  charge?: (userId: string, requests: number) => StreamDenial | null;
  deviceGate?: (userId: string, headers: IncomingMessage['headers']) => StreamDenial | null;
  /** Activation keys: admission against the account quota, then metering (`null` = not an activation key). */
  meter?: (req: IncomingMessage) => { denial: StreamDenial } | StreamMeter | null;
  /** Who the per-caller stream cap counts (an account, an API key); default the gateway user. Admins are never capped. */
  callerOf?: (req: IncomingMessage, userId: string) => string;
  maxStreamsPerCaller?: number;
  maxSessionMs?: number;
  idleMs?: number;
  /** Wait for a ready replica (default 0: refuse at once, the cold deployment is woken for the next attempt). */
  acquireWaitMs?: number;
  /** From the replica's socket open to its `ready` frame. */
  readyTimeoutMs?: number;
  upstream?: UpstreamFactory;
  onEnd?: (summary: StreamSummary) => void;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export const STT_STREAM_DEFAULTS = {
  maxStreamsPerCaller: 2,
  maxSessionMs: 4 * 3600_000,
  idleMs: 60_000,
  acquireWaitMs: 0,
  readyTimeoutMs: 10_000,
} as const;

const REASONS: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict',
  429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

function refusalText(d: StreamDenial): string {
  const type = d.type ?? (d.status === 400 ? 'invalid_request_error' : d.status === 401 ? 'authentication_error'
    : d.status === 403 ? 'permission_error' : d.status === 429 ? 'rate_limit_error' : 'upstream_error');
  const body = JSON.stringify({ error: { message: d.message, type, ...(d.code ? { code: d.code } : {}) } });
  const retry = d.retryAfterSeconds ? `Retry-After: ${Math.max(1, Math.ceil(d.retryAfterSeconds))}\r\n` : '';
  return `HTTP/1.1 ${d.status} ${REASONS[d.status] ?? 'Error'}\r\nContent-Type: application/json\r\n`
    + `Content-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\n${retry}Connection: close\r\n\r\n${body}`;
}

/** Close codes a peer may send on the wire (1005/1006/1015 are local-only). */
const wireCode = (code: number) => (code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 && code !== 1015 ? code : 1000);

function numberParam(url: URL, name: string, min: number, max: number): number | null | 'bad' {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 'bad';
  return Math.min(max, Math.max(min, n));
}

/** A control frame of the client, validated (`{error}` = refused: not JSON, an unknown type, a bad field). */
export function clientControl(text: string): { type: 'flush' } | { type: 'ping' } | { type: 'config'; prompt?: string | null; language?: string } | { error: string } {
  let msg: unknown;
  try { msg = JSON.parse(text); } catch { return { error: 'text frames must be JSON' }; }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { error: 'text frames must be JSON objects' };
  const m = msg as Record<string, unknown>;
  if (m.type === 'flush') return { type: 'flush' };
  if (m.type === 'ping') return { type: 'ping' };
  if (m.type !== 'config') return { error: `unknown frame type ${JSON.stringify(m.type ?? null).slice(0, 40)}` };
  const out: { type: 'config'; prompt?: string | null; language?: string } = { type: 'config' };
  if ('prompt' in m) {
    if (m.prompt !== null && typeof m.prompt !== 'string') return { error: 'config.prompt must be a string or null' };
    if (typeof m.prompt === 'string' && m.prompt.length > MAX_PROMPT_CHARS) return { error: `config.prompt is longer than ${MAX_PROMPT_CHARS} characters` };
    out.prompt = m.prompt as string | null;
  }
  if ('language' in m) {
    if (typeof m.language !== 'string' || !LANGUAGE_RE.test(m.language)) return { error: 'config.language must be a language code (pt, fr, en-US…)' };
    out.language = m.language;
  }
  return out;
}

export function createTranscriptionStream(deps: TranscriptionStreamDeps) {
  const open = deps.upstream ?? defaultUpstream;
  const log = deps.log ?? (() => {});
  const maxPerCaller = deps.maxStreamsPerCaller ?? STT_STREAM_DEFAULTS.maxStreamsPerCaller;
  const maxSessionMs = deps.maxSessionMs ?? STT_STREAM_DEFAULTS.maxSessionMs;
  const idleMs = deps.idleMs ?? STT_STREAM_DEFAULTS.idleMs;
  const readyTimeoutMs = deps.readyTimeoutMs ?? STT_STREAM_DEFAULTS.readyTimeoutMs;
  const perCaller = new Map<string, number>();
  let active = 0;

  /** The upgrade of `STT_STREAM_PATH` (false for any other path: the proxy answers 404). */
  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://gateway');
    if (url.pathname.replace(/\/$/, '') !== STT_STREAM_PATH) return false;
    socket.on('error', () => socket.destroy());
    const refuse = (d: StreamDenial) => { if (socket.writable) socket.end(refusalText(d)); else socket.destroy(); };
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
      refuse({ status: 400, message: 'not a WebSocket 13 upgrade' });
      return true;
    }
    const caller0 = deps.userOf(req);
    if (!caller0) { refuse({ status: 401, message: 'missing or invalid API key' }); return true; }
    const userId: string = caller0;
    const admin = deps.isAdmin(userId);

    // ── parameters ──────────────────────────────────────────────────────────
    const model = (url.searchParams.get('model') ?? '').trim();
    if (!model) { refuse({ status: 400, message: 'model is required (the app\'s STT alias, e.g. babelcast-stt)', code: 'missing_model' }); return true; }
    const language = url.searchParams.get('language')?.trim() || '';
    if (language && !LANGUAGE_RE.test(language)) { refuse({ status: 400, message: 'language must be a language code (pt, fr, en-US…)', code: 'invalid_language' }); return true; }
    const prompt = url.searchParams.get('prompt') ?? '';
    if (prompt.length > MAX_QUERY_PROMPT_CHARS) {
      refuse({ status: 400, message: `prompt in the URL is limited to ${MAX_QUERY_PROMPT_CHARS} characters: send a longer one in a {"type":"config"} frame`, code: 'prompt_too_long' });
      return true;
    }
    const chunk = numberParam(url, 'chunk_size', 0.2, 5);
    const window = numberParam(url, 'window', 5, 28);
    const silence = numberParam(url, 'silence', 0.3, 3);
    const waitAsked = numberParam(url, 'wait_ms', 0, MAX_WAIT_MS);
    const filterOn = filterEnabled() && !requestOptsOut(url.searchParams.get('filter_hallucinations') ?? undefined);
    if (chunk === 'bad' || window === 'bad' || silence === 'bad' || waitAsked === 'bad') {
      refuse({ status: 400, message: 'chunk_size, window, silence and wait_ms must be numbers', code: 'invalid_parameter' });
      return true;
    }

    // ── admission (same order and answers as the batch route) ───────────────
    const gated = deps.deviceGate?.(userId, req.headers);
    if (gated) { refuse(gated); return true; }
    let names: string[];
    if (model.startsWith('deployment:')) {
      if (!admin) { refuse({ status: 403, message: 'only an admin key may name a deployment; use the app\'s STT alias', code: 'permission_error' }); return true; }
      names = [model.slice('deployment:'.length)].filter(Boolean);
    } else {
      const denied = deps.admit?.(userId, model);
      if (denied) { refuse(denied); return true; }
      names = deps.deploymentsOf(model);
    }
    if (!names.length || !deps.controller) {
      refuse({ status: 404, code: 'no_streaming_backend', message: `model '${model}' has no GPU deployment that streams: use POST /v1/audio/transcriptions` });
      return true;
    }
    const metered = deps.meter?.(req) ?? null;
    if (metered && 'denial' in metered) { refuse(metered.denial); return true; }
    const meter = metered as StreamMeter | null;
    const caller = admin ? null : (deps.callerOf?.(req, userId) ?? userId);
    if (caller !== null && (perCaller.get(caller) ?? 0) >= maxPerCaller) {
      refuse({ status: 429, code: 'too_many_streams', retryAfterSeconds: 5, message: `this key already has ${maxPerCaller} transcription streams open` });
      return true;
    }
    if (caller !== null) perCaller.set(caller, (perCaller.get(caller) ?? 0) + 1);
    let callerHeld = caller !== null;
    const releaseCaller = () => {
      if (!callerHeld || caller === null) return;
      callerHeld = false;
      const n = (perCaller.get(caller) ?? 1) - 1;
      if (n > 0) perCaller.set(caller, n); else perCaller.delete(caller);
    };

    // ── a ready replica ─────────────────────────────────────────────────────
    const abort = new AbortController();
    socket.once('close', () => abort.abort());
    const waitMs = typeof waitAsked === 'number' ? waitAsked : (deps.acquireWaitMs ?? STT_STREAM_DEFAULTS.acquireWaitMs);
    let lease: Lease | null = null;
    let name = names[0]!;
    let firstError: unknown = null;
    for (const candidate of names) {
      const noWake = noWakeActive(candidate);
      try {
        lease = await deps.controller.acquire(candidate, noWake
          ? { waitMs: 0, noWake: true, stage: 'stt', signal: abort.signal }
          : { waitMs, stage: 'stt', signal: abort.signal });
        name = candidate;
        break;
      } catch (err) {
        if (noWake && err instanceof DeploymentError && err.status === 503) recordNoWakeSkip();
        firstError ??= err;
      }
    }
    if (!lease) {
      releaseCaller();
      if (abort.signal.aborted) return true;
      const e = firstError;
      const retry = e instanceof DeploymentError ? e.retryAfterSeconds : undefined;
      refuse({
        status: 503, code: 'gpu_not_ready', type: 'provider_unavailable', retryAfterSeconds: retry ?? 30,
        message: `the GPU for '${model}' is not ready (${e instanceof Error ? e.message : String(e)}): use POST /v1/audio/transcriptions meanwhile`,
      });
      return true;
    }
    if (socket.destroyed) { lease.done('cancelled'); releaseCaller(); return true; }

    // ── the replica's /ws/audio-stream ──────────────────────────────────────
    const q = new URLSearchParams({ segments: '1' });
    if (language) q.set('language', language);
    if (typeof chunk === 'number') q.set('chunk_size', String(chunk));
    if (typeof window === 'number') q.set('window', String(window));
    if (typeof silence === 'number') q.set('silence', String(silence));
    const target = `${replicaBase(lease.machine, lease.exposed).replace(/^http/, 'ws')}/ws/audio-stream?${q}`;
    let upstream: ReturnType<UpstreamFactory>;
    try {
      upstream = open(target, { ...outgoingTraceHeaders(), 'X-Aigw-Token': lease.token }, replicaTls(target, lease.token).tls);
    } catch (err) {
      lease.done(true);
      releaseCaller();
      refuse({ status: 502, code: 'replica_unreachable', message: `the GPU replica is unreachable: ${(err as Error).message}` });
      return true;
    }
    upstream.binaryType = 'arraybuffer';
    (socket as { setTimeout?: (ms: number) => void }).setTimeout?.(0);
    (socket as { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true);

    const startedAt = Date.now();
    const heldLease = lease;
    let phase: 'connecting' | 'opened' | 'streaming' | 'closed' = 'connecting';
    let upstreamOpen = false;
    let audioBytes = 0;
    let meteredSeconds = 0;
    let chargedMinutes = 1; // the admission charged the first minute
    let finals = 0;
    let lastClientFrame = Date.now();
    let gatewayAcks = 0;
    let paused = false;
    let drainTimer: ReturnType<typeof setInterval> | null = null;
    let tick: ReturnType<typeof setInterval> | null = null;
    const early: Buffer[] = head.length ? [Buffer.from(head)] : [];
    const collectEarly = (c: Buffer) => { early.push(c); };
    socket.on('data', collectEarly);
    const parser = new WsFrameParser(MAX_CLIENT_MESSAGE);

    const release = (outcome: Parameters<Lease['done']>[0]) => {
      heldLease.done(outcome);
      releaseCaller();
    };
    const fail = (d: StreamDenial, outcome: Parameters<Lease['done']>[0]) => {
      if (phase !== 'connecting' && phase !== 'opened') return;
      phase = 'closed';
      clearTimeout(readyTimer);
      try { upstream.close(); } catch { /* not open */ }
      release(outcome);
      log('stt stream: refused by the replica', { deployment: name, replica: heldLease.machine.id, status: d.status, code: d.code });
      refuse(d);
    };
    const readyTimer = setTimeout(() => {
      if (!upstreamOpen) {
        fail({ status: 504, code: 'gpu_timeout', retryAfterSeconds: 5, message: 'the GPU replica did not accept the stream in time' }, 'timeout');
      } else {
        fail({ status: 502, code: 'stream_unsupported', message: 'the GPU replica does not speak the streaming protocol (its speech-stack image predates it): use POST /v1/audio/transcriptions' }, false);
      }
    }, readyTimeoutMs);
    heldLease.signal?.addEventListener('abort', () => {
      if (phase === 'streaming') shutdown(1013, 'gpu_lost', 'the GPU replica was released', 'upstream', true);
      else fail({ status: 503, code: 'gpu_not_ready', retryAfterSeconds: 30, message: 'the GPU replica was released' }, 'cancelled');
    }, { once: true });

    const toClient = (opcode: number, payload: Uint8Array) => {
      if (phase === 'closed' || !socket.writable) return;
      socket.write(encodeFrame(opcode, payload));
    };
    const sendJson = (msg: Record<string, unknown>) => toClient(OP.text, Buffer.from(JSON.stringify(msg), 'utf8'));
    const sendUp = (data: string | Uint8Array) => {
      try { upstream.send(data); } catch {
        if (phase === 'streaming') shutdown(1013, 'gpu_lost', 'the connection to the GPU replica failed', 'upstream', true);
        else fail({ status: 502, code: 'replica_unreachable', message: 'the GPU replica is unreachable' }, true);
      }
    };

    function shutdown(code: number, errorCode: string | null, reason: string, from: StreamSummary['from'], failed = false): void {
      if (phase === 'closed') return;
      if (phase !== 'streaming') {
        fail({ status: 502, code: errorCode ?? 'replica_refused', message: reason }, failed);
        return;
      }
      const wasStreaming = true;
      if (errorCode && wasStreaming) sendJson({ type: 'error', code: errorCode, message: reason });
      phase = 'closed';
      if (wasStreaming) active--;
      clearTimeout(readyTimer);
      if (drainTimer) clearInterval(drainTimer);
      if (tick) clearInterval(tick);
      if (from !== 'upstream') { try { upstream.close(1000, 'client closed'); } catch { /* gone */ } }
      if (socket.writable) socket.write(encodeFrame(OP.close, closePayload(wireCode(code), (errorCode ?? reason).slice(0, 120))));
      socket.end();
      setTimeout(() => socket.destroy(), 1_000).unref?.();
      release(failed ? true : false);
      meterNow();
      meter?.end();
      const summary: StreamSummary = {
        userId, model, deployment: name, replica: heldLease.machine.id, audioSeconds: Math.round(audioBytes / BYTES_PER_SECOND * 10) / 10,
        durationMs: Date.now() - startedAt, finals, closeCode: code, reason: errorCode ?? reason, from,
      };
      log('stt stream: closed', { ...summary });
      try { deps.onEnd?.(summary); } catch { /* telemetry must not break the close */ }
    }

    /** Records the audio streamed since the last record; returns a denial when the account's quota is now over. */
    function meterNow(): StreamDenial | null {
      const seconds = audioBytes / BYTES_PER_SECOND;
      let denial: StreamDenial | null = null;
      if (meter && seconds - meteredSeconds > 0) {
        denial = meter.add(seconds - meteredSeconds);
        meteredSeconds = seconds;
      }
      return denial;
    }

    function checkUsage(): void {
      const seconds = audioBytes / BYTES_PER_SECOND;
      if (seconds - meteredSeconds >= METER_EVERY_SECONDS) {
        const denial = meterNow();
        if (denial) { shutdown(1008, denial.code ?? 'quota_exceeded', denial.message, 'gateway'); return; }
      }
      const minutes = Math.ceil(seconds / 60);
      if (minutes > chargedMinutes && deps.charge && !admin) {
        const denial = deps.charge(userId, minutes - chargedMinutes);
        chargedMinutes = minutes;
        if (denial) shutdown(1008, denial.code ?? 'daily_budget_exhausted', denial.message, 'gateway');
      }
    }

    const onClientData = (chunkIn: Buffer) => {
      let messages;
      try { messages = parser.push(chunkIn); } catch (err) {
        const code = err instanceof WsProtocolError ? err.code : 1002;
        shutdown(code, code === 1009 ? 'frame_too_large' : 'protocol_error', (err as Error).message, 'gateway');
        return;
      }
      for (const m of messages) {
        if (phase !== 'streaming') return;
        lastClientFrame = Date.now();
        if (m.kind === 'binary') {
          audioBytes += m.data.length;
          sendUp(new Uint8Array(m.data));
          checkUsage();
        } else if (m.kind === 'text') {
          const control = clientControl(m.data.toString('utf8'));
          if ('error' in control) sendJson({ type: 'error', code: 'bad_frame', message: control.error });
          else if (control.type === 'ping') sendJson({ type: 'pong' });
          else sendUp(JSON.stringify(control));
        } else if (m.kind === 'ping') toClient(OP.pong, m.data);
        else if (m.kind === 'close') { shutdown(m.code === 1005 ? 1000 : m.code, null, m.reason || 'client closed', 'client'); return; }
      }
      if (!paused && upstream.bufferedAmount > HIGH_WATER) {
        paused = true;
        socket.pause();
        drainTimer = setInterval(() => {
          if (upstream.bufferedAmount > LOW_WATER) return;
          paused = false;
          if (drainTimer) clearInterval(drainTimer);
          drainTimer = null;
          socket.resume();
        }, 20);
      }
    };

    const startStreaming = (ready: Record<string, unknown>) => {
      phase = 'streaming';
      active++;
      clearTimeout(readyTimer);
      socket.write(handshakeResponse(key, { 'X-Gateway-Provider': `deployment:${name}` }));
      socket.off('data', collectEarly);
      socket.on('data', onClientData);
      sendJson({
        type: 'ready', model, provider: `deployment:${name}`, engine: ready.model ?? null,
        language: ready.language ?? (language || null), prompt_chars: prompt.length,
      });
      tick = setInterval(() => {
        if (Date.now() - startedAt > maxSessionMs) { shutdown(1000, 'session_limit', `streams last at most ${Math.round(maxSessionMs / 60_000)} min: reconnect`, 'gateway'); return; }
        if (Date.now() - lastClientFrame > idleMs) { shutdown(1000, 'idle', `no audio for ${Math.round(idleMs / 1000)} s`, 'gateway'); return; }
        toClient(OP.ping, new Uint8Array(0));
      }, Math.min(KEEPALIVE_MS, Math.max(1_000, Math.floor(idleMs / 2))));
      tick.unref?.();
      log('stt stream: open', { userId, model, deployment: name, replica: heldLease.machine.id, language: language || null, promptChars: prompt.length });
      for (const c of early.splice(0)) onClientData(c);
    };

    upstream.onopen = () => {
      if (phase === 'closed') return;
      upstreamOpen = true;
      phase = 'opened';
      if (prompt) {
        gatewayAcks++;
        sendUp(JSON.stringify({ type: 'config', prompt }));
      }
    };
    upstream.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return; // the replica sends text only
      if (ev.data.length > MAX_UPSTREAM_TEXT) return;
      let msg: Record<string, unknown> | null = null;
      try { msg = JSON.parse(ev.data) as Record<string, unknown>; } catch { /* forwarded as is below */ }
      if (phase === 'opened') {
        if (msg?.type === 'ready') startStreaming(msg);
        return;
      }
      if (phase !== 'streaming') return;
      if (msg?.type === 'config' && gatewayAcks > 0) { gatewayAcks--; return; }
      if (msg?.type === 'final') {
        finals++;
        if (filterOn && typeof msg.text === 'string' && msg.text) {
          const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
          const lang = typeof msg.language === 'string' ? msg.language : language || undefined;
          const applied = applySttFilter({
            text: msg.text, avg_logprob: num(msg.avg_logprob), no_speech_prob: num(msg.no_speech_prob),
            compression_ratio: num(msg.compression_ratio), speech_ms: num(msg.speech_ms),
          }, lang);
          if (applied.filtered) {
            sendJson({ ...msg, text: applied.text, filtered: applied.filtered.codes });
            return;
          }
        }
      }
      toClient(OP.text, Buffer.from(ev.data, 'utf8'));
    };
    upstream.onclose = (ev) => {
      if (phase === 'connecting' || phase === 'opened') {
        fail(ev.code === 1013
          ? { status: 503, code: 'gpu_not_ready', retryAfterSeconds: 15, message: `the GPU replica is still loading Whisper (${ev.reason || 'warming'})` }
          : { status: 502, code: 'replica_refused', message: `the GPU replica refused the stream (${ev.code})` }, ev.code === 1013 ? false : true);
        return;
      }
      shutdown(1013, 'gpu_lost', `the GPU replica closed the stream (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`, 'upstream', ev.code !== 1000);
    };
    upstream.onerror = () => {
      if (phase === 'connecting' || phase === 'opened') {
        fail({ status: 502, code: 'replica_unreachable', message: 'the GPU replica is unreachable' }, true);
        return;
      }
      shutdown(1013, 'gpu_lost', 'the connection to the GPU replica failed', 'upstream', true);
    };
    socket.on('close', () => {
      if (phase === 'streaming') shutdown(1001, null, 'client went away', 'client');
      else if (phase !== 'closed') {
        phase = 'closed';
        clearTimeout(readyTimer);
        try { upstream.close(); } catch { /* */ }
        release('cancelled');
      }
    });
    return true;
  }

  return { handleUpgrade, get active() { return active; } };
}
