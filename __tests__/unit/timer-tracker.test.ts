/**
 * Unit tests for src/middleware/timer-tracker.ts
 *
 * Covers: trackedTimeout, trackedInterval, clearTimer, clearAllTimers, getTimerStats
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

import {
  trackedTimeout,
  trackedInterval,
  clearTimer,
  clearAllTimers,
  getTimerStats,
} from '../../src/middleware/timer-tracker';

beforeEach(async () => {
  // Always start from a clean slate
  await clearAllTimers();
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await clearAllTimers();
});

// ── trackedTimeout ────────────────────────────────────────────────────────────

describe('trackedTimeout', () => {
  it('returns a timer id', () => {
    const id = trackedTimeout(() => {}, 100, 'test');
    expect(id).toBeDefined();
    clearTimer(id);
  });

  it('registers the timeout in stats immediately', () => {
    const id = trackedTimeout(() => {}, 500, 'register-test');
    const stats = getTimerStats();
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.timeouts).toBeGreaterThanOrEqual(1);
    clearTimer(id);
  });

  it('invokes the callback when the timer fires', () => {
    const fn = vi.fn();
    trackedTimeout(fn, 200, 'callback-test');
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('removes itself from active timers after firing', () => {
    trackedTimeout(() => {}, 100, 'self-remove');
    const before = getTimerStats().total;
    vi.advanceTimersByTime(100);
    const after = getTimerStats().total;
    expect(after).toBe(before - 1);
  });

  it('groups timers by module name in stats', () => {
    const id1 = trackedTimeout(() => {}, 1000, 'mod-a');
    const id2 = trackedTimeout(() => {}, 1000, 'mod-a');
    const id3 = trackedTimeout(() => {}, 1000, 'mod-b');
    const stats = getTimerStats();
    expect(stats.byModule['mod-a']).toBe(2);
    expect(stats.byModule['mod-b']).toBe(1);
    clearTimer(id1);
    clearTimer(id2);
    clearTimer(id3);
  });

  it('uses "unknown" as the default module name', () => {
    const id = trackedTimeout(() => {}, 1000);
    const stats = getTimerStats();
    expect(stats.byModule['unknown']).toBeGreaterThanOrEqual(1);
    clearTimer(id);
  });

  it('does not fire callback if cleared before delay', () => {
    const fn = vi.fn();
    const id = trackedTimeout(fn, 500, 'pre-clear');
    clearTimer(id);
    vi.advanceTimersByTime(600);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ── trackedInterval ───────────────────────────────────────────────────────────

describe('trackedInterval', () => {
  it('returns a timer id', () => {
    const id = trackedInterval(() => {}, 100, 'interval-id');
    expect(id).toBeDefined();
    clearTimer(id);
  });

  it('registers as interval type in stats', () => {
    const id = trackedInterval(() => {}, 500, 'interval-type');
    const stats = getTimerStats();
    expect(stats.intervals).toBeGreaterThanOrEqual(1);
    clearTimer(id);
  });

  it('calls the callback repeatedly on each tick', () => {
    const fn = vi.fn();
    const id = trackedInterval(fn, 100, 'repeated');
    vi.advanceTimersByTime(350);
    expect(fn).toHaveBeenCalledTimes(3);
    clearTimer(id);
  });

  it('does NOT remove itself from active timers after firing (persists)', () => {
    const id = trackedInterval(() => {}, 100, 'persists');
    vi.advanceTimersByTime(300);
    const stats = getTimerStats();
    // Interval should still be tracked
    expect(stats.intervals).toBeGreaterThanOrEqual(1);
    clearTimer(id);
  });

  it('stops firing after clearTimer', () => {
    const fn = vi.fn();
    const id = trackedInterval(fn, 100, 'stop-interval');
    vi.advanceTimersByTime(250);
    clearTimer(id);
    const callsBeforeClear = fn.mock.calls.length;
    vi.advanceTimersByTime(300);
    expect(fn.mock.calls.length).toBe(callsBeforeClear);
  });
});

// ── clearTimer ────────────────────────────────────────────────────────────────

describe('clearTimer', () => {
  it('removes a tracked timeout from active map', () => {
    const id = trackedTimeout(() => {}, 1000, 'clear-timeout');
    const before = getTimerStats().total;
    clearTimer(id);
    expect(getTimerStats().total).toBe(before - 1);
  });

  it('removes a tracked interval from active map', () => {
    const id = trackedInterval(() => {}, 1000, 'clear-interval');
    const before = getTimerStats().total;
    clearTimer(id);
    expect(getTimerStats().total).toBe(before - 1);
  });

  it('handles unknown (untracked) ids without throwing', () => {
    // A raw setTimeout that was never tracked
    const rawId = setTimeout(() => {}, 9999);
    expect(() => clearTimer(rawId)).not.toThrow();
    clearTimeout(rawId);
  });

  it('calling clearTimer twice on same id does not throw', () => {
    const id = trackedTimeout(() => {}, 1000, 'double-clear');
    clearTimer(id);
    expect(() => clearTimer(id)).not.toThrow();
  });
});

// ── clearAllTimers ────────────────────────────────────────────────────────────

describe('clearAllTimers', () => {
  it('clears all tracked timeouts and intervals', async () => {
    trackedTimeout(() => {}, 5000, 'bulk-t1');
    trackedTimeout(() => {}, 5000, 'bulk-t2');
    trackedInterval(() => {}, 5000, 'bulk-i1');
    expect(getTimerStats().total).toBeGreaterThanOrEqual(3);

    await clearAllTimers();
    expect(getTimerStats().total).toBe(0);
  });

  it('leaves no stale timeouts firing after clear', async () => {
    const fn = vi.fn();
    trackedTimeout(fn, 100, 'stale');
    await clearAllTimers();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });

  it('leaves no stale intervals firing after clear', async () => {
    const fn = vi.fn();
    trackedInterval(fn, 100, 'stale-interval');
    await clearAllTimers();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
  });

  it('is safe to call when no timers are active', async () => {
    await expect(clearAllTimers()).resolves.toBeUndefined();
  });
});

// ── getTimerStats ─────────────────────────────────────────────────────────────

describe('getTimerStats', () => {
  it('returns zero counts when no timers are active', () => {
    const stats = getTimerStats();
    expect(stats.total).toBe(0);
    expect(stats.timeouts).toBe(0);
    expect(stats.intervals).toBe(0);
    expect(stats.byModule).toEqual({});
  });

  it('counts timeouts and intervals separately', () => {
    const t = trackedTimeout(() => {}, 9999, 'count-t');
    const i = trackedInterval(() => {}, 9999, 'count-i');
    const stats = getTimerStats();
    expect(stats.timeouts).toBeGreaterThanOrEqual(1);
    expect(stats.intervals).toBeGreaterThanOrEqual(1);
    expect(stats.total).toBe(stats.timeouts + stats.intervals);
    clearTimer(t);
    clearTimer(i);
  });

  it('total equals timeouts + intervals', () => {
    const ids = [
      trackedTimeout(() => {}, 9999, 'sum-t1'),
      trackedTimeout(() => {}, 9999, 'sum-t2'),
      trackedInterval(() => {}, 9999, 'sum-i1'),
    ];
    const stats = getTimerStats();
    expect(stats.total).toBe(stats.timeouts + stats.intervals);
    ids.forEach(id => clearTimer(id));
  });

  it('aggregates counts per module correctly', () => {
    const ids = [
      trackedTimeout(() => {}, 9999, 'alpha'),
      trackedTimeout(() => {}, 9999, 'alpha'),
      trackedInterval(() => {}, 9999, 'beta'),
    ];
    const stats = getTimerStats();
    expect(stats.byModule['alpha']).toBe(2);
    expect(stats.byModule['beta']).toBe(1);
    ids.forEach(id => clearTimer(id));
  });

  it('removes module key when all its timers are cleared', () => {
    const id = trackedTimeout(() => {}, 9999, 'ephemeral');
    expect(getTimerStats().byModule['ephemeral']).toBe(1);
    clearTimer(id);
    expect(getTimerStats().byModule['ephemeral']).toBeUndefined();
  });

  it('updates correctly as timers are added and removed', () => {
    const id1 = trackedTimeout(() => {}, 9999, 'dynamic');
    expect(getTimerStats().total).toBeGreaterThanOrEqual(1);
    const id2 = trackedInterval(() => {}, 9999, 'dynamic');
    expect(getTimerStats().total).toBeGreaterThanOrEqual(2);
    clearTimer(id1);
    expect(getTimerStats().total).toBeGreaterThanOrEqual(1);
    clearTimer(id2);
    expect(getTimerStats().total).toBe(0);
  });
});
