import { describe, it, expect } from 'vitest';
import { SpeculativeCache } from '../../src/gateway/pipeline/speculative-cache';

describe('SpeculativeCache eviction on session update', () => {
  it('does not evict another session when updating an existing session with new text', async () => {
    const cache = new SpeculativeCache();
    const translateFn = (text: string) => Promise.resolve(`translated: ${text}`);

    // Fill cache to MAX_SPECULATIONS (20) with different sessions
    for (let i = 0; i < 20; i++) {
      cache.speculate(`session-${i}`, `partial text ${i}`, translateFn);
    }
    expect(cache.stats().pendingCount).toBe(20);

    // Update session-10 (not the oldest) with new text
    // Bug: the code checks pending.size >= MAX_SPECULATIONS and evicts the OLDEST
    // entry (session-0), even though session-10 already exists and will be overwritten.
    // After evict session-0 (size=19) and overwrite session-10 (size still 19),
    // we lose session-0 unnecessarily.
    cache.speculate('session-10', 'updated partial text for session 10', translateFn);

    // After the bug fix: size should still be 20 (session-10 was overwritten in-place)
    // Before the bug fix: size is 19 (session-0 evicted unnecessarily)
    expect(cache.stats().pendingCount).toBe(20);

    // Verify session-0 was NOT evicted (it should still be resolvable)
    const result = await cache.resolve('session-0', 'partial text 0', 0.9);
    expect(result).toBe('translated: partial text 0');
  });

  it('correctly evicts when adding a truly NEW session at capacity', async () => {
    const cache = new SpeculativeCache();
    const translateFn = (text: string) => Promise.resolve(`translated: ${text}`);

    for (let i = 0; i < 20; i++) {
      cache.speculate(`session-${i}`, `partial text ${i}`, translateFn);
    }
    expect(cache.stats().pendingCount).toBe(20);

    // Add a genuinely NEW session (not an update) — should evict the oldest
    cache.speculate('session-new', 'brand new text', translateFn);

    // Size stays at 20 (one evicted, one added)
    expect(cache.stats().pendingCount).toBe(20);

    // session-0 (the oldest) should have been evicted
    const result = await cache.resolve('session-0', 'partial text 0', 0.9);
    expect(result).toBeNull();
  });

  it('does not evict when updating existing session at capacity with same text', async () => {
    const cache = new SpeculativeCache();
    const translateFn = (text: string) => Promise.resolve(`translated: ${text}`);

    for (let i = 0; i < 20; i++) {
      cache.speculate(`session-${i}`, `partial text ${i}`, translateFn);
    }

    // Same session, same text — should be a no-op (early return at line 78)
    cache.speculate('session-10', 'partial text 10', translateFn);

    expect(cache.stats().pendingCount).toBe(20);
  });
});
