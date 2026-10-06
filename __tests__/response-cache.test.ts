// ── ResponseCache unit tests ──────────────────────────────────────────────────
// Covers: buildKey determinism, TTL expiry, LRU eviction, hit/miss stats,
// invalidateKey/Provider/Model, per-request enabled=false override.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ResponseCache } from '../src/caching/response-cache';
import type { KvStore } from '../src/platform/deps';

// ── In-memory KvStore stub ────────────────────────────────────────────────────
class MemoryKvStore implements KvStore {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, _ttlSecs?: number): Promise<void> {
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async scan(pattern: string, callback?: (keys: string[]) => boolean | void): Promise<number> {
    const prefix = pattern.replace(/\*$/, '');
    const keys = [...this.store.keys()].filter(k => k.startsWith(prefix));
    if (callback) callback(keys);
    return keys.length;
  }

  size(): number { return this.store.size; }
  has(key: string): boolean { return this.store.has(key); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCache(opts?: ConstructorParameters<typeof ResponseCache>[1]) {
  const store = new MemoryKvStore();
  const cache = new ResponseCache(store, opts);
  return { cache, store };
}

// ── buildKey ──────────────────────────────────────────────────────────────────

describe('ResponseCache.buildKey', () => {
  it('returns deterministic SHA-256 key for same params', () => {
    const { cache } = makeCache();
    const params = { provider: 'openai', model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    expect(cache.buildKey(params)).toBe(cache.buildKey(params));
  });

  it('differs when provider changes', () => {
    const { cache } = makeCache();
    const base = { model: 'gpt-4', messages: [] as unknown[] };
    const k1 = cache.buildKey({ provider: 'openai', ...base });
    const k2 = cache.buildKey({ provider: 'groq', ...base });
    expect(k1).not.toBe(k2);
  });

  it('differs when messages change', () => {
    const { cache } = makeCache();
    const base = { provider: 'openai', model: 'gpt-4o' };
    const k1 = cache.buildKey({ ...base, messages: [{ role: 'user', content: 'hello' }] });
    const k2 = cache.buildKey({ ...base, messages: [{ role: 'user', content: 'world' }] });
    expect(k1).not.toBe(k2);
  });

  it('uses custom prefix when configured', () => {
    const { cache } = makeCache({ prefix: 'myns:' });
    const key = cache.buildKey({ provider: 'openai', model: 'gpt-4o' });
    expect(key.startsWith('myns:')).toBe(true);
  });

  it('defaults to "cache:" prefix', () => {
    const { cache } = makeCache();
    const key = cache.buildKey({ provider: 'openai', model: 'gpt-4o' });
    expect(key.startsWith('cache:')).toBe(true);
  });

  it('is order-independent for object keys', () => {
    const { cache } = makeCache();
    // JSON.stringify sorts by the explicit key order in buildKey, so two calls
    // with the same values produce the same hash regardless of JS object creation order.
    const k1 = cache.buildKey({ provider: 'openai', model: 'gpt-4', temperature: 0.7 });
    const k2 = cache.buildKey({ model: 'gpt-4', provider: 'openai', temperature: 0.7 });
    expect(k1).toBe(k2);
  });
});

describe('ResponseCache.buildCustomKey', () => {
  it('returns a key with "custom:" segment', () => {
    const { cache } = makeCache();
    const key = cache.buildCustomKey('my-custom-key');
    expect(key).toContain('custom:');
  });

  it('produces the same key for the same input', () => {
    const { cache } = makeCache();
    expect(cache.buildCustomKey('abc')).toBe(cache.buildCustomKey('abc'));
  });

  it('produces different keys for different inputs', () => {
    const { cache } = makeCache();
    expect(cache.buildCustomKey('abc')).not.toBe(cache.buildCustomKey('def'));
  });
});

// ── get / set round-trip ──────────────────────────────────────────────────────

describe('ResponseCache get/set', () => {
  it('returns null for missing key', async () => {
    const { cache } = makeCache();
    expect(await cache.get('nonexistent')).toBeNull();
  });

  it('returns stored value immediately after set', async () => {
    const { cache } = makeCache();
    const key = cache.buildKey({ provider: 'openai', model: 'gpt-4o' });
    await cache.set(key, { text: 'hello world' });
    const result = await cache.get<{ text: string }>(key);
    expect(result).toEqual({ text: 'hello world' });
  });

  it('returns null when TTL has expired', async () => {
    const { cache } = makeCache({ defaultTtlMs: 50 });
    const key = cache.buildKey({ provider: 'openai', model: 'gpt-4o' });
    await cache.set(key, 'value');
    // Advance time past TTL using fake timer
    const origDateNow = Date.now;
    Date.now = () => origDateNow() + 200; // 200ms in the future
    const result = await cache.get(key);
    Date.now = origDateNow;
    expect(result).toBeNull();
  });

  it('returns null when options.enabled is false', async () => {
    const { cache } = makeCache();
    const key = cache.buildKey({ provider: 'openai', model: 'gpt-4o' });
    await cache.set(key, 'value');
    const result = await cache.get(key, { enabled: false });
    expect(result).toBeNull();
  });

  it('respects custom TTL passed to set', async () => {
    const { cache } = makeCache({ defaultTtlMs: 300_000 });
    const key = cache.buildKey({ provider: 'openai', model: 'gpt-4o' });
    // Set with short custom TTL
    await cache.set(key, 'short-lived', 10);
    const origDateNow = Date.now;
    Date.now = () => origDateNow() + 200;
    const result = await cache.get(key);
    Date.now = origDateNow;
    expect(result).toBeNull();
  });

  it('overwrites previous value on re-set', async () => {
    const { cache } = makeCache();
    const key = cache.buildKey({ provider: 'groq', model: 'llama-3' });
    await cache.set(key, 'first');
    await cache.set(key, 'second');
    expect(await cache.get<string>(key)).toBe('second');
  });
});

// ── LRU eviction ─────────────────────────────────────────────────────────────

describe('ResponseCache LRU eviction', () => {
  it('evicts oldest entry when maxSize is exceeded', async () => {
    const { cache } = makeCache({ maxSize: 3 });

    const keys = Array.from({ length: 4 }, (_, i) =>
      cache.buildKey({ provider: 'openai', model: `m${i}` }),
    );
    for (let i = 0; i < 4; i++) {
      await cache.set(keys[i], `value${i}`);
    }

    // The first key should have been evicted (LRU)
    expect(await cache.get(keys[0])).toBeNull();
    // The last 3 should still be accessible
    for (let i = 1; i <= 3; i++) {
      expect(await cache.get<string>(keys[i])).toBe(`value${i}`);
    }
  });

  it('promotes a key on get so it is not evicted first', async () => {
    const { cache } = makeCache({ maxSize: 2 });
    const k1 = cache.buildKey({ provider: 'openai', model: 'a' });
    const k2 = cache.buildKey({ provider: 'openai', model: 'b' });
    await cache.set(k1, 'v1');
    await cache.set(k2, 'v2');
    // Access k1 — makes it recently used
    await cache.get(k1);
    // Adding k3 should evict k2 (oldest unused), not k1
    const k3 = cache.buildKey({ provider: 'openai', model: 'c' });
    await cache.set(k3, 'v3');
    expect(await cache.get(k1)).toBe('v1');
    expect(await cache.get(k2)).toBeNull();
  });

  it('does not evict when overwriting an existing key', async () => {
    const { cache } = makeCache({ maxSize: 2 });
    const k1 = cache.buildKey({ provider: 'openai', model: 'a' });
    const k2 = cache.buildKey({ provider: 'openai', model: 'b' });
    await cache.set(k1, 'v1');
    await cache.set(k2, 'v2');
    // Overwrite k1 — should NOT evict k2
    await cache.set(k1, 'v1-new');
    expect(await cache.get<string>(k2)).toBe('v2');
    expect(await cache.get<string>(k1)).toBe('v1-new');
  });

  it('tracks eviction count in stats', async () => {
    const { cache } = makeCache({ maxSize: 1 });
    const k1 = cache.buildKey({ provider: 'openai', model: 'a' });
    const k2 = cache.buildKey({ provider: 'openai', model: 'b' });
    await cache.set(k1, 'v1');
    await cache.set(k2, 'v2'); // evicts k1
    expect(cache.stats().evictions).toBe(1);
  });
});

// ── hit / miss stats ──────────────────────────────────────────────────────────

describe('ResponseCache stats', () => {
  it('counts hits and misses correctly', async () => {
    const { cache } = makeCache();
    const key = cache.buildKey({ provider: 'openai', model: 'gpt-4o' });
    await cache.get(key); // miss
    await cache.set(key, 'val');
    await cache.get(key); // hit
    await cache.get(key); // hit

    const s = cache.stats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
    expect(s.total).toBe(3);
    expect(s.hitRate).toBeCloseTo(66.67, 1);
  });

  it('counts a disabled-request as a miss', async () => {
    const { cache } = makeCache();
    const key = cache.buildKey({ provider: 'openai', model: 'gpt-4o' });
    await cache.set(key, 'val');
    await cache.get(key, { enabled: false });
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().hits).toBe(0);
  });

  it('hitRate is 0 when there are no requests', () => {
    const { cache } = makeCache();
    expect(cache.stats().hitRate).toBe(0);
  });

  it('resetStats clears hit/miss/evictions counters', async () => {
    const { cache } = makeCache();
    const key = cache.buildKey({ provider: 'openai', model: 'gpt-4o' });
    await cache.set(key, 'val');
    await cache.get(key);
    cache.resetStats();
    const s = cache.stats();
    expect(s.hits).toBe(0);
    expect(s.misses).toBe(0);
    expect(s.total).toBe(0);
  });
});

// ── invalidateKey ─────────────────────────────────────────────────────────────

describe('ResponseCache.invalidateKey', () => {
  it('removes the entry from the store', async () => {
    const { cache, store } = makeCache();
    const key = cache.buildKey({ provider: 'openai', model: 'gpt-4o' });
    await cache.set(key, 'val');
    expect(store.has(key)).toBe(true);
    await cache.invalidateKey(key);
    expect(await cache.get(key)).toBeNull();
    expect(store.has(key)).toBe(false);
  });

  it('is a no-op for non-existent key', async () => {
    const { cache } = makeCache();
    await expect(cache.invalidateKey('ghost-key')).resolves.not.toThrow();
  });
});

// ── invalidateProvider ────────────────────────────────────────────────────────

describe('ResponseCache.invalidateProvider', () => {
  it('removes all entries for a provider', async () => {
    const { cache } = makeCache();
    const k1 = cache.buildKey({ provider: 'openai', model: 'gpt-4o' });
    const k2 = cache.buildKey({ provider: 'openai', model: 'gpt-3.5' });
    const k3 = cache.buildKey({ provider: 'groq', model: 'llama-3' });
    await cache.set(k1, 'a');
    await cache.set(k2, 'b');
    await cache.set(k3, 'c');

    const count = await cache.invalidateProvider('openai');
    expect(count).toBe(2);
    expect(await cache.get(k1)).toBeNull();
    expect(await cache.get(k2)).toBeNull();
    expect(await cache.get<string>(k3)).toBe('c');
  });

  it('returns 0 when no entries match', async () => {
    const { cache } = makeCache();
    const count = await cache.invalidateProvider('nonexistent');
    expect(count).toBe(0);
  });
});

// ── invalidateModel ───────────────────────────────────────────────────────────

describe('ResponseCache.invalidateModel', () => {
  it('removes only entries for the specific provider+model pair', async () => {
    const { cache } = makeCache();
    const k1 = cache.buildKey({ provider: 'openai', model: 'gpt-4o' });
    const k2 = cache.buildKey({ provider: 'openai', model: 'gpt-3.5' });
    await cache.set(k1, 'gpt4-value');
    await cache.set(k2, 'gpt35-value');

    const count = await cache.invalidateModel('openai', 'gpt-4o');
    expect(count).toBe(1);
    expect(await cache.get(k1)).toBeNull();
    expect(await cache.get<string>(k2)).toBe('gpt35-value');
  });

  it('returns 0 when no entries match', async () => {
    const { cache } = makeCache();
    const count = await cache.invalidateModel('openai', 'nonexistent-model');
    expect(count).toBe(0);
  });
});

// ── invalidate (pattern) ──────────────────────────────────────────────────────

describe('ResponseCache.invalidate (pattern)', () => {
  it('removes keys matching a prefix pattern', async () => {
    const { cache } = makeCache({ prefix: 'c:' });
    // Manually set raw keys so we can scan them reliably
    const store = (cache as unknown as { store: MemoryKvStore }).store as MemoryKvStore;
    await store.set('c:openai:1', JSON.stringify({ data: 'v1', metadata: { expiresAt: Date.now() + 99999 } }));
    await store.set('c:openai:2', JSON.stringify({ data: 'v2', metadata: { expiresAt: Date.now() + 99999 } }));
    await store.set('c:groq:1',   JSON.stringify({ data: 'v3', metadata: { expiresAt: Date.now() + 99999 } }));

    const count = await cache.invalidate('openai:');
    expect(count).toBe(2);
    expect(store.has('c:openai:1')).toBe(false);
    expect(store.has('c:openai:2')).toBe(false);
    expect(store.has('c:groq:1')).toBe(true);
  });
});

// ── semantic flag passthrough ─────────────────────────────────────────────────

describe('ResponseCache semantic config', () => {
  it('isSemanticEnabled returns false by default', () => {
    const { cache } = makeCache();
    expect(cache.isSemanticEnabled()).toBe(false);
  });

  it('isSemanticEnabled returns true when semantic:true', () => {
    const { cache } = makeCache({ semantic: true });
    expect(cache.isSemanticEnabled()).toBe(true);
  });

  it('getSimilarityThreshold returns custom threshold', () => {
    const { cache } = makeCache({ similarityThreshold: 0.85 });
    expect(cache.getSimilarityThreshold()).toBe(0.85);
  });

  it('getSimilarityThreshold defaults to 0.9', () => {
    const { cache } = makeCache();
    expect(cache.getSimilarityThreshold()).toBe(0.9);
  });
});

// ── size tracking ─────────────────────────────────────────────────────────────

describe('ResponseCache size tracking', () => {
  it('size increases with each new entry', async () => {
    const { cache } = makeCache();
    expect(cache.stats().size).toBe(0);
    const k1 = cache.buildKey({ provider: 'openai', model: 'a' });
    await cache.set(k1, 'v1');
    expect(cache.stats().size).toBe(1);
    const k2 = cache.buildKey({ provider: 'openai', model: 'b' });
    await cache.set(k2, 'v2');
    expect(cache.stats().size).toBe(2);
  });

  it('size does not increase when overwriting existing key', async () => {
    const { cache } = makeCache();
    const k1 = cache.buildKey({ provider: 'openai', model: 'a' });
    await cache.set(k1, 'v1');
    await cache.set(k1, 'v2');
    expect(cache.stats().size).toBe(1);
  });

  it('size decreases when a key is invalidated', async () => {
    const { cache } = makeCache();
    const k1 = cache.buildKey({ provider: 'openai', model: 'a' });
    await cache.set(k1, 'v1');
    await cache.invalidateKey(k1);
    expect(cache.stats().size).toBe(0);
  });

  it('size decreases when expired entries are removed via get', async () => {
    const { cache } = makeCache({ defaultTtlMs: 1 });
    const k1 = cache.buildKey({ provider: 'openai', model: 'a' });
    await cache.set(k1, 'v1');
    const origDateNow = Date.now;
    Date.now = () => origDateNow() + 5000;
    await cache.get(k1); // triggers TTL removal
    Date.now = origDateNow;
    expect(cache.stats().size).toBe(0);
  });
});
