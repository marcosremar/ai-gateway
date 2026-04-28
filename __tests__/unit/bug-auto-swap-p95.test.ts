import { test, expect, describe } from 'vitest';
import { runAutoSwapBenchmark } from '../../src/gateway/routing/auto-swap-benchmark';
import type { DetectWithSwapFn } from '../../src/gateway/routing/auto-swap-benchmark';

// Stub detect function that returns deterministic results with known latencies
function createDetectFn(latencies: number[]): DetectWithSwapFn {
  let idx = 0;
  return (_text: string, source: string, _target: string, _minConfidence: number) => {
    // Artificially inflate latency to our test values by busy-waiting
    // Actually, we can't control latency precisely in a test, so we patch
    // the results differently — see below.
    return {
      detected: { language: source, confidence: 0.99 },
      shouldSwap: false,
    };
  };
}

describe('auto-swap benchmark P95 computation', () => {
  test('P95 should not return the maximum value when 95% of samples are identical', () => {
    // Create 20 phrases: first 19 should have latency ~100ms, last one should be much higher.
    // We do this by making the detect function artificially slow on the last call.
    let callCount = 0;
    const slowDetect: DetectWithSwapFn = (text, source, _target, _minConfidence) => {
      callCount++;
      if (callCount === 20) {
        // Spin to create a large latency gap
        const start = Date.now();
        while (Date.now() - start < 50) { /* busy wait 50ms */ }
      }
      return {
        detected: { language: source, confidence: 0.99 },
        shouldSwap: false,
      };
    };

    const phrases = Array.from({ length: 20 }, (_, i) => ({
      text: `phrase ${i}`,
      expectedLang: 'en',
    }));

    const result = runAutoSwapBenchmark({
      phrases,
      source: 'en',
      target: 'fr',
      minConfidence: 0.8,
      detect: slowDetect,
    });

    // The p95 latency should NOT be the maximum latency.
    // With 20 samples, P95 is the 19th value (not the 20th/last).
    // The bug causes it to return sorted[19] (max) instead of sorted[18] (19th value).
    //
    // If the fix is correct, p95LatencyMs should be close to the typical latency
    // (not the one 50ms outlier). If the bug is present, p95 equals the max.
    //
    // We check that p95 is less than the max:
    const allLatencies = result.results.map(r => r.latencyMs).sort((a, b) => a - b);
    const maxLatency = allLatencies[allLatencies.length - 1];
    const minLatency = allLatencies[0];

    // If there's a significant gap between typical and max, P95 should not be max
    if (maxLatency > minLatency * 2) {
      // P95 of 20 values should be sorted[18], not sorted[19] (the max).
      // With the bug: p95LatencyMs === maxLatency (off by one)
      // After fix: p95LatencyMs < maxLatency
      expect(result.p95LatencyMs).toBeLessThan(maxLatency);
    }
  });
});
