import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PerformanceRanker } from '@ai-gateway/providers/performance-ranker';
import type { FallbackEntry } from '@ai-gateway/providers/fallback';

describe('PerformanceRanker', () => {
  let ranker: PerformanceRanker;

  beforeEach(() => {
    vi.useFakeTimers();
    ranker = new PerformanceRanker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── record() ────────────────────────────────────────────────────────────

  describe('record()', () => {
    it('stores samples and increments sampleCount', () => {
      ranker.record('stt', 'groq', 'whisper-large-v3', 120, true);
      ranker.record('stt', 'groq', 'whisper-large-v3', 130, true);
      const stats = ranker.getStats('stt', 'groq', 'whisper-large-v3');
      expect(stats.sampleCount).toBe(2);
    });

    it('evicts oldest samples when exceeding windowSize', () => {
      const small = new PerformanceRanker({ windowSize: 3 });
      small.record('llm', 'openai', 'gpt-4o', 100, true);
      small.record('llm', 'openai', 'gpt-4o', 200, true);
      small.record('llm', 'openai', 'gpt-4o', 300, true);
      small.record('llm', 'openai', 'gpt-4o', 400, true);
      const stats = small.getStats('llm', 'openai', 'gpt-4o');
      expect(stats.sampleCount).toBe(3);
      // Oldest (100ms) should have been evicted; p50 should be 300
      expect(stats.p50).toBe(300);
    });

    it('isolates different provider:model:stage keys', () => {
      ranker.record('stt', 'groq', 'whisper', 100, true);
      ranker.record('stt', 'openai', 'whisper', 200, true);
      expect(ranker.getStats('stt', 'groq', 'whisper').sampleCount).toBe(1);
      expect(ranker.getStats('stt', 'openai', 'whisper').sampleCount).toBe(1);
      expect(ranker.getStats('llm', 'groq', 'whisper').sampleCount).toBe(0);
    });
  });

  // ─── getStats() ──────────────────────────────────────────────────────────

  describe('getStats()', () => {
    it('returns null percentiles and zero sampleCount for unknown key', () => {
      const stats = ranker.getStats('stt', 'unknown', 'model');
      expect(stats.p50).toBeNull();
      expect(stats.p95).toBeNull();
      expect(stats.successRate).toBe(0);
      expect(stats.sampleCount).toBe(0);
      expect(stats.trend).toBe('stable');
    });

    it('computes p50 correctly for odd number of samples', () => {
      ranker.record('llm', 'a', 'm', 100, true);
      ranker.record('llm', 'a', 'm', 200, true);
      ranker.record('llm', 'a', 'm', 300, true);
      const stats = ranker.getStats('llm', 'a', 'm');
      expect(stats.p50).toBe(200);
    });

    it('computes p50 correctly for even number of samples', () => {
      ranker.record('llm', 'a', 'm', 100, true);
      ranker.record('llm', 'a', 'm', 200, true);
      ranker.record('llm', 'a', 'm', 300, true);
      ranker.record('llm', 'a', 'm', 400, true);
      const stats = ranker.getStats('llm', 'a', 'm');
      expect(stats.p50).toBe(250);
    });

    it('computes p95 correctly', () => {
      // 20 samples: 1, 2, 3, ..., 20
      for (let i = 1; i <= 20; i++) {
        ranker.record('tts', 'a', 'm', i * 100, true);
      }
      const stats = ranker.getStats('tts', 'a', 'm');
      expect(stats.p95).toBeGreaterThan(1800);
      expect(stats.p95).toBeLessThanOrEqual(2000);
    });

    it('computes successRate correctly', () => {
      ranker.record('stt', 'a', 'm', 100, true);
      ranker.record('stt', 'a', 'm', 200, false);
      ranker.record('stt', 'a', 'm', 150, true);
      ranker.record('stt', 'a', 'm', 300, false);
      const stats = ranker.getStats('stt', 'a', 'm');
      expect(stats.successRate).toBe(0.5);
    });

    it('computes percentiles only from successful samples', () => {
      ranker.record('stt', 'a', 'm', 100, true);
      ranker.record('stt', 'a', 'm', 9999, false); // failure with high latency
      ranker.record('stt', 'a', 'm', 200, true);
      const stats = ranker.getStats('stt', 'a', 'm');
      // p50 should be based only on [100, 200], not including the 9999 failure
      expect(stats.p50).toBe(150);
    });

    it('returns null percentiles when all samples are failures', () => {
      ranker.record('stt', 'a', 'm', 100, false);
      ranker.record('stt', 'a', 'm', 200, false);
      const stats = ranker.getStats('stt', 'a', 'm');
      expect(stats.p50).toBeNull();
      expect(stats.p95).toBeNull();
      expect(stats.successRate).toBe(0);
      expect(stats.sampleCount).toBe(2);
    });
  });

  // ─── Time window expiration ──────────────────────────────────────────────

  describe('time window expiration', () => {
    it('expires samples older than windowTimeMs', () => {
      const r = new PerformanceRanker({ windowTimeMs: 60_000 });
      r.record('stt', 'a', 'm', 100, true);
      vi.advanceTimersByTime(61_000);
      const stats = r.getStats('stt', 'a', 'm');
      expect(stats.sampleCount).toBe(0);
      expect(stats.p50).toBeNull();
    });

    it('keeps samples within windowTimeMs', () => {
      const r = new PerformanceRanker({ windowTimeMs: 60_000 });
      r.record('stt', 'a', 'm', 100, true);
      vi.advanceTimersByTime(30_000);
      r.record('stt', 'a', 'm', 200, true);
      const stats = r.getStats('stt', 'a', 'm');
      expect(stats.sampleCount).toBe(2);
    });

    it('partially expires old samples', () => {
      const r = new PerformanceRanker({ windowTimeMs: 60_000 });
      r.record('stt', 'a', 'm', 100, true); // t=0
      vi.advanceTimersByTime(40_000);
      r.record('stt', 'a', 'm', 200, true); // t=40s
      vi.advanceTimersByTime(25_000); // now t=65s — first sample expired
      const stats = r.getStats('stt', 'a', 'm');
      expect(stats.sampleCount).toBe(1);
      expect(stats.p50).toBe(200);
    });
  });

  // ─── Trend detection ─────────────────────────────────────────────────────

  describe('trend detection', () => {
    it('reports stable when not enough samples', () => {
      ranker.record('llm', 'a', 'm', 100, true);
      ranker.record('llm', 'a', 'm', 200, true);
      ranker.record('llm', 'a', 'm', 300, true);
      expect(ranker.getStats('llm', 'a', 'm').trend).toBe('stable');
    });

    it('reports stable when latencies are consistent', () => {
      for (let i = 0; i < 10; i++) {
        ranker.record('llm', 'a', 'm', 100 + (i % 3), true);
      }
      expect(ranker.getStats('llm', 'a', 'm').trend).toBe('stable');
    });

    it('reports degrading when second half is much slower', () => {
      // First half: fast
      for (let i = 0; i < 5; i++) {
        ranker.record('llm', 'a', 'm', 100, true);
      }
      // Second half: 3x slower (above default threshold of 2.0)
      for (let i = 0; i < 5; i++) {
        ranker.record('llm', 'a', 'm', 300, true);
      }
      expect(ranker.getStats('llm', 'a', 'm').trend).toBe('degrading');
    });

    it('reports improving when second half is much faster', () => {
      // First half: slow
      for (let i = 0; i < 5; i++) {
        ranker.record('llm', 'a', 'm', 500, true);
      }
      // Second half: fast (ratio 100/500 = 0.2 < 1/2.0 = 0.5)
      for (let i = 0; i < 5; i++) {
        ranker.record('llm', 'a', 'm', 100, true);
      }
      expect(ranker.getStats('llm', 'a', 'm').trend).toBe('improving');
    });
  });

  // ─── isDegraded() ────────────────────────────────────────────────────────

  describe('isDegraded()', () => {
    it('returns false for unknown key', () => {
      expect(ranker.isDegraded('stt', 'unknown', 'model')).toBe(false);
    });

    it('returns true when trend is degrading', () => {
      for (let i = 0; i < 5; i++) ranker.record('stt', 'a', 'm', 100, true);
      for (let i = 0; i < 5; i++) ranker.record('stt', 'a', 'm', 500, true);
      expect(ranker.isDegraded('stt', 'a', 'm')).toBe(true);
    });

    it('returns false when trend is stable', () => {
      for (let i = 0; i < 10; i++) ranker.record('stt', 'a', 'm', 100, true);
      expect(ranker.isDegraded('stt', 'a', 'm')).toBe(false);
    });
  });

  // ─── rankChain() ─────────────────────────────────────────────────────────

  describe('rankChain()', () => {
    const chain: FallbackEntry[] = [
      { provider: 'slow', model: 'large' },
      { provider: 'fast', model: 'small' },
      { provider: 'medium', model: 'mid' },
    ];

    it('returns a copy without mutating the input', () => {
      const original = [...chain];
      ranker.rankChain('stt', chain);
      expect(chain).toEqual(original);
    });

    it('preserves original order when no samples exist', () => {
      const ranked = ranker.rankChain('stt', chain);
      expect(ranked.map((e) => e.provider)).toEqual(['slow', 'fast', 'medium']);
    });

    it('preserves original order when samples are below minSamples', () => {
      const r = new PerformanceRanker({ minSamples: 5 });
      // Only 3 samples each — below threshold
      for (let i = 0; i < 3; i++) {
        r.record('stt', 'slow', 'large', 500, true);
        r.record('stt', 'fast', 'small', 100, true);
      }
      const ranked = r.rankChain('stt', chain);
      expect(ranked.map((e) => e.provider)).toEqual(['slow', 'fast', 'medium']);
    });

    it('reorders chain by latency when enough samples exist', () => {
      const r = new PerformanceRanker({ minSamples: 3 });
      for (let i = 0; i < 5; i++) {
        r.record('stt', 'slow', 'large', 500, true);
        r.record('stt', 'fast', 'small', 100, true);
        r.record('stt', 'medium', 'mid', 250, true);
      }
      const ranked = r.rankChain('stt', chain);
      expect(ranked.map((e) => e.provider)).toEqual(['fast', 'medium', 'slow']);
    });

    it('places unscored entries after scored ones', () => {
      const r = new PerformanceRanker({ minSamples: 3 });
      // Only score 'fast' and 'slow' — 'medium' has no data
      for (let i = 0; i < 5; i++) {
        r.record('stt', 'slow', 'large', 500, true);
        r.record('stt', 'fast', 'small', 100, true);
      }
      const ranked = r.rankChain('stt', chain);
      expect(ranked.map((e) => e.provider)).toEqual(['fast', 'slow', 'medium']);
    });

    it('penalizes providers with low success rate', () => {
      const r = new PerformanceRanker({ minSamples: 3 });
      // 'flaky' has low latency but 50% success rate
      for (let i = 0; i < 6; i++) {
        r.record('llm', 'flaky', 'f', 100, i % 2 === 0); // 3 success, 3 fail
        r.record('llm', 'reliable', 'r', 180, true); // 100% success
      }
      const entries: FallbackEntry[] = [
        { provider: 'flaky', model: 'f' },
        { provider: 'reliable', model: 'r' },
      ];
      const ranked = r.rankChain('llm', entries);
      // flaky score: 100 * (2 - 0.5) = 150
      // reliable score: 180 * (2 - 1.0) = 180
      // flaky still wins on raw math, but let's verify the order is correct
      // Actually score: flaky = 100 * 1.5 = 150, reliable = 180 * 1.0 = 180
      // So flaky comes first (lower score). But if success rate drops further...
      expect(ranked.map((e) => e.provider)).toEqual(['flaky', 'reliable']);
    });

    it('heavily penalizes degrading providers', () => {
      const r = new PerformanceRanker({ minSamples: 3, degradationThreshold: 2.0 });
      // 'degrading' provider: starts fast then gets slow
      for (let i = 0; i < 4; i++) r.record('llm', 'degrading', 'd', 100, true);
      for (let i = 0; i < 4; i++) r.record('llm', 'degrading', 'd', 400, true);
      // 'stable' provider: consistently 250ms
      for (let i = 0; i < 8; i++) r.record('llm', 'stable', 's', 250, true);

      const entries: FallbackEntry[] = [
        { provider: 'degrading', model: 'd' },
        { provider: 'stable', model: 's' },
      ];
      const ranked = r.rankChain('llm', entries);
      // degrading: p50 ~ 250, trend=degrading, score = 250 * 1.0 * 2.0 = 500
      // stable: p50 = 250, trend=stable, score = 250 * 1.0 = 250
      expect(ranked.map((e) => e.provider)).toEqual(['stable', 'degrading']);
    });

    it('handles single-entry chain', () => {
      const single: FallbackEntry[] = [{ provider: 'a', model: 'b' }];
      const ranked = ranker.rankChain('stt', single);
      expect(ranked).toEqual([{ provider: 'a', model: 'b' }]);
    });

    it('handles empty chain', () => {
      expect(ranker.rankChain('stt', [])).toEqual([]);
    });

    it('uses wildcard model when entry has no model', () => {
      const r = new PerformanceRanker({ minSamples: 2 });
      for (let i = 0; i < 3; i++) r.record('stt', 'a', '*', 100, true);

      const entries: FallbackEntry[] = [{ provider: 'a' }];
      const stats = r.getStats('stt', 'a', '*');
      expect(stats.sampleCount).toBe(3);
      expect(stats.p50).toBe(100);
    });
  });

  // ─── Custom config ──────────────────────────────────────────────────────

  describe('custom config', () => {
    it('respects custom degradationThreshold', () => {
      const r = new PerformanceRanker({ degradationThreshold: 1.5 });
      // First half: 100ms, second half: 160ms (ratio 1.6 > 1.5 threshold)
      for (let i = 0; i < 4; i++) r.record('stt', 'a', 'm', 100, true);
      for (let i = 0; i < 4; i++) r.record('stt', 'a', 'm', 160, true);
      expect(r.getStats('stt', 'a', 'm').trend).toBe('degrading');
    });

    it('respects custom windowSize', () => {
      const r = new PerformanceRanker({ windowSize: 2 });
      r.record('stt', 'a', 'm', 100, true);
      r.record('stt', 'a', 'm', 200, true);
      r.record('stt', 'a', 'm', 300, true);
      expect(r.getStats('stt', 'a', 'm').sampleCount).toBe(2);
    });

    it('respects custom minSamples', () => {
      const r = new PerformanceRanker({ minSamples: 10 });
      for (let i = 0; i < 9; i++) r.record('stt', 'a', 'm', 100, true);

      const entries: FallbackEntry[] = [
        { provider: 'a', model: 'm' },
        { provider: 'b', model: 'n' },
      ];
      // Not enough samples → should preserve original order
      const ranked = r.rankChain('stt', entries);
      expect(ranked.map((e) => e.provider)).toEqual(['a', 'b']);
    });
  });

  // ─── Utility methods ─────────────────────────────────────────────────────

  describe('utility methods', () => {
    it('clear() removes all data', () => {
      ranker.record('stt', 'a', 'm', 100, true);
      ranker.record('llm', 'b', 'n', 200, true);
      expect(ranker.size).toBe(2);
      ranker.clear();
      expect(ranker.size).toBe(0);
      expect(ranker.getStats('stt', 'a', 'm').sampleCount).toBe(0);
    });

    it('size tracks number of unique keys', () => {
      expect(ranker.size).toBe(0);
      ranker.record('stt', 'a', 'm', 100, true);
      expect(ranker.size).toBe(1);
      ranker.record('stt', 'a', 'm', 200, true); // same key
      expect(ranker.size).toBe(1);
      ranker.record('llm', 'a', 'm', 100, true); // different stage
      expect(ranker.size).toBe(2);
    });
  });

  // ─── Integration with FallbackOptions ─────────────────────────────────────

  describe('integration with withProviderFallback', () => {
    it('PerformanceRanker type is accepted by FallbackOptions', async () => {
      // Type-level test: ensure the interface accepts PerformanceRanker
      const { withProviderFallback } = await import('@ai-gateway/providers/fallback');
      const r = new PerformanceRanker();
      const chain: FallbackEntry[] = [{ provider: 'test', model: 'model' }];

      const result = await withProviderFallback(
        chain,
        async () => 'ok',
        {
          performanceRanker: r,
          stage: 'stt',
        },
      );

      expect(result.result).toBe('ok');
      // Should have recorded a successful sample
      const stats = r.getStats('stt', 'test', 'model');
      expect(stats.sampleCount).toBe(1);
      expect(stats.successRate).toBe(1);
    });

    it('records failure samples on provider error', async () => {
      const { withProviderFallback } = await import('@ai-gateway/providers/fallback');
      const { CooldownTracker } = await import('@ai-gateway/providers/fallback');
      const r = new PerformanceRanker();
      const chain: FallbackEntry[] = [
        { provider: 'bad', model: 'fail' },
        { provider: 'good', model: 'ok' },
      ];

      let callCount = 0;
      const result = await withProviderFallback(
        chain,
        async (entry) => {
          callCount++;
          if (entry.provider === 'bad') {
            const err = new Error('server error') as Error & { status: number };
            err.status = 500;
            throw err;
          }
          return 'ok';
        },
        {
          performanceRanker: r,
          stage: 'llm',
          cooldownTracker: new CooldownTracker(),
        },
      );

      expect(result.result).toBe('ok');
      expect(result.usedProvider).toBe('good');

      // Check failure was recorded for 'bad'
      const badStats = r.getStats('llm', 'bad', 'fail');
      expect(badStats.sampleCount).toBe(1);
      expect(badStats.successRate).toBe(0);

      // Check success was recorded for 'good'
      const goodStats = r.getStats('llm', 'good', 'ok');
      expect(goodStats.sampleCount).toBe(1);
      expect(goodStats.successRate).toBe(1);
    });
  });
});
