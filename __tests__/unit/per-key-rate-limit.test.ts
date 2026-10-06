/**
 * Unit tests for src/middleware/per-key-rate-limit.ts
 *
 * Covers: parseKeyQuotas (env parsing, wildcard, defaults),
 * createPerKeyRateLimiter — check() (allow, block, window reset, independent keys,
 * key-specific vs wildcard quota), getStats() (unseen key, within window, expired window),
 * reset() (clears single key), resetAll() (clears all keys), and setQuota() (live update).
 *
 * Time is controlled via vi.useFakeTimers() so window expiry is deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { parseKeyQuotas, createPerKeyRateLimiter } from '../../src/middleware/per-key-rate-limit';

const ENV_KEY = 'TEST_PER_KEY_RATE_LIMIT';

beforeEach(() => {
  vi.useFakeTimers();
  delete process.env[ENV_KEY];
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env[ENV_KEY];
});

// ── parseKeyQuotas ─────────────────────────────────────────────────────────────

describe('parseKeyQuotas', () => {
  it('returns only default wildcard quota when env var is unset', () => {
    delete process.env[ENV_KEY];
    const quotas = parseKeyQuotas(ENV_KEY, 50);
    expect(quotas.get('*')).toEqual({ maxRequests: 50 });
    expect(quotas.size).toBe(1);
  });

  it('returns only default wildcard quota when env var is empty string', () => {
    process.env[ENV_KEY] = '';
    const quotas = parseKeyQuotas(ENV_KEY, 75);
    expect(quotas.get('*')).toEqual({ maxRequests: 75 });
    expect(quotas.size).toBe(1);
  });

  it('parses a single key:count entry', () => {
    process.env[ENV_KEY] = 'sk-abc:200';
    const quotas = parseKeyQuotas(ENV_KEY);
    expect(quotas.get('sk-abc')).toEqual({ maxRequests: 200 });
  });

  it('parses multiple key:count entries', () => {
    process.env[ENV_KEY] = 'sk-abc:100,sk-def:50,sk-ghi:300';
    const quotas = parseKeyQuotas(ENV_KEY);
    expect(quotas.get('sk-abc')).toEqual({ maxRequests: 100 });
    expect(quotas.get('sk-def')).toEqual({ maxRequests: 50 });
    expect(quotas.get('sk-ghi')).toEqual({ maxRequests: 300 });
  });

  it('adds default wildcard when not present in env var', () => {
    process.env[ENV_KEY] = 'sk-abc:100';
    const quotas = parseKeyQuotas(ENV_KEY, 25);
    expect(quotas.get('*')).toEqual({ maxRequests: 25 });
  });

  it('does not overwrite wildcard * if already in env var', () => {
    process.env[ENV_KEY] = '*:999,sk-abc:10';
    const quotas = parseKeyQuotas(ENV_KEY, 50);
    expect(quotas.get('*')).toEqual({ maxRequests: 999 });
  });

  it('skips empty comma-separated entries', () => {
    process.env[ENV_KEY] = 'sk-abc:100,,sk-def:50,';
    const quotas = parseKeyQuotas(ENV_KEY);
    expect(quotas.has('sk-abc')).toBe(true);
    expect(quotas.has('sk-def')).toBe(true);
    // No blank key
    expect(quotas.has('')).toBe(false);
  });

  it('skips entries with non-numeric max', () => {
    process.env[ENV_KEY] = 'sk-abc:notanumber,sk-def:100';
    const quotas = parseKeyQuotas(ENV_KEY);
    expect(quotas.has('sk-abc')).toBe(false);
    expect(quotas.get('sk-def')).toEqual({ maxRequests: 100 });
  });

  it('trims whitespace from entries', () => {
    process.env[ENV_KEY] = ' sk-abc:100 , sk-def:50 ';
    const quotas = parseKeyQuotas(ENV_KEY);
    expect(quotas.get('sk-abc')).toEqual({ maxRequests: 100 });
    expect(quotas.get('sk-def')).toEqual({ maxRequests: 50 });
  });

  it('uses defaultQuota=100 when none provided', () => {
    delete process.env[ENV_KEY];
    const quotas = parseKeyQuotas(ENV_KEY);
    expect(quotas.get('*')).toEqual({ maxRequests: 100 });
  });
});

// ── check() — basic allow/deny ─────────────────────────────────────────────────

describe('createPerKeyRateLimiter — check()', () => {
  it('allows the first request for a new key', () => {
    const quotas = new Map([['*', { maxRequests: 5, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    const result = limiter.check('sk-new');
    expect(result.allowed).toBe(true);
  });

  it('allows requests up to maxRequests', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 3, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    expect(limiter.check('sk-abc').allowed).toBe(true); // 1
    expect(limiter.check('sk-abc').allowed).toBe(true); // 2
    expect(limiter.check('sk-abc').allowed).toBe(true); // 3
  });

  it('blocks the first request exceeding maxRequests', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 2, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-abc'); // 1
    limiter.check('sk-abc'); // 2
    expect(limiter.check('sk-abc').allowed).toBe(false); // 3 — over limit
  });

  it('continues to block subsequent over-limit requests', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 1, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-abc'); // 1 — ok
    expect(limiter.check('sk-abc').allowed).toBe(false); // 2
    expect(limiter.check('sk-abc').allowed).toBe(false); // 3
  });

  it('resets the window after windowMs elapses', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 2, windowMs: 5_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    expect(limiter.check('sk-abc').allowed).toBe(false); // blocked

    vi.advanceTimersByTime(5_001);
    expect(limiter.check('sk-abc').allowed).toBe(true); // fresh window
  });

  it('reports correct current count', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 10, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    const result = limiter.check('sk-abc');
    expect(result.current).toBe(3);
  });

  it('reports correct remaining count', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 5, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    const result = limiter.check('sk-abc');
    expect(result.remaining).toBe(2);
  });

  it('remaining is 0 when at or past the limit', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 2, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    const result = limiter.check('sk-abc'); // 3rd — over limit
    expect(result.remaining).toBe(0);
  });

  it('reports correct max in result', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 42, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    const result = limiter.check('sk-abc');
    expect(result.max).toBe(42);
  });

  it('uses key-specific quota over wildcard', () => {
    const quotas = new Map<string, { maxRequests: number; windowMs?: number }>([
      ['sk-special', { maxRequests: 1 }],
      ['*', { maxRequests: 100 }],
    ]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-special'); // 1
    expect(limiter.check('sk-special').allowed).toBe(false); // 2 — limit=1
  });

  it('falls back to wildcard quota for unknown keys', () => {
    const quotas = new Map([['*', { maxRequests: 2, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-unknown');
    limiter.check('sk-unknown');
    expect(limiter.check('sk-unknown').allowed).toBe(false);
  });

  it('tracks multiple keys independently', () => {
    const quotas = new Map([['*', { maxRequests: 2, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-1');
    limiter.check('sk-1');
    expect(limiter.check('sk-1').allowed).toBe(false); // sk-1 at limit

    expect(limiter.check('sk-2').allowed).toBe(true); // sk-2 unaffected
  });

  it('returns retryAfterMs when blocked', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 1, windowMs: 10_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-abc');
    const result = limiter.check('sk-abc');
    expect(result.allowed).toBe(false);
    expect(typeof result.retryAfterMs).toBe('number');
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('does not set retryAfterMs when allowed', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 5, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    const result = limiter.check('sk-abc');
    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBeUndefined();
  });

  it('resetMs is non-negative', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 1, windowMs: 100 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-abc');
    vi.advanceTimersByTime(200); // past the window
    const result = limiter.check('sk-abc'); // fresh window
    expect(result.resetMs).toBeGreaterThanOrEqual(0);
  });
});

// ── getStats() ─────────────────────────────────────────────────────────────────

describe('createPerKeyRateLimiter — getStats()', () => {
  it('returns null for key with no known quota and no wildcard', () => {
    const quotas = new Map<string, { maxRequests: number }>(); // no wildcard
    const limiter = createPerKeyRateLimiter(quotas, 0);
    // Only non-default limiter without a wildcard configured at all
    // key not in quotas and no * entry → should return null
    // We need to construct with a quotas map that has no * either
    // The above creates with empty map so getStats should return null
    const result = limiter.getStats('sk-unknown');
    // Without * quota set and no entry for the key → null
    expect(result).toBeNull();
  });

  it('returns zeroed stats for unseen key with known quota', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 10, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    const stats = limiter.getStats('sk-abc');
    expect(stats).not.toBeNull();
    expect(stats!.current).toBe(0);
    expect(stats!.remaining).toBe(10);
    expect(stats!.allowed).toBe(true);
  });

  it('reflects count and remaining after check() calls', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 10, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    const stats = limiter.getStats('sk-abc');
    expect(stats!.current).toBe(3);
    expect(stats!.remaining).toBe(7);
  });

  it('allowed is false when count exceeds maxRequests', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 2, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    limiter.check('sk-abc'); // 3 — over limit
    const stats = limiter.getStats('sk-abc');
    expect(stats!.allowed).toBe(false);
  });

  it('returns zeroed stats when window has expired', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 5, windowMs: 5_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-abc');
    limiter.check('sk-abc');

    vi.advanceTimersByTime(5_001);
    const stats = limiter.getStats('sk-abc');
    expect(stats!.current).toBe(0);
    expect(stats!.remaining).toBe(5);
    expect(stats!.allowed).toBe(true);
  });

  it('resetMs is non-negative in expired window', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 2, windowMs: 100 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-abc');
    vi.advanceTimersByTime(200); // well past window
    const stats = limiter.getStats('sk-abc');
    expect(stats!.resetMs).toBeGreaterThanOrEqual(0);
  });

  it('uses wildcard quota for unknown key in getStats', () => {
    const quotas = new Map([['*', { maxRequests: 50, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    const stats = limiter.getStats('sk-new');
    expect(stats).not.toBeNull();
    expect(stats!.max).toBe(50);
  });
});

// ── reset() ────────────────────────────────────────────────────────────────────

describe('createPerKeyRateLimiter — reset()', () => {
  it('clears state so next check starts fresh', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 2, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    expect(limiter.check('sk-abc').allowed).toBe(false); // blocked

    limiter.reset('sk-abc');
    expect(limiter.check('sk-abc').allowed).toBe(true); // fresh after reset
  });

  it('getStats shows zero count after reset', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 5, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    limiter.reset('sk-abc');
    const stats = limiter.getStats('sk-abc');
    expect(stats!.current).toBe(0);
  });

  it('reset on unknown key does not throw', () => {
    const quotas = new Map([['*', { maxRequests: 5, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    expect(() => limiter.reset('sk-nonexistent')).not.toThrow();
  });

  it('reset only affects the specified key', () => {
    const quotas = new Map([['*', { maxRequests: 10, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-1');
    limiter.check('sk-1');
    limiter.check('sk-2');
    limiter.check('sk-2');
    limiter.check('sk-2');

    limiter.reset('sk-1');
    expect(limiter.getStats('sk-1')!.current).toBe(0);
    expect(limiter.getStats('sk-2')!.current).toBe(3); // sk-2 unchanged
  });
});

// ── resetAll() ─────────────────────────────────────────────────────────────────

describe('createPerKeyRateLimiter — resetAll()', () => {
  it('clears counters for all tracked keys', () => {
    const quotas = new Map([['*', { maxRequests: 10, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-1');
    limiter.check('sk-2');
    limiter.check('sk-3');

    limiter.resetAll();
    expect(limiter.getStats('sk-1')!.current).toBe(0);
    expect(limiter.getStats('sk-2')!.current).toBe(0);
    expect(limiter.getStats('sk-3')!.current).toBe(0);
  });

  it('after resetAll, previously-blocked key is unblocked', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 1, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-abc');
    expect(limiter.check('sk-abc').allowed).toBe(false);

    limiter.resetAll();
    expect(limiter.check('sk-abc').allowed).toBe(true);
  });

  it('resetAll on empty limiter does not throw', () => {
    const quotas = new Map([['*', { maxRequests: 5, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    expect(() => limiter.resetAll()).not.toThrow();
  });
});

// ── setQuota() ─────────────────────────────────────────────────────────────────

describe('createPerKeyRateLimiter — setQuota()', () => {
  it('new quota takes effect immediately on next check', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 10, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.setQuota('sk-abc', { maxRequests: 1 });
    limiter.check('sk-abc'); // 1 — hits new limit
    expect(limiter.check('sk-abc').allowed).toBe(false); // 2 — blocked
  });

  it('can raise quota to allow more requests', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 1, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.check('sk-abc');
    limiter.setQuota('sk-abc', { maxRequests: 10 });
    // Window hasn't reset, but quota was raised — current count is 1, new max is 10
    expect(limiter.check('sk-abc').allowed).toBe(true); // 2nd request now allowed
  });

  it('can assign quota to a previously unknown key', () => {
    const quotas = new Map([['*', { maxRequests: 100, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.setQuota('sk-new', { maxRequests: 2, windowMs: 60_000 });
    limiter.check('sk-new');
    limiter.check('sk-new');
    expect(limiter.check('sk-new').allowed).toBe(false); // respects new quota
  });

  it('can update wildcard quota', () => {
    const quotas = new Map([['*', { maxRequests: 100, windowMs: 60_000 }]]);
    const limiter = createPerKeyRateLimiter(quotas);
    limiter.setQuota('*', { maxRequests: 1 });
    limiter.check('sk-unknown'); // uses wildcard
    expect(limiter.check('sk-unknown').allowed).toBe(false);
  });
});

// ── independent limiter instances ─────────────────────────────────────────────

describe('createPerKeyRateLimiter — instance isolation', () => {
  it('two limiter instances track the same key independently', () => {
    const quotas = new Map([['sk-abc', { maxRequests: 2, windowMs: 60_000 }]]);
    const limiterA = createPerKeyRateLimiter(quotas);
    const limiterB = createPerKeyRateLimiter(quotas);

    limiterA.check('sk-abc');
    limiterA.check('sk-abc');
    expect(limiterA.check('sk-abc').allowed).toBe(false); // limiterA blocked

    expect(limiterB.check('sk-abc').allowed).toBe(true); // limiterB unaffected
  });
});
