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
  avg_logprob: number;
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
    return {
      text: (data.text as string) || '',
      language: (data.language as string) || '',
      used_gpu: true,
      avg_logprob: typeof data.avg_logprob === 'number' ? data.avg_logprob : 0,
      ...(Array.isArray(data.segments) ? { segments: data.segments } : {}),
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
): Promise<GpuLLMResult> {
  await validateRemoteEndpointResolved(gpuEndpoint);
  const body: Record<string, string> = { text, source_lang: sourceLang, target_lang: targetLang };
  if (glossary) body.glossary = glossary;
  if (context) body.context = context;
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
