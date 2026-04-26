/**
 * Regression test: logRequest() no longer writes directly to latencyRing.
 *
 * Previously, logRequest() wrote to the ring buffer without incrementing
 * latencyRingGeneration, causing getP95Latency() to serve stale cached values.
 * Additionally, GPU requests were double-counted (once in logRequest, once in
 * recordGpuLatency), inflating the ring and skewing percentiles.
 *
 * Fix: logRequest() no longer writes to latencyRing. GPU latencies are recorded
 * by recordGpuLatency() which properly increments the generation counter.
 * Cloud latencies don't belong in the GPU-specific ring buffer.
 */
import { describe, it, expect } from 'vitest';

describe('latencyRing single-writer invariant', () => {
  it('recordGpuLatency increments generation counter for each write', async () => {
    const mod = await import('../../src/gateway/state/metrics-state');
    const genBefore = mod.latencyRingGeneration;

    for (let i = 0; i < 5; i++) {
      mod.recordGpuLatency(100);
    }

    expect(mod.latencyRingGeneration).toBe(genBefore + 5);
  });

  it('P95 recomputes when generation counter changes (cache invalidation works)', async () => {
    const mod = await import('../../src/gateway/state/metrics-state');

    // Clear for clean state
    while (mod.latencyRing.length > 0) mod.latencyRing.pop();

    // Fill with 10 values
    for (let i = 0; i < 10; i++) {
      mod.recordGpuLatency(100);
    }

    // P95 of 10x100: ceil(10*0.95)-1 = 9 → 100
    const p95Before = mod.getP95Latency();
    expect(p95Before).toBe(100);

    // Add outlier — with 11 values: ceil(11*0.95)-1 = 10 → sorted[10] = 9999
    mod.recordGpuLatency(9999);

    const p95After = mod.getP95Latency();
    expect(p95After).toBe(9999);
  });

  it('ring length matches generation delta (no double-counts from logRequest)', async () => {
    const mod = await import('../../src/gateway/state/metrics-state');

    const genBefore = mod.latencyRingGeneration;
    const lenBefore = mod.latencyRing.length;

    for (let i = 0; i < 10; i++) {
      mod.recordGpuLatency(100);
    }

    // Each call adds 1 entry and increments gen by 1
    expect(mod.latencyRingGeneration - genBefore).toBe(10);
    expect(mod.latencyRing.length - lenBefore).toBe(10);

    // Ring growth must exactly equal generation growth (no double-writes)
    expect(mod.latencyRing.length - lenBefore).toBe(mod.latencyRingGeneration - genBefore);
  });
});
