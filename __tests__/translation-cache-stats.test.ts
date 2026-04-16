/**
 * Translation Cache — unit tests
 *
 * Covers LRUCache mechanics, getCachedTranslation/setCachedTranslation,
 * and the getTranslationCacheStats() function exposed to /health.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  LRUCache,
  getCachedTranslation,
  setCachedTranslation,
  getTranslationCacheStats,
} from '../src/gateway/pipeline/translation-cache';

// ── LRUCache ──────────────────────────────────────────────────────────────────

describe('LRUCache', () => {
  it('stores and retrieves a value', () => {
    const cache = new LRUCache<string>(10);
    cache.set('key', 'value');
    expect(cache.get('key')).toBe('value');
  });

  it('returns undefined for missing keys', () => {
    const cache = new LRUCache<string>(10);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('reports correct size', () => {
    const cache = new LRUCache<string>(10);
    expect(cache.size).toBe(0);
    cache.set('a', 'A');
    cache.set('b', 'B');
    expect(cache.size).toBe(2);
  });

  it('has() returns true for existing keys', () => {
    const cache = new LRUCache<string>(10);
    cache.set('x', 'y');
    expect(cache.has('x')).toBe(true);
    expect(cache.has('z')).toBe(false);
  });

  it('delete() removes a key', () => {
    const cache = new LRUCache<string>(10);
    cache.set('key', 'val');
    expect(cache.delete('key')).toBe(true);
    expect(cache.get('key')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('clear() empties the cache', () => {
    const cache = new LRUCache<string>(10);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('evicts LRU entry when maxSize is reached', () => {
    const cache = new LRUCache<string>(3);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');
    // Now full. Adding 'd' should evict 'a' (least recently used)
    cache.set('d', 'D');
    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined(); // evicted
    expect(cache.get('b')).toBe('B');
    expect(cache.get('c')).toBe('C');
    expect(cache.get('d')).toBe('D');
  });

  it('accessing a key moves it to MRU (protects from eviction)', () => {
    const cache = new LRUCache<string>(3);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');
    // Access 'a' — it becomes MRU
    cache.get('a');
    // Add 'd' — 'b' (now LRU) should be evicted
    cache.set('d', 'D');
    expect(cache.get('b')).toBeUndefined(); // evicted
    expect(cache.get('a')).toBe('A');       // still here
  });

  it('overwriting an existing key does not grow the cache', () => {
    const cache = new LRUCache<string>(3);
    cache.set('a', 'A');
    cache.set('a', 'A2');
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBe('A2');
  });

  it('entries() iterates all key-value pairs', () => {
    const cache = new LRUCache<string>(10);
    cache.set('x', 'X');
    cache.set('y', 'Y');
    const all = [...cache.entries()];
    expect(all).toHaveLength(2);
    expect(all.map(([k]) => k)).toContain('x');
    expect(all.map(([k]) => k)).toContain('y');
  });
});

// ── Translation cache functions ───────────────────────────────────────────────

// The translation-cache module uses module-level counters and a singleton LRU.
// Since vitest runs each test file in isolation, counters start at 0.

describe('getCachedTranslation / setCachedTranslation', () => {
  it('returns null for uncached translation (cold miss)', () => {
    const result = getCachedTranslation('Hello', 'en', 'fr');
    expect(result).toBeNull();
  });

  it('returns null for a different language pair', () => {
    setCachedTranslation('Hi', 'en', 'es', 'Hola');
    expect(getCachedTranslation('Hi', 'en', 'fr')).toBeNull(); // different target
    expect(getCachedTranslation('Hi', 'pt', 'es')).toBeNull(); // different source
  });

  it('caches and retrieves a translation', () => {
    setCachedTranslation('Good morning', 'en', 'fr', 'Bonjour');
    const result = getCachedTranslation('Good morning', 'en', 'fr');
    expect(result).toBe('Bonjour');
  });

  it('caches with custom style key', () => {
    setCachedTranslation('Hello', 'en', 'pt', 'Olá', 'formal');
    expect(getCachedTranslation('Hello', 'en', 'pt', 'formal')).toBe('Olá');
    expect(getCachedTranslation('Hello', 'en', 'pt', 'casual')).toBeNull(); // different style
    expect(getCachedTranslation('Hello', 'en', 'pt')).toBeNull();          // default style
  });

  it('overwrites an existing cached translation', () => {
    setCachedTranslation('Bye', 'en', 'es', 'Adiós');
    setCachedTranslation('Bye', 'en', 'es', 'Hasta luego');
    expect(getCachedTranslation('Bye', 'en', 'es')).toBe('Hasta luego');
  });

  it('is case-sensitive for the input text', () => {
    setCachedTranslation('hello', 'en', 'fr', 'bonjour');
    expect(getCachedTranslation('Hello', 'en', 'fr')).toBeNull(); // capital H = miss
  });
});

// ── getTranslationCacheStats ──────────────────────────────────────────────────

describe('getTranslationCacheStats', () => {
  it('returns an object with hits, misses, and size fields', () => {
    const stats = getTranslationCacheStats();
    expect(stats).toHaveProperty('cacheHits');
    expect(stats).toHaveProperty('cacheMisses');
    expect(stats).toHaveProperty('cacheSize');
    expect(typeof stats.cacheHits).toBe('number');
    expect(typeof stats.cacheMisses).toBe('number');
    expect(typeof stats.cacheSize).toBe('number');
  });

  it('increments misses on a cache miss', () => {
    const before = getTranslationCacheStats().cacheMisses;
    getCachedTranslation('unique-miss-text-123', 'en', 'de');
    const after = getTranslationCacheStats().cacheMisses;
    expect(after).toBe(before + 1);
  });

  it('increments hits on a cache hit', () => {
    setCachedTranslation('stat-test-phrase', 'en', 'it', 'frase di test');
    const before = getTranslationCacheStats().cacheHits;
    getCachedTranslation('stat-test-phrase', 'en', 'it');
    const after = getTranslationCacheStats().cacheHits;
    expect(after).toBe(before + 1);
  });

  it('cacheSize reflects number of stored entries', () => {
    const before = getTranslationCacheStats().cacheSize;
    setCachedTranslation('size-test-unique-a', 'en', 'zh', '你好');
    setCachedTranslation('size-test-unique-b', 'en', 'zh', '再见');
    const after = getTranslationCacheStats().cacheSize;
    expect(after).toBe(before + 2);
  });

  it('hit rate can be computed from hits and misses', () => {
    // Do some hits and misses
    setCachedTranslation('rate-test', 'en', 'fr', 'test');
    getCachedTranslation('rate-test', 'en', 'fr');   // hit
    getCachedTranslation('rate-test', 'en', 'fr');   // hit
    getCachedTranslation('never-set-xyz', 'en', 'fr'); // miss

    const { cacheHits, cacheMisses } = getTranslationCacheStats();
    const total = cacheHits + cacheMisses;
    expect(total).toBeGreaterThan(0);
    // Just verify the formula works — exact values depend on test order in this file
    const hitRate = cacheHits / total;
    expect(hitRate).toBeGreaterThanOrEqual(0);
    expect(hitRate).toBeLessThanOrEqual(1);
  });
});

// ── health payload shape ──────────────────────────────────────────────────────

describe('health payload shape for translationCache', () => {
  it('stats can be mapped to the health endpoint shape', () => {
    setCachedTranslation('health-test', 'en', 'de', 'Gesundheit');
    getCachedTranslation('health-test', 'en', 'de');     // hit
    getCachedTranslation('health-miss-xyz', 'en', 'de'); // miss

    const raw = getTranslationCacheStats();
    const total = raw.cacheHits + raw.cacheMisses;
    const healthPayload = {
      hits: raw.cacheHits,
      misses: raw.cacheMisses,
      size: raw.cacheSize,
      hitRate: total > 0 ? Math.round((raw.cacheHits / total) * 10000) / 10000 : 0,
    };

    expect(healthPayload.hits).toBeGreaterThanOrEqual(0);
    expect(healthPayload.misses).toBeGreaterThanOrEqual(0);
    expect(healthPayload.size).toBeGreaterThanOrEqual(0);
    expect(healthPayload.hitRate).toBeGreaterThanOrEqual(0);
    expect(healthPayload.hitRate).toBeLessThanOrEqual(1);
  });
});
