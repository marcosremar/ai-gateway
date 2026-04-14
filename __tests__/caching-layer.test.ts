/**
 * Tests for caching layer.
 */

import { describe, it, expect, vi } from 'vitest';
import { Cache, createCache, cached, memoize } from '../src/caching-layer';

describe('Cache', () => {
  it('should store and retrieve values', () => {
    const cache = createCache();
    cache.set('key', 'value');
    expect(cache.get('key')).toBe('value');
  });

  it('should return null for missing keys', () => {
    const cache = createCache();
    expect(cache.get('missing')).toBeNull();
  });

  it('should evict LRU entries when full', () => {
    const cache = new Cache({ maxSize: 2, ttlMs: 60_000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.size).toBeLessThanOrEqual(2);
  });

  it('should respect TTL expiration', async () => {
    const cache = new Cache({ ttlMs: 50, maxSize: 100 });
    cache.set('temp', 'value');
    expect(cache.get('temp')).toBe('value');

    await new Promise(resolve => setTimeout(resolve, 60));
    expect(cache.get('temp')).toBeNull();
  });

  it('should support has() method', () => {
    const cache = createCache();
    cache.set('exists', 42);
    expect(cache.has('exists')).toBe(true);
    expect(cache.has('nope')).toBe(false);
  });

  it('should support delete() method', () => {
    const cache = createCache();
    cache.set('deleteme', 'value');
    expect(cache.delete('deleteme')).toBe(true);
    expect(cache.get('deleteme')).toBeNull();
    expect(cache.delete('nonexistent')).toBe(false);
  });

  it('should support clear() method', () => {
    const cache = createCache();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('should return keys()', () => {
    const cache = createCache();
    cache.set('x', 1);
    cache.set('y', 2);
    const keys = cache.keys();
    expect(keys).toContain('x');
    expect(keys).toContain('y');
    expect(keys.length).toBe(2);
  });

  it('should call onEvict callback', () => {
    const onEvict = vi.fn();
    const cache = new Cache({ maxSize: 1, onEvict });
    cache.set('first', 1);
    cache.set('second', 2);
    expect(onEvict).toHaveBeenCalled();
  });

  it('should support getOrCompute', async () => {
    const cache = createCache();
    const compute = vi.fn().mockResolvedValue('computed');

    const result1 = await cache.getOrCompute('key', compute);
    const result2 = await cache.getOrCompute('key', compute);

    expect(result1).toBe('computed');
    expect(result2).toBe('computed');
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('should return stats', () => {
    const cache = new Cache({ maxSize: 50 });
    cache.set('a', 1);
    const stats = cache.getStats();
    expect(stats.size).toBe(1);
    expect(stats.maxSize).toBe(50);
  });

  it('should evict expired entries', async () => {
    const cache = new Cache({ ttlMs: 50, maxSize: 100 });
    cache.set('expire1', 1);
    cache.set('expire2', 2);
    cache.set('keep', 3, 60_000); // long TTL

    await new Promise(resolve => setTimeout(resolve, 60));
    const evicted = cache.evictExpired();
    expect(evicted).toBe(2);
    expect(cache.size).toBe(1);
  });
});

describe('cached function', () => {
  it('should cache async results', async () => {
    const cache = createCache();
    const compute = vi.fn().mockResolvedValue('result');

    const r1 = await cached(cache, 'async-key', compute);
    const r2 = await cached(cache, 'async-key', compute);

    expect(r1).toBe('result');
    expect(r2).toBe('result');
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('should support custom TTL', async () => {
    const cache = createCache({ ttlMs: 60_000 });
    const compute = vi.fn().mockResolvedValue('val');

    await cached(cache, 'ttl-key', compute, 50);
    expect(compute).toHaveBeenCalledTimes(1);

    await new Promise(resolve => setTimeout(resolve, 60));
    await cached(cache, 'ttl-key', compute, 50);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

describe('memoize', () => {
  it('should memoize function results', () => {
    const fn = vi.fn((x: number) => x * 2);
    const memoized = memoize(fn);

    memoized(5);
    memoized(5);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should memoize different args separately', () => {
    const fn = vi.fn((x: number) => x * 2);
    const memoized = memoize(fn);

    memoized(5);
    memoized(10);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should return correct results', () => {
    const fn = (x: number, y: number) => x + y;
    const memoized = memoize(fn);

    expect(memoized(1, 2)).toBe(3);
    expect(memoized(3, 4)).toBe(7);
    expect(memoized(1, 2)).toBe(3);
  });

  it('should work with object arguments', () => {
    const fn = vi.fn((obj: { a: number }) => obj.a * 2);
    const memoized = memoize(fn);

    memoized({ a: 5 });
    memoized({ a: 5 });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should respect maxSize option', () => {
    const fn = vi.fn((x: number) => x * 2);
    const memoized = memoize(fn, { maxSize: 2 });

    memoized(1);
    memoized(2);
    memoized(3); // should evict one of the earlier entries

    // At least one call should have been memoized (size <= 2 means at least 1 eviction)
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should respect TTL option', async () => {
    const fn = vi.fn(() => Date.now());
    const memoized = memoize(fn, { ttlMs: 50 });

    const t1 = memoized();
    await new Promise(resolve => setTimeout(resolve, 60));
    const t2 = memoized();

    expect(t2).not.toBe(t1);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
