/**
 * Tests for canary deployment module.
 */

import { describe, it, expect } from 'vitest';
import { createCanaryDeploy } from '../../src/canary';

describe('Canary Deploy', () => {
  it('should route percentage to canary', () => {
    const canary = createCanaryDeploy({
      currentVersion: 'v1',
      canaryVersion: 'v2',
      initialTrafficPercentage: 50,
    });

    let canaryCount = 0;
    for (let i = 0; i < 100; i++) {
      if (canary.shouldRouteToCanary()) canaryCount++;
    }

    expect(canaryCount).toBeGreaterThan(30);
    expect(canaryCount).toBeLessThan(70);
  });

  it('should rollback on high error rate', async () => {
    const canary = createCanaryDeploy({
      currentVersion: 'v1',
      canaryVersion: 'v2',
      maxErrorRate: 0.05,
    });

    for (let i = 0; i < 200; i++) {
      canary.recordRequest(true, i < 20, 100);
    }

    const decision = canary.evaluate();
    expect(decision.action).toBe('rollback');
  });

  it('should promote on good performance', async () => {
    const canary = createCanaryDeploy({
      currentVersion: 'v1',
      canaryVersion: 'v2',
    });

    for (let i = 0; i < 200; i++) {
      canary.recordRequest(true, false, 100);
    }

    const decision = canary.evaluate();
    expect(decision.action).toBe('promote');
  });
});
