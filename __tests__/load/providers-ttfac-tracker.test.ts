import { describe, it, expect } from 'vitest';
import { TtfacTracker } from '../../src/providers/ttfac-tracker';
import type { FallbackEntry } from '../../src/providers/fallback';

describe('TtfacTracker', () => {
  describe('constructor', () => {
    it('uses default config when none provided', () => {
      const tracker = new TtfacTracker();
      expect(tracker).toBeDefined();
    });

    it('accepts custom config', () => {
      const tracker = new TtfacTracker({
        enabled: true,
        ttfacWeight: 0.5,
        minSamples: 2,
        windowSize: 10,
        windowTimeMs: 60_000,
      });
      expect(tracker).toBeDefined();
    });
  });

  describe('record + getStats', () => {
    it('returns null stats for unrecorded provider:model', () => {
      const tracker = new TtfacTracker();
      const stats = tracker.getStats('unknown', 'model');
      expect(stats).toEqual({ ttfacP50: null, ttfacP95: null, totalP50: null, sampleCount: 0 });
    });

    it('records and retrieves stats for a single sample', () => {
      const tracker = new TtfacTracker();
      tracker.record('openai', 'tts-1', 100, 500);
      const stats = tracker.getStats('openai', 'tts-1');
      expect(stats.sampleCount).toBe(1);
      expect(stats.ttfacP50).toBe(100);
      expect(stats.totalP50).toBe(500);
    });

    it('computes p50 and p95 from multiple samples', () => {
      const tracker = new TtfacTracker({ windowTimeMs: 999_999_999 });
      const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
      for (const v of values) {
        tracker.record('groq', 'whisper', v, v * 2);
      }
      const stats = tracker.getStats('groq', 'whisper');
      expect(stats.sampleCount).toBe(10);
      expect(stats.ttfacP50).toBeCloseTo(550, -1);
      expect(stats.ttfacP95).toBeGreaterThan(900);
      expect(stats.totalP50).toBeCloseTo(1100, -1);
    });

    it('tracks different provider:model pairs independently', () => {
      const tracker = new TtfacTracker();
      tracker.record('openai', 'tts-1', 100, 500);
      tracker.record('groq', 'whisper', 50, 250);
      const o = tracker.getStats('openai', 'tts-1');
      const g = tracker.getStats('groq', 'whisper');
      expect(o.ttfacP50).toBe(100);
      expect(g.ttfacP50).toBe(50);
    });

    it('respects windowSize (circular buffer eviction)', () => {
      const tracker = new TtfacTracker({ windowSize: 3, windowTimeMs: 999_999_999 });
      tracker.record('p', 'm', 100, 1000);
      tracker.record('p', 'm', 200, 2000);
      tracker.record('p', 'm', 300, 3000);
      tracker.record('p', 'm', 400, 4000);
      const stats = tracker.getStats('p', 'm');
      expect(stats.sampleCount).toBe(3);
      expect(stats.ttfacP50).toBeCloseTo(300, -1);
    });
  });

  describe('rankByTtfac', () => {
    it('returns copy when disabled', () => {
      const tracker = new TtfacTracker({ enabled: false });
      const entries: FallbackEntry[] = [
        { provider: 'a', model: 'm1' },
        { provider: 'b', model: 'm2' },
      ];
      const result = tracker.rankByTtfac(entries);
      expect(result).toEqual(entries);
      expect(result).not.toBe(entries);
    });

    it('returns copy for single entry', () => {
      const tracker = new TtfacTracker({ enabled: true });
      const entries: FallbackEntry[] = [{ provider: 'a', model: 'm1' }];
      const result = tracker.rankByTtfac(entries);
      expect(result).toEqual(entries);
    });

    it('does not reorder entries without enough samples', () => {
      const tracker = new TtfacTracker({ enabled: true, minSamples: 5 });
      tracker.record('a', 'm1', 100, 500);
      const entries: FallbackEntry[] = [
        { provider: 'a', model: 'm1' },
        { provider: 'b', model: 'm2' },
      ];
      const result = tracker.rankByTtfac(entries);
      expect(result[0].provider).toBe('a');
      expect(result[1].provider).toBe('b');
    });

    it('reorders entries by blended score when enough samples exist', () => {
      const tracker = new TtfacTracker({ enabled: true, minSamples: 3, ttfacWeight: 1.0 });
      for (let i = 0; i < 5; i++) {
        tracker.record('slow', 'm1', 500, 1000);
        tracker.record('fast', 'm2', 100, 500);
      }
      const entries: FallbackEntry[] = [
        { provider: 'slow', model: 'm1' },
        { provider: 'fast', model: 'm2' },
      ];
      const result = tracker.rankByTtfac(entries);
      expect(result[0].provider).toBe('fast');
      expect(result[1].provider).toBe('slow');
    });

    it('keeps unscored entries in original positions', () => {
      const tracker = new TtfacTracker({ enabled: true, minSamples: 3 });
      for (let i = 0; i < 5; i++) {
        tracker.record('fast', 'm2', 100, 500);
      }
      const entries: FallbackEntry[] = [
        { provider: 'no-data', model: 'mx' },
        { provider: 'fast', model: 'm2' },
      ];
      const result = tracker.rankByTtfac(entries);
      expect(result[0].provider).toBe('no-data');
      expect(result[1].provider).toBe('fast');
    });
  });

  describe('seedFromBenchmark', () => {
    it('records multiple results at once', () => {
      const tracker = new TtfacTracker();
      tracker.seedFromBenchmark([
        { provider: 'a', model: 'm1', ttfacMs: 100, totalMs: 500 },
        { provider: 'b', model: 'm2', ttfacMs: 200, totalMs: 800 },
      ]);
      expect(tracker.getStats('a', 'm1').sampleCount).toBe(1);
      expect(tracker.getStats('b', 'm2').sampleCount).toBe(1);
    });
  });
});
