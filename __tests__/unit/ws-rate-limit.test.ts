/**
 * Unit tests for src/middleware/ws-rate-limit.ts
 *
 * Covers: createWsRateLimiter — check() (allow, block, window reset, onExceeded),
 * getStatus() (unknown ws, within window, expired window, at-limit remaining),
 * and reset() (clear state, independent connections).
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

import { createWsRateLimiter } from '../../src/middleware/ws-rate-limit';

// Fake WebSocket object
function makeWs(): { close: ReturnType<typeof vi.fn> } & object {
  return { close: vi.fn() };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── check() — basic allow/deny ────────────────────────────────────────────────

describe('createWsRateLimiter — check()', () => {
  it('allows first message on a new connection', () => {
    const limiter = createWsRateLimiter({ maxMessages: 3, windowMs: 10_000 });
    const ws = makeWs();
    expect(limiter.check(ws)).toBe(true);
  });

  it('allows messages up to maxMessages', () => {
    const limiter = createWsRateLimiter({ maxMessages: 5, windowMs: 10_000 });
    const ws = makeWs();
    for (let i = 0; i < 5; i++) {
      expect(limiter.check(ws)).toBe(true);
    }
  });

  it('blocks the first message exceeding maxMessages', () => {
    const limiter = createWsRateLimiter({ maxMessages: 2, windowMs: 10_000 });
    const ws = makeWs();
    limiter.check(ws); // 1
    limiter.check(ws); // 2 — still ok
    expect(limiter.check(ws)).toBe(false); // 3 — over limit
  });

  it('continues to block all subsequent over-limit messages', () => {
    const limiter = createWsRateLimiter({ maxMessages: 1, windowMs: 10_000 });
    const ws = makeWs();
    limiter.check(ws); // 1 — ok
    expect(limiter.check(ws)).toBe(false); // 2
    expect(limiter.check(ws)).toBe(false); // 3
  });

  it('resets the window after windowMs elapses', () => {
    const limiter = createWsRateLimiter({ maxMessages: 2, windowMs: 5_000 });
    const ws = makeWs();
    limiter.check(ws); // 1
    limiter.check(ws); // 2
    expect(limiter.check(ws)).toBe(false); // 3 — blocked

    vi.advanceTimersByTime(5_001); // window expired
    expect(limiter.check(ws)).toBe(true); // fresh window
  });

  it('calls custom onExceeded callback when blocked', () => {
    const onExceeded = vi.fn();
    const limiter = createWsRateLimiter({ maxMessages: 1, windowMs: 10_000, onExceeded });
    const ws = makeWs();
    limiter.check(ws); // 1 — ok
    limiter.check(ws); // 2 — blocked
    expect(onExceeded).toHaveBeenCalledOnce();
    expect(onExceeded).toHaveBeenCalledWith(ws);
  });

  it('does not call onExceeded for allowed messages', () => {
    const onExceeded = vi.fn();
    const limiter = createWsRateLimiter({ maxMessages: 5, windowMs: 10_000, onExceeded });
    const ws = makeWs();
    for (let i = 0; i < 5; i++) limiter.check(ws);
    expect(onExceeded).not.toHaveBeenCalled();
  });

  it('default onExceeded calls ws.close(4029, ...)', () => {
    const limiter = createWsRateLimiter({ maxMessages: 1, windowMs: 10_000 });
    const ws = makeWs();
    limiter.check(ws); // 1 — ok
    limiter.check(ws); // 2 — triggers default onExceeded
    expect(ws.close).toHaveBeenCalledWith(4029, 'Rate limit exceeded');
  });

  it('default onExceeded does not throw for ws without close()', () => {
    const limiter = createWsRateLimiter({ maxMessages: 1, windowMs: 10_000 });
    const ws = {} as object; // no close method
    limiter.check(ws);
    expect(() => limiter.check(ws)).not.toThrow();
  });

  it('tracks multiple connections independently', () => {
    const limiter = createWsRateLimiter({ maxMessages: 2, windowMs: 10_000 });
    const ws1 = makeWs();
    const ws2 = makeWs();
    limiter.check(ws1); // 1
    limiter.check(ws1); // 2
    expect(limiter.check(ws1)).toBe(false); // ws1 at limit

    expect(limiter.check(ws2)).toBe(true); // ws2 unaffected
  });

  it('uses default maxMessages of 100', () => {
    const limiter = createWsRateLimiter({ windowMs: 60_000 });
    const ws = makeWs();
    for (let i = 0; i < 100; i++) {
      expect(limiter.check(ws)).toBe(true);
    }
    expect(limiter.check(ws)).toBe(false); // 101st blocked
  });

  it('uses default windowMs of 60,000 ms', () => {
    const limiter = createWsRateLimiter({ maxMessages: 1 });
    const ws = makeWs();
    limiter.check(ws);
    expect(limiter.check(ws)).toBe(false);

    vi.advanceTimersByTime(59_999); // just before window ends
    expect(limiter.check(ws)).toBe(false); // still blocked

    vi.advanceTimersByTime(2); // past the 60s mark
    expect(limiter.check(ws)).toBe(true); // new window
  });
});

// ── getStatus() ───────────────────────────────────────────────────────────────

describe('createWsRateLimiter — getStatus()', () => {
  it('returns zeroed status for unknown connection', () => {
    const limiter = createWsRateLimiter({ maxMessages: 50, windowMs: 30_000 });
    const ws = makeWs();
    expect(limiter.getStatus(ws)).toEqual({
      count: 0,
      remaining: 50,
      windowMs: 30_000,
    });
  });

  it('reflects count and remaining after messages', () => {
    const limiter = createWsRateLimiter({ maxMessages: 10, windowMs: 30_000 });
    const ws = makeWs();
    limiter.check(ws);
    limiter.check(ws);
    limiter.check(ws);
    const status = limiter.getStatus(ws);
    expect(status.count).toBe(3);
    expect(status.remaining).toBe(7);
  });

  it('remaining is 0 when at or above maxMessages', () => {
    const limiter = createWsRateLimiter({ maxMessages: 2, windowMs: 30_000 });
    const ws = makeWs();
    limiter.check(ws);
    limiter.check(ws);
    limiter.check(ws); // over limit — remaining must not go negative
    const status = limiter.getStatus(ws);
    expect(status.remaining).toBe(0);
  });

  it('returns zeroed status when window has expired', () => {
    const limiter = createWsRateLimiter({ maxMessages: 5, windowMs: 5_000 });
    const ws = makeWs();
    limiter.check(ws);
    limiter.check(ws);

    vi.advanceTimersByTime(5_001);
    const status = limiter.getStatus(ws);
    expect(status.count).toBe(0);
    expect(status.remaining).toBe(5);
  });

  it('windowMs in status reflects remaining window time', () => {
    const limiter = createWsRateLimiter({ maxMessages: 10, windowMs: 10_000 });
    const ws = makeWs();
    limiter.check(ws);
    vi.advanceTimersByTime(3_000);
    const status = limiter.getStatus(ws);
    // Remaining window should be approximately 7000ms (10000 - 3000)
    expect(status.windowMs).toBeGreaterThan(6_900);
    expect(status.windowMs).toBeLessThanOrEqual(7_000);
  });

  it('reports configured windowMs for unknown connection', () => {
    const limiter = createWsRateLimiter({ maxMessages: 10, windowMs: 15_000 });
    const ws = makeWs();
    expect(limiter.getStatus(ws).windowMs).toBe(15_000);
  });
});

// ── reset() ───────────────────────────────────────────────────────────────────

describe('createWsRateLimiter — reset()', () => {
  it('clears state so next check starts fresh', () => {
    const limiter = createWsRateLimiter({ maxMessages: 2, windowMs: 10_000 });
    const ws = makeWs();
    limiter.check(ws);
    limiter.check(ws);
    expect(limiter.check(ws)).toBe(false); // blocked

    limiter.reset(ws);
    expect(limiter.check(ws)).toBe(true); // fresh after reset
  });

  it('getStatus returns zeroed values after reset', () => {
    const limiter = createWsRateLimiter({ maxMessages: 5, windowMs: 10_000 });
    const ws = makeWs();
    limiter.check(ws);
    limiter.check(ws);
    limiter.reset(ws);
    expect(limiter.getStatus(ws)).toEqual({ count: 0, remaining: 5, windowMs: 10_000 });
  });

  it('reset on unknown connection does not throw', () => {
    const limiter = createWsRateLimiter({ maxMessages: 5, windowMs: 10_000 });
    const ws = makeWs();
    expect(() => limiter.reset(ws)).not.toThrow();
  });

  it('reset only affects the specified connection', () => {
    const limiter = createWsRateLimiter({ maxMessages: 2, windowMs: 10_000 });
    const ws1 = makeWs();
    const ws2 = makeWs();
    limiter.check(ws1);
    limiter.check(ws2);

    limiter.reset(ws1);
    expect(limiter.getStatus(ws1).count).toBe(0);
    expect(limiter.getStatus(ws2).count).toBe(1); // ws2 unchanged
  });
});

// ── config edge cases ─────────────────────────────────────────────────────────

describe('createWsRateLimiter — config', () => {
  it('maxMessages: 0 blocks every message', () => {
    const limiter = createWsRateLimiter({ maxMessages: 0, windowMs: 10_000 });
    const ws = makeWs();
    expect(limiter.check(ws)).toBe(false);
  });

  it('very short windowMs causes rapid resets', () => {
    const limiter = createWsRateLimiter({ maxMessages: 1, windowMs: 100 });
    const ws = makeWs();
    expect(limiter.check(ws)).toBe(true);
    expect(limiter.check(ws)).toBe(false);

    vi.advanceTimersByTime(101);
    expect(limiter.check(ws)).toBe(true); // new window after 101ms
  });

  it('custom onExceeded receives the ws object', () => {
    const received: unknown[] = [];
    const limiter = createWsRateLimiter({
      maxMessages: 1,
      windowMs: 10_000,
      onExceeded: (ws) => received.push(ws),
    });
    const ws = makeWs();
    limiter.check(ws);
    limiter.check(ws); // triggers onExceeded
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(ws);
  });

  it('creates independent limiter instances per createWsRateLimiter call', () => {
    const limiterA = createWsRateLimiter({ maxMessages: 2, windowMs: 10_000 });
    const limiterB = createWsRateLimiter({ maxMessages: 10, windowMs: 10_000 });
    const ws = makeWs();
    limiterA.check(ws);
    limiterA.check(ws);
    expect(limiterA.check(ws)).toBe(false); // limiterA blocked

    // Same ws object but different limiter instance — should be tracked separately
    expect(limiterB.check(ws)).toBe(true); // limiterB unaffected
  });
});
