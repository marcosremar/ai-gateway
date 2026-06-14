// ── BabelCast Gateway — WebSocket Server ─────────────────────────────────────
// Bun native WS on PORT+1 + HTTP REST API on PORT. All route/handler logic
// lives in server/ws/* and server/routes/*. This file wires them together.

import { createLogger } from '../src/logger';
import { safeCatch } from '../src/safe-catch';
const log = createLogger('ws-server');

import { timingSafeEqual } from 'crypto';
import { botState, deployState, gpuHealthy, gpuModelWarmth, gpuReadinessState, gpuReadyForProduction, isStageWarm, isTtsWarm } from './state';
import { shouldPreferGpuTts } from './providers';
import { isGpuAvailable } from './state';
import { wsClients, unsubscribeDub, isBackpressured, shouldEmitLegacyProviderStatus, getWsBroadcastDropped, buildTranscriptReconnectHint } from './ws-state';
import type { BabelCastWS } from './ws-state';
import { PORT } from './config';
import { speculativeCache } from './speculative-cache';

// ── Extracted modules ────────────────────────────────────────────────────────
import {
  botAudioSource,
  setBotAudioSource,
  trySetBotAudioSource,
  setBotAudioSampleRate,
  parseBotAudioHandshake,
  BOT_AUDIO_DEFAULT_SAMPLE_RATE,
  getBotAudioChunks as _getBotAudioChunks,
  incBotAudioChunks,
  resetBotAudioChunks,
  getBotAudioBufferBytes,
  appendBotAudioChunk,
  shouldProcessBotAudio,
  clearBotAudioBuffer,
  resetBotAudioProcessing,
  processBotAudioBuffer,
  startParecCapture as _startParecCapture,
  stopParecCapture as _stopParecCapture,
} from './ws/bot-audio';
import {
  reloadStreamingSTTRouter as _reloadStreamingSTTRouter,
  sttSessions,
  sttCleanupTimer as _sttCleanupTimer,
} from './ws/streaming-stt-session';
import { handleWsCommand } from './ws/handlers';
import { openSttSession } from './ws/stt-lifecycle';
import { handleSpeechMessage } from './ws/speech-lifecycle';
import { startHttpApiServer } from './ws/http-api-server';
import { runStartupTasks, initDatabase, installFileLogger } from './ws/startup-tasks';

// ── Re-exports (stable public API consumed by bot-handlers, config-handlers, tests) ──
export const sttCleanupTimer = _sttCleanupTimer;
export function getBotAudioChunks(): number { return _getBotAudioChunks(); }
export function startParecCapture(): void { _startParecCapture(); }
export function stopParecCapture(): void { _stopParecCapture(); }
export async function reloadStreamingSTTRouter(): Promise<void> { return _reloadStreamingSTTRouter(); }
export { handleWsCommand };

type WsData = {
  id: string;
  type: 'bot' | 'stt' | 'bot-audio' | 'speech' | 'recall-audio' | 'frame-inspector';
  language?: string;
  /** Target language for STT sessions — enables auto-speculation when set. */
  speculateTarget?: string;
  /** Silence timeout before flushing accumulated STT text (ms). Default 700. */
  pauseMs?: number;
  speechConfig?: { source: string; target: string; speaker?: string };
  /** For frame-inspector: unsubscribe fn returned by subscribeFrames. */
  __unsubscribe?: () => void;
  /** True once this socket has been counted into wsConnectionCount (#403). */
  __counted?: boolean;
  /** bot-audio: true once the protocol handshake JSON has arrived (#444). */
  __handshakeSeen?: boolean;
};

/**
 * Clamp the global connection counter so it can never go negative (#403). Any
 * path where `open()` didn't run (or `close()` fires twice under a hot reload)
 * would otherwise drive the counter below zero and permanently lower effective
 * capacity. Pure helper so the clamp is unit-testable without booting Bun.
 */
export function clampConnCount(n: number): number {
  return Math.max(0, n);
}

/** Global WebSocket connection limit — prevents resource exhaustion from unlimited connections. */
const MAX_WS_TOTAL = 200;
let wsConnectionCount = 0;

/** Advertised per-type cap for bot-events clients (legacy 500-slot budget). */
export const MAX_WS_CLIENTS = 500;

/**
 * Effective bot-events client budget (#401). The bot-events `open()` checks
 * `wsClients.size >= MAX_WS_CLIENTS` (500), but the global `MAX_WS_TOTAL` (200)
 * is enforced first in `fetch`, so the 500-slot check can never fire — bot
 * clients are silently starved at 200. The real budget is the smaller of the two
 * caps; surface it so the per-type check uses the true ceiling (and operators can
 * see the advertised 500 is unreachable while the global cap is lower). Pure.
 */
export function effectiveBotEventsBudget(
  globalCap = MAX_WS_TOTAL,
  perTypeCap = MAX_WS_CLIENTS,
): number {
  return Math.min(globalCap, perTypeCap);
}

/**
 * Whether PII-adjacent recall/bot handshake metadata (bot_id, recording_id,
 * sample_rate) should be logged (#472). These fields are newline-sanitized but
 * still identifier-adjacent, so they shouldn't land in normal logs. Gate behind
 * an explicit debug flag (`AIGW_WS_DEBUG_META=1`); default off. Pure (reads env).
 */
export function shouldLogWsMetadata(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const flag = (env.AIGW_WS_DEBUG_META ?? '').toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

/**
 * Fail-closed decision for the Recall WS ingress (#473). When `RECALL_API_KEY`
 * is configured (Recall is in use) but `RECALL_WS_SECRET` is absent, the recall
 * path silently falls back to generic gateway auth — meaning any gateway-key
 * holder can stream into the recall fan-out. Returns true when the dedicated
 * recall secret must be present (i.e. fall back is NOT allowed): Recall is
 * enabled AND we're not explicitly allowing the insecure fallback. Pure.
 */
export function recallRequiresWsSecret(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const recallEnabled = Boolean((env.RECALL_API_KEY ?? '').trim());
  const allowInsecure = (env.AIGW_RECALL_ALLOW_GATEWAY_AUTH ?? '').toLowerCase();
  const insecureOk = allowInsecure === '1' || allowInsecure === 'true' || allowInsecure === 'yes';
  return recallEnabled && !insecureOk;
}

/** Versioned WS message-protocol identifier advertised on connect (#492). */
export const WS_PROTOCOL_VERSION = 1;

/**
 * Stamp the protocol version onto an outbound `connected` frame (#492). Event
 * types were implicit, so clients couldn't negotiate or detect a protocol bump.
 * Adding a `protocolVersion` field to the connect handshake lets clients branch
 * on capability. Additive (never removes caller fields). Pure.
 */
export function withProtocolVersion<T extends Record<string, unknown>>(frame: T): T & { protocolVersion: number } {
  return { ...frame, protocolVersion: WS_PROTOCOL_VERSION };
}

/**
 * Classify a parsed control message on an STT socket (#453). The message loop
 * only acts on `action: 'clear' | 'turn_complete'`; any other/malformed action
 * was silently ignored, giving the client no feedback. This returns the
 * recognized action or null so the caller can nack an unknown control message.
 * Pure (operates on an already-parsed object).
 */
export type WsControlAction = 'clear' | 'turn_complete';
export function parseWsControlAction(parsed: unknown): WsControlAction | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const action = (parsed as { action?: unknown }).action;
  if (action === 'clear' || action === 'turn_complete') return action;
  return null;
}

/** Seconds clients should wait before retrying after a connection-cap 429 (#404). */
export const WS_CONN_CAP_RETRY_AFTER_SEC = 5;

/**
 * Build the 429 response for the global connection-cap rejection (#404). The
 * previous bare "Too many connections" gave clients no backoff hint, inviting a
 * tight reconnect storm against a full pool. This adds a `Retry-After` header and
 * a JSON body carrying the limit so well-behaved clients back off. Pure (returns
 * a `Response`) so the header/body contract is unit-testable without Bun.
 */
export function buildConnCapRejection(
  limit = MAX_WS_TOTAL,
  retryAfterSec = WS_CONN_CAP_RETRY_AFTER_SEC,
): Response {
  return new Response(
    JSON.stringify({ error: 'too_many_connections', limit, retryAfter: retryAfterSec }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSec),
      },
    },
  );
}

/** Per-message byte ceiling (documented "5MB / 1009" contract). */
export const MAX_WS_MESSAGE_SIZE = 5 * 1024 * 1024;

/**
 * Byte length of an inbound WS message (#481). Binary frames already expose
 * `byteLength`, but strings were measured with `.length` (UTF-16 code units),
 * so a multibyte 5M-char string could be ~10 MB of bytes yet pass the guard.
 * Measure UTF-8 bytes for strings so the size cap is a true byte cap.
 */
export function wsMessageByteLength(msg: string | { byteLength: number }): number {
  return typeof msg === 'string' ? Buffer.byteLength(msg, 'utf8') : msg.byteLength;
}

/** True when the message exceeds the byte ceiling (#479/#481). */
export function exceedsWsMessageLimit(msg: string | { byteLength: number }, limit = MAX_WS_MESSAGE_SIZE): boolean {
  return wsMessageByteLength(msg) > limit;
}

/** A 1009 close reason the client can parse to learn the byte limit (#480). */
export function wsTooLargeCloseReason(limit = MAX_WS_MESSAGE_SIZE): string {
  return `Message too large (max ${limit} bytes)`;
}

/**
 * Normalize an inbound WS frame to a Buffer exactly once (#445). The relay paths
 * did `Buffer.isBuffer(msg) ? msg : Buffer.from(msg)` and then handled the bytes
 * again; for `Uint8Array`/`ArrayBuffer` payloads this risks double-copying. This
 * single helper returns the existing Buffer untouched, or wraps a view without
 * copying when possible. Pure.
 */
export function toFrameBuffer(msg: string | Buffer | ArrayBuffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(msg)) return msg;
  if (typeof msg === 'string') return Buffer.from(msg);
  if (msg instanceof Uint8Array) return Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength);
  return Buffer.from(msg as ArrayBuffer);
}

/**
 * Format a structured close-code log line for a disconnecting socket (#494).
 * `close()` only logged the id, so idle-timeout vs backpressure-close vs
 * client-leave were indistinguishable in the logs. This emits the id, type,
 * numeric close code, and (sanitized, length-capped) reason. Pure → easy to test.
 */
export function formatWsCloseLog(
  id: string,
  type: string,
  code?: number,
  reason?: string,
): string {
  const safeReason = (reason ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 120);
  return `[ws] close id=${id} type=${type} code=${code ?? 'n/a'}${safeReason ? ` reason="${safeReason}"` : ''}`;
}

/**
 * A live snapshot of WS connection counters for `/metrics` / debugging (#489).
 * These gauges were not exported anywhere, so operators couldn't see leaks or
 * backpressure drops. Now also surfaces the broadcast-drop counter (#490) so a
 * silent audio/status gap caused by a saturated subscriber is diagnosable
 * instead of invisible. Pure read of the current counts.
 */
export function getWsConnectionStats(): {
  total: number;
  max: number;
  botEvents: number;
  sttSessions: number;
  broadcastDropped: number;
} {
  return {
    total: wsConnectionCount,
    max: MAX_WS_TOTAL,
    botEvents: wsClients.size,
    sttSessions: sttSessions.size,
    broadcastDropped: getWsBroadcastDropped(),
  };
}

/** Known WS endpoint paths → the `WsData.type` they upgrade to (#413). */
const WS_PATH_TYPES: Record<string, WsData['type']> = {
  '/v1/speech/ws': 'speech',
  '/v1/stt/stream': 'stt',
  '/ws/bot-audio': 'bot-audio',
  '/v1/observability/frames': 'frame-inspector',
};

/**
 * Classify a WS upgrade path. Returns the connection type for a known endpoint,
 * `'bot'` for the bot-events root (`/` or `/ws`), or null for an unknown path
 * so the caller can 404 instead of silently upgrading a typo to a bot-events
 * client that consumes a slot while doing nothing (#413).
 */
export function classifyWsPath(pathname: string): WsData['type'] | null {
  if (pathname in WS_PATH_TYPES) return WS_PATH_TYPES[pathname];
  if (pathname === '/' || pathname === '' || pathname === '/ws' || pathname === '/v1/events') return 'bot';
  return null;
}

/**
 * Resolve the STT silence-flush window from a raw query value (#455). Clamped
 * to [50, 30000] ms with a 700 ms default; returned so the server can echo the
 * effective value back to the client (a client sending pause_ms=0 otherwise
 * silently gets 700).
 */
export function resolvePauseMs(raw: string | null | undefined): number {
  const parsed = parseInt(raw ?? '', 10);
  const v = Number.isFinite(parsed) ? parsed : 700;
  return Math.max(50, Math.min(30_000, v || 700));
}

/**
 * Validate critical configuration at startup and return warnings.
 * Non-fatal: the server still starts, but operators get prominent log lines
 * so they know what's missing.
 */
export function validateStartupConfig(): string[] {
  const warnings: string[] = [];

  if (!process.env.RUNPOD_API_KEY && !process.env.VAST_API_KEY && !process.env.TENSORDOCK_API_KEY) {
    warnings.push('No GPU provider API keys configured (RUNPOD_API_KEY, VAST_API_KEY, TENSORDOCK_API_KEY)');
  }
  if (!process.env.GROQ_API_KEY && !process.env.OPENAI_API_KEY) {
    warnings.push('No AI provider API keys configured (GROQ_API_KEY, OPENAI_API_KEY)');
  }
  if (!process.env.DAILY_BUDGET_USD) {
    warnings.push('DAILY_BUDGET_USD not set — no spending limit. Set to prevent runaway costs.');
  }
  if (!process.env.GATEWAY_API_KEY) {
    warnings.push('GATEWAY_API_KEY not set — only localhost connections will be allowed.');
  }
  if (process.env.RECALL_API_KEY && !process.env.RECALL_WS_SECRET) {
    warnings.push('RECALL_API_KEY is set but RECALL_WS_SECRET is missing — Recall audio ingress will fall back to gateway auth only.');
  }

  return warnings;
}

/**
 * Extract the WS auth token, preferring the `Authorization: Bearer` header over
 * the `?token=` query param (#471). Tokens in the query string leak into proxy
 * access logs and browser history; the header is the safer channel. We still
 * accept the query param for browser WebSocket clients (which can't set headers),
 * but header wins when both are present. Returns the token plus where it came
 * from so the caller can redact / warn on query-sourced tokens. Pure.
 */
export function extractWsAuthToken(
  headerAuth: string | null | undefined,
  queryToken: string | null | undefined,
): { token: string | null; source: 'header' | 'query' | 'none' } {
  const fromHeader = headerAuth?.replace(/^Bearer\s+/i, '').trim();
  if (fromHeader) return { token: fromHeader, source: 'header' };
  const fromQuery = (queryToken ?? '').trim();
  if (fromQuery) return { token: fromQuery, source: 'query' };
  return { token: null, source: 'none' };
}

/**
 * Allowlist check for a browser-originated WS upgrade `Origin` (#478). HTTP has
 * CORS handling but the WS upgrade did not validate `Origin`, so any web page
 * holding a token could open an authenticated socket. Behavior is fail-OPEN when
 * no allowlist is configured (`AIGW_WS_ALLOWED_ORIGINS` unset/empty) so existing
 * non-browser clients and dev setups are unaffected; once an allowlist is set,
 * only listed origins (exact match, comma-separated) pass. A missing `Origin`
 * header (non-browser client) is always allowed — only browsers send it. Pure.
 */
export function isAllowedWsOrigin(
  origin: string | null | undefined,
  allowed: string | null | undefined,
): boolean {
  const list = (allowed ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (list.length === 0) return true;        // no allowlist configured → allow all
  if (!origin) return true;                  // non-browser client → no Origin to check
  return list.includes(origin.trim());
}

/** Constant-time string comparison to prevent timing attacks on auth tokens.
 *  Length mismatches are still compared in constant time (against a padded
 *  copy of `b`) so the response time doesn't leak the expected token length.
 *  Exported so the recall-token path reuses the same padded compare rather than
 *  a fast-returning `===` that leaks the empty/short case (#476).
 */
export function safeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) {
    try {
      timingSafeEqual(Buffer.from(a.padEnd(b.length, '\0')), Buffer.from(b.padEnd(a.length, '\0')));
    } catch { /* no-op */ }
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch { return false; }
}

function isLoopbackAddress(address: string): boolean {
  // Accept the full 127.0.0.0/8 range per RFC 1122, plus IPv6 loopback and
  // IPv4-mapped IPv6 loopback addresses (e.g. ::ffff:127.0.0.x).
  if (address === '::1') return true;
  if (address === '0:0:0:0:0:0:0:1') return true;
  const v4Mapped = address.match(/^::ffff:(.+)$/i);
  if (v4Mapped) return isLoopbackAddress(v4Mapped[1]);
  return address.startsWith('127.');
}

function isGatewayWsAuthorized(
  req: Request,
  server: import('bun').Server<WsData>,
  overrideToken?: string | null,
): boolean {
  const expectedToken = process.env.GATEWAY_API_KEY;
  const authToken = overrideToken ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (expectedToken) {
    return Boolean(authToken) && safeCompare(authToken, expectedToken);
  }
  const remoteAddr = server.requestIP(req)?.address || '';
  return isLoopbackAddress(remoteAddr);
}

/** Send the initial gpu:status snapshot on a fresh bot events connection. */
function sendInitialGpuStatus(ws: import('bun').ServerWebSocket<WsData>): void {
  const _gpuStatus = deployState.status === 'ready' && gpuHealthy ? 'ready'
    : deployState.status === 'error' ? 'error'
    : deployState.status !== 'idle' ? 'booting'
    : 'offline';
  const _gpuAvail = isGpuAvailable();
  const _tier = (_gpuStatus === 'ready' && _gpuAvail) ? 'gpu' : 'cloud';
  const _sttGpu = _gpuAvail && isStageWarm('stt');
  const _llmGpu = _gpuAvail && isStageWarm('llm');
  const _ttsGpu = _gpuAvail && shouldPreferGpuTts();
  ws.send(JSON.stringify({
    type: 'gpu:status',
    gpuStatus: _gpuStatus,
    tier: _tier,
    reason: deployState.message || 'Current status',
    endpoint: deployState.endpoint || null,
    gpuType: deployState.gpuType || null,
    modelWarmth: { stt: gpuModelWarmth.stt.warm, llm: gpuModelWarmth.llm.warm, tts: isTtsWarm() },
    pipelineRouting: _gpuAvail ? {
      stt: _sttGpu ? 'gpu' : 'cloud',
      llm: _llmGpu ? 'gpu' : 'cloud',
      tts: _ttsGpu ? 'gpu' : 'cloud',
      mode: (_sttGpu && _llmGpu && _ttsGpu) ? 'atomic-gpu' : (_sttGpu || _llmGpu || _ttsGpu) ? 'hybrid' : 'cloud',
    } : null,
    readiness: {
      phase: gpuReadinessState.condemned ? 'condemned'
        : gpuReadyForProduction ? 'production'
        : gpuReadinessState.shadowPhase ? 'shadow'
        : deployState.status === 'ready' ? 'benchmarking'
        : 'idle',
      shadowRuns: gpuReadinessState.shadowCompletedRuns,
    },
  }));
  // Legacy provider:status for Python app backward compat — gated so newer
  // fleets can drop the duplicate connect frame too (#493).
  if (shouldEmitLegacyProviderStatus()) {
    ws.send(JSON.stringify({ type: 'provider:status', gpu: _gpuStatus, tier: _tier, reason: deployState.message || 'Current status' }));
  }
  // Tell a (re)connecting client the current transcript cursor so it can resume
  // a delta instead of missing or duplicating transcripts on reconnect (#491).
  try { ws.send(JSON.stringify(buildTranscriptReconnectHint())); } catch { /* socket closing */ }
  log.log(`[ws] Client connected id=${ws.data.id} (total=${wsClients.size}), sent gpu:status gpu=${_gpuStatus} tier=${_tier}`);
}

export async function startWsServer(): Promise<number> {
  installFileLogger();

  // ── Single-instance PID lock + orphan deploy detection ────────────────────
  // Protects ~/.babelcast/ state from concurrent writes when the operator is
  // iterating on the dev repo and restarting the server mid-deploy.
  const { acquirePidLock, detectOrphanDeployOnBoot } = await import('./ws/pid-lock');
  acquirePidLock();
  detectOrphanDeployOnBoot();

  // ── Startup config validation ─────────────────────────────────────────────
  const configWarnings = validateStartupConfig();
  if (configWarnings.length > 0) {
    log.warn('='.repeat(70));
    log.warn('[startup] Configuration warnings:');
    for (const w of configWarnings) {
      log.warn(`  - ${w}`);
    }
    log.warn('='.repeat(70));
  } else {
    log.log('[startup] Configuration validated — all critical env vars present.');
  }

  const WS_PORT = PORT + 1;
  Bun.serve<WsData>({
    port: WS_PORT,
    reusePort: true,
    fetch(req, server) {
      const url = new URL(req.url);

      // ── Global WS connection limit — reject before any per-session upgrade ──
      // 429 now carries Retry-After + a JSON body with the limit so a client
      // hitting a full pool backs off instead of reconnect-storming (#404).
      if (wsConnectionCount >= MAX_WS_TOTAL) {
        return buildConnCapRejection();
      }

      // ── Recall.ai audio endpoint — uses its own secret, checked before gateway auth ──
      if (url.pathname === '/recall/audio') {
        const recallSecret = process.env.RECALL_WS_SECRET?.trim() ?? '';
        const recallToken = url.searchParams.get('token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
        const recallAuthorized = recallSecret.length > 0
          ? Boolean(recallToken) && safeCompare(recallToken ?? '', recallSecret)
          : false;
        // Fail closed: when Recall is enabled but no dedicated WS secret is set,
        // do NOT silently fall back to generic gateway auth (any gateway-key
        // holder could otherwise stream into the recall fan-out) (#473).
        if (recallSecret.length === 0 && recallRequiresWsSecret()) {
          log.warn('[recall-audio] RECALL_API_KEY set but RECALL_WS_SECRET missing — refusing ingress (set the secret or AIGW_RECALL_ALLOW_GATEWAY_AUTH=1)');
          return new Response('Recall WS secret not configured', { status: 503 });
        }
        if (!recallAuthorized && !isGatewayWsAuthorized(req, server, recallToken)) {
          return new Response('Unauthorized', { status: 401 });
        }
        const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), type: 'recall-audio' } });
        if (upgraded) return;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      // ── Origin allowlist for browser-originated upgrades (#478) ──────────────
      // Fail-open when AIGW_WS_ALLOWED_ORIGINS is unset so non-browser/dev
      // clients are unaffected; only enforce once an allowlist is configured.
      if (!isAllowedWsOrigin(req.headers.get('origin'), process.env.AIGW_WS_ALLOWED_ORIGINS)) {
        return new Response('Forbidden origin', { status: 403 });
      }

      // WebSocket authentication.
      // Localhost exemption: if no GATEWAY_API_KEY is set AND connection is from localhost, allow it.
      // Prefer the Authorization header over the ?token= query param (#471) — a
      // query token lands in proxy/access logs and browser history.
      const ext = extractWsAuthToken(req.headers.get('authorization'), url.searchParams.get('token'));
      const authToken = ext.token ?? undefined;
      if (ext.source === 'query') {
        log.warn('[ws] auth token supplied via ?token= query (logged/cacheable) — prefer Authorization header');
      }
      if (!isGatewayWsAuthorized(req, server, authToken)) {
        if (!process.env.GATEWAY_API_KEY) {
          return new Response('Unauthorized — no GATEWAY_API_KEY configured, only localhost allowed', { status: 401 });
        }
        return new Response('Unauthorized', { status: 401 });
      }

      if (url.pathname === '/v1/speech/ws') {
        const source = url.searchParams.get('source') || 'fr';
        const target = url.searchParams.get('target') || 'en';
        const speaker = url.searchParams.get('speaker') || undefined;
        const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), type: 'speech', speechConfig: { source, target, speaker } } });
        if (upgraded) return;
      } else if (url.pathname === '/v1/stt/stream') {
        const language = url.searchParams.get('language') || undefined;
        const speculateTarget = url.searchParams.get('target') || undefined;
        const pauseMs = resolvePauseMs(url.searchParams.get('pause_ms'));
        const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), type: 'stt', language, speculateTarget, pauseMs } });
        if (upgraded) return;
      } else if (url.pathname === '/ws/bot-audio') {
        const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), type: 'bot-audio' } });
        if (upgraded) return;
      } else if (url.pathname === '/v1/observability/frames') {
        const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), type: 'frame-inspector' } });
        if (upgraded) return;
      } else if (classifyWsPath(url.pathname) === 'bot') {
        // Bot-events channel root only — unknown paths fall through to 404 below
        // instead of silently becoming a bot client that wastes a slot (#413).
        const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), type: 'bot' } });
        if (upgraded) return;
      } else {
        return new Response('Not found', { status: 404 });
      }
      return new Response(
        `BabelCast WebSocket gateway. Connect: ws://localhost:${WS_PORT}`,
        { status: 200, headers: { 'Content-Type': 'text/plain' } },
      );
    },
    websocket: {
      maxPayloadLength: 4 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      idleTimeout: 120,
      open(ws) {
        wsConnectionCount++;
        ws.data.__counted = true;  // gate the close() decrement on this (#403)
        if (ws.data.type === 'speech') {
          // Advertise the protocol version so clients can negotiate (#492).
          ws.send(JSON.stringify(withProtocolVersion({ type: 'connected', message: 'Speech pipeline ready. Send config JSON then binary WAV.' })));
          log.log(`[speech-ws] Client connected id=${ws.data.id}`);
        } else if (ws.data.type === 'stt') {
          openSttSession(ws);
        } else if (ws.data.type === 'bot-audio') {
          // Only one bot-audio source at a time — the buffer/relay is global.
          // Reject a second concurrent source instead of silently clobbering
          // the first (which cross-talks all sessions and breaks close cleanup).
          if (!trySetBotAudioSource(ws as unknown as BabelCastWS)) {
            log.warn(`[bot-audio] Rejecting second bot-audio source id=${ws.data.id} — one already active`);
            ws.close(1013, 'Bot audio source already connected');
            return;
          }
          log.log(`[bot-audio] Bot audio source connected id=${ws.data.id}`);
        } else if (ws.data.type === 'recall-audio') {
          log.log(`[recall-audio] Recall bot connected id=${ws.data.id}`);
          import('./recall-handlers').then(({ setRecallState }) => {
            setRecallState({ wsConnected: true, status: 'in_meeting', message: 'Recall bot streaming audio' });
          }).catch(safeCatch('ws-recall-setstate'));
        } else if (ws.data.type === 'frame-inspector') {
          // Whisker-style live frame tail. Each emitFrame() broadcast to subscribers.
          log.log(`[frame-inspector] Subscriber connected id=${ws.data.id}`);
          ws.send(JSON.stringify({ type: 'connected', message: 'Frame inspector ready' }));
          try {
            const { subscribeFrames } = require('./observers-init') as { subscribeFrames: (h: (f: unknown) => void) => () => void };
            const unsub = subscribeFrames((frame) => {
              if (ws.readyState === 1) {
                try { ws.send(JSON.stringify({ type: 'frame', frame })); } catch { /* WS may be closing */ }
              }
            });
            // If the socket already started closing during subscribe, tear the
            // subscription down now rather than leaking it until a close that may
            // not re-fire (#414).
            if (ws.readyState !== 1) {
              try { unsub(); } catch { /* no-op */ }
            } else {
              ws.data.__unsubscribe = unsub;
            }
          } catch (e) {
            log.warn('[frame-inspector] subscribeFrames not available:', e instanceof Error ? e.message : e);
          }
        } else {
          // ── Bot events session ─────────────────────────────────────
          // Use the reconciled budget (min of global + per-type cap) so the
          // check reflects the real ceiling instead of an unreachable 500 (#401).
          const budget = effectiveBotEventsBudget();
          if (wsClients.size >= budget) {
            log.warn(`[ws] Connection limit reached (${budget}) — rejecting`);
            ws.close(1013, 'Too many connections');
            return;
          }
          wsClients.add(ws as unknown as BabelCastWS);
          ws.send(JSON.stringify({
            type: 'connected',
            botStatus: botState.status,
            message: botState.message,
          }));
          sendInitialGpuStatus(ws);
        }
      },
      message(ws, msg) {
        // ── Message size guard — reject oversized payloads (byte-accurate) ──
        // Strings are measured in UTF-8 bytes, not UTF-16 code units, so a
        // multibyte payload can't sneak ~2× its char count past the cap (#481).
        // The 1009 reason carries the byte limit so clients can chunk (#480).
        if (exceedsWsMessageLimit(msg)) {
          ws.close(1009, wsTooLargeCloseReason());
          return;
        }

        if (ws.data.type === 'speech') {
          handleSpeechMessage(ws, msg);
        } else if (ws.data.type === 'stt') {
          const backend = sttSessions.get(ws.data.id);
          if (!backend) return;
          if (typeof msg === 'string') {
            try {
              const ctrl = JSON.parse(msg);
              // Classify the control action; nack anything unrecognized so a
              // client sending a typo'd action gets feedback instead of a
              // silent no-op (#453).
              const action = parseWsControlAction(ctrl);
              if (action === 'clear') {
                (backend as { clearState?: () => void }).clearState?.();
              } else if (action === 'turn_complete') {
                // Smart-Turn signal from client: client-side ONNX model
                // detected end-of-utterance. Forces immediate flush of
                // accumulated text (skip the server-side pause timer).
                // See docs/test-vad-smart-turn.html for the client model.
                const flush = (backend as { _flushAccum?: () => void })._flushAccum
                  ?? (backend as { flushAccum?: () => void }).flushAccum;
                try { flush?.(); } catch { /* no-op */ }
              } else {
                try { ws.send(JSON.stringify({ type: 'error', code: 'unknown_control', message: 'unknown STT control action' })); } catch { /* socket closing */ }
              }
            } catch { /* ignore malformed */ }
          } else {
            // Mute gate: drop chunks while bot is speaking (configurable via
            // AIGW_MUTE_STRATEGY). Prevents feedback loops on speakers and
            // honors operator turn-take strategy.
            try {
              const { shouldDropUserAudio } = require('./observers-init') as { shouldDropUserAudio: () => boolean };
              if (shouldDropUserAudio()) return;
            } catch { /* observers not loaded — fall through */ }
            try {
              backend.sendAudio(msg);
            } catch (sendErr) {
              log.warn('sendAudio failed: %s', sendErr instanceof Error ? sendErr.message : sendErr);
            }
          }
        } else if (ws.data.type === 'recall-audio') {
          if (typeof msg === 'string') {
            // Identifier-adjacent metadata (bot_id/recording_id) is gated behind
            // an explicit debug flag so it doesn't land in normal logs (#472).
            if (shouldLogWsMetadata()) {
              try {
                const meta = JSON.parse(msg) as Record<string, unknown>;
                const safeBotId = String(meta.bot_id ?? '?').replace(/[\r\n\t]/g, '_').slice(0, 80);
                const safeRecId = String(meta.recording_id ?? '?').replace(/[\r\n\t]/g, '_').slice(0, 80);
                log.log(`[recall-audio] Metadata: bot_id=${safeBotId} recording_id=${safeRecId}`);
              } catch { /* ignore */ }
            }
            return;
          }
          // Per-connection rate limit: cap recall-audio chunks at 100 msgs/sec.
          // A compromised Recall token could otherwise fan-out 4MB chunks at line
          // speed to all wsClients (O(N) amplifier).
          const now = Date.now();
          const wsRl = ws.data as unknown as { __rlWindow?: number; __rlCount?: number };
          if (!wsRl.__rlWindow || now - wsRl.__rlWindow > 1000) {
            wsRl.__rlWindow = now;
            wsRl.__rlCount = 0;
          }
          wsRl.__rlCount = (wsRl.__rlCount ?? 0) + 1;
          if (wsRl.__rlCount > 100) {
            log.warn('[recall-audio] Rate limit exceeded — closing connection');
            ws.close(1008, 'Rate limit exceeded');
            return;
          }
          const recallChunk = toFrameBuffer(msg);  // normalize once, no double-copy (#445)
          for (const client of wsClients) {
            // Drop frames for saturated viewers (same rationale as bot-audio relay).
            if (isBackpressured(client)) continue;
            try { client.send(recallChunk); } catch { wsClients.delete(client); }
          }
        } else if (ws.data.type === 'bot-audio') {
          if (typeof msg === 'string') {
            const hs = parseBotAudioHandshake(msg);
            if (hs) {
              ws.data.__handshakeSeen = true;
              log.log(`[bot-audio] Handshake: sample_rate=${hs.sampleRate}`);
              setBotAudioSampleRate(hs.sampleRate);
            } else {
              // Unexpected text on a binary audio socket — nack instead of
              // silently swallowing the frame so the client gets feedback (#486).
              try { ws.send(JSON.stringify({ type: 'error', code: 'unexpected_text', message: 'bot-audio expects binary PCM or a handshake JSON' })); } catch { /* socket closing */ }
            }
            return;
          }
          // Binary audio before the handshake: don't guess 16 kHz silently —
          // default the rate explicitly once and note it, so the WAV header and
          // STT aren't fed a mislabeled stream (#444).
          if (!ws.data.__handshakeSeen) {
            ws.data.__handshakeSeen = true;
            log.warn(`[bot-audio] Binary audio before handshake — defaulting sample_rate=${BOT_AUDIO_DEFAULT_SAMPLE_RATE} id=${ws.data.id}`);
            setBotAudioSampleRate(BOT_AUDIO_DEFAULT_SAMPLE_RATE);
          }
          const chunkCount = incBotAudioChunks();
          if (chunkCount === 1 || chunkCount % 500 === 0) {
            log.log(`[bot-audio] Relaying audio chunk #${chunkCount} (${msg.byteLength} bytes) to ${wsClients.size} clients`);
          }
          for (const client of wsClients) {
            // Drop frames for saturated viewers — buffering real-time PCM for a
            // slow client wastes RAM/bandwidth and risks a backpressure-close.
            if (isBackpressured(client)) continue;
            try { client.send(msg); } catch { wsClients.delete(client); }
          }
          const audioChunk = toFrameBuffer(msg);  // normalize once, no double-copy (#445)
          appendBotAudioChunk(audioChunk);
          if (shouldProcessBotAudio()) {
            processBotAudioBuffer().catch(e => log.warn('buffer processing failed: %s', e instanceof Error ? e.message : e));
          }
        } else {
          try {
            const raw = typeof msg === 'string' ? msg : (Buffer.isBuffer(msg) ? msg : Buffer.from(msg)).toString();
            const cmd = JSON.parse(raw) as Record<string, unknown>;
            handleWsCommand(ws as unknown as BabelCastWS, cmd).catch(err => log.error('Command error: %s', err instanceof Error ? err.message : err));
          } catch { /* ignore parse errors */ }
        }
      },
      close(ws, code, reason) {
        // Structured close-code logging so idle-timeout vs backpressure-close vs
        // client-leave are distinguishable in the logs (#494).
        log.log(formatWsCloseLog(ws.data.id, ws.data.type, code, reason));
        // Only decrement for a socket that was actually counted in open(), and
        // clamp at zero so a double-close / un-opened socket can't drive the
        // counter negative and shrink effective capacity (#403).
        if (ws.data.__counted) {
          ws.data.__counted = false;
          wsConnectionCount = clampConnCount(wsConnectionCount - 1);
        }
        speculativeCache.clear(ws.data.id);

        if (ws.data.type === 'frame-inspector') {
          try { ws.data.__unsubscribe?.(); } catch { /* no-op */ }
          log.log(`[frame-inspector] Subscriber disconnected id=${ws.data.id}`);
          return;
        }
        if (ws.data.type === 'speech') {
          log.log(`[speech-ws] Client disconnected id=${ws.data.id}`);
        } else if (ws.data.type === 'stt') {
          const backend = sttSessions.get(ws.data.id);
          // Flush any pending un-flushed text before tearing down so the last
          // utterance in shortBuf/accumulator still reaches the client (#448).
          try { (backend as any)?._flushAccum?.(); } catch { /* no-op */ }
          (backend as any)?._clearSttAccumTimer?.();
          backend?.close();
          sttSessions.delete(ws.data.id);
          log.log(`[stt-ws] Client disconnected id=${ws.data.id}`);
        } else if (ws.data.type === 'recall-audio') {
          log.log(`[recall-audio] Recall bot disconnected id=${ws.data.id}`);
          import('./recall-handlers').then(({ recallState, setRecallState }) => {
            if (recallState.wsConnected) {
              setRecallState({ wsConnected: false, status: 'ended', message: 'Recall bot disconnected' });
              setTimeout(() => {
                if (recallState.status === 'ended') setRecallState({ status: 'idle', message: '' });
              }, 5_000);
            }
          }).catch(safeCatch('ws-recall-disconnect'));
        } else if (ws.data.type === 'bot-audio') {
          // A rejected second source (see open()) also fires close() — only run
          // teardown for the socket that actually owns the global source slot,
          // otherwise we'd flush/clear the active source's buffer out from under it.
          if (botAudioSource !== ws) {
            log.log(`[bot-audio] Ignoring close for non-active bot-audio socket id=${ws.data.id}`);
            return;
          }
          setBotAudioSource(null);
          log.log(`[bot-audio] Bot audio source disconnected id=${ws.data.id} (${_getBotAudioChunks()} chunks relayed, ${getBotAudioBufferBytes()} bytes buffered)`);
          if (getBotAudioBufferBytes() >= 16000) {
            processBotAudioBuffer().catch(e => log.warn('final buffer flush failed: %s', e instanceof Error ? e.message : e));
          } else {
            clearBotAudioBuffer();
          }
          resetBotAudioChunks();
          resetBotAudioProcessing();
        } else {
          unsubscribeDub(ws.data.id);
          wsClients.delete(ws as unknown as BabelCastWS);
          log.log(`[ws] Client disconnected id=${ws.data.id} (total=${wsClients.size})`);
        }
      },
    },
  });

  initDatabase();
  startHttpApiServer();
  await runStartupTasks();

  return WS_PORT;
}

// Auto-start when run directly (bun server/ws-server.ts)
if (typeof Bun !== 'undefined' && Bun.main === import.meta.path) {
  startWsServer().then((port) => {
    log.log('Listening on WS port %d, HTTP port %d', port, PORT);
  });
}
