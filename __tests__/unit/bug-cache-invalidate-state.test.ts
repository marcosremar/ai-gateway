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

describe('ResponseCache invalidate state consistency', () => {
  it('invalidate updates _size after deleting entries', async () => {
    const kvStore = createMemoryKvStore();
    const cache = new ResponseCache(kvStore, { prefix: 'test:', maxSize: 100 });

    // Add 5 entries with known keys
    for (let i = 0; i < 5; i++) {
      await cache.set(`test:key-${i}`, `value-${i}`, 60_000);
    }
    expect(cache.stats().size).toBe(5);

    // Invalidate all — pattern '' matches all 'test:*' keys
    const count = await cache.invalidate('');
    expect(count).toBe(5);
    expect(cache.stats().size).toBe(0);
  });

  it('partial invalidate updates _size correctly', async () => {
    const kvStore = createMemoryKvStore();
    const cache = new ResponseCache(kvStore, { prefix: 'test:', maxSize: 100 });

    await cache.set('test:a', 'val-a', 60_000);
    await cache.set('test:b', 'val-b', 60_000);
    await cache.set('test:c', 'val-c', 60_000);
    expect(cache.stats().size).toBe(3);

    // Invalidate only 'test:a' key
    const count = await cache.invalidate('a');
    expect(count).toBe(1);
    expect(cache.stats().size).toBe(2);
  });

  it('invalidate does not corrupt subsequent LRU eviction', async () => {
    const kvStore = createMemoryKvStore();
    const cache = new ResponseCache(kvStore, { prefix: 'evict:', maxSize: 3 });

    await cache.set('evict:a', 'val-a', 60_000);
    await cache.set('evict:b', 'val-b', 60_000);
    await cache.set('evict:c', 'val-c', 60_000);
    expect(cache.stats().size).toBe(3);

    // Invalidate 2 entries — size should drop to 1
    await cache.invalidate('a');
    await cache.invalidate('b');
    expect(cache.stats().size).toBe(1);

    // Before the fix, _size was still 3, so adding 1 more entry would trigger
    // eviction even though only 1 entry exists. After fix, we can add up to 3.
    await cache.set('evict:d', 'val-d', 60_000);
    await cache.set('evict:e', 'val-e', 60_000);
    expect(cache.stats().size).toBe(3);

    // evict:c is the oldest — adding evict:f evicts it
    await cache.set('evict:f', 'val-f', 60_000);
    expect(cache.stats().size).toBe(3);

    // evict:c was evicted; d, e, f remain
    expect(await cache.get('evict:c')).toBeNull();
    expect(await cache.get('evict:d')).toBe('val-d');
    expect(await cache.get('evict:e')).toBe('val-e');
    expect(await cache.get('evict:f')).toBe('val-f');
  });
});
