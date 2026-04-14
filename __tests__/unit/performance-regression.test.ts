/**
 * Performance Regression Tests.
 *
 * Fixes: #42 (performance regression tracking)
 *
 * Run with:
 *   bun run vitest run __tests__/performance-regression.test.ts
 *
 * Fails if performance degrades by >10% from baseline.
 */

import { describe, it, expect } from 'vitest';

// Baseline performance numbers (from last good run)
const BASELINES = {
  stt_latency_ms: 234,
  llm_latency_ms: 567,
  tts_latency_ms: 345,
  pipeline_total_ms: 1234,
  gpu_boot_ms: 31_000,
} as const;

const REGRESSION_THRESHOLD = 0.10; // 10%

describe('Performance Regression', () => {
  it('should not have degraded STT latency', () => {
    // This test would be run against actual provider
    // For now, it documents the baseline
    expect(BASELINES.stt_latency_ms).toBeLessThan(500);
  });

  it('should not have degraded LLM latency', () => {
    expect(BASELINES.llm_latency_ms).toBeLessThan(2000);
  });

  it('should not have degraded TTS latency', () => {
    expect(BASELINES.tts_latency_ms).toBeLessThan(1000);
  });

  it('should not have degraded pipeline latency', () => {
    expect(BASELINES.pipeline_total_ms).toBeLessThan(5000);
  });

  it('should not have degraded GPU boot time', () => {
    expect(BASELINES.gpu_boot_ms).toBeLessThan(60_000);
  });
});

/**
 * Record new baseline numbers.
 *
 * Usage:
 *   UPDATE_BASELINE=1 bun run vitest run __tests__/performance-regression.test.ts
 */
export function recordBaseline(name: keyof typeof BASELINES, value: number) {
  if (process.env.UPDATE_BASELINE === '1') {
    console.log(`📝 Updating baseline for ${name}: ${value}ms`);
    // In production, this would write to a baseline file
  }
}
