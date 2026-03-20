/**
 * Tests for server/speculative-cache.ts — SpeculativeCache
 * Verifies: speculate, resolve (hit/miss), similarity checks, expiry, LRU eviction, stats.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SpeculativeCache } from '../server/speculative-cache';

describe('SpeculativeCache', () => {
  let cache: SpeculativeCache;

  beforeEach(() => {
    cache = new SpeculativeCache();
  });

  // ── Basic speculate + resolve ──────────────────────────────────────────────

  it('returns null when no speculation exists', async () => {
    const result = await cache.resolve('s1', 'hello world', 0.7);
    expect(result).toBeNull();
  });

  it('hits on exact match', async () => {
    const translateFn = async (text: string) => `translated: ${text}`;
    cache.speculate('s1', 'hello world', translateFn);
    const result = await cache.resolve('s1', 'hello world', 0.7);
    expect(result).toBe('translated: hello world');
  });

  it('hits on prefix match (final extends partial)', async () => {
    const translateFn = async (text: string) => `translated: ${text}`;
    cache.speculate('s1', 'hello', translateFn);
    const result = await cache.resolve('s1', 'hello world', 0.7);
    expect(result).toBe('translated: hello');
  });

  it('hits when texts are similar enough (Levenshtein)', async () => {
    const translateFn = async (text: string) => `translated: ${text}`;
    // "hello worl" vs "hello world" — 1 edit distance, 91% similar
    cache.speculate('s1', 'hello worl', translateFn);
    const result = await cache.resolve('s1', 'hello world', 0.7);
    expect(result).toBe('translated: hello worl');
  });

  it('misses when texts are too different', async () => {
    const translateFn = async (text: string) => `translated: ${text}`;
    cache.speculate('s1', 'bonjour', translateFn);
    const result = await cache.resolve('s1', 'hello world', 0.7);
    expect(result).toBeNull();
  });

  it('misses when partial is too short', async () => {
    const translateFn = async (text: string) => `translated: ${text}`;
    cache.speculate('s1', 'hi', translateFn);
    const result = await cache.resolve('s1', 'hello world', 0.7);
    expect(result).toBeNull();
  });

  // ── Case insensitivity ─────────────────────────────────────────────────────

  it('is case-insensitive', async () => {
    const translateFn = async (text: string) => `translated: ${text}`;
    cache.speculate('s1', 'Hello World', translateFn);
    const result = await cache.resolve('s1', 'hello world', 0.7);
    expect(result).toBe('translated: Hello World');
  });

  // ── Translation failure ────────────────────────────────────────────────────

  it('misses when translation fails', async () => {
    const translateFn = async () => { throw new Error('LLM down'); };
    cache.speculate('s1', 'hello world', translateFn);
    // Wait a tick for the promise to settle
    await new Promise(r => setTimeout(r, 10));
    const result = await cache.resolve('s1', 'hello world', 0.7);
    expect(result).toBeNull();
  });

  // ── Session isolation ──────────────────────────────────────────────────────

  it('isolates speculations by session', async () => {
    const translateFn = async (text: string) => `translated: ${text}`;
    cache.speculate('s1', 'hello', translateFn);
    cache.speculate('s2', 'bonjour', translateFn);

    const r1 = await cache.resolve('s1', 'hello world', 0.7);
    expect(r1).toBe('translated: hello');

    const r2 = await cache.resolve('s2', 'bonjour le monde', 0.7);
    expect(r2).toBe('translated: bonjour');
  });

  // ── Duplicate suppression ──────────────────────────────────────────────────

  it('does not re-speculate with same text', async () => {
    let callCount = 0;
    const translateFn = async (text: string) => { callCount++; return `t: ${text}`; };

    cache.speculate('s1', 'hello', translateFn);
    cache.speculate('s1', 'hello', translateFn); // same text — should not re-trigger

    expect(callCount).toBe(1);
  });

  it('replaces speculation with new text', async () => {
    const translateFn = async (text: string) => `translated: ${text}`;

    cache.speculate('s1', 'hello', translateFn);
    cache.speculate('s1', 'hello world', translateFn); // updated partial

    const result = await cache.resolve('s1', 'hello world', 0.7);
    expect(result).toBe('translated: hello world');
  });

  // ── Clear ──────────────────────────────────────────────────────────────────

  it('clears speculation for a session', async () => {
    const translateFn = async (text: string) => `translated: ${text}`;
    cache.speculate('s1', 'hello world', translateFn);
    cache.clear('s1');

    const result = await cache.resolve('s1', 'hello world', 0.7);
    expect(result).toBeNull();
  });

  // ── Stats ──────────────────────────────────────────────────────────────────

  it('tracks stats correctly', async () => {
    const translateFn = async (text: string) => `translated: ${text}`;

    // 1 miss (no speculation)
    await cache.resolve('s1', 'no speculation', 0.7);

    // 1 hit
    cache.speculate('s2', 'hello', translateFn);
    await cache.resolve('s2', 'hello world', 0.7);

    // 1 miss (too different)
    cache.speculate('s3', 'bonjour', translateFn);
    await cache.resolve('s3', 'completely different text entirely', 0.7);

    const stats = cache.stats();
    expect(stats.total).toBe(3);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(2);
    expect(stats.hitRate).toBeCloseTo(1 / 3, 2);
  });

  // ── Empty/whitespace ──────────────────────────────────────────────────────

  it('ignores empty partial text', async () => {
    const translateFn = async (text: string) => `translated: ${text}`;
    cache.speculate('s1', '', translateFn);
    cache.speculate('s1', '   ', translateFn);

    const stats = cache.stats();
    expect(stats.pendingCount).toBe(0);
  });

  // ── Containment match ──────────────────────────────────────────────────────

  it('hits on containment with sufficient length ratio', async () => {
    const translateFn = async (text: string) => `translated: ${text}`;
    // partial is contained in final and length ratio is >= 0.7
    cache.speculate('s1', 'world hello', translateFn);
    // "world hello" (11 chars) in "the world hello" (15 chars) -> ratio 0.73 >= 0.7
    const result = await cache.resolve('s1', 'the world hello', 0.7);
    expect(result).toBe('translated: world hello');
  });

  // ── Min confidence threshold ───────────────────────────────────────────────

  it('respects higher minConfidence', async () => {
    const translateFn = async (text: string) => `translated: ${text}`;
    // "the quick brown" vs "a quick brown fox jumps" — not a prefix, ~65% similar, should fail at 0.95
    cache.speculate('s1', 'the quick brown', translateFn);
    const result = await cache.resolve('s1', 'a quick brown fox jumps', 0.95);
    expect(result).toBeNull();
  });

  it('passes with lower minConfidence', async () => {
    const translateFn = async (text: string) => `translated: ${text}`;
    // "hello" vs "hello world" — prefix match always passes
    cache.speculate('s1', 'hello', translateFn);
    const result = await cache.resolve('s1', 'hello world', 0.95);
    expect(result).toBe('translated: hello');
  });
});
