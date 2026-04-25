/**
 * predictive-warmer — Phase 3.
 *
 * Uses fake timers so the tick loop can be advanced deterministically and
 * no real interval leaks between tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPredictiveWarmerForTests,
  currentEwma,
  forecastNext,
  recordRequest,
  startPredictiveWarmer,
  stopPredictiveWarmer,
} from '../src/gateway/autoscaler/predictive-warmer';

const MINUTE = 60_000;

describe('predictive-warmer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    _resetPredictiveWarmerForTests();
  });

  afterEach(() => {
    _resetPredictiveWarmerForTests();
    vi.useRealTimers();
  });

  it('EWMA stabilizes on a steady request rate', () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    for (let minute = 0; minute < 15; minute++) {
      for (let i = 0; i < 10; i++) {
        recordRequest(base + minute * MINUTE + i * 1_000);
      }
    }
    vi.setSystemTime(new Date(base + 15 * MINUTE));
    const ewma = currentEwma();
    expect(ewma).toBeGreaterThan(9);
    expect(ewma).toBeLessThanOrEqual(10);
  });

  it('forecast on a flat history returns zero when there is no traffic', () => {
    expect(forecastNext()).toBe(0);
  });

  it('triggers ensureCapacity when forecast exceeds capacity', async () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    // Heavy, sustained traffic: 20 req/min for 15 minutes.
    for (let minute = 0; minute < 15; minute++) {
      for (let i = 0; i < 20; i++) {
        recordRequest(base + minute * MINUTE + i * 500);
      }
    }
    vi.setSystemTime(new Date(base + 15 * MINUTE));
    const getCapacity = vi.fn(() => 1);
    const ensureCapacity = vi.fn(async (_target: number) => {});
    startPredictiveWarmer(getCapacity, ensureCapacity, { tickMs: 1_000, forecastWindowMin: 5, safetyMargin: 1.2 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ensureCapacity).toHaveBeenCalled();
    const target = ensureCapacity.mock.calls[0][0];
    // Forecast: ~20 req/min * 5 min * 1.2 = 120
    expect(target).toBeGreaterThanOrEqual(100);
  });

  it('does not call ensureCapacity when target is already met', async () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    for (let minute = 0; minute < 15; minute++) {
      for (let i = 0; i < 5; i++) {
        recordRequest(base + minute * MINUTE + i * 1_000);
      }
    }
    vi.setSystemTime(new Date(base + 15 * MINUTE));
    const ensureCapacity = vi.fn(async (_target: number) => {});
    startPredictiveWarmer(() => 9_999, ensureCapacity, { tickMs: 1_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(ensureCapacity).not.toHaveBeenCalled();
  });

  it('stopPredictiveWarmer halts ticks', async () => {
    const ensureCapacity = vi.fn(async (_target: number) => {});
    startPredictiveWarmer(() => 0, ensureCapacity, { tickMs: 1_000 });
    stopPredictiveWarmer();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ensureCapacity).not.toHaveBeenCalled();
  });
});
