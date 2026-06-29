/**
 * Unit tests for InMemoryStateAdapter — the zero-dependency StateStore
 * used in tests and as a Redis fallback.
 *
 * Covers: KV (get/set/del/scan with TTL), List (rpush/ltrim/lrange),
 * Hash (hset/hdel/hgetall/hincrby), and lazy sweep.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryStateAdapter } from '../../src/modules/platform/adapters/in-memory-state';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeFreshStore() {
  return new InMemoryStateAdapter();
}

// ── KV: get / set / del ──────────────────────────────────────────────────────

describe('InMemoryStateAdapter – KV', () => {
  let store: InMemoryStateAdapter;
  beforeEach(() => { store = makeFreshStore(); });

  it('returns null for unknown key', async () => {
    expect(await store.get('missing')).toBeNull();
  });

  it('stores and retrieves a value', async () => {
    await store.set('k', 'v');
    expect(await store.get('k')).toBe('v');
  });

  it('overwrites an existing value', async () => {
    await store.set('k', 'first');
    await store.set('k', 'second');
    expect(await store.get('k')).toBe('second');
  });

  it('del removes the key', async () => {
    await store.set('k', 'v');
    await store.del('k');
    expect(await store.get('k')).toBeNull();
  });

  it('del is idempotent for missing keys', async () => {
    await expect(store.del('nope')).resolves.toBeUndefined();
  });

  it('key with TTL expires after the deadline', async () => {
    vi.useFakeTimers();
    await store.set('k', 'v', 1); // 1 second TTL
    vi.advanceTimersByTime(999);
    expect(await store.get('k')).toBe('v'); // still alive
    vi.advanceTimersByTime(2);
    expect(await store.get('k')).toBeNull(); // expired
    vi.useRealTimers();
  });

  it('key without TTL never expires via time advance', async () => {
    vi.useFakeTimers();
    await store.set('k', 'eternal');
    vi.advanceTimersByTime(1_000_000_000);
    expect(await store.get('k')).toBe('eternal');
    vi.useRealTimers();
  });

  it('set ttlSecs=0 stores with no expiry (falsy branch)', async () => {
    await store.set('k', 'v', 0);
    expect(await store.get('k')).toBe('v');
  });
});

// ── KV: scan ────────────────────────────────────────────────────────────────

describe('InMemoryStateAdapter – scan', () => {
  let store: InMemoryStateAdapter;
  beforeEach(() => { store = makeFreshStore(); });

  it('returns 0 when no keys match the prefix', async () => {
    await store.set('other:key', 'v');
    expect(await store.scan('cache:*')).toBe(0);
  });

  it('finds matching keys', async () => {
    await store.set('cache:a', '1');
    await store.set('cache:b', '2');
    await store.set('other', '3');
    const found: string[] = [];
    await store.scan('cache:*', keys => { found.push(...keys); });
    expect(found.sort()).toEqual(['cache:a', 'cache:b']);
  });

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 10; i++) await store.set(`k:${i}`, 'v');
    const count = await store.scan('k:*', undefined, 3);
    expect(count).toBe(3);
  });

  it('callback returning false stops early', async () => {
    await store.set('a', '1');
    await store.set('b', '2');
    let calls = 0;
    await store.scan('*', () => { calls++; return false; });
    expect(calls).toBe(1);
  });

  it('throws when limit is 0', async () => {
    await expect(store.scan('*', undefined, 0)).rejects.toThrow(/limit must be positive/);
  });

  it('throws when limit is negative', async () => {
    await expect(store.scan('*', undefined, -5)).rejects.toThrow(/limit must be positive/);
  });

  it('does not include expired keys', async () => {
    vi.useFakeTimers();
    await store.set('expired', 'v', 1);
    vi.advanceTimersByTime(2000);
    const found: string[] = [];
    await store.scan('*', keys => { found.push(...keys); });
    expect(found).not.toContain('expired');
    vi.useRealTimers();
  });

  it('callback is not called when no keys match', async () => {
    const cb = vi.fn();
    await store.scan('no-match:*', cb);
    expect(cb).not.toHaveBeenCalled();
  });
});

// ── List: rpush / ltrim / lrange ────────────────────────────────────────────

describe('InMemoryStateAdapter – lists', () => {
  let store: InMemoryStateAdapter;
  beforeEach(() => { store = makeFreshStore(); });

  it('lrange returns empty array for missing key', async () => {
    expect(await store.lrange('missing', 0, -1)).toEqual([]);
  });

  it('rpush appends elements in order', async () => {
    await store.rpush('lst', 'a');
    await store.rpush('lst', 'b');
    await store.rpush('lst', 'c');
    expect(await store.lrange('lst', 0, -1)).toEqual(['a', 'b', 'c']);
  });

  it('lrange with positive start/stop', async () => {
    for (const v of ['a', 'b', 'c', 'd']) await store.rpush('lst', v);
    expect(await store.lrange('lst', 1, 2)).toEqual(['b', 'c']);
  });

  it('lrange with negative stop (-1 = last element)', async () => {
    for (const v of ['x', 'y', 'z']) await store.rpush('lst', v);
    expect(await store.lrange('lst', 0, -1)).toEqual(['x', 'y', 'z']);
    expect(await store.lrange('lst', 0, -2)).toEqual(['x', 'y']);
  });

  it('lrange with negative start', async () => {
    for (const v of ['a', 'b', 'c']) await store.rpush('lst', v);
    expect(await store.lrange('lst', -2, -1)).toEqual(['b', 'c']);
  });

  it('lrange throws when result exceeds maxElements', async () => {
    for (const v of ['a', 'b', 'c', 'd']) await store.rpush('lst', v);
    await expect(store.lrange('lst', 0, -1, 2)).rejects.toThrow(/exceeds maxElements/);
  });

  it('lrange does not throw when result equals maxElements', async () => {
    for (const v of ['a', 'b']) await store.rpush('lst', v);
    await expect(store.lrange('lst', 0, -1, 2)).resolves.toEqual(['a', 'b']);
  });

  it('lrange without maxElements does not throw for large results', async () => {
    for (let i = 0; i < 100; i++) await store.rpush('lst', String(i));
    const result = await store.lrange('lst', 0, -1);
    expect(result).toHaveLength(100);
  });

  it('ltrim keeps only the specified range', async () => {
    for (const v of ['a', 'b', 'c', 'd', 'e']) await store.rpush('lst', v);
    await store.ltrim('lst', 1, 3);
    expect(await store.lrange('lst', 0, -1)).toEqual(['b', 'c', 'd']);
  });

  it('ltrim on missing key is a no-op', async () => {
    await expect(store.ltrim('missing', 0, 5)).resolves.toBeUndefined();
  });

  it('del removes the list', async () => {
    await store.rpush('lst', 'v');
    await store.del('lst');
    expect(await store.lrange('lst', 0, -1)).toEqual([]);
  });
});

// ── Hash: hset / hdel / hgetall / hincrby ───────────────────────────────────

describe('InMemoryStateAdapter – hashes', () => {
  let store: InMemoryStateAdapter;
  beforeEach(() => { store = makeFreshStore(); });

  it('hgetall returns empty object for missing key', async () => {
    expect(await store.hgetall('missing')).toEqual({});
  });

  it('hset stores a field and hgetall retrieves it', async () => {
    await store.hset('h', 'field', 'value');
    expect(await store.hgetall('h')).toEqual({ field: 'value' });
  });

  it('multiple fields accumulate in the hash', async () => {
    await store.hset('h', 'a', '1');
    await store.hset('h', 'b', '2');
    expect(await store.hgetall('h')).toEqual({ a: '1', b: '2' });
  });

  it('hset overwrites existing field', async () => {
    await store.hset('h', 'k', 'old');
    await store.hset('h', 'k', 'new');
    expect(await store.hgetall('h')).toEqual({ k: 'new' });
  });

  it('hdel removes a specific field', async () => {
    await store.hset('h', 'a', '1');
    await store.hset('h', 'b', '2');
    await store.hdel('h', 'a');
    expect(await store.hgetall('h')).toEqual({ b: '2' });
  });

  it('hdel on missing hash is a no-op', async () => {
    await expect(store.hdel('missing', 'field')).resolves.toBeUndefined();
  });

  it('hset with TTL causes hash to expire', async () => {
    vi.useFakeTimers();
    await store.hset('h', 'k', 'v', 1);
    expect(await store.hgetall('h')).toEqual({ k: 'v' });
    vi.advanceTimersByTime(1001);
    expect(await store.hgetall('h')).toEqual({});
    vi.useRealTimers();
  });

  it('hgetall respects the limit parameter', async () => {
    for (let i = 0; i < 10; i++) await store.hset('h', `f${i}`, String(i));
    const result = await store.hgetall('h', 3);
    expect(Object.keys(result)).toHaveLength(3);
  });

  it('hincrby initialises missing field to the increment value', async () => {
    await store.hincrby('h', 'counter', 5);
    expect(await store.hgetall('h')).toEqual({ counter: '5' });
  });

  it('hincrby accumulates correctly', async () => {
    await store.hincrby('h', 'counter', 3);
    await store.hincrby('h', 'counter', 7);
    expect(await store.hgetall('h')).toEqual({ counter: '10' });
  });

  it('hincrby works with negative increments', async () => {
    await store.hincrby('h', 'score', 10);
    await store.hincrby('h', 'score', -4);
    expect(await store.hgetall('h')).toEqual({ score: '6' });
  });

  it('del removes the hash entirely', async () => {
    await store.hset('h', 'k', 'v');
    await store.del('h');
    expect(await store.hgetall('h')).toEqual({});
  });
});

// ── Cross-type del ───────────────────────────────────────────────────────────

describe('InMemoryStateAdapter – del clears all data-structure types', () => {
  it('deletes kv + list + hash under the same key', async () => {
    const store = makeFreshStore();
    await store.set('k', 'kv-val');
    await store.rpush('k', 'list-val');
    await store.hset('k', 'field', 'hash-val');

    await store.del('k');

    expect(await store.get('k')).toBeNull();
    expect(await store.lrange('k', 0, -1)).toEqual([]);
    expect(await store.hgetall('k')).toEqual({});
  });
});
