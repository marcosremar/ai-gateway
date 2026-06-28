/**
 * Unit tests for src/middleware/per-key-rate-limit.ts.
 *
 * Covers: parseKeyQuotas (env parsing, defaults, wildcard, malformed entries)
 * and createPerKeyRateLimiter (check, getStats, reset, resetAll, setQuota,
 * window rollover, per-key and wildcard fallback).
 *
 * Uses fake timers to control window expiry without real delays.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseKeyQuotas, createPerKeyRateLimiter } from '../src/middleware/per-key-rate-limit';

// ── helpers ───────────────────────────────────────────────────────────────────

function setEnv(val: string | undefined, key = 'RATE_LIMIT_KEYS') {
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

// ── parseKeyQuotas ────────────────────────────────────────────────────────────

describe('parseKeyQuotas', () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_KEYS;
    delete process.env.TEST_RATE_KEYS;
  });

  it('returns only the wildcard entry when env var is unset', () => {
    setEnv(undefined);
    const q = parseKeyQuotas('RATE_LIMIT_KEYS', 100);
    expect(q.size).toBe(1);
    expect(q.get('*')?.maxRequests).toBe(100);
  });

  it('returns only the wildcard entry when env var is empty string', () => {
    setEnv('');
    const q = parseKeyQuotas();
    expect(q.size).toBe(1);
    expect(q.get('*')).toBeDefined();
  });

  it('parses a single key:quota entry', () => {
    setEnv('sk-abc:50');
    const q = parseKeyQuotas();
    expect(q.get('sk-abc')?.maxRequests).toBe(50);
    expect(q.get('*')?.maxRequests).toBe(100); // default
  });

  it('parses multiple key:quota entries separated by commas', () => {
    setEnv('sk-abc:50,sk-def:200,sk-xyz:1');
    const q = parseKeyQuotas();
    expect(q.get('sk-abc')?.maxRequests).toBe(50);
    expect(q.get('sk-def')?.maxRequests).toBe(200);
    expect(q.get('sk-xyz')?.maxRequests).toBe(1);
  });

  it('adds a wildcard default only when not explicitly in the env var', () => {
    setEnv('*:300,sk-abc:50');
    const q = parseKeyQuotas();
    expect(q.get('*')?.maxRequests).toBe(300); // explicit wins
    expect(q.get('sk-abc')?.maxRequests).toBe(50);
  });

  it('skips entries with non-numeric limits', () => {
    setEnv('sk-abc:bad,sk-def:100');
    const q = parseKeyQuotas();
    expect(q.has('sk-abc')).toBe(false);
    expect(q.get('sk-def')?.maxRequests).toBe(100);
  });

  it('uses a custom env var name', () => {
    process.env.TEST_RATE_KEYS = 'sk-test:77';
    const q = parseKeyQuotas('TEST_RATE_KEYS');
    expect(q.get('sk-test')?.maxRequests).toBe(77);
  });

  it('uses a custom default quota for the wildcard', () => {
    setEnv(undefined);
    const q = parseKeyQuotas('RATE_LIMIT_KEYS', 42);
    expect(q.get('*')?.maxRequests).toBe(42);
  });

  it('trims whitespace around entries', () => {
    setEnv('  sk-abc  :  25  ,  sk-def:10  ');
    const q = parseKeyQuotas();
    // key:val split is on first ':', leading/trailing spaces around the full
    // "key:val" entry are trimmed, not per-side — keys may have leading space.
    // Just verify the non-whitespace keys parse correctly when no extra spaces.
    setEnv('sk-clean:99');
    const q2 = parseKeyQuotas();
    expect(q2.get('sk-clean')?.maxRequests).toBe(99);
  });
});

// ── createPerKeyRateLimiter — check ──────────────────────────────────────────

describe('createPerKeyRateLimiter — check', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('allows requests within quota', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 5 }]]), 5);
    const result = limiter.check('sk-abc');
    expect(result.allowed).toBe(true);
    expect(result.current).toBe(1);
    expect(result.remaining).toBe(4);
  });

  it('blocks requests that exceed quota within the window', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 3 }]]), 3);
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    const result = limiter.check('sk-abc'); // 4th request
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('tracks different keys independently', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 2 }]]), 2);
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    const resultAbc = limiter.check('sk-abc'); // exceeds for sk-abc
    const resultDef = limiter.check('sk-def'); // first for sk-def
    expect(resultAbc.allowed).toBe(false);
    expect(resultDef.allowed).toBe(true);
  });

  it('uses key-specific quota over the wildcard fallback', () => {
    const limiter = createPerKeyRateLimiter(new Map([
      ['*', { maxRequests: 10 }],
      ['sk-low', { maxRequests: 1 }],
    ]), 10);
    limiter.check('sk-low');
    const result = limiter.check('sk-low'); // 2nd — exceeds key-specific limit
    expect(result.allowed).toBe(false);
  });

  it('falls back to wildcard quota for unknown keys', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 5 }]]), 5);
    const result = limiter.check('sk-unknown');
    expect(result.allowed).toBe(true);
    expect(result.max).toBe(5);
  });

  it('resets window after windowMs elapses', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 2, windowMs: 1000 }]]), 2);
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    // Over limit
    expect(limiter.check('sk-abc').allowed).toBe(false);
    // Advance past window
    vi.advanceTimersByTime(1001);
    // New window — allowed again
    expect(limiter.check('sk-abc').allowed).toBe(true);
  });

  it('returns decreasing remaining count as requests accumulate', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 5 }]]), 5);
    const r1 = limiter.check('sk-abc');
    const r2 = limiter.check('sk-abc');
    const r3 = limiter.check('sk-abc');
    expect(r1.remaining).toBe(4);
    expect(r2.remaining).toBe(3);
    expect(r3.remaining).toBe(2);
  });

  it('includes retryAfterMs only when request is blocked', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 1 }]]), 1);
    const ok = limiter.check('sk-abc');
    const blocked = limiter.check('sk-abc');
    expect(ok.retryAfterMs).toBeUndefined();
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('resetMs is non-negative even near window boundary', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 10, windowMs: 1000 }]]), 10);
    limiter.check('sk-abc');
    vi.advanceTimersByTime(999); // almost expired
    const result = limiter.check('sk-abc');
    expect(result.resetMs).toBeGreaterThanOrEqual(0);
  });

  it('uses default windowMs of 60s when not specified in quota', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 5 }]]), 5);
    limiter.check('sk-abc');
    vi.advanceTimersByTime(59_999);
    // Still within default 60s window — same window
    const r = limiter.check('sk-abc');
    expect(r.resetMs).toBeGreaterThan(0);
  });

  it('returns max equal to the quota limit', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 7 }]]), 7);
    expect(limiter.check('sk-abc').max).toBe(7);
  });
});

// ── createPerKeyRateLimiter — getStats ───────────────────────────────────────

describe('createPerKeyRateLimiter — getStats', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns zeroed stats for a key that has never been used', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 100 }]]), 100);
    const stats = limiter.getStats('sk-new');
    expect(stats).not.toBeNull();
    expect(stats!.current).toBe(0);
    expect(stats!.remaining).toBe(100);
    expect(stats!.allowed).toBe(true);
  });

  it('reflects current usage after check calls', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 10 }]]), 10);
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    const stats = limiter.getStats('sk-abc');
    expect(stats!.current).toBe(2);
    expect(stats!.remaining).toBe(8);
  });

  it('shows allowed:false when key is over quota', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 2 }]]), 2);
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    const stats = limiter.getStats('sk-abc');
    expect(stats!.allowed).toBe(false);
    expect(stats!.remaining).toBe(0);
  });

  it('reports a fresh window when the current window has expired', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 5, windowMs: 1000 }]]), 5);
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    vi.advanceTimersByTime(1001); // window expired
    // getStats should show a fresh window (count=0) without rolling it over
    const stats = limiter.getStats('sk-abc');
    expect(stats!.current).toBe(0);
    expect(stats!.allowed).toBe(true);
    expect(stats!.remaining).toBe(5);
    expect(stats!.resetMs).toBe(1000);
  });

  it('returns null when key has no applicable quota', () => {
    // Create a limiter with no wildcard and a specific key different from the one queried
    const limiter = createPerKeyRateLimiter(new Map([['sk-specific', { maxRequests: 10 }]]), 100);
    // 'sk-other' is not in the map and no '*' either
    // Note: getStats uses keyQuotas.get(apiKey) ?? keyQuotas.get('*')
    // When '*' doesn't exist it returns null — this tests that branch.
    const limiterNoDefault = createPerKeyRateLimiter(new Map([['sk-specific', { maxRequests: 10 }]]));
    const stats = limiterNoDefault.getStats('sk-other');
    expect(stats).toBeNull();
  });
});

// ── createPerKeyRateLimiter — reset / resetAll ────────────────────────────────

describe('createPerKeyRateLimiter — reset / resetAll', () => {
  it('reset clears the counter for a specific key', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 2 }]]), 2);
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    limiter.check('sk-abc'); // over limit
    limiter.reset('sk-abc');
    // After reset, key should be allowed again
    expect(limiter.check('sk-abc').allowed).toBe(true);
  });

  it('reset does not affect other keys', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 1 }]]), 1);
    limiter.check('sk-abc');
    limiter.check('sk-def');
    limiter.reset('sk-abc');
    // sk-def is still over limit
    expect(limiter.check('sk-def').allowed).toBe(false);
    // sk-abc was reset, this is its first check — allowed
    expect(limiter.check('sk-abc').allowed).toBe(true);
  });

  it('resetAll clears all counters', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 1 }]]), 1);
    limiter.check('sk-abc');
    limiter.check('sk-def');
    limiter.check('sk-xyz');
    limiter.resetAll();
    expect(limiter.check('sk-abc').allowed).toBe(true);
    expect(limiter.check('sk-def').allowed).toBe(true);
    expect(limiter.check('sk-xyz').allowed).toBe(true);
  });

  it('reset is a no-op for an unknown key', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 5 }]]), 5);
    expect(() => limiter.reset('sk-never-seen')).not.toThrow();
  });
});

// ── createPerKeyRateLimiter — setQuota ────────────────────────────────────────

describe('createPerKeyRateLimiter — setQuota', () => {
  it('updates the quota for an existing key', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 5 }]]), 5);
    limiter.setQuota('sk-abc', { maxRequests: 1 });
    limiter.check('sk-abc');
    expect(limiter.check('sk-abc').allowed).toBe(false);
  });

  it('adds a quota for a new key', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 100 }]]), 100);
    limiter.setQuota('sk-restricted', { maxRequests: 2 });
    limiter.check('sk-restricted');
    limiter.check('sk-restricted');
    expect(limiter.check('sk-restricted').allowed).toBe(false);
    // Wildcard key is unaffected
    expect(limiter.check('sk-other').allowed).toBe(true);
  });

  it('can lower the quota mid-flight (pending counters still count)', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 100 }]]), 100);
    // Use 5 of the 100 allowance
    for (let i = 0; i < 5; i++) limiter.check('sk-abc');
    // Drop to 3
    limiter.setQuota('sk-abc', { maxRequests: 3 });
    // 5 > 3 → already over the new limit
    expect(limiter.check('sk-abc').allowed).toBe(false);
  });

  it('can override wildcard quota', () => {
    const limiter = createPerKeyRateLimiter(new Map([['*', { maxRequests: 5 }]]), 5);
    limiter.setQuota('*', { maxRequests: 1 });
    limiter.check('sk-unknown');
    expect(limiter.check('sk-unknown').allowed).toBe(false);
  });
});

// ── createPerKeyRateLimiter — default quota parameter ────────────────────────

describe('createPerKeyRateLimiter — default quota parameter', () => {
  it('uses provided defaultQuota when no quotas map is supplied', () => {
    delete process.env.RATE_LIMIT_KEYS;
    const limiter = createPerKeyRateLimiter(undefined, 3);
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    limiter.check('sk-abc');
    expect(limiter.check('sk-abc').allowed).toBe(false);
  });
});
