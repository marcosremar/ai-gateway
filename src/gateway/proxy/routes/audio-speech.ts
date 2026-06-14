/**
 * POST /v1/audio/speech — TTS
 *
 * Includes an in-memory LRU cache keyed by model+voice+input+speed+format.
 * TTS is one of the priciest pipeline stages and identical phrases (UI
 * prompts, repeated translations) recur constantly, so caching avoids paying
 * to re-synthesize the same audio. Cache TTL: 1 hour, max 200 entries.
 */

import { createHash } from 'crypto';
import type { TTSProvider } from '../../providers/cloud/types';
import type { ProxyRequest, ProxyResponse } from '../types';
import { withProxyRetry } from './retry';
import { createLogger } from '../../../logger';

const log = createLogger('audio-speech');

// ── TTS response cache ──────────────────────────────────────────────────
const TTS_CACHE_TTL_MS = 60 * 60_000; // 1 hour
const TTS_CACHE_MAX_ENTRIES = 200;
const ttsCache = new Map<string, { audio: Buffer; contentType: string; expiresAt: number }>();

/** Build a deterministic cache key from all output-affecting TTS params. */
export function ttsCacheKey(
  model: string,
  voice: string,
  input: string,
  speed: number | undefined,
  format: string,
): string {
  const hash = createHash('sha256')
    .update(`${model}\0${voice}\0${speed ?? 1}\0${format}\0${input}`)
    .digest('hex')
    .slice(0, 24);
  return hash;
}

function ttsCacheGet(key: string): { audio: Buffer; contentType: string } | null {
  const entry = ttsCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { ttsCache.delete(key); return null; }
  // Refresh recency (Map preserves insertion order → re-insert to mark MRU)
  ttsCache.delete(key);
  ttsCache.set(key, entry);
  return { audio: entry.audio, contentType: entry.contentType };
}

function ttsCacheSet(key: string, audio: Buffer, contentType: string): void {
  while (ttsCache.size >= TTS_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    let removedAny = false;
    for (const [k, v] of ttsCache) {
      if (v.expiresAt < now) { ttsCache.delete(k); removedAny = true; break; }
    }
    if (!removedAny) {
      const oldestKey = ttsCache.keys().next().value;
      if (oldestKey !== undefined) ttsCache.delete(oldestKey);
      else break;
    }
  }
  ttsCache.set(key, { audio, contentType, expiresAt: Date.now() + TTS_CACHE_TTL_MS });
}

/** Clear the TTS cache. Exported for tests. */
export function _resetTtsCache(): void { ttsCache.clear(); }

export async function handleAudioSpeech(
  req: ProxyRequest,
  ttsProviders: Record<string, TTSProvider>,
): Promise<ProxyResponse> {
  if (!req.body || typeof req.body !== 'object') {
    return { status: 400, body: { error: { message: 'request body is required', type: 'invalid_request_error' } } };
  }
  const body = req.body as Record<string, unknown>;

  if (!body.model || typeof body.model !== 'string') {
    return { status: 400, body: { error: { message: 'model is required', type: 'invalid_request_error' } } };
  }
  if (!body.input || typeof body.input !== 'string') {
    return { status: 400, body: { error: { message: 'input text is required', type: 'invalid_request_error' } } };
  }
  if (!body.voice || typeof body.voice !== 'string') {
    return { status: 400, body: { error: { message: 'voice is required', type: 'invalid_request_error' } } };
  }
  if (body.input.length > 4096) {
    return { status: 400, body: { error: { message: 'input text exceeds 4096 characters', type: 'invalid_request_error' } } };
  }
  if (body.speed !== undefined && (typeof body.speed !== 'number' || body.speed < 0.25 || body.speed > 4.0)) {
    return { status: 400, body: { error: { message: 'speed must be between 0.25 and 4.0', type: 'invalid_request_error' } } };
  }
  const validFormats = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'];
  if (body.response_format !== undefined && (typeof body.response_format !== 'string' || !validFormats.includes(body.response_format))) {
    return { status: 400, body: { error: { message: `response_format must be one of: ${validFormats.join(', ')}`, type: 'invalid_request_error' } } };
  }

  const provider = ttsProviders[body.model];
  if (!provider) {
    return { status: 404, body: { error: { message: `TTS model "${body.model}" not found`, type: 'invalid_request_error' } } };
  }

  const format = ((body.response_format as string) || 'mp3') as 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  const speed = body.speed as number | undefined;

  // Check cache — identical synthesis params return cached audio instantly.
  const cacheKey = ttsCacheKey(body.model, body.voice, body.input, speed, format);
  const cachedAudio = ttsCacheGet(cacheKey);
  if (cachedAudio) {
    return {
      status: 200,
      headers: { 'Content-Type': cachedAudio.contentType, 'X-Cache': 'HIT' },
      body: cachedAudio.audio,
    };
  }

  try {
    const result = await withProxyRetry(
      provider.providerId,
      body.model,
      () => provider.synthesize({
        model: body.model as string,
        input: body.input as string,
        voice: body.voice as string,
        responseFormat: format,
        speed,
      }),
      'TTS',
    );

    // Cache the synthesized audio for future identical requests.
    ttsCacheSet(cacheKey, result.audio, result.contentType);

    return {
      status: 200,
      headers: { 'Content-Type': result.contentType, 'X-Cache': 'MISS' },
      body: result.audio,
    };
  } catch (err) {
    log.error(`TTS error for model ${body.model}:`, err);
    return {
      status: 500,
      body: { error: { message: 'Speech synthesis failed', type: 'server_error' } },
    };
  }
}
