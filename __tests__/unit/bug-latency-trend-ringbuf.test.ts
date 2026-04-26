import { test, expect, describe, beforeEach } from 'vitest';
import {
  latencyRing,
  latencyRingIdx,
  recordGpuLatency,
  getLatencyTrend,
  setLatencyRingIdx,
  LATENCY_RING_SIZE,
} from '../../src/gateway/state/metrics-state';

describe('latency ring buffer trend detection', () => {
  // Reset the ring buffer before each test
  beforeEach(() => {
    latencyRing.length = 0;
    setLatencyRingIdx(0);
  });

  test('getLatencyTrend correctly detects degrading trend after ring wraps', () => {
    // Fill the ring buffer with low-latency samples (100ms) — "good" performance
    for (let i = 0; i < LATENCY_RING_SIZE; i++) {
      recordGpuLatency(100);
    }

    // Now overwrite the first half with high-latency samples (500ms) — "degrading" performance
    // After filling, latencyRingIdx wraps back to 0, so the next writes go to indices 0..N
    const overwriteCount = Math.floor(LATENCY_RING_SIZE / 2) + 1;
    for (let i = 0; i < overwriteCount; i++) {
      recordGpuLatency(500);
    }

    // The ring now has: first half = 500ms (newer), second half = 100ms (older)
    // But chronologically, the newest data is the 500ms entries.
    // The trend should be 'degrading' because latency went from 100 → 500.
    const trend = getLatencyTrend();

    // The ring buffer contains a mix: 500ms entries at positions 0..overwriteCount-1,
    // and 100ms entries at positions overwriteCount..LATENCY_RING_SIZE-1.
    // Chronologically, the most recent entries are the 500ms ones.
    // getLatencyTrend splits into first half (indices 0..half) and second half (indices half..end).
    // If it treats the array as-is (not unwrapped), the first half has 500ms and second has 100ms,
    // so changePct would be negative (improving), which is WRONG.
    // The correct result should be 'degrading' because latency increased over time.
    expect(trend.trend).toBe('degrading');
  });
});
