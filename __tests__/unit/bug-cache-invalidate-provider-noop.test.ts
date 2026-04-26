/**
 * Bug: ResponseCache.invalidateProvider/invalidateModel are no-ops.
 *
 * buildKey() produces opaque SHA256 hashes prefixed with `cache:`.
 * invalidateProvider() scans for `cache:p:openai*` — a literal pattern that
 * cannot possibly match the hashed keys. Result: invalidateProvider always
 * returns 0 and invalidates nothing, silently leaving stale entries.
 *
 * Fix: track per-key provider/model metadata (or scan all + decode envelope
 * metadata to filter). Minimal fix: store the prefix as part of the key so
 * the pattern can match, OR expose a metadata-based invalidation that reads
 * each entry's envelope.
 */
import { describe, it, expect } from 'vitest';
import { ResponseCache } from '../../src/caching/response-cache';

class FakeStore {
  data = new Map<string, string>();
  async get(k: string) { return this.data.get(k) ?? null; }
  async set(k: string, v: string) { this.data.set(k, v); }
  async del(k: string) { this.data.delete(k); }
  async scan(pattern: string, cb: (keys: string[]) => void) {
    const glob = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    const keys = [...this.data.keys()].filter(k => glob.test(k));
    if (keys.length > 0) cb(keys);
    return keys.length;
  }
}

describe('ResponseCache.invalidateProvider', () => {
  it('actually invalidates entries for the given provider', async () => {
    const store = new FakeStore();
    const cache = new ResponseCache(store as any);

    const k1 = cache.buildKey({ provider: 'openai', model: 'gpt-4' });
    const k2 = cache.buildKey({ provider: 'anthropic', model: 'claude' });
    await cache.set(k1, 'A');
    await cache.set(k2, 'B');
    expect(store.data.size).toBe(2);

    const removed = await cache.invalidateProvider('openai');
    expect(removed).toBe(1);
    expect(store.data.size).toBe(1);
    expect(await cache.get(k1)).toBeNull();
    expect(await cache.get(k2)).not.toBeNull();
  });
});
