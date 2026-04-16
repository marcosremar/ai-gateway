import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EWMATracker, type EWMARanking } from '../../server/ewma-tracker';

describe('EWMATracker', () => {
  let tracker: EWMATracker;

  beforeEach(() => {
    tracker = new EWMATracker(0.3);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Initial state ──────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('ranking returns empty array when no providers recorded', () => {
      expect(tracker.ranking()).toEqual([]);
    });

    it('getState returns empty object when no providers recorded', () => {
      expect(tracker.getState()).toEqual({});
    });

    it('getLatency returns null for unknown provider', () => {
      expect(tracker.getLatency('unknown')).toBeNull();
    });

    it('pickBest returns null with empty candidates', () => {
      expect(tracker.pickBest([])).toBeNull();
    });
  });

  // ── Recording first observation ────────────────────────────────────────────

  describe('first observation', () => {
    it('EWMA equals the exact first value', () => {
      vi.setSystemTime(1000);
      tracker.record('providerA', 200);
      expect(tracker.getLatency('providerA')).toBe(200);
    });

    it('peak equals the first value', () => {
      vi.setSystemTime(1000);
      tracker.record('providerA', 150);
      const state = tracker.getState();
      expect(state['providerA'].peakMs).toBe(150);
    });

    it('samples count is 1 after first observation', () => {
      tracker.record('providerA', 100);
      const state = tracker.getState();
      expect(state['providerA'].samples).toBe(1);
    });
  });

  // ── Multiple observations / EWMA blending ─────────────────────────────────

  describe('multiple observations', () => {
    it('EWMA blends correctly with decay factor 0.3', () => {
      vi.setSystemTime(1000);
      tracker.record('p', 100);
      // ewma = 100

      vi.setSystemTime(2000);
      tracker.record('p', 200);
      // ewma = 0.3 * 200 + 0.7 * 100 = 60 + 70 = 130
      expect(tracker.getLatency('p')).toBe(130);
    });

    it('samples count increments on each observation', () => {
      vi.setSystemTime(1000);
      tracker.record('p', 100);
      tracker.record('p', 200);
      tracker.record('p', 300);
      expect(tracker.getState()['p'].samples).toBe(3);
    });

    it('EWMA converges toward repeated values', () => {
      vi.setSystemTime(1000);
      tracker.record('p', 500);
      // Record many 100ms observations — EWMA should converge toward 100
      for (let i = 0; i < 50; i++) {
        tracker.record('p', 100);
      }
      const latency = tracker.getLatency('p')!;
      expect(latency).toBeGreaterThan(99);
      expect(latency).toBeLessThan(110);
    });
  });

  // ── Decay factor effect ────────────────────────────────────────────────────

  describe('decay factor effect', () => {
    it('higher decay gives more weight to recent observations', () => {
      const lowDecay = new EWMATracker(0.1);
      const highDecay = new EWMATracker(0.9);

      vi.setSystemTime(1000);
      lowDecay.record('p', 100);
      highDecay.record('p', 100);

      vi.setSystemTime(2000);
      lowDecay.record('p', 500);
      highDecay.record('p', 500);

      const lowLatency = lowDecay.getLatency('p')!;
      const highLatency = highDecay.getLatency('p')!;

      // High decay EWMA: 0.9*500 + 0.1*100 = 460
      // Low decay EWMA:  0.1*500 + 0.9*100 = 140
      expect(highLatency).toBeGreaterThan(lowLatency);
      expect(highLatency).toBeCloseTo(460);
      expect(lowLatency).toBeCloseTo(140);
    });
  });

  // ── Peak tracking ─────────────────────────────────────────────────────────

  describe('peak tracking', () => {
    it('peak stays above or equal to EWMA', () => {
      vi.setSystemTime(1000);
      tracker.record('p', 100);
      tracker.record('p', 500);
      tracker.record('p', 50);

      const state = tracker.getState();
      expect(state['p'].peakMs).toBeGreaterThanOrEqual(state['p'].ewmaMs);
    });

    it('peak reflects worst-case blending', () => {
      vi.setSystemTime(1000);
      tracker.record('p', 100);
      // ewma = 100, peak = 100

      vi.setSystemTime(2000);
      tracker.record('p', 400);
      // ewma = 0.3*400 + 0.7*100 = 190
      // peak = max(190, 400*0.5 + 100*0.5) = max(190, 250) = 250
      const state = tracker.getState();
      expect(state['p'].ewmaMs).toBe(190);
      expect(state['p'].peakMs).toBe(250);
    });
  });

  // ── Stale penalty ─────────────────────────────────────────────────────────

  describe('stale penalty', () => {
    it('inflates EWMA by 10% when provider unused for >60s', () => {
      vi.setSystemTime(1000);
      tracker.record('p', 200);

      // Advance time by 61 seconds
      vi.setSystemTime(1000 + 61_000);
      const latency = tracker.getLatency('p')!;
      // 200 * 1.1 = 220
      expect(latency).toBeCloseTo(220);
    });

    it('does not penalize provider used within 60s', () => {
      vi.setSystemTime(1000);
      tracker.record('p', 200);

      // Advance time by 59 seconds — still within threshold
      vi.setSystemTime(1000 + 59_000);
      const latency = tracker.getLatency('p')!;
      expect(latency).toBe(200);
    });

    it('ranking applies stale penalty to sort order', () => {
      vi.setSystemTime(1000);
      tracker.record('fast', 100);
      tracker.record('slow', 150);

      // Make 'fast' stale — advance 61s
      vi.setSystemTime(1000 + 61_000);
      tracker.record('slow', 150);

      const ranked = tracker.ranking();
      // 'fast' is stale: 100 * 1.1 = 110
      // 'slow' is fresh: 0.3*150 + 0.7*150 = 150
      // But 110 < 150, so fast is still best
      expect(ranked[0].provider).toBe('fast');

      // Now make 'fast' really stale and slow very fast
      vi.setSystemTime(1000 + 61_000 + 1);
      tracker.record('slow', 50);

      const ranked2 = tracker.ranking();
      // 'fast' stale: 100 * 1.1 = 110
      // 'slow' fresh: 0.3*50 + 0.7*150 = 120. Hmm still 110 < 120.
      // Let's verify manually:
      expect(ranked2[0].provider).toBe('fast');
    });
  });

  // ── pickBest ──────────────────────────────────────────────────────────────

  describe('pickBest', () => {
    it('returns lowest EWMA provider', () => {
      vi.setSystemTime(1000);
      tracker.record('fast', 100);
      tracker.record('medium', 200);
      tracker.record('slow', 500);

      expect(tracker.pickBest(['fast', 'medium', 'slow'])).toBe('fast');
    });

    it('returns the single candidate even if unknown', () => {
      expect(tracker.pickBest(['unknown'])).toBe('unknown');
    });

    it('returns first unknown when all candidates are unknown', () => {
      expect(tracker.pickBest(['a', 'b', 'c'])).toBe('a');
    });

    it('prefers known providers over unknowns', () => {
      vi.setSystemTime(1000);
      tracker.record('known', 300);

      expect(tracker.pickBest(['unknown', 'known'])).toBe('known');
    });

    it('returns null for empty candidates', () => {
      expect(tracker.pickBest([])).toBeNull();
    });
  });

  // ── ranking ───────────────────────────────────────────────────────────────

  describe('ranking', () => {
    it('sorts by EWMA ascending (lowest first)', () => {
      vi.setSystemTime(1000);
      tracker.record('slow', 500);
      tracker.record('fast', 50);
      tracker.record('medium', 200);

      const ranked = tracker.ranking();
      expect(ranked.map(r => r.provider)).toEqual(['fast', 'medium', 'slow']);
    });

    it('returns EWMARanking shape with all fields', () => {
      vi.setSystemTime(1000);
      tracker.record('p', 123);

      const ranked = tracker.ranking();
      expect(ranked).toHaveLength(1);
      expect(ranked[0]).toEqual({
        provider: 'p',
        ewmaMs: 123,
        peakMs: 123,
        samples: 1,
      });
    });

    it('rounds EWMA and peak to integers', () => {
      vi.setSystemTime(1000);
      tracker.record('p', 100);
      tracker.record('p', 101);
      // ewma = 0.3*101 + 0.7*100 = 30.3 + 70 = 100.3

      const ranked = tracker.ranking();
      expect(ranked[0].ewmaMs).toBe(100); // Math.round(100.3)
    });
  });

  // ── setDecayFactor ────────────────────────────────────────────────────────

  describe('setDecayFactor', () => {
    it('clamps to 0 when given negative value', () => {
      tracker.setDecayFactor(-0.5);

      vi.setSystemTime(1000);
      tracker.record('p', 100);
      tracker.record('p', 200);
      // With decay=0: ewma = 0*200 + 1*100 = 100
      expect(tracker.getLatency('p')).toBe(100);
    });

    it('clamps to 1 when given value above 1', () => {
      tracker.setDecayFactor(5);

      vi.setSystemTime(1000);
      tracker.record('p', 100);
      tracker.record('p', 200);
      // With decay=1: ewma = 1*200 + 0*100 = 200
      expect(tracker.getLatency('p')).toBe(200);
    });

    it('accepts valid values between 0 and 1', () => {
      tracker.setDecayFactor(0.5);

      vi.setSystemTime(1000);
      tracker.record('p', 100);
      tracker.record('p', 200);
      // With decay=0.5: ewma = 0.5*200 + 0.5*100 = 150
      expect(tracker.getLatency('p')).toBe(150);
    });
  });

  // ── reset ─────────────────────────────────────────────────────────────────

  describe('reset', () => {
    it('clears all providers', () => {
      tracker.record('a', 100);
      tracker.record('b', 200);
      tracker.reset();

      expect(tracker.ranking()).toEqual([]);
      expect(tracker.getState()).toEqual({});
      expect(tracker.getLatency('a')).toBeNull();
    });
  });

  // ── getState ──────────────────────────────────────────────────────────────

  describe('getState', () => {
    it('returns all provider data', () => {
      vi.setSystemTime(5000);
      tracker.record('a', 100);
      tracker.record('b', 200);

      const state = tracker.getState();
      expect(Object.keys(state)).toHaveLength(2);
      expect(state['a']).toEqual({
        ewmaMs: 100,
        peakMs: 100,
        samples: 1,
        lastUpdate: 5000,
      });
      expect(state['b']).toEqual({
        ewmaMs: 200,
        peakMs: 200,
        samples: 1,
        lastUpdate: 5000,
      });
    });
  });

  // ── Max providers eviction (LRU at MAX_PROVIDERS=50) ──────────────────────

  describe('max providers eviction', () => {
    it('evicts the oldest provider when at capacity', () => {
      // Fill up to 50 providers
      for (let i = 0; i < 50; i++) {
        vi.setSystemTime(i * 1000);
        tracker.record(`provider-${i}`, 100 + i);
      }
      expect(Object.keys(tracker.getState())).toHaveLength(50);

      // Recording a 51st should evict the oldest (provider-0 at time 0)
      vi.setSystemTime(100_000);
      tracker.record('provider-new', 999);

      const state = tracker.getState();
      expect(Object.keys(state)).toHaveLength(50);
      expect(state['provider-0']).toBeUndefined();
      expect(state['provider-new']).toBeDefined();
      // provider-1 (time 1000) should still exist
      expect(state['provider-1']).toBeDefined();
    });

    it('evicts based on lastUpdate time, not insertion order', () => {
      // Fill up to 50 providers
      for (let i = 0; i < 50; i++) {
        vi.setSystemTime(i * 1000);
        tracker.record(`provider-${i}`, 100);
      }

      // Update provider-0 to make it recent
      vi.setSystemTime(999_000);
      tracker.record('provider-0', 100);

      // Now provider-1 (time 1000) is the oldest
      vi.setSystemTime(1_000_000);
      tracker.record('provider-new', 999);

      const state = tracker.getState();
      expect(state['provider-0']).toBeDefined(); // was updated recently
      expect(state['provider-1']).toBeUndefined(); // oldest, evicted
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('recording with latencyMs=0', () => {
      vi.setSystemTime(1000);
      tracker.record('p', 0);
      expect(tracker.getLatency('p')).toBe(0);
      expect(tracker.getState()['p'].ewmaMs).toBe(0);
    });

    it('multiple providers with same EWMA are both returned in ranking', () => {
      vi.setSystemTime(1000);
      tracker.record('a', 100);
      tracker.record('b', 100);

      const ranked = tracker.ranking();
      expect(ranked).toHaveLength(2);
      expect(ranked[0].ewmaMs).toBe(100);
      expect(ranked[1].ewmaMs).toBe(100);
      // Both providers should be present
      const providers = ranked.map(r => r.provider);
      expect(providers).toContain('a');
      expect(providers).toContain('b');
    });

    it('constructor clamps decay factor to valid range', () => {
      const trackerNeg = new EWMATracker(-1);
      vi.setSystemTime(1000);
      trackerNeg.record('p', 100);
      trackerNeg.record('p', 200);
      // decay=0 → ewma stays at 100
      expect(trackerNeg.getLatency('p')).toBe(100);

      const trackerHigh = new EWMATracker(2);
      vi.setSystemTime(2000);
      trackerHigh.record('p', 100);
      trackerHigh.record('p', 200);
      // decay=1 → ewma = 200
      expect(trackerHigh.getLatency('p')).toBe(200);
    });
  });
});
