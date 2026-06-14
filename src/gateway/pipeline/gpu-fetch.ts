// ── BabelCast Gateway — GPU Fetch Helpers ────────────────────────────────────
// Pure HTTP fetchers for GPU pod endpoints (STT, LLM, TTS).
// These functions take callbacks for recording success/failure so they
// remain independent of server/ state modules.

import { createLogger } from '../../logger';
import { validateRemoteEndpointResolved } from './ssrf-protection';

const log = createLogger('gpu-fetch');

// ── Types ───────────────────────────────────────────────────────────────────

export interface GpuSTTResult {
  text: string;
  language: string;
  used_gpu: boolean;
  /**
   * Avg log-probability from the pod's Whisper output. `undefined` when the pod
   * didn't report it (#17) — distinct from a real, very-confident `0`, so the
   * metadata hallucination filter (NaN-sentinel) doesn't mistake "missing" for
   * "0.0". Previously hard-coded to `0`, masking the missing case.
   */
  avg_logprob?: number;
  /** Compression ratio from the pod (#17) — feeds the repetitive-hallucination filter. */
  compression_ratio?: number;
  /** No-speech probability from the pod (#17) — feeds the silence/hallucination filter. */
  no_speech_prob?: number;
  segments?: unknown[];
  words?: unknown[];
}

export interface GpuLLMResult {
  translated_text: string;
  used_gpu: boolean;
}

export interface GpuTTSResult {
  audio: Buffer;
  contentType: string;
  used_gpu: boolean;
}

/** Callbacks for recording stage success/failure (injected by server layer). */
export interface StageRecorder {
  recordSuccess(stage: 'stt' | 'llm' | 'tts'): void;
  recordFailure(stage: 'stt' | 'llm' | 'tts'): void;
}

// ── STT metadata extraction (#17) ─────────────────────────────────────────────

/**
 * Pull Whisper metadata signals (`avg_logprob`, `compression_ratio`,
 * `no_speech_prob`) from a GPU pod's transcription response (#17).
 *
 * Prefer a top-level numeric value; if absent, fall back to averaging the
 * per-segment metrics (verbose_json shape). Any signal that can't be resolved
 * is left `undefined` — callers treat that as "missing" (NaN sentinel
 * downstream), never as a confident `0`. Pure + synchronous → unit-testable.
 */
export function extractSttMetrics(data: Record<string, unknown>): {
  avg_logprob?: number; compression_ratio?: number; no_speech_prob?: number;
} {
  const topNum = (k: string): number | undefined =>
    typeof data[k] === 'number' && Number.isFinite(data[k] as number) ? (data[k] as number) : undefined;

  const segs = Array.isArray(data.segments) ? (data.segments as Array<Record<string, unknown>>) : [];
  const segAvg = (k: string): number | undefined => {
    let sum = 0; let n = 0;
    for (const s of segs) {
      const v = s?.[k];
      if (typeof v === 'number' && Number.isFinite(v)) { sum += v; n++; }
    }
    return n > 0 ? sum / n : undefined;
  };

  return {
    avg_logprob: topNum('avg_logprob') ?? segAvg('avg_logprob'),
    compression_ratio: topNum('compression_ratio') ?? segAvg('compression_ratio'),
    no_speech_prob: topNum('no_speech_prob') ?? segAvg('no_speech_prob'),
  };
}

// ── GPU STT ─────────────────────────────────────────────────────────────────

export async function fetchGpuSTT(
  gpuEndpoint: string, audio: Buffer, language: string, prompt: string,
  hotwords: string, wordTimestamps: boolean, signal: AbortSignal,
  recorder: StageRecorder,
  requestId?: string,
): Promise<GpuSTTResult> {
  await validateRemoteEndpointResolved(gpuEndpoint);
  const form = new FormData();
  form.append('file', new Blob([audio as BlobPart], { type: 'audio/wav' }), 'audio.wav');
  const params = new URLSearchParams();
  if (language) params.set('language', language);
  if (prompt) params.set('prompt', prompt);
  if (hotwords) params.set('hotwords', hotwords);
  if (wordTimestamps) params.set('word_timestamps', 'true');
  try {
    const headers: Record<string, string> = {};
    if (requestId) headers['X-Request-Id'] = requestId;
    const gpuRes = await fetch(`${gpuEndpoint}/v1/transcribe?${params}`, {
      method: 'POST', body: form, signal, headers,
    });
    if (!gpuRes.ok) {
      const errBody = await gpuRes.text().catch(() => '');
      log.warn(`HTTP ${gpuRes.status}: ${errBody.slice(0, 200)}`);
      recorder.recordFailure('stt');
      throw new Error(`GPU STT HTTP ${gpuRes.status}`);
    }
    const data = await gpuRes.json() as Record<string, unknown>;
    recorder.recordSuccess('stt');
    const metrics = extractSttMetrics(data);
    return {
      text: (data.text as string) || '',
      language: (data.language as string) || '',
      used_gpu: true,
      // #17 — forward all three Whisper signals (top-level, else segment-averaged)
      // so the metadata hallucination filter can operate on GPU output too;
      // omit (undefined) when truly absent rather than masking with 0.
      ...(metrics.avg_logprob !== undefined ? { avg_logprob: metrics.avg_logprob } : {}),
      ...(metrics.compression_ratio !== undefined ? { compression_ratio: metrics.compression_ratio } : {}),
      ...(metrics.no_speech_prob !== undefined ? { no_speech_prob: metrics.no_speech_prob } : {}),
      ...(Array.isArray(data.segments) ? { segments: data.segments } : {}),
      // Forward word-level timestamps when the pod returns them (requested via
      // `word_timestamps=true`). Previously the `words` field was declared on
      // GpuSTTResult and read by the /v1/transcribe handler but never populated,
      // so word timestamps from the GPU were silently dropped.
      ...(Array.isArray(data.words) ? { words: data.words } : {}),
    };
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) recorder.recordFailure('stt');
    throw err;
  }
}

// ── GPU LLM ─────────────────────────────────────────────────────────────────

export async function fetchGpuLLM(
  gpuEndpoint: string, text: string, sourceLang: string, targetLang: string,
  glossary: string, context: string, signal: AbortSignal,
  recorder: StageRecorder,
  requestId?: string,
  maxTokens?: number,
): Promise<GpuLLMResult> {
  await validateRemoteEndpointResolved(gpuEndpoint);
  const body: Record<string, string | number> = { text, source_lang: sourceLang, target_lang: targetLang };
  if (glossary) body.glossary = glossary;
  if (context) body.context = context;
  // #30 — bound GPU generation so a self-hosted model can't over-generate on a
  // short utterance (GPU $/min tracks tokens). Send both common field names so
  // either server shape (OpenAI-style `max_tokens` / HF-style `max_new_tokens`)
  // picks it up; omitted entirely when unset to keep the body back-compat.
  if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0) {
    const mt = Math.floor(maxTokens);
    body.max_tokens = mt;
    body.max_new_tokens = mt;
  }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (requestId) headers['X-Request-Id'] = requestId;
    const gpuRes = await fetch(`${gpuEndpoint}/v1/translate/text`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!gpuRes.ok) {
      const errBody = await gpuRes.text().catch(() => '');
      log.warn(`HTTP ${gpuRes.status}: ${errBody.slice(0, 200)}`);
      recorder.recordFailure('llm');
      throw new Error(`GPU LLM HTTP ${gpuRes.status}`);
    }
    const data = await gpuRes.json() as Record<string, unknown>;
    recorder.recordSuccess('llm');
    return {
      translated_text: (data.translated_text as string) || '',
      used_gpu: true,
    };
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) recorder.recordFailure('llm');
    throw err;
  }
}

// ── GPU TTS ─────────────────────────────────────────────────────────────────

export async function fetchGpuTTS(
  gpuEndpoint: string, text: string, language: string, speaker: string,
  signal: AbortSignal, recorder: StageRecorder,
  refAudio?: string, refText?: string,
  requestId?: string,
): Promise<GpuTTSResult> {
  await validateRemoteEndpointResolved(gpuEndpoint);
  try {
    const body: Record<string, string> = { text, language, speaker };
    if (refAudio) body.reference_audio = refAudio;
    if (refText) body.ref_text = refText;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (requestId) headers['X-Request-Id'] = requestId;
    const gpuRes = await fetch(`${gpuEndpoint}/v1/tts`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!gpuRes.ok) {
      const errBody = await gpuRes.text().catch(() => '');
      log.warn(`HTTP ${gpuRes.status}: ${errBody.slice(0, 200)}`);
      recorder.recordFailure('tts');
      throw new Error(`GPU TTS HTTP ${gpuRes.status}`);
    }
    const audio = Buffer.from(await gpuRes.arrayBuffer());
    recorder.recordSuccess('tts');
    return { audio, contentType: gpuRes.headers.get('content-type') || 'audio/wav', used_gpu: true };
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) recorder.recordFailure('tts');
    throw err;
  }
}
