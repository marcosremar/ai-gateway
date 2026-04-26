import { describe, it, expect, beforeEach } from 'vitest';
import { ResponseCache } from '../../src/caching/response-cache';
import type { KvStore } from '../../src/deps';

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

describe('ResponseCache _size accounting', () => {
  it('does not double-count _size when overwriting an existing key', async () => {
    const kvStore = createMemoryKvStore();
    const cache = new ResponseCache(kvStore, { maxSize: 100 });

    const key = 'cache:testkey';

    // First set
    await cache.set(key, 'value1', 60_000);
    expect(cache.stats().size).toBe(1);

    // Second set of the SAME key — should still be size 1, not 2
    await cache.set(key, 'value2', 60_000);
    expect(cache.stats().size).toBe(1);
  });

  it('tracks _size correctly after multiple overwrites', async () => {
    const kvStore = createMemoryKvStore();
    const cache = new ResponseCache(kvStore, { maxSize: 100 });

    const key = 'cache:overwrite-key';

    await cache.set(key, 'v1', 60_000);
    expect(cache.stats().size).toBe(1);

    await cache.set(key, 'v2', 60_000);
    expect(cache.stats().size).toBe(1);

    await cache.set(key, 'v3', 60_000);
    expect(cache.stats().size).toBe(1);

    // Verify it still returns the latest value
    const result = await cache.get<string>(key);
    expect(result).toBe('v3');
  });

  it('eviction works correctly with overwrites not inflating size', async () => {
    const kvStore = createMemoryKvStore();
    const cache = new ResponseCache(kvStore, { maxSize: 3 });

    // Fill to capacity
    await cache.set('cache:a', 'val-a', 60_000);
    await cache.set('cache:b', 'val-b', 60_000);
    await cache.set('cache:c', 'val-c', 60_000);
    expect(cache.stats().size).toBe(3);

    // Overwrite existing key 'a' — should NOT trigger eviction
    await cache.set('cache:a', 'val-a-updated', 60_000);
    expect(cache.stats().size).toBe(3);

    // Add a new key — should trigger eviction of the oldest
    await cache.set('cache:d', 'val-d', 60_000);
    expect(cache.stats().size).toBe(3);

    // 'a' was the oldest (overwritten but still oldest), 'b' should be evicted next
    const aResult = await cache.get<string>('cache:a');
    expect(aResult).toBe('val-a-updated');
  });
});
