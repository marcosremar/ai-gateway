// ── BabelCast Gateway — Atomic Pipeline Response Builder ─────────────────────
// Pure helpers to format the `/v1/speech` atomic-pipeline result (from
// client.pipeline) into the canonical JSON response body. Extracted from
// server/ai-handlers.ts:handlePipeline.

export interface AtomicPipelineResult {
  stt: { text: string; latencyMs?: number; provider?: string };
  chat: { content: string; latencyMs?: number; provider?: string };
  tts?: {
    audio?: Buffer | Uint8Array;
    contentType?: string;
    latencyMs?: number;
    provider?: string;
  };
  totalLatencyMs: number;
  usedGpu: boolean;
}

export interface AtomicResponseBody {
  transcription: string;
  response: string;
  audio_base64: string;
  content_type: string;
  timing: {
    total_ms: number;
    stt_ms: number;
    llm_ms: number;
    tts_ms: number;
    used_gpu: boolean;
    stt_provider: string;
    llm_provider: string;
    tts_provider: string;
    clone: boolean;
    network_ms?: number;
    server_total_ms?: number;
  };
}

/** Compute network overhead = client round-trip minus server-reported stages. */
export function computeNetworkMs(result: AtomicPipelineResult): number | undefined {
  if (!result.usedGpu) return undefined;
  const sttMs = result.stt.latencyMs || 0;
  const llmMs = result.chat.latencyMs || 0;
  const ttsMs = result.tts?.latencyMs || 0;
  const serverTotalMs = sttMs + llmMs + ttsMs;
  return Math.max(0, result.totalLatencyMs - serverTotalMs);
}

/** Extract the TTS audio as a Buffer if present. */
export function extractAtomicAudio(result: AtomicPipelineResult): Buffer | undefined {
  if (!result.tts?.audio) return undefined;
  return Buffer.isBuffer(result.tts.audio) ? result.tts.audio : Buffer.from(result.tts.audio);
}

/** Build the canonical pipeline response body for the atomic path. */
export function buildAtomicResponseBody(
  result: AtomicPipelineResult,
  audioB64: string,
  isCloneRequest: boolean,
): AtomicResponseBody {
  const networkMs = computeNetworkMs(result);
  const sttMs = result.stt.latencyMs || 0;
  const llmMs = result.chat.latencyMs || 0;
  const ttsMs = result.tts?.latencyMs || 0;
  const serverTotalMs = sttMs + llmMs + ttsMs;
  return {
    transcription: result.stt.text,
    response: result.chat.content,
    audio_base64: audioB64,
    content_type: result.tts?.contentType || '',
    timing: {
      total_ms: result.totalLatencyMs,
      stt_ms: sttMs,
      llm_ms: llmMs,
      tts_ms: ttsMs,
      used_gpu: result.usedGpu,
      stt_provider: result.stt.provider || 'cloud',
      llm_provider: result.chat.provider || 'cloud',
      tts_provider: result.tts?.provider || 'cloud',
      clone: isCloneRequest,
      ...(networkMs !== undefined && { network_ms: networkMs, server_total_ms: serverTotalMs }),
    },
  };
}
