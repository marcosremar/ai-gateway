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
  if (audioBuffer.length === 0) {
    ws.send(JSON.stringify({ status: 'error', message: 'No audio data' }));
    return;
  }
  const config = ws.data.speechConfig || { source: 'fr', target: 'en' };
  const callbacks: PipelineCallbacks = {
    onStageStart(stage: string) {
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify({ status: 'processing', stage }));
    },
    onStageDone(stage: string, result) {
      if (ws.readyState !== 1) return;
      const data: Record<string, unknown> = { status: 'processing', stage, latencyMs: result.latencyMs, provider: result.provider };
      if (stage === 'stt' && result.text) data.transcript = result.text;
      if (stage === 'llm' && result.text) data.response = result.text;
      ws.send(JSON.stringify(data));
    },
    onAudioChunk(chunk: Buffer, _isFirst: boolean) {
      if (ws.readyState !== 1) return;
      // Skip the chunk if the client is already saturated; sending would grow
      // the per-socket buffer and trip the backpressure-close instead.
      if (isSpeechBackpressured(ws as unknown as { getBufferedAmount?: () => number })) return;
      ws.send(chunk);
    },
    onComplete(result: PipelineResult) {
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify({
        status: 'complete',
        transcript: result.transcription,
        response: result.translation,
        timing: result.timing,
      }));
    },
    onError(stage: string, error: Error) {
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify({ status: 'error', stage, message: error.message }));
    },
  };
  runStreamingPipeline(audioBuffer, {
    source: config.source, target: config.target, speaker: config.speaker,
    sessionId: ws.data.id,
  }, callbacks).catch(err => {
    if (ws.readyState !== 1) return;
    log.warn('speech pipeline error: %s', err instanceof Error ? err.message : err);
    ws.send(JSON.stringify({ status: 'error', message: err instanceof Error ? err.message : String(err) }));
  });
}
