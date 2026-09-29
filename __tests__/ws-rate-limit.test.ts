/**
 * Unit tests for src/middleware/ws-rate-limit.ts.
 *
 * Covers: createWsRateLimiter — check (allow/deny), getStatus,
 * reset, window rollover, custom config, and the default onExceeded
 * callback (closes with 4029).
 *
 * Uses vi.useFakeTimers to control window expiry without real delays.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWsRateLimiter } from '../src/middleware/ws-rate-limit';

// A plain object is sufficient — WeakMap only needs an object key.
function makeWs(override?: Partial<{ close: (...args: unknown[]) => void }>) {
  return { close: vi.fn(), ...override };
}

describe('createWsRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── default config ─────────────────────────────────────────────────────────

  describe('default config (100 msgs / 60 s)', () => {
    it('allows the first message', () => {
      const limiter = createWsRateLimiter();
      const ws = makeWs();
      expect(limiter.check(ws)).toBe(true);
    });

    it('allows up to maxMessages messages within the window', () => {
      const limiter = createWsRateLimiter({ maxMessages: 5, windowMs: 10_000 });
      const ws = makeWs();
      for (let i = 0; i < 5; i++) {
        expect(limiter.check(ws)).toBe(true);
      }
    });

    it('rejects the (maxMessages + 1)th message', () => {
      const limiter = createWsRateLimiter({ maxMessages: 3, windowMs: 10_000 });
      const ws = makeWs();
      limiter.check(ws);
      limiter.check(ws);
      limiter.check(ws); // 3rd — still allowed
      const result = limiter.check(ws); // 4th — denied
      expect(result).toBe(false);
    });

    it('calls onExceeded when the limit is exceeded', () => {
      const onExceeded = vi.fn();
      const limiter = createWsRateLimiter({ maxMessages: 2, windowMs: 10_000, onExceeded });
      const ws = makeWs();
      limiter.check(ws);
      limiter.check(ws);
      limiter.check(ws); // exceeds
      expect(onExceeded).toHaveBeenCalledOnce();
      expect(onExceeded).toHaveBeenCalledWith(ws);
    });

    it('continues to call onExceeded on subsequent over-limit messages', () => {
      const onExceeded = vi.fn();
      const limiter = createWsRateLimiter({ maxMessages: 1, windowMs: 10_000, onExceeded });
      const ws = makeWs();
      limiter.check(ws); // allowed
      limiter.check(ws); // denied + callback
      limiter.check(ws); // denied + callback again
      expect(onExceeded).toHaveBeenCalledTimes(2);
    });

    it('does not call onExceeded for allowed messages', () => {
      const onExceeded = vi.fn();
      const limiter = createWsRateLimiter({ maxMessages: 5, windowMs: 10_000, onExceeded });
      const ws = makeWs();
      for (let i = 0; i < 5; i++) limiter.check(ws);
      expect(onExceeded).not.toHaveBeenCalled();
    });
  });

  // ── default onExceeded closes the WebSocket ────────────────────────────────

  describe('default onExceeded', () => {
    it('calls ws.close(4029, ...) when the limit is exceeded', () => {
      const limiter = createWsRateLimiter({ maxMessages: 1, windowMs: 60_000 });
      const ws = makeWs();
      limiter.check(ws); // allowed
      limiter.check(ws); // denied
      expect(ws.close).toHaveBeenCalledOnce();
      const [code] = ws.close.mock.calls[0];
      expect(code).toBe(4029);
    });

    it('does not throw if the ws object has no close method', () => {
      const limiter = createWsRateLimiter({ maxMessages: 1, windowMs: 60_000 });
      const ws = {}; // no close method
      limiter.check(ws as object);
      expect(() => limiter.check(ws as object)).not.toThrow();
    });
  });

  // ── window rollover ────────────────────────────────────────────────────────

  describe('window rollover', () => {
    it('resets the count after the window expires', () => {
      const limiter = createWsRateLimiter({ maxMessages: 2, windowMs: 5_000 });
      const ws = makeWs();
      limiter.check(ws); // 1
      limiter.check(ws); // 2
      expect(limiter.check(ws)).toBe(false); // 3 — denied

      // Advance past the 5s window
      vi.advanceTimersByTime(5_001);

      // New window — should be allowed again
      expect(limiter.check(ws)).toBe(true);
    });

    it('starts a fresh window immediately after rollover', () => {
      const limiter = createWsRateLimiter({ maxMessages: 2, windowMs: 1_000 });
      const ws = makeWs();
      limiter.check(ws);
      limiter.check(ws);
      vi.advanceTimersByTime(1_001);
      // fresh window: two more allowed
      expect(limiter.check(ws)).toBe(true);
      expect(limiter.check(ws)).toBe(true);
      expect(limiter.check(ws)).toBe(false);
    });
  });

  // ── independent per-connection tracking ───────────────────────────────────

  describe('per-connection independence', () => {
    it('tracks connections independently', () => {
      const limiter = createWsRateLimiter({ maxMessages: 2, windowMs: 10_000 });
      const ws1 = makeWs();
      const ws2 = makeWs();
      limiter.check(ws1);
      limiter.check(ws1);
      expect(limiter.check(ws1)).toBe(false); // ws1 exhausted
      expect(limiter.check(ws2)).toBe(true);  // ws2 unaffected
    });
  });

  // ── getStatus ──────────────────────────────────────────────────────────────

  describe('getStatus', () => {
    it('returns max remaining for an untracked connection', () => {
      const limiter = createWsRateLimiter({ maxMessages: 10, windowMs: 60_000 });
      const ws = makeWs();
      const status = limiter.getStatus(ws);
      expect(status.count).toBe(0);
      expect(status.remaining).toBe(10);
      expect(status.windowMs).toBe(60_000);
    });

    it('reflects current count after messages', () => {
      const limiter = createWsRateLimiter({ maxMessages: 10, windowMs: 60_000 });
      const ws = makeWs();
      limiter.check(ws);
      limiter.check(ws);
      limiter.check(ws);
      const status = limiter.getStatus(ws);
      expect(status.count).toBe(3);
      expect(status.remaining).toBe(7);
    });

    it('remaining never goes below zero', () => {
      const limiter = createWsRateLimiter({ maxMessages: 2, windowMs: 60_000 });
      const ws = makeWs();
      limiter.check(ws);
      limiter.check(ws);
      limiter.check(ws); // over limit
      const status = limiter.getStatus(ws);
      expect(status.remaining).toBe(0);
    });

    it('reports windowMs as time remaining in window, not total window', () => {
      const limiter = createWsRateLimiter({ maxMessages: 10, windowMs: 10_000 });
      const ws = makeWs();
      limiter.check(ws); // starts the window
      vi.advanceTimersByTime(4_000);
      const status = limiter.getStatus(ws);
      // ~6000ms remaining in the window
      expect(status.windowMs).toBeLessThan(10_000);
      expect(status.windowMs).toBeGreaterThan(0);
    });

    it('returns fresh status after window expires', () => {
      const limiter = createWsRateLimiter({ maxMessages: 5, windowMs: 5_000 });
      const ws = makeWs();
      limiter.check(ws);
      limiter.check(ws);
      vi.advanceTimersByTime(5_001);
      const status = limiter.getStatus(ws);
      expect(status.count).toBe(0);
      expect(status.remaining).toBe(5);
    });
  });

  // ── reset ──────────────────────────────────────────────────────────────────

  describe('reset', () => {
    it('resets the rate limit for a connection', () => {
      const limiter = createWsRateLimiter({ maxMessages: 2, windowMs: 60_000 });
      const ws = makeWs();
      limiter.check(ws);
      limiter.check(ws);
      expect(limiter.check(ws)).toBe(false); // over limit
      limiter.reset(ws);
      expect(limiter.check(ws)).toBe(true); // allowed after reset
    });

    it('reset on untracked connection does not throw', () => {
      const limiter = createWsRateLimiter();
      const ws = makeWs();
      expect(() => limiter.reset(ws)).not.toThrow();
    });

    it('reset does not affect other connections', () => {
      const limiter = createWsRateLimiter({ maxMessages: 2, windowMs: 60_000 });
      const ws1 = makeWs();
      const ws2 = makeWs();
      limiter.check(ws1);
      limiter.check(ws1);
      limiter.check(ws2);
      limiter.reset(ws1);
      // ws2 state unchanged
      expect(limiter.getStatus(ws2).count).toBe(1);
    });
  });

  // ── custom config ──────────────────────────────────────────────────────────

  describe('custom config', () => {
    it('uses the provided maxMessages override', () => {
      const limiter = createWsRateLimiter({ maxMessages: 1, windowMs: 60_000 });
      const ws = makeWs();
      expect(limiter.check(ws)).toBe(true);
      expect(limiter.check(ws)).toBe(false);
    });

    it('uses the provided windowMs override', () => {
      const limiter = createWsRateLimiter({ maxMessages: 5, windowMs: 500 });
      const ws = makeWs();
      for (let i = 0; i < 5; i++) limiter.check(ws);
      vi.advanceTimersByTime(501);
      expect(limiter.check(ws)).toBe(true); // new window
    });

    it('accepts a zero-message limit (every message denied)', () => {
      const limiter = createWsRateLimiter({ maxMessages: 0, windowMs: 60_000 });
      const ws = makeWs();
      expect(limiter.check(ws)).toBe(false);
    });
  });
});
