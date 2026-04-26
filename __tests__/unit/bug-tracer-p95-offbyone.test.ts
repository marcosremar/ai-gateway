/**
 * Bug: DistributedTracer.analyzeBottlenecks() and getRealtimeMetrics() use
 * `latencies[Math.floor(N * 0.95)]` which collapses to the MAX value for
 * small N. With 20 samples, Math.floor(19) = 19 → returns sorted[19] which
 * is the 20th (last/max) element, not the 19th (true 95th percentile).
 *
 * Same class of bug already fixed in commit 0214769 for the benchmark
 * code path. The tracer paths still have it.
 */
import { describe, it, expect } from 'vitest';
import { DistributedTracer } from '../../src/platform/observability/distributed-tracer';

describe('DistributedTracer.analyzeBottlenecks — P95 indexing', () => {
  it('p95 of 20 samples is NOT the max value', () => {
    const tracer = new DistributedTracer();
    // Inject 19 fast spans + 1 slow outlier → max=10000, true p95=100.
    for (let i = 0; i < 19; i++) {
      const s = tracer.startSpan('op');
      // simulate 100ms duration
      (s.tags as any).duration_ms = 100;
      // backdate startTime so the analyze window picks it up
      s.startTime = Date.now() - 1000;
    }
    const outlier = tracer.startSpan('op');
    (outlier.tags as any).duration_ms = 10_000;
    outlier.startTime = Date.now() - 1000;

    const result = tracer.analyzeBottlenecks(60_000);
    // P95 of 20 sorted samples (19×100 + 1×10000) should be 100, not 10000.
    expect(result.p95LatencyMs).toBeLessThan(10_000);
    expect(result.p95LatencyMs).toBe(100);
  });
});
