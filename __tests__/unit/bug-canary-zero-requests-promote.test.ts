/**
 * Bug: createCanaryDeploy().evaluate() recommends promote even when
 * canaryRequests === 0.
 *
 * The early "insufficient data" guard checks the SUM of canary + stable
 * requests against minRequests. If canary traffic percentage is 0 (or
 * the random gate just didn't fire any canary requests yet), all traffic
 * went to stable. canaryErrorRate computes as 0 (default since 0/0 → 0
 * via the `> 0` guard), so 0 < maxErrorRate*0.5 is TRUE, and the function
 * returns `promote` with confidence 0.9 — promoting a canary that has
 * NEVER been exercised.
 */
import { describe, it, expect } from 'vitest';
import { createCanaryDeploy } from '../../src/canary';

describe('canary evaluate — guard against zero canary samples', () => {
  it('does NOT recommend promote when canaryRequests === 0', () => {
    const c = createCanaryDeploy({
      currentVersion: 'v1',
      canaryVersion: 'v2',
      minRequests: 10,
      initialTrafficPercentage: 0, // canary gets no traffic
    });

    // 100 stable requests, 0 canary requests
    for (let i = 0; i < 100; i++) {
      c.recordRequest(false, false, 100);
    }

    const decision = c.evaluate();
    // With zero canary samples we have no signal — must NOT promote.
    expect(decision.action).not.toBe('promote');
  });

  it('returns continue when total >= minRequests but canaryRequests is 0', () => {
    const c = createCanaryDeploy({
      currentVersion: 'v1',
      canaryVersion: 'v2',
      minRequests: 10,
      initialTrafficPercentage: 0,
    });
    for (let i = 0; i < 50; i++) c.recordRequest(false, false, 100);
    const decision = c.evaluate();
    expect(decision.action).toBe('continue');
    expect(decision.reason).toMatch(/no canary|0 canary|Insufficient/i);
  });
});
