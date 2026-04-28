import { describe, it, expect } from 'vitest';
import { recordProviderLatency, getProviderP95 } from '../../server/providers';

// PROVIDER_LATENCY_RING_SIZE = 30, so only last 30 samples are kept.
// Bug: Math.floor(N * 0.95) gives wrong P95 when N * 0.95 is an integer (N multiple of 20).
// For N=20: floor(19) = 19 -> index 19 (max). Correct nearest-rank: ceil(19) - 1 = 18.
// For N=30: floor(28.5) = 28, ceil(28.5) = 29 - 1 = 28. Same result, not affected.
// Only N=20 (within ring size) is affected.

describe('getProviderP95 nearest-rank off-by-one', () => {
  it('P95 of 20 values should not be the max when N*0.95 is exact integer', () => {
    // Seed 20 values: 100, 101, ... 119
    for (let i = 100; i <= 119; i++) {
      recordProviderLatency('p95-20', 'stt', i);
    }
    const result = getProviderP95('p95-20', 'stt');
    // Sorted: [100..119], N=20
    // Nearest-rank P95: ceil(0.95 * 20) - 1 = ceil(19) - 1 = 18 -> sorted[18] = 118
    // Bug (Math.floor): floor(0.95 * 20) = 19 -> sorted[19] = 119 (MAX - wrong!)
    expect(result).toBe(118);
  });

  it('P95 of 20 values should exclude a single extreme outlier', () => {
    // Seed 19 values from 100 to 118, then one outlier at 50000
    for (let i = 100; i <= 118; i++) {
      recordProviderLatency('p95-20-outlier', 'stt', i);
    }
    recordProviderLatency('p95-20-outlier', 'stt', 50000);

    const result = getProviderP95('p95-20-outlier', 'stt');
    // Sorted: [100..118, 50000], N=20
    // Correct P95: index 18 -> sorted[18] = 118
    // Bug: index 19 -> sorted[19] = 50000
    expect(result).toBe(118);
    expect(result).toBeLessThan(1000);
  });
});
