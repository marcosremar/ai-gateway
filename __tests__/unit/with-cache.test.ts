/**
 * Unit tests for src/caching/with-cache.ts
 *
 * Covers:
 *  - cache miss → calls provider, stores result, returns response
 *  - cache hit → returns cached value without calling provider
 *  - default condition: temperature undefined → cacheable
 *  - default condition: temperature 0 → cacheable
 *  - default condition: temperature > 0 → not cacheable (bypass cache)
 *  - custom condition override (returns false → always bypass)
 *  - custom condition override (returns true → always cache)
 *  - cache.get() throws → logs warning, falls through to provider
 *  - cache.set() throws → logs warning, still returns the live response
 *  - providerId proxied from inner provider
 *  - isConfigured() proxied from inner provider
 *  - withApiKey() wraps the new provider with caching
 *  - withConfig() wraps the new provider with caching
 *  - withApiKey absent on inner provider → absent on wrapper
 *  - withConfig absent on inner provider → absent on wrapper
 *  - cache.set() receives the ttlMs from opts
 *  - identical requests share the same cache key (deterministic)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withCache, type WithCacheOptions } from '../../src/caching/with-cache';
import type { LLMProvider, ChatRequest, ChatResponse } from '../../src/providers/types';
import type { ResponseCache } from '../../src/caching/response-cache';

// ── Helpers ───────────────────────────────────────────────────────────────────

const MOCK_RESPONSE: ChatResponse = {
  content: 'Hello from LLM',
  model: 'gpt-4o',
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
};

const BASE_REQUEST: ChatRequest = {
  messages: [{ role: 'user', content: 'Hello' }],
  model: 'gpt-4o',
  temperature: 0,
};

function makeProvider(overrides: Partial<LLMProvider> = {}): LLMProvider & { chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn(async (_req: ChatRequest): Promise<ChatResponse> => MOCK_RESPONSE);
  return {
    providerId: 'mock-llm',
    isConfigured: () => true,
    chat,
    ...overrides,
  } as LLMProvider & { chat: ReturnType<typeof vi.fn> };
}

function makeCache(overrides: Partial<ResponseCache> = {}): ResponseCache {
  return {
    buildKey: vi.fn((_p) => 'cache-key-abc'),
    get: vi.fn(async (_k: string) => null),
    set: vi.fn(async () => {}),
    ...overrides,
  } as unknown as ResponseCache;
}

// ── Cache miss / hit ──────────────────────────────────────────────────────────

describe('withCache — cache miss', () => {
  it('calls the underlying provider when cache returns null', async () => {
    const provider = makeProvider();
    const cache = makeCache({ get: vi.fn(async () => null) });
    const wrapped = withCache(provider, cache);

    const result = await wrapped.chat(BASE_REQUEST);

    expect(provider.chat).toHaveBeenCalledOnce();
    expect(result).toEqual(MOCK_RESPONSE);
  });

  it('stores the provider response in cache after a miss', async () => {
    const provider = makeProvider();
    const setCalled = vi.fn();
    const cache = makeCache({
      get: vi.fn(async () => null),
      set: vi.fn(async (key, value, ttl) => { setCalled(key, value, ttl); }),
    });
    const wrapped = withCache(provider, cache);

    await wrapped.chat(BASE_REQUEST);

    expect(setCalled).toHaveBeenCalledOnce();
    const [, storedValue] = setCalled.mock.calls[0];
    expect(storedValue).toEqual(MOCK_RESPONSE);
  });

  it('passes ttlMs from opts to cache.set()', async () => {
    const provider = makeProvider();
    const cache = makeCache({ get: vi.fn(async () => null) });
    const wrapped = withCache(provider, cache, { ttlMs: 60_000 });

    await wrapped.chat(BASE_REQUEST);

    const setMock = cache.set as ReturnType<typeof vi.fn>;
    const [, , ttl] = setMock.mock.calls[0];
    expect(ttl).toBe(60_000);
  });
});

describe('withCache — cache hit', () => {
  it('returns cached value without calling the provider', async () => {
    const provider = makeProvider();
    const cachedResponse: ChatResponse = { content: 'Cached!', model: 'gpt-4o' };
    const cache = makeCache({ get: vi.fn(async () => cachedResponse) });
    const wrapped = withCache(provider, cache);

    const result = await wrapped.chat(BASE_REQUEST);

    expect(provider.chat).not.toHaveBeenCalled();
    expect(result).toEqual(cachedResponse);
  });

  it('does not call cache.set() on a cache hit', async () => {
    const provider = makeProvider();
    const cache = makeCache({ get: vi.fn(async () => MOCK_RESPONSE) });
    const wrapped = withCache(provider, cache);

    await wrapped.chat(BASE_REQUEST);

    const setMock = cache.set as ReturnType<typeof vi.fn>;
    expect(setMock).not.toHaveBeenCalled();
  });
});

// ── Default caching condition ─────────────────────────────────────────────────

describe('withCache — default condition (temperature)', () => {
  it('caches when temperature is undefined', async () => {
    const provider = makeProvider();
    const cache = makeCache({ get: vi.fn(async () => null) });
    const wrapped = withCache(provider, cache);

    await wrapped.chat({ ...BASE_REQUEST, temperature: undefined });

    expect(cache.buildKey).toHaveBeenCalled();
  });

  it('caches when temperature is 0', async () => {
    const provider = makeProvider();
    const cache = makeCache({ get: vi.fn(async () => null) });
    const wrapped = withCache(provider, cache);

    await wrapped.chat({ ...BASE_REQUEST, temperature: 0 });

    expect(cache.buildKey).toHaveBeenCalled();
  });

  it('bypasses cache when temperature > 0', async () => {
    const provider = makeProvider();
    const cache = makeCache();
    const wrapped = withCache(provider, cache);

    await wrapped.chat({ ...BASE_REQUEST, temperature: 0.7 });

    expect(cache.buildKey).not.toHaveBeenCalled();
    expect(provider.chat).toHaveBeenCalledOnce();
  });

  it('bypasses cache when temperature is 1', async () => {
    const provider = makeProvider();
    const cache = makeCache();
    const wrapped = withCache(provider, cache);

    await wrapped.chat({ ...BASE_REQUEST, temperature: 1 });

    expect(cache.buildKey).not.toHaveBeenCalled();
  });
});

// ── Custom condition ──────────────────────────────────────────────────────────

describe('withCache — custom condition', () => {
  it('always bypasses cache when condition returns false', async () => {
    const provider = makeProvider();
    const cache = makeCache();
    const opts: WithCacheOptions = { condition: () => false };
    const wrapped = withCache(provider, cache, opts);

    await wrapped.chat({ ...BASE_REQUEST, temperature: 0 });

    expect(cache.buildKey).not.toHaveBeenCalled();
    expect(provider.chat).toHaveBeenCalled();
  });

  it('always caches when condition returns true (even for high temperature)', async () => {
    const provider = makeProvider();
    const cache = makeCache({ get: vi.fn(async () => null) });
    const opts: WithCacheOptions = { condition: () => true };
    const wrapped = withCache(provider, cache, opts);

    await wrapped.chat({ ...BASE_REQUEST, temperature: 0.9 });

    expect(cache.buildKey).toHaveBeenCalled();
  });

  it('condition receives the full ChatRequest', async () => {
    const conditionFn = vi.fn(() => false);
    const provider = makeProvider();
    const cache = makeCache();
    const wrapped = withCache(provider, cache, { condition: conditionFn });
    const req: ChatRequest = { ...BASE_REQUEST, temperature: 0.5, model: 'gpt-4o-mini' };

    await wrapped.chat(req);

    expect(conditionFn).toHaveBeenCalledWith(req);
  });
});

// ── Error resilience ──────────────────────────────────────────────────────────

describe('withCache — error resilience', () => {
  it('falls through to provider when cache.get() throws', async () => {
    const provider = makeProvider();
    const warnSpy = vi.fn();
    const cache = makeCache({
      get: vi.fn(async () => { throw new Error('Redis down'); }),
    });
    const wrapped = withCache(provider, cache, { logger: { warn: warnSpy } });

    const result = await wrapped.chat(BASE_REQUEST);

    expect(result).toEqual(MOCK_RESPONSE);
    expect(provider.chat).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cache.get failed'));
  });

  it('still returns the live response when cache.set() throws', async () => {
    const provider = makeProvider();
    const warnSpy = vi.fn();
    const cache = makeCache({
      get: vi.fn(async () => null),
      set: vi.fn(async () => { throw new Error('disk full'); }),
    });
    const wrapped = withCache(provider, cache, { logger: { warn: warnSpy } });

    const result = await wrapped.chat(BASE_REQUEST);

    expect(result).toEqual(MOCK_RESPONSE);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cache.set failed'));
  });

  it('warns with error message string when non-Error is thrown from cache.get()', async () => {
    const provider = makeProvider();
    const warnSpy = vi.fn();
    const cache = makeCache({
      get: vi.fn(async () => { throw 'string error'; }),
    });
    const wrapped = withCache(provider, cache, { logger: { warn: warnSpy } });

    await wrapped.chat(BASE_REQUEST);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('string error'));
  });
});

// ── Provider proxy ────────────────────────────────────────────────────────────

describe('withCache — provider proxy', () => {
  it('exposes the inner provider\'s providerId', () => {
    const provider = makeProvider({ providerId: 'groq' });
    const wrapped = withCache(provider, makeCache());
    expect(wrapped.providerId).toBe('groq');
  });

  it('proxies isConfigured() to inner provider', () => {
    const provider = makeProvider({ isConfigured: () => false });
    const wrapped = withCache(provider, makeCache());
    expect(wrapped.isConfigured()).toBe(false);
  });

  it('withApiKey is undefined on wrapper when absent on inner provider', () => {
    const provider = makeProvider();
    // makeProvider does not set withApiKey
    const wrapped = withCache(provider, makeCache());
    expect(wrapped.withApiKey).toBeUndefined();
  });

  it('withConfig is undefined on wrapper when absent on inner provider', () => {
    const provider = makeProvider();
    const wrapped = withCache(provider, makeCache());
    expect(wrapped.withConfig).toBeUndefined();
  });

  it('withApiKey wraps the keyed provider with caching', async () => {
    const keyedProvider = makeProvider({ providerId: 'groq-with-key' });
    const provider = makeProvider({
      withApiKey: (_key: string) => keyedProvider,
    });
    const cache = makeCache({ get: vi.fn(async () => null) });
    const wrapped = withCache(provider, cache);

    const withKey = wrapped.withApiKey!('sk-test-key');
    expect(withKey).toBeDefined();

    // Should delegate to the keyed provider
    const result = await withKey.chat(BASE_REQUEST);
    expect(keyedProvider.chat).toHaveBeenCalled();
    expect(result).toEqual(MOCK_RESPONSE);
  });

  it('withConfig wraps the configured provider with caching', async () => {
    const configuredProvider = makeProvider({ providerId: 'groq-configured' });
    const provider = makeProvider({
      withConfig: (_opts: { apiKey: string; baseURL?: string }) => configuredProvider,
    });
    const cache = makeCache({ get: vi.fn(async () => null) });
    const wrapped = withCache(provider, cache);

    const withCfg = wrapped.withConfig!({ apiKey: 'sk-config', baseURL: 'https://api.groq.com' });
    expect(withCfg).toBeDefined();

    const result = await withCfg.chat(BASE_REQUEST);
    expect(configuredProvider.chat).toHaveBeenCalled();
    expect(result).toEqual(MOCK_RESPONSE);
  });
});

// ── Deterministic key ─────────────────────────────────────────────────────────

describe('withCache — deterministic cache key', () => {
  it('calls buildKey with provider, model, messages, and temperature', async () => {
    const provider = makeProvider({ providerId: 'groq' });
    const cache = makeCache({ get: vi.fn(async () => null) });
    const wrapped = withCache(provider, cache);

    await wrapped.chat(BASE_REQUEST);

    const buildKeyMock = cache.buildKey as ReturnType<typeof vi.fn>;
    expect(buildKeyMock).toHaveBeenCalledWith({
      provider: 'groq',
      model: BASE_REQUEST.model,
      messages: BASE_REQUEST.messages,
      temperature: BASE_REQUEST.temperature,
    });
  });

  it('uses same key for identical requests (cache hit on second call)', async () => {
    const provider = makeProvider();
    let stored: ChatResponse | null = null;
    const cache: ResponseCache = {
      buildKey: (_p) => 'fixed-key',
      get: vi.fn(async () => stored),
      set: vi.fn(async (_k, value) => { stored = value as ChatResponse; }),
    } as unknown as ResponseCache;
    const wrapped = withCache(provider, cache);

    await wrapped.chat(BASE_REQUEST);
    await wrapped.chat(BASE_REQUEST);

    // Second call should be served from cache
    expect(provider.chat).toHaveBeenCalledOnce();
  });
});
