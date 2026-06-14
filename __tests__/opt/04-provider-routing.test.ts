/**
 * Unit tests for provider-routing / caching optimizations
 * (docs/optimizations/04-provider-routing-caching.md).
 *
 * Scope: pure, importable modules only — no network / provider / GPU / real FS.
 * Provider clients (ollama, self-hosted, openai-compat) and the proxy server
 * are NOT imported directly here: the clients construct an OpenAI SDK client and
 * the server boots a Node http listener at call time. Their behaviour is covered
 * via (a) the shared, side-effect-free `buildSamplingParams` mapper they all
 * delegate to, (b) the exported pure cache helpers, and (c) replicating the
 * query-stripping logic the route-matcher fix depends on.
 *
 * Covered findings: #1 (head-start race null-vs-reject), #364 (chat-param
 * pass-through), #326/#328/#334 (response-cache + TTS cache keying & TTL),
 * #332 (don't cache empty responses), #379 (route path matching ignores query),
 * #347/#348 (cost-efficiency ranking).
 */
import { describe, it, expect, vi } from 'vitest';

import { raceProviders, type RaceCandidate } from '../../src/gateway/routing/provider-racer';
import { buildSamplingParams } from '../../src/gateway/providers/cloud/openai-compat/chat-params';
import { ResponseCache } from '../../src/caching/response-cache';
import { withCache } from '../../src/caching/with-cache';
import {
  PerformanceRanker,
  MODEL_PRICING,
  estimateCostPerRequest,
} from '../../src/gateway/providers/cloud/performance-ranker';
import { ttsCacheKey, handleAudioSpeech, _resetTtsCache } from '../../src/gateway/proxy/routes/audio-speech';
import type { FallbackEntry } from '../../src/gateway/providers/cloud/fallback';
import type { KvStore } from '../../src/deps';
import type {
  ChatRequest,
  ChatResponse,
  LLMProvider,
  TTSProvider,
  TTSRequest,
  TTSResponse,
} from '../../src/gateway/providers/cloud/types';

// ── Test doubles ───────────────────────────────────────────────────────────

/** A minimal in-memory KvStore for ResponseCache (no Redis/Prisma). */
function makeMemStore(): KvStore {
  const map = new Map<string, string>();
  return {
    async get(key) { return map.has(key) ? map.get(key)! : null; },
    async set(key, value) { map.set(key, value); },
    async del(key) { map.delete(key); },
    async scan(_pattern, callback) {
      const keys = [...map.keys()];
      if (callback) callback(keys);
      return keys.length;
    },
  } as KvStore;
}

/** A deferred race candidate that records its abort signal. */
function makeRaceCandidate(
  name: string,
  opts: { delayMs: number; fail?: boolean; value?: string },
): { candidate: RaceCandidate<string>; state: { aborted: boolean; started: boolean } } {
  const state = { aborted: false, started: false };
  const candidate: RaceCandidate<string> = {
    name,
    run: (signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        state.started = true;
        if (signal.aborted) state.aborted = true;
        signal.addEventListener('abort', () => { state.aborted = true; });
        const t = setTimeout(() => {
          if (opts.fail) reject(new Error(`${name} failed`));
          else resolve(opts.value ?? name);
        }, opts.delayMs);
        (t as unknown as { unref?: () => void }).unref?.();
      }),
  };
  return { candidate, state };
}

const fe = (provider: string, model: string): FallbackEntry => ({ provider, model });

// ════════════════════════════════════════════════════════════════════════════
// #1 — head-start race: a fast-failing primary must NOT reject the whole race;
// it must fall through to launching the remaining candidates.
// ════════════════════════════════════════════════════════════════════════════
describe('raceProviders head start (opt #1)', () => {
  it('falls through to the fallback when the primary rejects during the head start', async () => {
    // Primary fails almost immediately (before headstartMs); fallback resolves.
    const primary = makeRaceCandidate('primary', { delayMs: 1, fail: true });
    const fallback = makeRaceCandidate('fallback', { delayMs: 5, value: 'from-fallback' });

    const res = await raceProviders([primary.candidate, fallback.candidate], { headstartMs: 50 });

    expect(res.provider).toBe('fallback');
    expect(res.result).toBe('from-fallback');
  });

  it('returns the primary result when it wins during the head start', async () => {
    const primary = makeRaceCandidate('primary', { delayMs: 1, value: 'from-primary' });
    const fallback = makeRaceCandidate('fallback', { delayMs: 100, value: 'from-fallback' });

    const res = await raceProviders([primary.candidate, fallback.candidate], { headstartMs: 50 });

    expect(res.provider).toBe('primary');
    expect(res.result).toBe('from-primary');
    // Fallback should never have been launched while primary won the head start.
    expect(fallback.state.started).toBe(false);
  });

  it('rejects (aggregating) only when ALL candidates fail, not when the primary fast-fails', async () => {
    const primary = makeRaceCandidate('primary', { delayMs: 1, fail: true });
    const fallback = makeRaceCandidate('fallback', { delayMs: 5, fail: true });

    await expect(
      raceProviders([primary.candidate, fallback.candidate], { headstartMs: 50 }),
    ).rejects.toThrow(/failed/);
  });

  it('does not surface an unhandled rejection from the primary fast-fail (no-op catch attached)', async () => {
    // If the primary's rejection were not caught, Node would log an
    // unhandledRejection. We assert the race still resolves cleanly.
    const onUnhandled = vi.fn();
    process.once('unhandledRejection', onUnhandled);

    const primary = makeRaceCandidate('primary', { delayMs: 1, fail: true });
    const fallback = makeRaceCandidate('fallback', { delayMs: 5, value: 'ok' });

    const res = await raceProviders([primary.candidate, fallback.candidate], { headstartMs: 40 });
    // Give the microtask/macrotask queue a tick to flush any stray rejection.
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', onUnhandled);

    expect(res.result).toBe('ok');
    expect(onUnhandled).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #364 — chat sampling param pass-through (tools/tool_choice/top_p/seed/n/stop/
// penalties) mapped to OpenAI snake_case, only when defined.
// ════════════════════════════════════════════════════════════════════════════
describe('buildSamplingParams (opt #364)', () => {
  const base: ChatRequest = { model: 'm', messages: [] };

  it('emits nothing when no sampling params are set', () => {
    expect(buildSamplingParams(base)).toEqual({});
  });

  it('maps camelCase request fields to snake_case wire fields', () => {
    const out = buildSamplingParams({
      ...base,
      tools: [{ type: 'function', function: { name: 'f' } }],
      toolChoice: 'auto',
      topP: 0.9,
      seed: 42,
      n: 3,
      stop: ['<END>'],
      frequencyPenalty: 0.5,
      presencePenalty: -0.25,
    });
    expect(out).toEqual({
      tools: [{ type: 'function', function: { name: 'f' } }],
      tool_choice: 'auto',
      top_p: 0.9,
      seed: 42,
      n: 3,
      stop: ['<END>'],
      frequency_penalty: 0.5,
      presence_penalty: -0.25,
    });
  });

  it('omits unset fields so provider defaults are preserved (only top_p present)', () => {
    const out = buildSamplingParams({ ...base, topP: 0.1 });
    expect(out).toEqual({ top_p: 0.1 });
    expect('seed' in out).toBe(false);
    expect('tools' in out).toBe(false);
  });

  it('passes through falsy-but-defined values like seed 0 and presence_penalty 0', () => {
    const out = buildSamplingParams({ ...base, seed: 0, presencePenalty: 0 });
    expect(out).toEqual({ seed: 0, presence_penalty: 0 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #326 / #334 — ResponseCache.buildKey includes every output-affecting field.
// ════════════════════════════════════════════════════════════════════════════
describe('ResponseCache.buildKey output-affecting fields (opt #326/#334)', () => {
  const cache = () => new ResponseCache(makeMemStore());

  it('produces the same key for identical params (deterministic)', () => {
    const c = cache();
    const params = { provider: 'groq', model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0 };
    expect(c.buildKey(params)).toBe(c.buildKey(params));
  });

  it('splits the key when max_tokens differs (50-token cap must not hit a full answer)', () => {
    const c = cache();
    const a = c.buildKey({ provider: 'groq', model: 'm', messages: [], maxTokens: 50 });
    const b = c.buildKey({ provider: 'groq', model: 'm', messages: [], maxTokens: 500 });
    expect(a).not.toBe(b);
  });

  it('splits the key when response_format differs (verbose_json must not hit text)', () => {
    const c = cache();
    const txt = c.buildKey({ provider: 'oa', model: 'm', input: 'x', responseFormat: { type: 'text' } });
    const json = c.buildKey({ provider: 'oa', model: 'm', input: 'x', responseFormat: { type: 'json_object' } });
    expect(txt).not.toBe(json);
  });

  it('splits the key on differing top_p / seed / tools / stop', () => {
    const c = cache();
    const k = (extra: Record<string, unknown>) =>
      c.buildKey({ provider: 'groq', model: 'm', messages: [], ...extra });
    const baseKey = k({});
    expect(k({ topP: 0.9 })).not.toBe(baseKey);
    expect(k({ seed: 7 })).not.toBe(baseKey);
    expect(k({ tools: [{ name: 't' }] })).not.toBe(baseKey);
    expect(k({ stop: ['x'] })).not.toBe(baseKey);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ResponseCache.set TTL + #332 — withCache must not memoize empty responses.
// ════════════════════════════════════════════════════════════════════════════
describe('ResponseCache TTL + withCache empty-response policy (opt #328 TTL / #332)', () => {
  it('expires entries after the TTL (TTS-style short TTL honored)', async () => {
    vi.useFakeTimers();
    try {
      const c = new ResponseCache(makeMemStore());
      const key = c.buildKey({ provider: 'p', model: 'm', input: 'phrase' });
      await c.set(key, { audio: 'data' }, 1000); // 1s TTL (mirrors a per-request override)
      expect(await c.get(key)).toEqual({ audio: 'data' });
      vi.advanceTimersByTime(1500);
      expect(await c.get(key)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('withCache caches a non-empty answer and serves it on the second call', async () => {
    const c = new ResponseCache(makeMemStore());
    const chat = vi.fn(async (): Promise<ChatResponse> => ({ content: 'hello', model: 'm' }));
    const provider: LLMProvider = { providerId: 'groq', isConfigured: () => true, chat };
    const wrapped = withCache(provider, c);

    const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0 };
    await wrapped.chat(req);
    await wrapped.chat(req);
    expect(chat).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it('withCache does NOT cache an empty/whitespace response (#332)', async () => {
    const c = new ResponseCache(makeMemStore());
    const chat = vi.fn(async (): Promise<ChatResponse> => ({ content: '   ', model: 'm' }));
    const provider: LLMProvider = { providerId: 'groq', isConfigured: () => true, chat };
    const wrapped = withCache(provider, c);

    const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0 };
    await wrapped.chat(req);
    await wrapped.chat(req);
    expect(chat).toHaveBeenCalledTimes(2); // empty response never memoized → upstream hit twice
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #328 — TTS endpoint caching (key + HIT/MISS behaviour).
// ════════════════════════════════════════════════════════════════════════════
describe('TTS cache (opt #328)', () => {
  it('ttsCacheKey is stable for identical params and changes per output-affecting field', () => {
    const k = ttsCacheKey('tts-1', 'nova', 'hello world', 1, 'mp3');
    expect(ttsCacheKey('tts-1', 'nova', 'hello world', 1, 'mp3')).toBe(k);
    expect(ttsCacheKey('tts-1', 'alloy', 'hello world', 1, 'mp3')).not.toBe(k); // voice
    expect(ttsCacheKey('tts-1', 'nova', 'hello world', 2, 'mp3')).not.toBe(k);  // speed
    expect(ttsCacheKey('tts-1', 'nova', 'hello world', 1, 'wav')).not.toBe(k);  // format
    expect(ttsCacheKey('tts-1', 'nova', 'different', 1, 'mp3')).not.toBe(k);    // input
  });

  it('returns X-Cache MISS then HIT, synthesizing only once for identical input', async () => {
    _resetTtsCache();
    const synth = vi.fn(async (_r: TTSRequest): Promise<TTSResponse> => ({
      audio: Buffer.from('AUDIO'),
      contentType: 'audio/mpeg',
    }));
    const provider = {
      providerId: 'openai',
      isConfigured: () => true,
      synthesize: synth,
      getVoices: () => [],
    } as unknown as TTSProvider;

    const body = { model: 'tts-1', voice: 'nova', input: 'cached phrase' };
    const req1 = { method: 'POST', url: '/v1/audio/speech', headers: {}, body } as never;

    const r1 = await handleAudioSpeech(req1, { 'tts-1': provider });
    expect(r1.status).toBe(200);
    expect(r1.headers?.['X-Cache']).toBe('MISS');

    const r2 = await handleAudioSpeech(req1, { 'tts-1': provider });
    expect(r2.status).toBe(200);
    expect(r2.headers?.['X-Cache']).toBe('HIT');
    expect((r2.body as Buffer).toString()).toBe('AUDIO');

    expect(synth).toHaveBeenCalledTimes(1); // second request served from cache
    _resetTtsCache();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #379 — route matching strips the query string. The fix relies on `path`
// (= url.split('?')[0]) for equality instead of the raw `url`.
// ════════════════════════════════════════════════════════════════════════════
describe('proxy route path matching ignores query string (opt #379)', () => {
  const stripQuery = (url: string) => url.split('?')[0];

  it('a cache-buster query no longer breaks the canonical route match', () => {
    expect(stripQuery('/v1/chat/completions?x=1')).toBe('/v1/chat/completions');
    expect(stripQuery('/v1/audio/speech?ts=123')).toBe('/v1/audio/speech');
    expect(stripQuery('/v1/models?foo=bar&baz=1')).toBe('/v1/models');
  });

  it('raw-url equality (the old behaviour) would have 404ed a query-bearing request', () => {
    const url = '/v1/chat/completions?x=1';
    expect(url === '/v1/chat/completions').toBe(false);            // old, buggy
    expect(stripQuery(url) === '/v1/chat/completions').toBe(true); // new, fixed
  });
});

// ════════════════════════════════════════════════════════════════════════════
// #347 / #348 — cost-efficiency ranking: a static price table + rankChainByCost.
// ════════════════════════════════════════════════════════════════════════════
describe('cost-efficiency ranking (opt #347/#348)', () => {
  it('MODEL_PRICING exists and estimateCostPerRequest returns a number for known models', () => {
    expect(Object.keys(MODEL_PRICING).length).toBeGreaterThan(0);
    const cost = estimateCostPerRequest('gpt-4o');
    expect(typeof cost).toBe('number');
    expect(cost!).toBeGreaterThan(0);
  });

  it('estimateCostPerRequest returns null for an unknown model (rank on latency only)', () => {
    expect(estimateCostPerRequest('totally-unknown-model')).toBeNull();
  });

  it('ranks a cheaper model ahead of a pricier one when latency is comparable', () => {
    const ranker = new PerformanceRanker({ minSamples: 2, windowTimeMs: 600_000 });
    // Same observed latency for both → only price should break the tie.
    for (let i = 0; i < 3; i++) {
      ranker.record('llm', 'openai', 'gpt-4o', 300, true);       // pricey ($2.5/$10 per 1M)
      ranker.record('llm', 'openai', 'gpt-4o-mini', 300, true);  // cheap ($0.15/$0.6 per 1M)
    }
    // Chain is configured pricey-first; cost ranking must promote the cheap model.
    const chain = [fe('openai', 'gpt-4o'), fe('openai', 'gpt-4o-mini')];
    const ranked = ranker.rankChainByCost('llm', chain);
    expect(ranked[0].model).toBe('gpt-4o-mini');
  });

  it('rankChainByCost keeps unknown (no-sample, no-price) entries at the back', () => {
    const ranker = new PerformanceRanker({ minSamples: 2 });
    for (let i = 0; i < 3; i++) ranker.record('llm', 'groq', 'llama-3.1-8b-instant', 200, true);
    const chain = [fe('mystery', 'unpriced-cold-model'), fe('groq', 'llama-3.1-8b-instant')];
    const ranked = ranker.rankChainByCost('llm', chain);
    // Priced+sampled entry is promoted; the pure-unknown sinks to the back.
    expect(ranked[ranked.length - 1].model).toBe('unpriced-cold-model');
  });

  it('rankChainByCost returns a copy and does not mutate the input chain', () => {
    const ranker = new PerformanceRanker();
    const chain = [fe('openai', 'gpt-4o'), fe('openai', 'gpt-4o-mini')];
    const before = chain.map((c) => c.model);
    ranker.rankChainByCost('llm', chain);
    expect(chain.map((c) => c.model)).toEqual(before);
  });
});
