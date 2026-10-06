import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordInferenceCost,
  getInferenceCostStats,
  resetDailyInferenceCost,
} from '../server/cost-tracker';

beforeEach(() => {
  resetDailyInferenceCost();
});

describe('recordInferenceCost / getInferenceCostStats', () => {
  // ── Initial state ──────────────────────────────────────────────────────────

  describe('initial state (after reset)', () => {
    it('totalUsd is 0', () => {
      expect(getInferenceCostStats().totalUsd).toBe(0);
    });

    it('requests count is 0', () => {
      expect(getInferenceCostStats().requests).toBe(0);
    });

    it('avgCostPerRequest is 0 when no requests recorded', () => {
      expect(getInferenceCostStats().avgCostPerRequest).toBe(0);
    });
  });

  // ── Per-request flat-rate providers ───────────────────────────────────────

  describe('flat-rate cost (no tokens)', () => {
    it('groq:stt records $0.001 per call', () => {
      recordInferenceCost('groq', 'stt');
      expect(getInferenceCostStats().totalUsd).toBe(0.001);
    });

    it('openai:stt records $0.006 per call', () => {
      recordInferenceCost('openai', 'stt');
      expect(getInferenceCostStats().totalUsd).toBe(0.006);
    });

    it('openai:tts records $0.015 per call', () => {
      recordInferenceCost('openai', 'tts');
      expect(getInferenceCostStats().totalUsd).toBe(0.015);
    });

    it('fireworks:stt records $0.002 per call', () => {
      recordInferenceCost('fireworks', 'stt');
      expect(getInferenceCostStats().totalUsd).toBe(0.002);
    });

    it('modal:tts records $0.001 per call', () => {
      recordInferenceCost('modal', 'tts');
      expect(getInferenceCostStats().totalUsd).toBe(0.001);
    });

    it('accumulates costs across multiple calls', () => {
      recordInferenceCost('groq', 'stt'); // 0.001
      recordInferenceCost('openai', 'stt'); // 0.006
      recordInferenceCost('fireworks', 'stt'); // 0.002
      expect(getInferenceCostStats().totalUsd).toBe(0.009);
    });

    it('increments request count on each call', () => {
      recordInferenceCost('groq', 'stt');
      recordInferenceCost('groq', 'stt');
      recordInferenceCost('groq', 'stt');
      expect(getInferenceCostStats().requests).toBe(3);
    });
  });

  // ── Token-scaled cost ─────────────────────────────────────────────────────

  describe('token-scaled cost', () => {
    it('groq:llm scales by tokens / 1000', () => {
      // $0.0005 per 1K tokens
      recordInferenceCost('groq', 'llm', 2000);
      // 0.0005 * (2000 / 1000) = 0.001
      expect(getInferenceCostStats().totalUsd).toBe(0.001);
    });

    it('openai:llm scales by tokens / 1000', () => {
      // $0.003 per 1K tokens
      recordInferenceCost('openai', 'llm', 1000);
      expect(getInferenceCostStats().totalUsd).toBe(0.003);
    });

    it('openai:tts uses flat rate when tokens provided', () => {
      // openai:tts is $0.015 per request; with tokens=1000 → $0.015 * (1000/1000) = $0.015
      recordInferenceCost('openai', 'tts', 1000);
      expect(getInferenceCostStats().totalUsd).toBe(0.015);
    });

    it('tokens=0 is falsy so falls back to flat-rate cost', () => {
      // Implementation uses `tokens ? ... : baseCost` — 0 is falsy, so the flat
      // baseCost is used instead of baseCost * (0/1000). This documents the
      // current behavior (caller should omit tokens rather than pass 0).
      recordInferenceCost('openai', 'llm', 0);
      expect(getInferenceCostStats().totalUsd).toBe(0.003); // flat rate, not zero
    });

    it('fractional tokens scale proportionally (rounded to 4dp)', () => {
      // groq:llm $0.0005 per 1K — 500 tokens = 0.00025 raw
      // Math.round(0.00025 * 10000) / 10000 = Math.round(2.5) / 10000 = 3/10000 = 0.0003
      recordInferenceCost('groq', 'llm', 500);
      expect(getInferenceCostStats().totalUsd).toBe(0.0003);
    });
  });

  // ── GPU zero-cost ─────────────────────────────────────────────────────────

  describe('GPU providers have zero cost', () => {
    it('gpu:stt costs nothing', () => {
      recordInferenceCost('gpu', 'stt');
      expect(getInferenceCostStats().totalUsd).toBe(0);
    });

    it('gpu:llm costs nothing', () => {
      recordInferenceCost('gpu', 'llm');
      expect(getInferenceCostStats().totalUsd).toBe(0);
    });

    it('gpu:tts costs nothing', () => {
      recordInferenceCost('gpu', 'tts');
      expect(getInferenceCostStats().totalUsd).toBe(0);
    });

    it('GPU calls still increment request count', () => {
      recordInferenceCost('gpu', 'stt');
      recordInferenceCost('gpu', 'llm');
      expect(getInferenceCostStats().requests).toBe(2);
    });
  });

  // ── Unknown providers ─────────────────────────────────────────────────────

  describe('unknown provider/stage combinations', () => {
    it('unknown provider has zero cost', () => {
      recordInferenceCost('unknown-provider', 'stt');
      expect(getInferenceCostStats().totalUsd).toBe(0);
    });

    it('unknown stage has zero cost', () => {
      recordInferenceCost('groq', 'unknown-stage');
      expect(getInferenceCostStats().totalUsd).toBe(0);
    });

    it('unknown provider/stage still increments request count', () => {
      recordInferenceCost('mystery', 'stage');
      expect(getInferenceCostStats().requests).toBe(1);
    });

    it('unknown provider with tokens has zero cost', () => {
      recordInferenceCost('mystery', 'stt', 5000);
      expect(getInferenceCostStats().totalUsd).toBe(0);
    });
  });

  // ── avgCostPerRequest ─────────────────────────────────────────────────────

  describe('avgCostPerRequest calculation', () => {
    it('equals totalUsd / requests for single call', () => {
      recordInferenceCost('openai', 'stt'); // $0.006
      const stats = getInferenceCostStats();
      expect(stats.avgCostPerRequest).toBe(0.006);
    });

    it('averages correctly across mixed-cost calls', () => {
      recordInferenceCost('groq', 'stt'); // $0.001
      recordInferenceCost('openai', 'stt'); // $0.006
      // avg = 0.007 / 2 = 0.0035
      const stats = getInferenceCostStats();
      expect(stats.avgCostPerRequest).toBe(0.0035);
    });

    it('includes zero-cost GPU calls in denominator', () => {
      recordInferenceCost('openai', 'stt'); // $0.006
      recordInferenceCost('gpu', 'stt'); // $0
      // avg = 0.006 / 2 = 0.003
      const stats = getInferenceCostStats();
      expect(stats.avgCostPerRequest).toBe(0.003);
    });

    it('rounds to 4 decimal places', () => {
      // 3 groq:stt at $0.001 each = $0.003 / 3 = $0.001 exactly — but also test rounding
      recordInferenceCost('groq', 'stt'); // 0.001
      recordInferenceCost('groq', 'stt'); // 0.001
      recordInferenceCost('groq', 'stt'); // 0.001
      recordInferenceCost('openai', 'stt'); // 0.006
      // avg = 0.009 / 4 = 0.00225 → rounded to 4dp = 0.0023
      const stats = getInferenceCostStats();
      expect(stats.avgCostPerRequest).toBe(Math.round((0.009 / 4) * 10000) / 10000);
    });
  });

  // ── totalUsd rounding ─────────────────────────────────────────────────────

  describe('totalUsd precision', () => {
    it('is rounded to 4 decimal places', () => {
      // 3 openai:stt at $0.006 each = $0.018 — exact
      recordInferenceCost('openai', 'stt');
      recordInferenceCost('openai', 'stt');
      recordInferenceCost('openai', 'stt');
      expect(getInferenceCostStats().totalUsd).toBe(0.018);
    });

    it('handles sub-penny accumulation without overflow', () => {
      for (let i = 0; i < 100; i++) {
        recordInferenceCost('groq', 'stt'); // 100 * 0.001 = 0.1
      }
      expect(getInferenceCostStats().totalUsd).toBe(0.1);
    });
  });

  // ── resetDailyInferenceCost ───────────────────────────────────────────────

  describe('resetDailyInferenceCost', () => {
    it('resets totalUsd to 0', () => {
      recordInferenceCost('openai', 'stt');
      resetDailyInferenceCost();
      expect(getInferenceCostStats().totalUsd).toBe(0);
    });

    it('resets requests to 0', () => {
      recordInferenceCost('groq', 'stt');
      recordInferenceCost('groq', 'stt');
      resetDailyInferenceCost();
      expect(getInferenceCostStats().requests).toBe(0);
    });

    it('resets avgCostPerRequest to 0', () => {
      recordInferenceCost('openai', 'llm', 1000);
      resetDailyInferenceCost();
      expect(getInferenceCostStats().avgCostPerRequest).toBe(0);
    });

    it('allows fresh accumulation after reset', () => {
      recordInferenceCost('openai', 'stt'); // 0.006
      resetDailyInferenceCost();
      recordInferenceCost('groq', 'stt'); // 0.001
      expect(getInferenceCostStats().totalUsd).toBe(0.001);
      expect(getInferenceCostStats().requests).toBe(1);
    });
  });
});
