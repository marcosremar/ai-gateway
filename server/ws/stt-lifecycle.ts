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

  const connectBackend = async () => {
    // While an async provider resolves (a deployment's replica acquire), PCM frames must not be dropped: a
    // buffering placeholder sits in the session map and drains into the real backend once it connects.
    const pendingAudio: (ArrayBuffer | Buffer)[] = [];
    sttSessions.set(ws.data.id, {
      provider: 'deployment',
      sendAudio: (pcm: ArrayBuffer | Buffer) => { if (pendingAudio.length < 512) pendingAudio.push(pcm); },
      close: () => { pendingAudio.length = 0; },
      abort: () => { pendingAudio.length = 0; },
      get isOpen() { return false; },
      get isConnecting() { return true; },
    } as unknown as import('../../src/streaming-stt').StreamingSTTBackend);

    // Async factory: a 'deployment' provider acquires a replica through the deployments controller (waking a cold
    // speech-stack and hedging to the next provider when none is ready in time).
    const backend = await getSttRouter().createBackendAsync(language, excluded);
    if (!backend || ws.readyState !== 1) {
      backend?.close();
      sttSessions.delete(ws.data.id);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', message: 'No STT backend available (no GPU and no Fireworks key)' }));
        ws.close();
      }
      return;
    }
    backend.onConnected = () => {
      if (ws.readyState !== 1) { backend.close(); return; }
      // The placeholder leaves the map only now — frames sent while the upstream socket was still opening are
      // drained into the live backend instead of dropped by sendAudio's not-open guard.
      sttSessions.set(ws.data.id, backend);
      for (const pcm of pendingAudio.splice(0)) backend.sendAudio(pcm);
      log.log(`[stt-ws] Backend connected: ${backend.provider} id=${ws.data.id}`);
      ws.send(JSON.stringify({ type: 'connected', provider: backend.provider }));
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
      (backend as any).sendSeed?.(sttContext.join(' '));
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
      ws.send(JSON.stringify({ type: 'partial', text: partialText, provider: evt.provider }));
      emitFrame({ kind: 'stt_partial', ts: Date.now(), stage: 'stt', provider: evt.provider, meta: { sessionId: ws.data.id, len: partialText.length } });

      if (!pending) return;

      if (!sttAccumStartTime) sttAccumStartTime = Date.now();
      const accumAge = Date.now() - sttAccumStartTime;
      if (accumAge >= STT_MAX_ACCUM_MS && pending.split(/\s+/).length >= STT_MIN_FLUSH_WORDS) {
        log.log(`[stt-ws] Max accum timeout (${accumAge}ms, ${pending.split(/\s+/).length}w) — forcing flush id=${ws.data.id}`);
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
        excluded.add(backend.provider);
        log.log(`[stt-ws] Reconnecting (excluded: ${[...excluded].join(',')}) id=${ws.data.id}`);
        connectBackend().catch((e) => {
          log.warn(`[stt-ws] Reconnect failed — closing client WS:`, e instanceof Error ? e.message : e);
          if (ws.readyState === 1) ws.close(1001, 'STT backend reconnect failed');
        });
      }
    };
    backend.connect();
    (backend as any)._sttAccumTimer = () => sttAccumTimer;
    (backend as any)._clearSttAccumTimer = () => { if (sttAccumTimer) { clearTimeout(sttAccumTimer); sttAccumTimer = null; } };
    // Expose flush for client-driven Smart-Turn `{action:'turn_complete'}` ctrl.
    (backend as any)._flushAccum = () => flushSttAccum();
    log.log(`[stt-ws] Client connected id=${ws.data.id} lang=${language || 'auto'} provider=${backend.provider}`);
  };
  connectBackend().catch((e) => {
    log.warn(`[stt-ws] Initial backend connect failed id=${ws.data.id}:`, e instanceof Error ? e.message : e);
    if (ws.readyState === 1) ws.close(1001, 'STT backend connect failed');
  });
}
