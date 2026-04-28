import { describe, it, expect } from 'vitest';
import { createCanaryDeploy } from '../src/canary/index';

describe('canary resetStats', () => {
  it('should reset average latency fields after resetStats()', () => {
    const canary = createCanaryDeploy({
      currentVersion: 'v1',
      canaryVersion: 'v2',
    });

    // Record some requests to populate averages
    canary.recordRequest(true, false, 200);  // canary 200ms
    canary.recordRequest(true, false, 400);  // canary 400ms
    canary.recordRequest(false, false, 100); // stable 100ms
    canary.recordRequest(false, false, 150); // stable 150ms

    const statsBefore = canary.getStats();
    expect(statsBefore.canaryAvgLatencyMs).toBeGreaterThan(0);
    expect(statsBefore.stableAvgLatencyMs).toBeGreaterThan(0);

    // Reset stats
    canary.resetStats();

    const statsAfter = canary.getStats();
    // BUG: these should be 0 after reset but they aren't
    expect(statsAfter.canaryAvgLatencyMs).toBe(0);
    expect(statsAfter.stableAvgLatencyMs).toBe(0);
  });
});
