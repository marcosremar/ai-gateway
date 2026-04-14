// ── BabelCast Gateway — Pipeline Response Encoding ───────────────────────────
// Pure functions for encoding pipeline stage results into the final response.

// ── Types ───────────────────────────────────────────────────────────────────

/** STT stage result. */
export interface SttStageResult {
  text: string;
  provider: string;
  latencyMs: number;
  serverMs: number | undefined;
  networkMs: number | undefined;
}

/** LLM stage result. */
export interface LlmStageResult {
  translatedText: string;
  provider: string;
  latencyMs: number;
}

/** TTS stage result. */
export interface TtsStageResult {
  audioB64: string;
  audioRaw?: Buffer;       // raw audio bytes (kept for binary HTTP responses)
  contentType: string;
  provider: string;
  latencyMs: number;
}

/** Full pipeline response body. */
export interface PipelineResponseBody {
  transcription: string;
  response: string;
  audio_base64: string;
  content_type: string;
  timing: Record<string, unknown>;
}

// ── Response encoder ────────────────────────────────────────────────────────

/**
 * Build the final pipeline JSON response body from individual stage results.
 */
export function encodePipelineResponse(
  stt: SttStageResult, llm: LlmStageResult, tts: TtsStageResult,
  totalMs: number, isCloneRequest: boolean,
): PipelineResponseBody {
  const usedAnyGpu = stt.provider === 'gpu' || llm.provider === 'gpu' || tts.provider === 'gpu';
  return {
    transcription: stt.text,
    response: llm.translatedText,
    audio_base64: tts.audioB64,
    content_type: tts.contentType,
    timing: {
      total_ms: totalMs, stt_ms: stt.latencyMs, llm_ms: llm.latencyMs, tts_ms: tts.latencyMs,
      used_gpu: usedAnyGpu,
      stt_provider: stt.provider, llm_provider: llm.provider, tts_provider: tts.provider || 'none',
      clone: isCloneRequest,
      ...(stt.serverMs !== undefined && { stt_server_ms: stt.serverMs, stt_network_ms: stt.networkMs }),
    },
  };
}

/**
 * Check whether the client wants raw binary audio (Accept: audio/wav or application/octet-stream).
 */
export function wantsBinaryAudio(acceptHeader: string): boolean {
  return acceptHeader.includes('audio/wav') || acceptHeader.includes('application/octet-stream');
}
