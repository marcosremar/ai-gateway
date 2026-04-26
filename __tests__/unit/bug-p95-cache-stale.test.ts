import { test, expect, describe, beforeEach } from 'vitest';
import {
  latencyRing,
  recordGpuLatency,
  getP95Latency,
  setLatencyRingIdx,
  LATENCY_RING_SIZE,
} from '../../src/gateway/state/metrics-state';

describe('P95 latency cache invalidation', () => {
  beforeEach(() => {
    latencyRing.length = 0;
    setLatencyRingIdx(0);
  });

  test('getP95Latency returns updated value after ring wraps and new data is recorded', () => {
    // Fill the ring buffer with low-latency samples (100ms)
    for (let i = 0; i < LATENCY_RING_SIZE; i++) {
      recordGpuLatency(100);
    }

    // Compute P95 once to populate the cache
    const p95Before = getP95Latency();
    expect(p95Before).not.toBeNull();
    // All samples are 100ms, so P95 should be 100
    expect(p95Before!).toBe(100);

    // Now overwrite ALL entries with high-latency samples (5000ms)
    // The ring wraps around, length stays at LATENCY_RING_SIZE
    for (let i = 0; i < LATENCY_RING_SIZE; i++) {
      recordGpuLatency(5000);
    }

    // The cache was invalidated because we're recording new data.
    // P95 should now reflect the new data (5000ms), not the cached old value (100ms).
    const p95After = getP95Latency();
    expect(p95After).not.toBeNull();
    // This should be 5000 since all entries are now 5000ms
    expect(p95After!).toBe(5000);
  });
});
