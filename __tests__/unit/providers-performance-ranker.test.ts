import { describe, it, expect, vi } from 'vitest';
import { PerformanceRanker } from '../../src/providers/performance-ranker';
import type { FallbackEntry } from '../../src/providers/fallback';

describe('PerformanceRanker', () => {
  describe('record + getStats', () => {
    it('returns empty stats for unknown key', () => {
      const ranker = new PerformanceRanker();
      const stats = ranker.getStats('stt', 'groq', 'whisper');
      expect(stats).toEqual({ p50: null, p95: null, successRate: 0, sampleCount: 0, trend: 'stable' });
    });

    it('records and retrieves stats', () => {
      const ranker = new PerformanceRanker();
      ranker.record('stt', 'groq', 'whisper', 100, true);
      ranker.record('stt', 'groq', 'whisper', 200, true);
      const stats = ranker.getStats('stt', 'groq', 'whisper');
      expect(stats.sampleCount).toBe(2);
      expect(stats.p50).toBeCloseTo(150, -1);
      expect(stats.successRate).toBe(1);
    });

    it('computes success rate correctly', () => {
      const ranker = new PerformanceRanker();
      ranker.record('stt', 'groq', 'whisper', 100, true);
      ranker.record('stt', 'groq', 'whisper', 500, false);
      ranker.record('stt', 'groq', 'whisper', 150, true);
      const stats = ranker.getStats('stt', 'groq', 'whisper');
      expect(stats.successRate).toBeCloseTo(2 / 3);
    });

    it('uses only successful samples for percentiles', () => {
      const ranker = new PerformanceRanker();
      ranker.record('stt', 'groq', 'whisper', 100, true);
      ranker.record('stt', 'groq', 'whisper', 9999, false);
      const stats = ranker.getStats('stt', 'groq', 'whisper');
      expect(stats.p50).toBe(100);
    });

    it('respects windowSize limit', () => {
      const ranker = new PerformanceRanker({ windowSize: 3 });
      for (let i = 0; i < 10; i++) {
        ranker.record('stt', 'groq', 'whisper', 100 + i * 10, true);
      }
      const stats = ranker.getStats('stt', 'groq', 'whisper');
      expect(stats.sampleCount).toBe(3);
    });

    it('tracks separate keys independently', () => {
      const ranker = new PerformanceRanker();
      ranker.record('stt', 'groq', 'whisper', 100, true);
      ranker.record('tts', 'openai', 'tts-1', 200, true);
      expect(ranker.getStats('stt', 'groq', 'whisper').p50).not.toBe(
        ranker.getStats('tts', 'openai', 'tts-1').p50,
      );
    });
  });

  describe('trend detection', () => {
    it('detects degrading trend', () => {
      const ranker = new PerformanceRanker({ degradationThreshold: 2.0 });
      const base = Date.now() - 200_000;
      for (let i = 0; i < 5; i++) {
        ranker['buffers'].set('groq:whisper:stt', [
          ...Array.from({ length: 5 }, (_, j) => ({ latencyMs: 100 + j * 10, success: true, timestamp: base + j * 1000 })),
          ...Array.from({ length: 5 }, (_, j) => ({ latencyMs: 300 + j * 10, success: true, timestamp: base + 5000 + j * 1000 })),
        ]);
      }
      const stats = ranker.getStats('stt', 'groq', 'whisper');
      expect(stats.trend).toBe('degrading');
    });

    it('detects improving trend', () => {
      const ranker = new PerformanceRanker({ degradationThreshold: 2.0 });
      const base = Date.now() - 200_000;
      ranker['buffers'].set('groq:whisper:stt', [
        ...Array.from({ length: 5 }, (_, j) => ({ latencyMs: 400 + j * 10, success: true, timestamp: base + j * 1000 })),
        ...Array.from({ length: 5 }, (_, j) => ({ latencyMs: 100 + j * 10, success: true, timestamp: base + 5000 + j * 1000 })),
      ]);
      const stats = ranker.getStats('stt', 'groq', 'whisper');
      expect(stats.trend).toBe('improving');
    });

    it('reports stable when too few samples', () => {
      const ranker = new PerformanceRanker();
      ranker.record('stt', 'groq', 'whisper', 100, true);
      ranker.record('stt', 'groq', 'whisper', 200, true);
      const stats = ranker.getStats('stt', 'groq', 'whisper');
      expect(stats.trend).toBe('stable');
    });
  });

  describe('isDegraded', () => {
    it('returns true when trend is degrading', () => {
      const ranker = new PerformanceRanker();
      const spy = vi.spyOn(ranker as any, 'getStats').mockReturnValue({
        p50: 500, p95: 800, successRate: 0.9, sampleCount: 10, trend: 'degrading',
      });
      expect(ranker.isDegraded('stt', 'groq', 'whisper')).toBe(true);
      spy.mockRestore();
    });

    it('returns false when trend is stable', () => {
      const ranker = new PerformanceRanker();
      const spy = vi.spyOn(ranker as any, 'getStats').mockReturnValue({
        p50: 100, p95: 200, successRate: 1, sampleCount: 10, trend: 'stable',
      });
      expect(ranker.isDegraded('stt', 'groq', 'whisper')).toBe(false);
      spy.mockRestore();
    });
  });

  describe('rankChain', () => {
    it('returns copy for single entry', () => {
      const ranker = new PerformanceRanker();
      const chain: FallbackEntry[] = [{ provider: 'groq', model: 'whisper' }];
      const result = ranker.rankChain('stt', chain);
      expect(result).toEqual(chain);
      expect(result).not.toBe(chain);
    });

    it('places unscored entries after scored ones', () => {
      const ranker = new PerformanceRanker({ minSamples: 2 });
      ranker.record('stt', 'groq', 'whisper', 100, true);
      ranker.record('stt', 'groq', 'whisper', 110, true);
      const chain: FallbackEntry[] = [
        { provider: 'groq', model: 'whisper' },
        { provider: 'openai', model: 'unknown' },
      ];
      const result = ranker.rankChain('stt', chain);
      expect(result[0].provider).toBe('groq');
      expect(result[1].provider).toBe('openai');
    });

    it('orders scored entries by composite score', () => {
      const ranker = new PerformanceRanker({ minSamples: 2 });
      for (let i = 0; i < 3; i++) {
        ranker.record('stt', 'slow', 'm1', 500, true);
        ranker.record('stt', 'fast', 'm2', 100, true);
      }
      const chain: FallbackEntry[] = [
        { provider: 'slow', model: 'm1' },
        { provider: 'fast', model: 'm2' },
      ];
      const result = ranker.rankChain('stt', chain);
      expect(result[0].provider).toBe('fast');
      expect(result[1].provider).toBe('slow');
    });
  });

  describe('persistence (toJSON/fromJSON)', () => {
    it('round-trips data correctly', () => {
      const ranker = new PerformanceRanker();
      ranker.record('stt', 'groq', 'whisper', 100, true);
      ranker.record('stt', 'groq', 'whisper', 200, true);
      const json = ranker.toJSON();
      expect(json.version).toBe(1);
      expect(Object.keys(json.buffers)).toHaveLength(1);

      const ranker2 = new PerformanceRanker();
      ranker2.fromJSON(json);
      const stats = ranker2.getStats('stt', 'groq', 'whisper');
      expect(stats.sampleCount).toBe(2);
    });

    it('fromJSON ignores invalid snapshot', () => {
      const ranker = new PerformanceRanker();
      ranker.fromJSON({} as any);
      ranker.fromJSON(null as any);
      ranker.fromJSON({ version: 99 } as any);
      expect(ranker.size).toBe(0);
    });

    it('fromJSON prunes expired samples', () => {
      const ranker = new PerformanceRanker({ windowTimeMs: 100 });
      const oldSnapshot = {
        version: 1 as const,
        savedAt: Date.now(),
        buffers: {
          'groq:whisper:stt': [{ latencyMs: 100, success: true, timestamp: Date.now() - 999_999 }],
        },
      };
      ranker.fromJSON(oldSnapshot);
      expect(ranker.size).toBe(0);
    });
  });

  describe('clear + size', () => {
    it('clear removes all data', () => {
      const ranker = new PerformanceRanker();
      ranker.record('stt', 'groq', 'whisper', 100, true);
      expect(ranker.size).toBe(1);
      ranker.clear();
      expect(ranker.size).toBe(0);
    });
  });

  describe('dispose', () => {
    it('does not throw without persistPath', () => {
      const ranker = new PerformanceRanker();
      expect(() => ranker.dispose()).not.toThrow();
    });
  });
});
