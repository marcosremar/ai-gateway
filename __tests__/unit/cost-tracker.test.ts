import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordInferenceCost,
  getInferenceCostStats,
  resetDailyInferenceCost,
} from '../../server/cost-tracker';

describe('cost-tracker', () => {
  beforeEach(() => {
    resetDailyInferenceCost();
  });

  describe('recordInferenceCost — flat-rate providers', () => {
    it('records groq:stt at $0.001 flat', () => {
      recordInferenceCost('groq', 'stt');
      expect(getInferenceCostStats().totalUsd).toBe(0.001);
      expect(getInferenceCostStats().requests).toBe(1);
    });

    it('records openai:stt at $0.006 flat', () => {
      recordInferenceCost('openai', 'stt');
      expect(getInferenceCostStats().totalUsd).toBe(0.006);
    });

    it('records openai:tts at $0.015 flat', () => {
      recordInferenceCost('openai', 'tts');
      expect(getInferenceCostStats().totalUsd).toBe(0.015);
    });

    it('records fireworks:stt at $0.002 flat', () => {
      recordInferenceCost('fireworks', 'stt');
      expect(getInferenceCostStats().totalUsd).toBe(0.002);
    });

    it('records modal:tts at $0.001 flat', () => {
      recordInferenceCost('modal', 'tts');
      expect(getInferenceCostStats().totalUsd).toBe(0.001);
    });

    it('records modal:stt at $0.001 flat', () => {
      recordInferenceCost('modal', 'stt');
      expect(getInferenceCostStats().totalUsd).toBe(0.001);
    });

    it('records modal:llm at $0.001 flat', () => {
      recordInferenceCost('modal', 'llm');
      expect(getInferenceCostStats().totalUsd).toBe(0.001);
    });
  });

  describe('recordInferenceCost — token-scaled providers', () => {
    it('scales groq:llm by tokens ($0.0005/1K)', () => {
      recordInferenceCost('groq', 'llm', 2000); // 2K tokens → 0.001
      expect(getInferenceCostStats().totalUsd).toBe(0.001);
    });

    it('scales openai:llm by tokens ($0.003/1K)', () => {
      recordInferenceCost('openai', 'llm', 500); // 0.5K tokens → 0.0015
      expect(getInferenceCostStats().totalUsd).toBe(0.0015);
    });

    it('scales fireworks:llm by tokens ($0.001/1K)', () => {
      recordInferenceCost('fireworks', 'llm', 1000); // 1K tokens → 0.001
      expect(getInferenceCostStats().totalUsd).toBe(0.001);
    });

    it('scales openrouter:llm by tokens ($0.002/1K)', () => {
      recordInferenceCost('openrouter', 'llm', 3000); // 3K tokens → 0.006
      expect(getInferenceCostStats().totalUsd).toBe(0.006);
    });

    it('uses flat rate for groq:llm when no tokens provided', () => {
      recordInferenceCost('groq', 'llm'); // flat = $0.0005
      expect(getInferenceCostStats().totalUsd).toBe(0.0005);
    });

    it('partial-K tokens produce fractional cost', () => {
      // openai:llm = $0.003/1K → 100 tokens = $0.0003
      recordInferenceCost('openai', 'llm', 100);
      expect(getInferenceCostStats().totalUsd).toBe(0.0003);
    });
  });

  describe('recordInferenceCost — GPU stages (zero cost)', () => {
    it('records gpu:stt at $0', () => {
      recordInferenceCost('gpu', 'stt');
      expect(getInferenceCostStats().totalUsd).toBe(0);
      expect(getInferenceCostStats().requests).toBe(1);
    });

    it('records gpu:llm at $0', () => {
      recordInferenceCost('gpu', 'llm');
      expect(getInferenceCostStats().totalUsd).toBe(0);
    });

    it('records gpu:tts at $0', () => {
      recordInferenceCost('gpu', 'tts');
      expect(getInferenceCostStats().totalUsd).toBe(0);
    });

    it('counts GPU requests even though cost is 0', () => {
      recordInferenceCost('gpu', 'stt');
      recordInferenceCost('gpu', 'llm');
      recordInferenceCost('gpu', 'tts');
      const stats = getInferenceCostStats();
      expect(stats.requests).toBe(3);
      expect(stats.totalUsd).toBe(0);
    });
  });

  describe('recordInferenceCost — unknown provider/stage', () => {
    it('records $0 for unrecognised provider+stage', () => {
      recordInferenceCost('unknown', 'mystery');
      const stats = getInferenceCostStats();
      expect(stats.totalUsd).toBe(0);
      expect(stats.requests).toBe(1);
    });

    it('records $0 for empty strings', () => {
      recordInferenceCost('', '');
      expect(getInferenceCostStats().totalUsd).toBe(0);
    });
  });

  describe('recordInferenceCost — accumulation', () => {
    it('accumulates costs across multiple calls', () => {
      recordInferenceCost('groq', 'stt');      // 0.001
      recordInferenceCost('openai', 'stt');    // 0.006
      recordInferenceCost('fireworks', 'llm', 1000); // 0.001
      const stats = getInferenceCostStats();
      expect(stats.totalUsd).toBe(0.008);
      expect(stats.requests).toBe(3);
    });

    it('mixes GPU (zero) and cloud costs in the same session', () => {
      recordInferenceCost('gpu', 'stt');    // 0
      recordInferenceCost('groq', 'llm', 1000); // 0.0005
      recordInferenceCost('gpu', 'tts');    // 0
      const stats = getInferenceCostStats();
      expect(stats.totalUsd).toBe(0.0005);
      expect(stats.requests).toBe(3);
    });
  });

  describe('getInferenceCostStats', () => {
    it('returns all zeros when no requests have been recorded', () => {
      const stats = getInferenceCostStats();
      expect(stats.totalUsd).toBe(0);
      expect(stats.requests).toBe(0);
      expect(stats.avgCostPerRequest).toBe(0);
    });

    it('returns 0 avgCostPerRequest when all requests are free (GPU)', () => {
      recordInferenceCost('gpu', 'llm');
      recordInferenceCost('gpu', 'tts');
      const stats = getInferenceCostStats();
      expect(stats.requests).toBe(2);
      expect(stats.totalUsd).toBe(0);
      expect(stats.avgCostPerRequest).toBe(0);
    });

    it('computes avgCostPerRequest as total / count', () => {
      recordInferenceCost('openai', 'stt'); // 0.006
      recordInferenceCost('openai', 'stt'); // 0.006 → total 0.012, avg 0.006
      const stats = getInferenceCostStats();
      expect(stats.avgCostPerRequest).toBe(0.006);
    });

    it('rounds totalUsd to 4 decimal places', () => {
      // groq:llm at 3333 tokens: 0.0005 * 3.333 = 0.0016665 → rounds to 0.0017
      recordInferenceCost('groq', 'llm', 3333);
      const stats = getInferenceCostStats();
      expect(stats.totalUsd).toBe(0.0017);
    });

    it('rounds avgCostPerRequest to 4 decimal places', () => {
      // 3 × groq:stt (0.001 each) → total 0.003, avg 0.001 (already clean)
      // Use odd counts: openai:stt (0.006) + openai:llm/1K (0.003) → total 0.009, avg 0.0045
      recordInferenceCost('openai', 'stt');         // 0.006
      recordInferenceCost('openai', 'llm', 1000);  // 0.003
      const stats = getInferenceCostStats();
      expect(stats.avgCostPerRequest).toBe(0.0045);
    });

    it('is idempotent — successive reads without new records return the same value', () => {
      recordInferenceCost('groq', 'stt');
      const first = getInferenceCostStats();
      const second = getInferenceCostStats();
      expect(first).toEqual(second);
    });
  });

  describe('resetDailyInferenceCost', () => {
    it('clears totalUsd and requests', () => {
      recordInferenceCost('groq', 'stt');
      recordInferenceCost('openai', 'llm', 1000);
      expect(getInferenceCostStats().requests).toBe(2);

      resetDailyInferenceCost();

      const stats = getInferenceCostStats();
      expect(stats.totalUsd).toBe(0);
      expect(stats.requests).toBe(0);
      expect(stats.avgCostPerRequest).toBe(0);
    });

    it('allows fresh recording after reset', () => {
      recordInferenceCost('groq', 'stt'); // 0.001
      resetDailyInferenceCost();
      recordInferenceCost('openai', 'stt'); // 0.006
      const stats = getInferenceCostStats();
      expect(stats.totalUsd).toBe(0.006);
      expect(stats.requests).toBe(1);
    });

    it('calling reset on empty state is a no-op', () => {
      resetDailyInferenceCost(); // already 0
      resetDailyInferenceCost(); // again — should not throw
      expect(getInferenceCostStats().totalUsd).toBe(0);
    });
  });
});
