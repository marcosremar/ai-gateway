/**
 * Wave-4 unit tests for provider-routing / caching optimizations
 * (docs/optimizations/04-provider-routing-caching.md).
 *
 * Scope: pure, importable logic only — no network / provider SDK / GPU / real
 * FS. Provider behavior is exercised via side-effect-free exported helpers.
 *
 * Covered findings:
 *   #314 image route preserves provider 4xx status;
 *   #329 image response cache (seeded-only, LRU);
 *   #330 STT cache stores the full response (verbose_json segments/words);
 *   #331 embedding per-input caching + truncated-response guard;
 *   #334 ResponseCache.buildKey stable (key-order-independent) hashing;
 *   #340 dynamic model-catalog TTL memo (+ stale-on-error);
 *   #370 buffered TTS audio is emitted as a real chunked stream;
 *   #376 image route retries transient failures via withProxyRetry;
 *   #378 self-hosted STT honors the requested response_format;
 *   #382 provider warmup includes all configured cloud providers;
 *   #383 warmup idle backoff skips cycles on a dormant gateway;
 *   #398 registry getAllModels enumerates the LLM model catalog.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ResponseCache, stableStringify } from '../../src/caching/response-cache';
import { AIProviderRegistry } from '../../src/gateway/providers/cloud/registry';
import {
  chunkAudioBuffer,
  bufferToChunkedStream,
  TTS_STREAM_CHUNK_BYTES,
} from '../../src/gateway/providers/cloud/minimax';
import { resolveSelfHostedSttFormat } from '../../src/gateway/providers/cloud/self-hosted/self-hosted-provider';
import { ModelCatalogCache } from '../../src/gateway/proxy/routes/models';
import {
  buildTranscriptionBody,
  handleAudioTranscriptions,
  _resetSttCache,
} from '../../src/gateway/proxy/routes/audio-transcriptions';
import {
  partitionEmbeddingInputs,
  assembleEmbeddings,
  embeddingInputKey,
} from '../../src/gateway/proxy/routes/embeddings';
import {
  imageCacheKey,
  isImageCacheable,
  handleImageGenerate,
  _resetImageCache,
} from '../../src/gateway/proxy/routes/images';
import { buildWarmupKeys, shouldRunWarmupCycle } from '../../src/gateway/providers/cloud/warmup-keys';

// ─── #334 ResponseCache stable hashing ──────────────────────────────────────
describe('#334 stableStringify / buildKey key-order independence', () => {
  it('stableStringify sorts nested object keys deterministically', () => {
    const a = stableStringify({ b: 1, a: { y: 2, x: 3 } });
    const b = stableStringify({ a: { x: 3, y: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  it('preserves array order (significant for messages/tools)', () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  function makeKv() {
    const store = new Map<string, string>();
    return {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => { store.set(k, v); },
      del: async (k: string) => { store.delete(k); },
      scan: async () => {},
    };
  }

  it('two requests differing only in nested key order share a cache key', () => {
    const cache = new ResponseCache(makeKv() as any, { prefix: 'c:' });
    const tools1 = [{ type: 'function', function: { name: 'f', parameters: { a: 1, b: 2 } } }];
    const tools2 = [{ type: 'function', function: { parameters: { b: 2, a: 1 }, name: 'f' } }];
    const k1 = cache.buildKey({ provider: 'p', model: 'm', tools: tools1 });
    const k2 = cache.buildKey({ provider: 'p', model: 'm', tools: tools2 });
    expect(k1).toBe(k2);
  });

  it('still distinguishes genuinely different requests', () => {
    const cache = new ResponseCache(makeKv() as any, { prefix: 'c:' });
    const k1 = cache.buildKey({ provider: 'p', model: 'm', maxTokens: 50 });
    const k2 = cache.buildKey({ provider: 'p', model: 'm', maxTokens: 500 });
    expect(k1).not.toBe(k2);
  });
});

// ─── #398 registry enumerates LLM model catalog ─────────────────────────────
describe('#398 getAllModels enumerates LLM models', () => {
  const llmStub = { providerId: 'groq', chat: async () => ({ content: '', model: '' }), isConfigured: () => true } as any;

  it('enumerates the explicit llmModels catalog when present', () => {
    const reg = new AIProviderRegistry();
    reg.register({
      id: 'groq', name: 'Groq', description: '', requiresApiKey: true,
      capabilities: ['llm'], llm: llmStub,
      llmModels: [
        { id: 'llama-3.3-70b-versatile', name: 'L70', description: '', capability: 'llm' },
        { id: 'llama-3.1-8b-instant', name: 'L8', description: '', capability: 'llm' },
      ],
    } as any);
    const models = reg.getAllModels('llm');
    expect(models.map((m) => m.id).sort()).toEqual(['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']);
    expect(models.every((m) => m.providerId === 'groq')).toBe(true);
  });

  it('falls back to one pseudo-model when no catalog is declared (backward compatible)', () => {
    const reg = new AIProviderRegistry();
    reg.register({
      id: 'openrouter', name: 'OpenRouter', description: 'd', requiresApiKey: true,
      capabilities: ['llm'], llm: { ...llmStub, providerId: 'openrouter' },
    } as any);
    const models = reg.getAllModels('llm');
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('openrouter');
  });
});

// ─── #370 real chunked TTS stream ───────────────────────────────────────────
describe('#370 buffered audio emitted as chunked stream', () => {
  it('chunkAudioBuffer splits into fixed-size chunks', () => {
    const buf = Buffer.alloc(TTS_STREAM_CHUNK_BYTES * 2 + 5, 7);
    const chunks = chunkAudioBuffer(buf);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].length).toBe(TTS_STREAM_CHUNK_BYTES);
    expect(chunks[2].length).toBe(5);
    // Concatenation must equal the original bytes.
    const joined = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    expect(joined.equals(buf)).toBe(true);
  });

  it('respects a custom chunk size and emits >1 chunk (vs single-chunk)', () => {
    const buf = Buffer.from('abcdefghij');
    const chunks = chunkAudioBuffer(buf, 4);
    expect(chunks.map((c) => Buffer.from(c).toString())).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('empty buffer yields zero chunks', () => {
    expect(chunkAudioBuffer(Buffer.alloc(0))).toEqual([]);
  });

  it('bufferToChunkedStream streams all bytes across multiple reads', async () => {
    const buf = Buffer.from('hello-world-streaming');
    const stream = bufferToChunkedStream(buf, 5);
    const reader = stream.getReader();
    const out: number[] = [];
    let reads = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      reads++;
      out.push(...value);
    }
    expect(reads).toBeGreaterThan(1); // genuinely chunked, not one blob
    expect(Buffer.from(out).equals(buf)).toBe(true);
  });
});

// ─── #378 self-hosted STT honors requested format ───────────────────────────
describe('#378 resolveSelfHostedSttFormat', () => {
  it('honors supported subtitle/json formats', () => {
    expect(resolveSelfHostedSttFormat('srt')).toBe('srt');
    expect(resolveSelfHostedSttFormat('vtt')).toBe('vtt');
    expect(resolveSelfHostedSttFormat('json')).toBe('json');
    expect(resolveSelfHostedSttFormat('text')).toBe('text');
    expect(resolveSelfHostedSttFormat('verbose_json')).toBe('verbose_json');
  });

  it('defaults to verbose_json for undefined/unknown values', () => {
    expect(resolveSelfHostedSttFormat(undefined)).toBe('verbose_json');
    expect(resolveSelfHostedSttFormat('bogus')).toBe('verbose_json');
  });
});

// ─── #340 dynamic model-catalog TTL memo ────────────────────────────────────
describe('#340 ModelCatalogCache', () => {
  it('memoizes within the TTL (single upstream call)', async () => {
    let calls = 0;
    let now = 1000;
    const cache = new ModelCatalogCache(60_000, () => now);
    const catalog = { providerId: 'openrouter', listModels: async () => { calls++; return ['m1', 'm2']; } };
    expect(await cache.getModels(catalog)).toEqual(['m1', 'm2']);
    now += 30_000;
    expect(await cache.getModels(catalog)).toEqual(['m1', 'm2']);
    expect(calls).toBe(1);
  });

  it('refetches after TTL expiry', async () => {
    let calls = 0;
    let now = 1000;
    const cache = new ModelCatalogCache(60_000, () => now);
    const catalog = { providerId: 'openrouter', listModels: async () => { calls++; return [`m${calls}`]; } };
    await cache.getModels(catalog);
    now += 60_001;
    await cache.getModels(catalog);
    expect(calls).toBe(2);
  });

  it('serves the last good value on a failed refresh (stale-on-error)', async () => {
    let now = 1000;
    let shouldFail = false;
    const cache = new ModelCatalogCache(10, () => now);
    const catalog = {
      providerId: 'openrouter',
      listModels: async () => { if (shouldFail) throw new Error('502'); return ['ok']; },
    };
    expect(await cache.getModels(catalog)).toEqual(['ok']);
    now += 100; // expire
    shouldFail = true;
    expect(await cache.getModels(catalog)).toEqual(['ok']); // stale served
  });

  it('throws on first-call failure with no cached value', async () => {
    const cache = new ModelCatalogCache();
    const catalog = { providerId: 'x', listModels: async () => { throw new Error('boom'); } };
    await expect(cache.getModels(catalog)).rejects.toThrow('boom');
  });
});

// ─── #330 STT cache stores full response ────────────────────────────────────
describe('#330 buildTranscriptionBody + full-response cache', () => {
  beforeEach(() => _resetSttCache());

  it('verbose_json body includes segments/words/language/duration', () => {
    const body = buildTranscriptionBody(
      {
        text: 'hi', language: 'en', duration: 1.2,
        segments: [{ id: 0, start: 0, end: 1, text: 'hi', avg_logprob: -0.1, compression_ratio: 1, no_speech_prob: 0 }],
        words: [{ word: 'hi', start: 0, end: 1 }],
      } as any,
      'verbose_json',
    ) as Record<string, unknown>;
    expect(body.text).toBe('hi');
    expect(body.language).toBe('en');
    expect(Array.isArray(body.segments)).toBe(true);
    expect(Array.isArray(body.words)).toBe(true);
  });

  it('non-verbose formats return only text', () => {
    const body = buildTranscriptionBody({ text: 'hi', segments: [] } as any, 'json') as Record<string, unknown>;
    expect(body).toEqual({ text: 'hi' });
  });

  it('a verbose_json cache HIT replays segments (not just text)', async () => {
    const transcribe = vi.fn().mockResolvedValue({
      text: 'hello world',
      segments: [{ id: 0, start: 0, end: 1, text: 'hello world', avg_logprob: -0.2, compression_ratio: 1.1, no_speech_prob: 0.01 }],
    });
    const provider = { providerId: 'groq', getModels: () => [], isConfigured: () => true, transcribe } as any;
    const sttProviders = { 'whisper-large-v3': provider };

    const audio = Buffer.from('AUDIODATA');
    const makeReq = () => ({
      rawBody: audio,
      body: { model: 'whisper-large-v3', response_format: 'verbose_json' },
    }) as any;

    const first = await handleAudioTranscriptions(makeReq(), sttProviders);
    expect(first.headers?.['X-Cache']).toBe('MISS');
    expect((first.body as any).segments).toHaveLength(1);

    const second = await handleAudioTranscriptions(makeReq(), sttProviders);
    expect(second.headers?.['X-Cache']).toBe('HIT');
    // The HIT must carry segments, proving the FULL response was cached (#330).
    expect((second.body as any).segments).toHaveLength(1);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
});

// ─── #331 embedding per-input cache helpers ─────────────────────────────────
describe('#331 per-input embedding caching helpers', () => {
  it('partitionEmbeddingInputs separates hits from misses by index', () => {
    const inputs = ['a', 'b', 'c'];
    const hits: Record<number, number[]> = { 1: [0.1, 0.2] };
    const { missIndices, results } = partitionEmbeddingInputs(inputs, (i) => hits[i] ?? null);
    expect(missIndices).toEqual([0, 2]);
    expect(results[1]).toEqual([0.1, 0.2]);
    expect(results[0]).toBeNull();
  });

  it('assembleEmbeddings merges fresh vectors back in miss order', () => {
    const results: (number[] | null)[] = [null, [9], null];
    const out = assembleEmbeddings(results, [0, 2], [[1], [2]]);
    expect(out).toEqual([[1], [9], [2]]);
  });

  it('assembleEmbeddings throws on a truncated provider response (#331)', () => {
    expect(() => assembleEmbeddings([null, null], [0, 1], [[1]])).toThrow(/mismatch/);
  });

  it('embeddingInputKey is per-string (different inputs → different keys)', () => {
    const cache = { buildCustomKey: (k: string) => `H(${k})` };
    const k1 = embeddingInputKey(cache, 'openai', 'm', 'foo', 256);
    const k2 = embeddingInputKey(cache, 'openai', 'm', 'bar', 256);
    expect(k1).not.toBe(k2);
    // Same string + dims → same key (enables reuse across requests).
    expect(embeddingInputKey(cache, 'openai', 'm', 'foo', 256)).toBe(k1);
  });
});

// ─── #329 / #314 / #376 image route ─────────────────────────────────────────
describe('#329 image cache key + cacheability', () => {
  it('isImageCacheable only for seeded requests', () => {
    expect(isImageCacheable(42)).toBe(true);
    expect(isImageCacheable(undefined)).toBe(false);
  });

  it('imageCacheKey is stable for identical params, differs on seed/prompt', () => {
    const base = { prompt: 'a cat', model: 'sd', width: 512, height: 512, steps: 20, seed: 1 };
    expect(imageCacheKey(base)).toBe(imageCacheKey({ ...base }));
    expect(imageCacheKey(base)).not.toBe(imageCacheKey({ ...base, seed: 2 }));
    expect(imageCacheKey(base)).not.toBe(imageCacheKey({ ...base, prompt: 'a dog' }));
  });
});

describe('#329/#376/#314 handleImageGenerate', () => {
  beforeEach(() => _resetImageCache());

  function imgProvider(generate: any) {
    return { providerId: 'fireworks', isConfigured: () => true, generate } as any;
  }

  it('caches a seeded image — second identical call serves from cache', async () => {
    const generate = vi.fn().mockResolvedValue({ image: Buffer.from('PNGBYTES'), contentType: 'image/png' });
    const provider = imgProvider(generate);
    const req = () => ({ body: { prompt: 'x', model: 'sd', seed: 7 } }) as any;

    const r1 = await handleImageGenerate(req(), provider);
    expect(r1.status).toBe(200);
    expect(r1.headers?.['X-Cache']).toBe('MISS');

    const r2 = await handleImageGenerate(req(), provider);
    expect(r2.headers?.['X-Cache']).toBe('HIT');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache unseeded (non-deterministic) requests', async () => {
    const generate = vi.fn().mockResolvedValue({ image: Buffer.from('A'), contentType: 'image/png' });
    const provider = imgProvider(generate);
    const req = () => ({ body: { prompt: 'x', model: 'sd' } }) as any; // no seed

    await handleImageGenerate(req(), provider);
    const r2 = await handleImageGenerate(req(), provider);
    expect(r2.headers?.['X-Cache']).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('#376 retries a transient 5xx and then succeeds', async () => {
    const generate = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('upstream'), { status: 503 }))
      .mockResolvedValueOnce({ image: Buffer.from('OK'), contentType: 'image/png' });
    const provider = imgProvider(generate);
    const res = await handleImageGenerate({ body: { prompt: 'x', seed: 1 } } as any, provider);
    expect(res.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(2); // retried via withProxyRetry
  });

  it('#314 preserves a provider 4xx status instead of masking it as 500', async () => {
    const generate = vi.fn().mockRejectedValue(Object.assign(new Error('bad params'), { status: 400 }));
    const provider = imgProvider(generate);
    const res = await handleImageGenerate({ body: { prompt: 'x', seed: 1 } } as any, provider);
    expect(res.status).toBe(400);
    // 400 is non-retryable → exactly one attempt.
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

// ─── #382 / #383 provider warmup helpers ────────────────────────────────────
describe('#382 buildWarmupKeys', () => {
  const env = {
    GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o', FIREWORKS_API_KEY: 'f',
    OPENROUTER_API_KEY: 'or', DEEPGRAM_API_KEY: 'd', ELEVENLABS_API_KEY: 'e',
  };

  it('includes every configured cloud provider, not just groq/openai', () => {
    const keys = buildWarmupKeys(
      { groq: true, openai: true, fireworks: true, openrouter: true, deepgram: true, elevenlabs: true },
      env,
    );
    expect(Object.keys(keys).sort()).toEqual(['deepgram', 'elevenlabs', 'fireworks', 'groq', 'openai', 'openrouter']);
  });

  it('omits providers that are unavailable or missing a key', () => {
    const keys = buildWarmupKeys({ groq: true, fireworks: true }, { GROQ_API_KEY: 'g' });
    expect(keys).toEqual({ groq: 'g' }); // fireworks available but no key
  });
});

describe('#383 shouldRunWarmupCycle idle backoff', () => {
  it('runs while traffic is recent', () => {
    expect(shouldRunWarmupCycle({ now: 100_000, lastRequestTime: 99_000, gpuDeployed: false })).toBe(true);
  });

  it('skips a dormant gateway past the idle backoff window', () => {
    expect(shouldRunWarmupCycle({ now: 100_000 + 11 * 60_000, lastRequestTime: 100_000, gpuDeployed: false })).toBe(false);
  });

  it('always runs when a GPU pod is deployed (health monitoring)', () => {
    expect(shouldRunWarmupCycle({ now: 100_000 + 60 * 60_000, lastRequestTime: 100_000, gpuDeployed: true })).toBe(true);
  });

  it('respects a custom idleBackoffMs', () => {
    expect(shouldRunWarmupCycle({ now: 5_000, lastRequestTime: 0, gpuDeployed: false, idleBackoffMs: 1_000 })).toBe(false);
    expect(shouldRunWarmupCycle({ now: 500, lastRequestTime: 0, gpuDeployed: false, idleBackoffMs: 1_000 })).toBe(true);
  });
});
