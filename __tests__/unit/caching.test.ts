import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResponseCache } from '../src/caching/response-cache';
import { withCache } from '../src/caching/with-cache';
import type { KvStore } from '../src/deps';
import type { LLMProvider, ChatRequest, ChatResponse } from '../src/providers/types';

function createMemoryKvStore(): KvStore {
  const data = new Map<string, { value: string; expiry?: number }>();
  return {
    get: async (key) => {
      const entry = data.get(key);
      if (!entry) return null;
      if (entry.expiry && Date.now() > entry.expiry) { data.delete(key); return null; }
      return entry.value;
    },
    set: async (key, value, ttlSecs?) => {
      data.set(key, { value, expiry: ttlSecs ? Date.now() + ttlSecs * 1000 : undefined });
    },
    del: async (key) => { data.delete(key); },
    scan: async (pattern, callback) => {
      const prefix = pattern.replace(/\*/g, '');
      const matchingKeys = [...data.keys()].filter((k) => k.startsWith(prefix));
      if (callback) {
        callback(matchingKeys);
      }
      return matchingKeys.length;
    },
  };
}

describe('ResponseCache', () => {
  let kvStore: KvStore;
  let cache: ResponseCache;

  beforeEach(() => {
    kvStore = createMemoryKvStore();
    cache = new ResponseCache(kvStore);
  });

  it('cache miss returns null', async () => {
    const result = await cache.get('nonexistent');
    expect(result).toBeNull();
  });

  it('cache hit after set', async () => {
    const key = cache.buildKey({ provider: 'openai', model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] });
    await cache.set(key, { content: 'hello', model: 'gpt-4' });
    const result = await cache.get<{ content: string }>(key);
    expect(result?.content).toBe('hello');
  });

  it('same params produce same key', () => {
    const key1 = cache.buildKey({ provider: 'openai', model: 'gpt-4', messages: [{ role: 'user', content: 'test' }] });
    const key2 = cache.buildKey({ provider: 'openai', model: 'gpt-4', messages: [{ role: 'user', content: 'test' }] });
    expect(key1).toBe(key2);
  });

  it('different params produce different keys', () => {
    const key1 = cache.buildKey({ provider: 'openai', model: 'gpt-4', messages: [{ role: 'user', content: 'a' }] });
    const key2 = cache.buildKey({ provider: 'openai', model: 'gpt-4', messages: [{ role: 'user', content: 'b' }] });
    expect(key1).not.toBe(key2);
  });

  it('tracks hit/miss stats', async () => {
    const key = cache.buildKey({ provider: 'test', model: 'm', messages: [] });
    await cache.get(key); // miss
    await cache.set(key, 'data');
    await cache.get(key); // hit

    const stats = cache.stats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);
  });

  it('invalidates by pattern', async () => {
    const key1 = 'cache:abc123';
    const key2 = 'cache:def456';
    await cache.set(key1, 'data1');
    await cache.set(key2, 'data2');

    const invalidated = await cache.invalidate('*'); // all cache keys
    expect(invalidated).toBeGreaterThanOrEqual(0);
    expect(await cache.get(key1)).toBeNull();
    expect(await cache.get(key2)).toBeNull();
  });
});

describe('withCache', () => {
  let kvStore: KvStore;
  let cache: ResponseCache;
  let mockProvider: LLMProvider;

  beforeEach(() => {
    kvStore = createMemoryKvStore();
    cache = new ResponseCache(kvStore);
    mockProvider = {
      providerId: 'test',
      isConfigured: () => true,
      chat: vi.fn().mockResolvedValue({
        content: 'response',
        model: 'test-model',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      } as ChatResponse),
    };
  });

  it('caches deterministic requests (temperature=0)', async () => {
    const cached = withCache(mockProvider, cache);
    const req: ChatRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0,
    };

    await cached.chat(req);
    await cached.chat(req); // second call

    expect(mockProvider.chat).toHaveBeenCalledTimes(1); // only once
  });

  it('does not cache non-deterministic requests', async () => {
    const cached = withCache(mockProvider, cache);
    const req: ChatRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.7,
    };

    await cached.chat(req);
    await cached.chat(req);

    expect(mockProvider.chat).toHaveBeenCalledTimes(2);
  });

  it('caches when temperature is undefined', async () => {
    const cached = withCache(mockProvider, cache);
    const req: ChatRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    };

    await cached.chat(req);
    await cached.chat(req);

    expect(mockProvider.chat).toHaveBeenCalledTimes(1);
  });

  it('respects custom condition', async () => {
    const cached = withCache(mockProvider, cache, {
      condition: () => true, // always cache
    });
    const req: ChatRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.9,
    };

    await cached.chat(req);
    await cached.chat(req);

    expect(mockProvider.chat).toHaveBeenCalledTimes(1);
  });
});
