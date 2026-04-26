/**
 * Bug: determineDegradation() returns 'full' (GPU pipeline available) when
 * there are NO providers at all — readyTiers=0 AND circuitStates is empty.
 *
 * The minimal guard requires circuitStates.size > 0 (i.e. SOME provider was
 * tracked in the past), so a fresh-boot system with no deploys yet falls
 * through every check and ends at 'full'. The gateway then thinks it can
 * run the full GPU pipeline when there is literally nothing to route to.
 *
 * Correct behaviour: with zero ready tiers, fall back to cloud/minimal,
 * not full.
 */
import { describe, it, expect } from 'vitest';
import { determineDegradation } from '../../src/gateway/autoscaler/degradation-manager';

describe('determineDegradation — zero-provider edge case', () => {
  it('does NOT return "full" when readyTiers=0 and no circuits exist', () => {
    const level = determineDegradation({
      queueDepth: 0,
      p95LatencyMs: null,
      circuitStates: new Map(),
      readyTiers: 0,
      activeSessions: 0,
    });
    // 'full' requires GPU pipeline working — impossible with 0 ready tiers.
    expect(level).not.toBe('full');
  });

  it('returns "full" when readyTiers > 0 and signals are healthy', () => {
    const level = determineDegradation({
      queueDepth: 0,
      p95LatencyMs: 100,
      circuitStates: new Map([[0, 'closed' as const]]),
      readyTiers: 1,
      activeSessions: 0,
    });
    expect(level).toBe('full');
  });
});
