// ── Streaming STT WebSocket session lifecycle ────────────────────────────────
// Handles open/message/close for a single /v1/stt/stream client: connects a
// backend from the STT router, accumulates partials, flushes final segments,
// and reconnects on upstream failure.

import { createLogger } from '../../src/logger';
import type { ServerWebSocket } from 'bun';
import { speculativeCache } from '../speculative-cache';
import { getLabsFlags } from '../labs-settings';
import { getSttRouter, sttSessions } from './streaming-stt-session';
import { buildSpeculativeTranslateFn } from './bot-audio';
import { emitFrame } from '../../src/observers';

const log = createLogger('stt-lifecycle');

/**
 * Whether an accumulated STT segment should be force-flushed once the max-accum
 * timer elapses (#452). The original guard only fired when the word count
 * reached the min-flush threshold, so a long monologue of short (<3-word)
 * tokens never force-flushed and latency grew unbounded. Force-flush by chars
 * too: enough words OR enough characters means we have something worth sending.
 */
export function shouldForceFlush(
  pending: string,
  minWords: number,
  minChars: number,
): boolean {
  const t = pending.trim();
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean).length;
  return words >= minWords || t.length >= minChars;
}

/** Default minimum gap (ms) between client `partial` frames (#427). */
export const STT_PARTIAL_MIN_INTERVAL_MS = 100; // ≤10 partials/sec

/**
 * Make a rate-limiter for STT `partial` frames (#427). Under fast ASR every
 * upstream result emits a client `partial` AND an observer frame (two
 * allocations/sends per token); a chatty provider can flood the socket. This
 * returns `shouldEmit(now, force)` → true at most once per `minIntervalMs`,
 * with `force` (e.g. on the final result) always allowed through so the last
 * partial of an utterance is never swallowed. Pure/closure-based, time injected
 * so it's deterministic in tests.
 */
export function makePartialThrottle(minIntervalMs = STT_PARTIAL_MIN_INTERVAL_MS) {
  let last = -Infinity;
  return function shouldEmit(now: number, force = false): boolean {
    if (force || now - last >= minIntervalMs) {
      last = now;
      return true;
    }
    return false;
  };
}

/** Max chars of accumulated STT context to re-send upstream as the prior-segment seed (#456). */
export const STT_SEED_MAX_CHARS = 600;

/**
 * Cap the prior-segment context seed sent back to the upstream STT provider
 * (#456). Each final pushes text into a rolling context (max N segments) whose
 * joined string is re-uploaded as the seed on every final; long segments make
 * that seed large and re-sent each time. Keep only the trailing `maxChars`
 * (most recent context matters most for ASR) on a word boundary. Pure.
 */
export function capSeedChars(seed: string, maxChars = STT_SEED_MAX_CHARS): string {
  if (seed.length <= maxChars) return seed;
  const tail = seed.slice(seed.length - maxChars);
  // Avoid starting mid-word: drop up to the first space so the seed begins clean.
  const sp = tail.indexOf(' ');
  return sp > 0 && sp < tail.length - 1 ? tail.slice(sp + 1) : tail;
}

/**
 * Application-level WebSocket close code used when no STT backend is available
 * (#417). A plain transport close (1000/1006) is indistinguishable from a network
 * drop; a code in the private application range (4000–4999) lets clients tell a
 * config/availability failure ("no GPU and no Fireworks key") from a flaky link
 * and avoid pointlessly reconnecting. Centralized so the value can't drift.
 */
export const STT_NO_BACKEND_CLOSE_CODE = 4002;

/**
 * Decide whether a previously-excluded STT provider set should be cleared after a
 * provider has stayed healthy long enough (#451). `excluded` only ever grows on
 * disconnect, so a provider that drops once (e.g. a GPU pod restart) and then
 * recovers is never retried for the life of the session — pinning the client to a
 * slower cloud fallback. Once the current backend has been continuously connected
 * for `minHealthyMs`, it's safe to forget past exclusions so the preferred
 * (faster) provider can be re-selected on the next reconnect. Pure/time-injected.
 */
export const STT_EXCLUSION_RESET_MS = 30_000;
export function shouldResetExclusions(
  connectedSinceMs: number,
  now: number,
  minHealthyMs = STT_EXCLUSION_RESET_MS,
): boolean {
  if (!Number.isFinite(connectedSinceMs) || connectedSinceMs <= 0) return false;
  return now - connectedSinceMs >= minHealthyMs;
}

type WsData = {
  id: string;
  type: 'bot' | 'stt' | 'bot-audio' | 'speech' | 'recall-audio' | 'frame-inspector';
  language?: string;
  speculateTarget?: string;
  pauseMs?: number;
  speechConfig?: { source: string; target: string; speaker?: string };
  __unsubscribe?: () => void;
};

/**
 * Open a streaming STT session on `ws`. Connects an upstream backend via the
 * router, registers result/disconnect hooks, and returns once the backend is
 * wired (backend.connect() is called inside).
 */
export function openSttSession(ws: ServerWebSocket<WsData>): void {
  const language = ws.data.language;
  const excluded = new Set<string>();
  // Wall-clock of the current backend's last successful connect; used to decide
  // whether a recovered provider has been healthy long enough to clear the
  // exclusion set so the preferred (faster) provider can be retried (#451).
  let connectedSince = 0;

  const connectBackend = () => {
    const backend = getSttRouter().createBackend(language, excluded);
    if (!backend) {
      ws.send(JSON.stringify({ type: 'error', code: 'no_backend', message: 'No STT backend available (no GPU and no Fireworks key)' }));
      // Application close code so clients can distinguish a config/backend
      // failure from a transport-level network drop (#417).
      ws.close(STT_NO_BACKEND_CLOSE_CODE, 'No STT backend available');
      return;
    }
    backend.onConnected = () => {
      connectedSince = Date.now();
      log.log(`[stt-ws] Backend connected: ${backend.provider} id=${ws.data.id}`);
      // Echo the effective pause window so a client that sent an out-of-range
      // (or omitted) pause_ms learns the value the server actually applied (#455).
      ws.send(JSON.stringify({ type: 'connected', provider: backend.provider, pauseMs: STT_ACCUM_TIMEOUT_MS }));
      emitFrame({ kind: 'user_speech_start', ts: Date.now(), stage: 'stt', provider: backend.provider, meta: { sessionId: ws.data.id } });
    };
    // Text accumulator: the STT backend emits the FULL running text on each
    // result (all active segments concatenated). We track the full text and a
    // "flushed" cursor so we only send the NEW (delta) portion to the client.
    //
    // Short-segment grouping: when isFinal fires but the pending text is too
    // short for a useful subtitle (<5 words / <30 chars), we hold it in
    // `shortBuf` and merge it with the next segment before flushing.
    let sttFullText = '';
    let sttFlushedLen = 0;
    let sttAccumTimer: ReturnType<typeof setTimeout> | null = null;
    let shortBuf = '';
    // Throttle intermediate `partial` frames to ≤10/s; finals always pass (#427).
    const partialThrottle = makePartialThrottle();
    const sttContext: string[] = [];
    const STT_CONTEXT_MAX = 5;
    const STT_ACCUM_TIMEOUT_MS = ws.data.pauseMs ?? 700;
    const STT_SHORT_TIMEOUT_MS = Math.max(1200, (ws.data.pauseMs ?? 700) * 2);
    const STT_MIN_FLUSH_WORDS = 3;
    const STT_MIN_FLUSH_CHARS = 20;
    const STT_MAX_ACCUM_MS = 5000;
    let sttAccumStartTime: number | null = null;

    const emitText = (text: string) => {
      if (!text || ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: 'text', text, provider: backend.provider }));
      emitFrame({ kind: 'stt_final', ts: Date.now(), stage: 'stt', provider: backend.provider, meta: { sessionId: ws.data.id, len: text.length } });
      sttContext.push(text);
      while (sttContext.length > STT_CONTEXT_MAX) sttContext.shift();
      // Cap the re-uploaded seed by chars so long segments don't bloat every
      // final's upstream payload (#456).
      (backend as any).sendSeed?.(capSeedChars(sttContext.join(' ')));
      const labs = getLabsFlags();
      if (labs.speculativeTranslation && ws.data.speculateTarget && text) {
        const srcLang = ws.data.language || 'fr';
        const tgtLang = ws.data.speculateTarget;
        const translateFn = buildSpeculativeTranslateFn(srcLang, tgtLang, 'default');
        try { speculativeCache.speculate(ws.data.id, text, translateFn); } catch (e) { log.warn('[ws] speculative translate failed:', e instanceof Error ? e.message : e); }
      }
    };

    const flushSttAccum = () => {
      if (sttAccumTimer) { clearTimeout(sttAccumTimer); sttAccumTimer = null; }
      const pending = sttFullText.slice(sttFlushedLen).trim();
      if (!pending && !shortBuf) return;
      sttFlushedLen = sttFullText.length;
      const merged = (shortBuf ? shortBuf + ' ' + pending : pending).trim();
      shortBuf = '';
      sttAccumStartTime = null;
      emitText(merged);
    };

    backend.onResult = (evt) => {
      if (ws.readyState !== 1) return;
      const newText = evt.text.trim();
      if (!newText) return;

      sttFullText = newText;
      const pending = sttFullText.slice(sttFlushedLen).trim();

      const partialText = shortBuf ? (shortBuf + ' ' + pending).trim() : (pending || newText);
      // Skip intermediate partials that arrive faster than ~10/s to cut
      // bandwidth + per-token allocations; the final partial always emits (#427).
      if (partialThrottle(Date.now(), evt.isFinal)) {
        ws.send(JSON.stringify({ type: 'partial', text: partialText, provider: evt.provider }));
        emitFrame({ kind: 'stt_partial', ts: Date.now(), stage: 'stt', provider: evt.provider, meta: { sessionId: ws.data.id, len: partialText.length } });
      }

      if (!pending) return;

      if (!sttAccumStartTime) sttAccumStartTime = Date.now();
      const accumAge = Date.now() - sttAccumStartTime;
      // Force-flush by words OR chars so a long run of short tokens can't grow
      // latency unbounded under the word-only threshold (#452).
      if (accumAge >= STT_MAX_ACCUM_MS && shouldForceFlush(pending, STT_MIN_FLUSH_WORDS, STT_MIN_FLUSH_CHARS)) {
        log.log(`[stt-ws] Max accum timeout (${accumAge}ms, ${pending.split(/\s+/).length}w/${pending.length}c) — forcing flush id=${ws.data.id}`);
        flushSttAccum();
        return;
      }

      if (evt.isFinal) {
        const combined = (shortBuf ? shortBuf + ' ' + pending : pending).trim();
        const wordCount = combined.split(/\s+/).length;
        if (wordCount >= STT_MIN_FLUSH_WORDS || combined.length >= STT_MIN_FLUSH_CHARS) {
          flushSttAccum();
        } else {
          shortBuf = combined;
          sttFlushedLen = sttFullText.length;
          if (sttAccumTimer) clearTimeout(sttAccumTimer);
          sttAccumTimer = setTimeout(flushSttAccum, STT_SHORT_TIMEOUT_MS);
        }
      } else {
        if (sttAccumTimer) clearTimeout(sttAccumTimer);
        sttAccumTimer = setTimeout(flushSttAccum, STT_ACCUM_TIMEOUT_MS);
      }
    };
    backend.onDisconnected = (reason) => {
      log.log(`[stt-ws] Backend ${backend.provider} disconnected: ${reason} id=${ws.data.id}`);
      sttSessions.delete(ws.data.id);
      if (ws.readyState !== 1) return;
      if (ws.readyState === 1) {
        // If this backend had been healthy long enough, forget prior exclusions so
        // the preferred (faster) provider can be retried instead of staying pinned
        // to a slower fallback for the rest of the session (#451).
        if (shouldResetExclusions(connectedSince, Date.now()) && excluded.size > 0) {
          log.log(`[stt-ws] Provider ${backend.provider} was healthy ≥${STT_EXCLUSION_RESET_MS}ms — clearing exclusions id=${ws.data.id}`);
          excluded.clear();
        }
        connectedSince = 0;
        excluded.add(backend.provider);
        log.log(`[stt-ws] Reconnecting (excluded: ${[...excluded].join(',')}) id=${ws.data.id}`);
        try {
          connectBackend();
        } catch (e) {
          log.warn(`[stt-ws] Reconnect failed — closing client WS:`, e instanceof Error ? e.message : e);
          ws.close(1001, 'STT backend reconnect failed');
        }
      }
    };
    backend.connect();
    sttSessions.set(ws.data.id, backend);
    (backend as any)._sttAccumTimer = () => sttAccumTimer;
    (backend as any)._clearSttAccumTimer = () => { if (sttAccumTimer) { clearTimeout(sttAccumTimer); sttAccumTimer = null; } };
    // Expose flush for client-driven Smart-Turn `{action:'turn_complete'}` ctrl.
    (backend as any)._flushAccum = () => flushSttAccum();
    log.log(`[stt-ws] Client connected id=${ws.data.id} lang=${language || 'auto'} provider=${backend.provider}`);
  };
  connectBackend();
}
