import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  computeP95,
  countRecentBreaches,
  LATENCY_BREACH_COUNT,
  LatencyTracker,
} from '@ai-gateway/autoscaler/latency-tracker';

describe('computeP95', () => {
  it('returns null for empty array', () => {
    expect(computeP95([])).toBeNull();
  });

  it('returns the single value for array of one', () => {
    expect(computeP95([42])).toBe(42);
  });

  it('computes p95 for sequential values 1..100', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    // p95 of [1..100] = value at index ceil(100*0.95)-1 = 94 → value 95
    expect(computeP95(samples)).toBe(95);
  });

  it('handles unsorted input', () => {
    const samples = [500, 100, 300, 200, 400];
    const result = computeP95(samples);
    expect(result).toBe(500); // ceil(5*0.95)-1 = 4 → sorted[4] = 500
  });

  it('does not mutate original array', () => {
    const samples = [3, 1, 2];
    computeP95(samples);
    expect(samples).toEqual([3, 1, 2]);
  });

  it('works with identical values', () => {
    expect(computeP95([100, 100, 100, 100])).toBe(100);
  });
});

describe('countRecentBreaches', () => {
  it('returns 0 for empty samples', () => {
    expect(countRecentBreaches([], 1000)).toBe(0);
  });

  it('returns 0 when all samples are below threshold', () => {
    expect(countRecentBreaches([100, 200, 300, 400, 500], 1000)).toBe(0);
  });

  it('counts all breaches when all recent samples exceed threshold', () => {
    expect(countRecentBreaches([2000, 3000, 4000], 1000)).toBe(LATENCY_BREACH_COUNT);
  });

  it('only considers last LATENCY_BREACH_COUNT samples', () => {
    // First 5 samples are low, last 3 are high
    expect(countRecentBreaches([100, 200, 300, 400, 500, 2000, 3000, 4000], 1000)).toBe(
      LATENCY_BREACH_COUNT,
    );
  });

  it('counts mixed recent breaches correctly', () => {
    // Last 3 samples: 500 (ok), 2000 (breach), 3000 (breach)
    expect(countRecentBreaches([100, 500, 2000, 3000], 1000)).toBe(2);
  });
});

describe('LatencyTracker', () => {
  let store: { data: Map<string, string[]> };
  let tracker: LatencyTracker;

  beforeEach(() => {
    store = {
      data: new Map(),
    };
    // Build a minimal ListStore mock
    const listStore = {
      rpush: vi.fn(async (key: string, value: string) => {
        const arr = store.data.get(key) ?? [];
        arr.push(value);
        store.data.set(key, arr);
      }),
      ltrim: vi.fn(async (key: string, start: number, stop: number) => {
        const arr = store.data.get(key) ?? [];
        // Redis-compatible: negative indices count from end
        const len = arr.length;
        const s = start < 0 ? Math.max(0, len + start) : start;
        const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
        store.data.set(key, arr.slice(s, e + 1));
      }),
      lrange: vi.fn(async (key: string, start: number, stop: number) => {
        const arr = store.data.get(key) ?? [];
        const len = arr.length;
        const s = start < 0 ? Math.max(0, len + start) : start;
        const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
        return arr.slice(s, e + 1);
      }),
    };
    tracker = new LatencyTracker(listStore as any);
  });

  it('reports and retrieves latency stats', async () => {
    await tracker.reportLatency('user-1', 500);
    await tracker.reportLatency('user-1', 1000);
    await tracker.reportLatency('user-1', 1500);

    const stats = await tracker.getLatencyStats('user-1', 1200);
    expect(stats.samples).toEqual([500, 1000, 1500]);
    expect(stats.p95).toBe(1500);
    expect(stats.breaches).toBe(1); // 1500 > 1200
  });

  it('returns empty stats for unknown user', async () => {
    const stats = await tracker.getLatencyStats('nonexistent');
    expect(stats).toEqual({ p95: null, samples: [], breaches: 0 });
  });

  it('filters NaN values from stored samples', async () => {
    // Simulate corrupt data in store
    store.data.set('autoscaler:latency:user-1', ['100', 'NaN', '200', 'invalid']);
    const listStore = {
      rpush: vi.fn(),
      ltrim: vi.fn(),
      lrange: vi.fn(async () => store.data.get('autoscaler:latency:user-1') ?? []),
    };
    const t = new LatencyTracker(listStore as any);
    const stats = await t.getLatencyStats('user-1');
    expect(stats.samples).toEqual([100, 200]);
  });
});
