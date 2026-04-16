import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TtfacTracker } from '@ai-gateway/providers/ttfac-tracker';
import type { FallbackEntry } from '@ai-gateway/providers/fallback';

describe('TtfacTracker', () => {
  let tracker: TtfacTracker;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── record + getStats ──────────────────────────────────────────────────

  describe('record and getStats', () => {
    beforeEach(() => {
      tracker = new TtfacTracker({ enabled: true, minSamples: 1, windowSize: 30 });
    });

    it('returns null stats for unknown provider', () => {
      const stats = tracker.getStats('unknown', 'model');
      expect(stats).toEqual({ ttfacP50: null, ttfacP95: null, totalP50: null, sampleCount: 0 });
    });

    it('records and retrieves stats correctly', () => {
      tracker.record('groq', 'playai-tts', 80, 200);
      tracker.record('groq', 'playai-tts', 120, 300);
      tracker.record('groq', 'playai-tts', 100, 250);

      const stats = tracker.getStats('groq', 'playai-tts');
      expect(stats.sampleCount).toBe(3);
      expect(stats.ttfacP50).toBe(100); // median of [80, 100, 120]
      expect(stats.totalP50).toBe(250); // median of [200, 250, 300]
      expect(stats.ttfacP95).toBeCloseTo(118, 0); // p95 of [80, 100, 120]
    });

    it('isolates different provider:model pairs', () => {
      tracker.record('groq', 'playai-tts', 80, 200);
      tracker.record('openai', 'tts-1', 200, 500);

      const groqStats = tracker.getStats('groq', 'playai-tts');
      const openaiStats = tracker.getStats('openai', 'tts-1');

      expect(groqStats.sampleCount).toBe(1);
      expect(groqStats.ttfacP50).toBe(80);
      expect(openaiStats.sampleCount).toBe(1);
      expect(openaiStats.ttfacP50).toBe(200);
    });

    it('computes correct percentiles with single sample', () => {
      tracker.record('modal', 'qwen3-tts', 150, 400);

      const stats = tracker.getStats('modal', 'qwen3-tts');
      expect(stats.ttfacP50).toBe(150);
      expect(stats.ttfacP95).toBe(150);
      expect(stats.totalP50).toBe(400);
      expect(stats.sampleCount).toBe(1);
    });
  });

  // ─── rankByTtfac ───────────────────────────────────────────────────────

  describe('rankByTtfac', () => {
    it('ranks providers by blended score (low TTFAC wins)', () => {
      tracker = new TtfacTracker({ enabled: true, minSamples: 2, ttfacWeight: 0.7 });

      // Provider A: low TTFAC, moderate total
      tracker.record('providerA', 'model-a', 50, 300);
      tracker.record('providerA', 'model-a', 60, 320);
      tracker.record('providerA', 'model-a', 55, 310);

      // Provider B: high TTFAC, low total
      tracker.record('providerB', 'model-b', 200, 250);
      tracker.record('providerB', 'model-b', 210, 260);
      tracker.record('providerB', 'model-b', 205, 255);

      const entries: FallbackEntry[] = [
        { provider: 'providerB', model: 'model-b' },
        { provider: 'providerA', model: 'model-a' },
      ];

      const ranked = tracker.rankByTtfac(entries);

      // A score: 55*0.7 + 310*0.3 = 38.5 + 93 = 131.5
      // B score: 205*0.7 + 255*0.3 = 143.5 + 76.5 = 220
      // A should come first
      expect(ranked[0].provider).toBe('providerA');
      expect(ranked[1].provider).toBe('providerB');
    });

    it('weight=1.0 is pure TTFAC ranking', () => {
      tracker = new TtfacTracker({ enabled: true, minSamples: 2, ttfacWeight: 1.0 });

      // Provider A: high TTFAC, low total
      tracker.record('a', 'm', 300, 100);
      tracker.record('a', 'm', 310, 110);

      // Provider B: low TTFAC, high total
      tracker.record('b', 'm', 50, 900);
      tracker.record('b', 'm', 60, 950);

      const entries: FallbackEntry[] = [
        { provider: 'a', model: 'm' },
        { provider: 'b', model: 'm' },
      ];

      const ranked = tracker.rankByTtfac(entries);
      // Pure TTFAC: B (55) < A (305), so B first
      expect(ranked[0].provider).toBe('b');
      expect(ranked[1].provider).toBe('a');
    });

    it('weight=0.0 is pure total latency ranking', () => {
      tracker = new TtfacTracker({ enabled: true, minSamples: 2, ttfacWeight: 0.0 });

      // Provider A: low TTFAC, high total
      tracker.record('a', 'm', 10, 800);
      tracker.record('a', 'm', 15, 850);

      // Provider B: high TTFAC, low total
      tracker.record('b', 'm', 500, 200);
      tracker.record('b', 'm', 510, 210);

      const entries: FallbackEntry[] = [
        { provider: 'a', model: 'm' },
        { provider: 'b', model: 'm' },
      ];

      const ranked = tracker.rankByTtfac(entries);
      // Pure total: B (205) < A (825), so B first
      expect(ranked[0].provider).toBe('b');
      expect(ranked[1].provider).toBe('a');
    });

    it('falls back to original order with insufficient samples', () => {
      tracker = new TtfacTracker({ enabled: true, minSamples: 3 });

      // Only 1 sample each — not enough
      tracker.record('a', 'm', 300, 400);
      tracker.record('b', 'm', 50, 100);

      const entries: FallbackEntry[] = [
        { provider: 'a', model: 'm' },
        { provider: 'b', model: 'm' },
      ];

      const ranked = tracker.rankByTtfac(entries);
      // Both have < minSamples, so original order preserved
      expect(ranked[0].provider).toBe('a');
      expect(ranked[1].provider).toBe('b');
    });

    it('entries without data keep original position', () => {
      tracker = new TtfacTracker({ enabled: true, minSamples: 2, ttfacWeight: 0.7 });

      // Only providerA and providerC have enough data
      tracker.record('a', 'm', 200, 400);
      tracker.record('a', 'm', 210, 420);

      tracker.record('c', 'm', 50, 300);
      tracker.record('c', 'm', 60, 310);

      // providerB has no data
      const entries: FallbackEntry[] = [
        { provider: 'a', model: 'm' },
        { provider: 'b', model: 'm' },
        { provider: 'c', model: 'm' },
      ];

      const ranked = tracker.rankByTtfac(entries);

      // B (index 1) keeps its position (no data)
      expect(ranked[1].provider).toBe('b');
      // A and C are scored — C is better, so C goes to index 0, A goes to index 2
      expect(ranked[0].provider).toBe('c');
      expect(ranked[2].provider).toBe('a');
    });

    it('does not mutate the input array', () => {
      tracker = new TtfacTracker({ enabled: true, minSamples: 1 });

      tracker.record('a', 'm', 300, 500);
      tracker.record('b', 'm', 50, 100);

      const entries: FallbackEntry[] = [
        { provider: 'a', model: 'm' },
        { provider: 'b', model: 'm' },
      ];

      const original = [...entries];
      tracker.rankByTtfac(entries);

      expect(entries).toEqual(original);
    });

    it('returns copy of input when disabled', () => {
      tracker = new TtfacTracker({ enabled: false });

      tracker.record('a', 'm', 300, 500);
      tracker.record('b', 'm', 50, 100);

      const entries: FallbackEntry[] = [
        { provider: 'a', model: 'm' },
        { provider: 'b', model: 'm' },
      ];

      const ranked = tracker.rankByTtfac(entries);
      expect(ranked).toEqual(entries);
      expect(ranked).not.toBe(entries); // new array
    });

    it('handles entries without model (uses wildcard)', () => {
      tracker = new TtfacTracker({ enabled: true, minSamples: 1 });

      tracker.record('a', '*', 200, 400);
      tracker.record('b', '*', 50, 100);

      const entries: FallbackEntry[] = [
        { provider: 'a' },
        { provider: 'b' },
      ];

      const ranked = tracker.rankByTtfac(entries);
      expect(ranked[0].provider).toBe('b');
      expect(ranked[1].provider).toBe('a');
    });
  });

  // ─── seedFromBenchmark ─────────────────────────────────────────────────

  describe('seedFromBenchmark', () => {
    it('populates data correctly', () => {
      tracker = new TtfacTracker({ enabled: true, minSamples: 1 });

      tracker.seedFromBenchmark([
        { provider: 'groq', model: 'playai-tts', ttfacMs: 80, totalMs: 200 },
        { provider: 'groq', model: 'playai-tts', ttfacMs: 100, totalMs: 250 },
        { provider: 'groq', model: 'playai-tts', ttfacMs: 90, totalMs: 220 },
        { provider: 'openai', model: 'tts-1', ttfacMs: 300, totalMs: 600 },
      ]);

      const groqStats = tracker.getStats('groq', 'playai-tts');
      expect(groqStats.sampleCount).toBe(3);
      expect(groqStats.ttfacP50).toBe(90);
      expect(groqStats.totalP50).toBe(220);

      const openaiStats = tracker.getStats('openai', 'tts-1');
      expect(openaiStats.sampleCount).toBe(1);
      expect(openaiStats.ttfacP50).toBe(300);
    });

    it('seeded data is used for ranking', () => {
      tracker = new TtfacTracker({ enabled: true, minSamples: 2, ttfacWeight: 1.0 });

      tracker.seedFromBenchmark([
        { provider: 'fast', model: 'v1', ttfacMs: 30, totalMs: 500 },
        { provider: 'fast', model: 'v1', ttfacMs: 40, totalMs: 550 },
        { provider: 'slow', model: 'v1', ttfacMs: 500, totalMs: 600 },
        { provider: 'slow', model: 'v1', ttfacMs: 510, totalMs: 610 },
      ]);

      const entries: FallbackEntry[] = [
        { provider: 'slow', model: 'v1' },
        { provider: 'fast', model: 'v1' },
      ];

      const ranked = tracker.rankByTtfac(entries);
      expect(ranked[0].provider).toBe('fast');
      expect(ranked[1].provider).toBe('slow');
    });
  });

  // ─── Window eviction ──────────────────────────────────────────────────

  describe('window eviction', () => {
    it('evicts samples that exceed windowSize', () => {
      tracker = new TtfacTracker({ enabled: true, minSamples: 1, windowSize: 3 });

      tracker.record('a', 'm', 100, 200);
      tracker.record('a', 'm', 200, 300);
      tracker.record('a', 'm', 300, 400);
      tracker.record('a', 'm', 400, 500); // pushes out the 100 sample

      const stats = tracker.getStats('a', 'm');
      expect(stats.sampleCount).toBe(3);
      // Remaining: [200, 300, 400] → p50 = 300
      expect(stats.ttfacP50).toBe(300);
    });

    it('evicts old samples past windowTimeMs', () => {
      tracker = new TtfacTracker({
        enabled: true,
        minSamples: 1,
        windowTimeMs: 60_000, // 1 minute
      });

      // Record at t=0
      tracker.record('a', 'm', 100, 200);
      tracker.record('a', 'm', 150, 250);

      // Advance time past window
      vi.advanceTimersByTime(61_000);

      // Record a fresh sample
      tracker.record('a', 'm', 50, 100);

      const stats = tracker.getStats('a', 'm');
      // Old samples evicted, only the fresh one remains
      expect(stats.sampleCount).toBe(1);
      expect(stats.ttfacP50).toBe(50);
    });

    it('returns empty stats when all samples have expired', () => {
      tracker = new TtfacTracker({
        enabled: true,
        minSamples: 1,
        windowTimeMs: 10_000,
      });

      tracker.record('a', 'm', 100, 200);
      vi.advanceTimersByTime(11_000);

      const stats = tracker.getStats('a', 'm');
      expect(stats.sampleCount).toBe(0);
      expect(stats.ttfacP50).toBeNull();
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty entries array', () => {
      tracker = new TtfacTracker({ enabled: true });
      const ranked = tracker.rankByTtfac([]);
      expect(ranked).toEqual([]);
    });

    it('handles single entry array', () => {
      tracker = new TtfacTracker({ enabled: true, minSamples: 1 });
      tracker.record('a', 'm', 100, 200);

      const entries: FallbackEntry[] = [{ provider: 'a', model: 'm' }];
      const ranked = tracker.rankByTtfac(entries);
      expect(ranked).toEqual(entries);
    });

    it('uses default config values', () => {
      tracker = new TtfacTracker();
      // Disabled by default — should return copy without reordering
      tracker.record('a', 'm', 300, 500);
      tracker.record('b', 'm', 50, 100);

      const entries: FallbackEntry[] = [
        { provider: 'a', model: 'm' },
        { provider: 'b', model: 'm' },
      ];

      const ranked = tracker.rankByTtfac(entries);
      expect(ranked[0].provider).toBe('a');
      expect(ranked[1].provider).toBe('b');
    });

    it('mixed scored and unscored entries preserve relative positions', () => {
      tracker = new TtfacTracker({ enabled: true, minSamples: 2, ttfacWeight: 0.5 });

      // 5 entries, only index 0, 2, 4 have data
      for (let i = 0; i < 3; i++) {
        tracker.record('fast', 'm', 30, 100);
      }
      for (let i = 0; i < 3; i++) {
        tracker.record('medium', 'm', 100, 300);
      }
      for (let i = 0; i < 3; i++) {
        tracker.record('slow', 'm', 500, 800);
      }

      const entries: FallbackEntry[] = [
        { provider: 'slow', model: 'm' },
        { provider: 'nodata1', model: 'm' },
        { provider: 'medium', model: 'm' },
        { provider: 'nodata2', model: 'm' },
        { provider: 'fast', model: 'm' },
      ];

      const ranked = tracker.rankByTtfac(entries);

      // Unscored entries stay at index 1 and 3
      expect(ranked[1].provider).toBe('nodata1');
      expect(ranked[3].provider).toBe('nodata2');

      // Scored slots are 0, 2, 4 — ranked by score: fast < medium < slow
      expect(ranked[0].provider).toBe('fast');
      expect(ranked[2].provider).toBe('medium');
      expect(ranked[4].provider).toBe('slow');
    });
  });
});
