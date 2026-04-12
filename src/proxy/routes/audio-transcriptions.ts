/**
 * POST /v1/audio/transcriptions — STT
 *
 * Includes an in-memory cache keyed by audio hash + model + language.
 * Identical audio sent twice (common on client retry after timeout)
 * returns the cached transcription instantly without hitting the provider.
 * Cache TTL: 5 minutes, max 200 entries.
 */

import { createHash } from 'crypto';
import type { STTProvider } from '../../providers/types';
import type { ProxyRequest, ProxyResponse } from '../types';
import { withProxyRetry } from './retry';

// ── STT response cache ──────────────────────────────────────────────────
const STT_CACHE_TTL_MS = 5 * 60_000;
const STT_CACHE_MAX_ENTRIES = 200;
const sttCache = new Map<string, { text: string; expiresAt: number }>();

function sttCacheKey(audioHash: string, model: string, language?: string): string {
  return `${audioHash}:${model}:${language ?? '*'}`;
}

function hashAudio(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function sttCacheGet(key: string): string | null {
  const entry = sttCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { sttCache.delete(key); return null; }
  return entry.text;
}

/** Clear the STT cache. Exported for tests. */
export function _resetSttCache(): void { sttCache.clear(); }

function sttCacheSet(key: string, text: string): void {
  // Evict oldest if at capacity
  if (sttCache.size >= STT_CACHE_MAX_ENTRIES) {
    const oldest = sttCache.keys().next().value;
    if (oldest !== undefined) sttCache.delete(oldest);
  }
  sttCache.set(key, { text, expiresAt: Date.now() + STT_CACHE_TTL_MS });
}

export async function handleAudioTranscriptions(
  req: ProxyRequest,
  sttProviders: Record<string, STTProvider>,
): Promise<ProxyResponse> {
  // For multipart/form-data, the body should already be parsed
  // In practice, audio transcriptions need raw binary + model field
  const body = req.body as {
    model: string;
    language?: string;
    prompt?: string;
    response_format?: string;
  };

  if (!body.model || typeof body.model !== 'string') {
    return { status: 400, body: { error: { message: 'model is required', type: 'invalid_request_error' } } };
  }
  if (req.rawBody.length === 0) {
    return { status: 400, body: { error: { message: 'audio data is required', type: 'invalid_request_error' } } };
  }
  if (req.rawBody.length > 25 * 1024 * 1024) {
    return { status: 400, body: { error: { message: 'audio file exceeds 25MB limit', type: 'invalid_request_error' } } };
  }
  const validResponseFormats = ['json', 'text', 'srt', 'verbose_json', 'vtt'];
  if (body.response_format && !validResponseFormats.includes(body.response_format)) {
    return { status: 400, body: { error: { message: `response_format must be one of: ${validResponseFormats.join(', ')}`, type: 'invalid_request_error' } } };
  }

  const provider = sttProviders[body.model];
  if (!provider) {
    return { status: 404, body: { error: { message: `STT model "${body.model}" not found`, type: 'invalid_request_error' } } };
  }

  // Check STT cache — identical audio + model + language returns cached result
  const audioHash = hashAudio(req.rawBody);
  const cacheKey = sttCacheKey(audioHash, body.model, body.language);
  const cached = sttCacheGet(cacheKey);
  if (cached !== null) {
    return {
      status: 200,
      headers: { 'X-Cache': 'HIT' },
      body: { text: cached },
    };
  }

  try {
    const result = await withProxyRetry(
      provider.providerId,
      body.model,
      () => provider.transcribe({
        audio: req.rawBody,
        model: body.model,
        language: body.language,
        prompt: body.prompt,
        responseFormat: body.response_format as 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt',
      }),
      'STT',
    );

    // Cache the result for future identical requests
    sttCacheSet(cacheKey, result.text);

    return {
      status: 200,
      headers: { 'X-Cache': 'MISS' },
      body: { text: result.text },
    };
  } catch (err) {
    console.error(`[audio-transcriptions] STT error for model ${body.model}:`, err);
    return {
      status: 500,
      body: { error: { message: 'Transcription failed', type: 'server_error' } },
    };
  }
}
