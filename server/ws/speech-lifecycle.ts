// ── /v1/speech/ws WebSocket session lifecycle ────────────────────────────────
// First message: JSON config {source, target, speaker?}. Subsequent binary
// messages are WAV audio → full STT→LLM→TTS pipeline with streaming callbacks.

import { createLogger } from '../../src/logger';
import type { ServerWebSocket } from 'bun';
import { runStreamingPipeline } from '../pipeline-runner';
import type { PipelineCallbacks, PipelineResult } from '../pipeline-runner';

const log = createLogger('speech-lifecycle');

/**
 * Per-socket buffered-bytes ceiling for outbound audio. With
 * `closeOnBackpressureLimit: true`, a slow client whose buffer keeps growing
 * gets force-disconnected mid-stream. Dropping a late audio chunk degrades
 * gracefully (a brief gap) instead of killing the whole session.
 */
export const SPEECH_AUDIO_BACKPRESSURE_BYTES = 2 * 1024 * 1024;

/** True when the socket's buffered bytes are at/over the audio ceiling. */
export function isSpeechBackpressured(
  ws: { getBufferedAmount?: () => number },
  limit = SPEECH_AUDIO_BACKPRESSURE_BYTES,
): boolean {
  return (ws.getBufferedAmount?.() ?? 0) >= limit;
}

/** Smallest WAV file: 44-byte RIFF header + at least one 16-bit mono sample. */
const MIN_WAV_BYTES = 44;

/**
 * Cheap pre-pipeline framing validation for inbound speech audio (#441).
 * Previously only `length === 0` was rejected, so a truncated or odd-length PCM
 * buffer (16-bit samples must be byte-pairs) or a buffer that claims to be a
 * RIFF/WAV file but is shorter than a header reached STT and burned a full
 * pipeline run. Returns a reason string when the buffer is unusable, else null.
 */
export function validateSpeechAudio(buf: Buffer): string | null {
  if (buf.length === 0) return 'No audio data';
  const hasRiff = buf.length >= 4 && buf.toString('latin1', 0, 4) === 'RIFF';
  if (hasRiff) {
    if (buf.length < MIN_WAV_BYTES) return 'Truncated WAV (shorter than 44-byte header)';
    return null; // header present and plausibly complete
  }
  // Raw 16-bit PCM: an odd byte count means a split sample → corrupt framing.
  if (buf.length % 2 !== 0) return 'PCM buffer not aligned to 16-bit samples';
  return null;
}

/**
 * True when a completed pipeline produced no transcription (#458). `onComplete`
 * always reports `status:'complete'`, so a client can't tell genuine silence
 * (mic muted, background noise filtered) from a real translation without this
 * flag. Treats a missing or whitespace-only transcription as no-speech. Pure.
 */
export function isNoSpeechResult(transcription: string | null | undefined): boolean {
  return !transcription || transcription.trim().length === 0;
}

/**
 * Guarded send for speech-ws callbacks (#459). Each callback checks
 * `readyState === 1` before sending, but the socket can still close between that
 * check and the actual `ws.send`, so an un-guarded send can throw on the late
 * frame and reject the pipeline promise. This re-checks readyState AND swallows a
 * send throw, returning whether the payload was actually sent. The STT path
 * already wraps its sends; this brings the speech path to parity.
 */
export function safeWsSend(
  ws: { readyState: number; send: (data: string | Buffer) => unknown },
  payload: string | Buffer,
): boolean {
  if (ws.readyState !== 1) return false;
  try { ws.send(payload); return true; } catch { return false; }
}

type WsData = {
  id: string;
  type: 'bot' | 'stt' | 'bot-audio' | 'speech' | 'recall-audio' | 'frame-inspector';
  speechConfig?: { source: string; target: string; speaker?: string };
  __unsubscribe?: () => void;
};

/** Handle a single inbound message on a /v1/speech/ws client. */
export function handleSpeechMessage(
  ws: ServerWebSocket<WsData>,
  msg: string | Buffer | Uint8Array,
): void {
  if (typeof msg === 'string') {
    try {
      const parsed = JSON.parse(msg) as Record<string, unknown>;
      if (parsed.type === 'config') {
        ws.data.speechConfig = {
          source: (parsed.source as string) || ws.data.speechConfig?.source || 'fr',
          target: (parsed.target as string) || ws.data.speechConfig?.target || 'en',
          speaker: (parsed.speaker as string) || ws.data.speechConfig?.speaker,
        };
        ws.send(JSON.stringify({ type: 'config_ack', ...ws.data.speechConfig }));
      } else if (parsed.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch { /* ignore parse errors */ }
    return;
  }

  // Binary message = WAV audio → run pipeline
  const audioBuffer = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
  const framingError = validateSpeechAudio(audioBuffer);
  if (framingError) {
    ws.send(JSON.stringify({ status: 'error', message: framingError }));
    return;
  }
  const config = ws.data.speechConfig || { source: 'fr', target: 'en' };
  // All callback sends go through safeWsSend so a socket that closes between the
  // readyState check and the send can't throw and reject the pipeline promise (#459).
  const callbacks: PipelineCallbacks = {
    onStageStart(stage: string) {
      safeWsSend(ws, JSON.stringify({ status: 'processing', stage }));
    },
    onStageDone(stage: string, result) {
      const data: Record<string, unknown> = { status: 'processing', stage, latencyMs: result.latencyMs, provider: result.provider };
      if (stage === 'stt' && result.text) data.transcript = result.text;
      if (stage === 'llm' && result.text) data.response = result.text;
      safeWsSend(ws, JSON.stringify(data));
    },
    onAudioChunk(chunk: Buffer, _isFirst: boolean) {
      if (ws.readyState !== 1) return;
      // Skip the chunk if the client is already saturated; sending would grow
      // the per-socket buffer and trip the backpressure-close instead.
      if (isSpeechBackpressured(ws as unknown as { getBufferedAmount?: () => number })) return;
      safeWsSend(ws, chunk);
    },
    onComplete(result: PipelineResult) {
      // Distinguish silence from a successful translation so clients don't treat
      // an empty transcript as an error or a real result (#458).
      const noSpeech = isNoSpeechResult(result.transcription);
      safeWsSend(ws, JSON.stringify({
        status: 'complete',
        noSpeech,
        transcript: result.transcription,
        response: result.translation,
        timing: result.timing,
      }));
    },
    onError(stage: string, error: Error) {
      safeWsSend(ws, JSON.stringify({ status: 'error', stage, message: error.message }));
    },
  };
  runStreamingPipeline(audioBuffer, {
    source: config.source, target: config.target, speaker: config.speaker,
    sessionId: ws.data.id,
  }, callbacks).catch(err => {
    log.warn('speech pipeline error: %s', err instanceof Error ? err.message : err);
    safeWsSend(ws, JSON.stringify({ status: 'error', message: err instanceof Error ? err.message : String(err) }));
  });
}
