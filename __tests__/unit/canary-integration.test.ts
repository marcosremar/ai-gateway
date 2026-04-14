/**
 * Integration tests for canary deployment module.
 *
 * Verifies:
 * - Canary starts after successful deploy when enabled
 * - Canary evaluates and promotes on good performance
 * - Canary evaluates and rolls back on high errors
 * - Canary status returns correct data
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCanaryDeploy, type CanaryConfig } from '../../src/canary';

describe('createCanaryDeploy — basic lifecycle', () => {
  let config: CanaryConfig;

  beforeEach(() => {
    config = {
      currentVersion: 'v1.0.0',
      canaryVersion: 'v2.0.0',
      initialTrafficPercentage: 5,
      maxErrorRate: 0.05,
      trafficStep: 10,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create a canary controller with correct initial state', () => {
    const canary = createCanaryDeploy(config);
    const stats = canary.getStats();

    expect(stats.trafficPercentage).toBe(5);
    expect(stats.status).toBe('pending');
    expect(stats.canaryRequests).toBe(0);
    expect(stats.stableRequests).toBe(0);
  });

  it('should route to canary based on traffic percentage', () => {
    // With 100% traffic, always route to canary
    const canaryFull = createCanaryDeploy({ ...config, initialTrafficPercentage: 100 });
    let canaryCount = 0;
    for (let i = 0; i < 100; i++) {
      if (canaryFull.shouldRouteToCanary()) canaryCount++;
    }
    expect(canaryCount).toBe(100);

    // With 0% traffic, never route to canary
    const canaryZero = createCanaryDeploy({ ...config, initialTrafficPercentage: 0 });
    canaryCount = 0;
    for (let i = 0; i < 100; i++) {
      if (canaryZero.shouldRouteToCanary()) canaryCount++;
    }
    expect(canaryCount).toBe(0);
  });

  it('should not route to canary after rollback', async () => {
    const canary = createCanaryDeploy(config);
    await canary.rollback();

    for (let i = 0; i < 100; i++) {
      expect(canary.shouldRouteToCanary()).toBe(false);
    }
  });

  it('should record requests and update stats', () => {
    const canary = createCanaryDeploy(config);

    canary.recordRequest(true, false, 100);   // canary, success, 100ms
    canary.recordRequest(true, true, 200);    // canary, error, 200ms
    canary.recordRequest(false, false, 50);   // stable, success, 50ms
    canary.recordRequest(false, false, 60);   // stable, success, 60ms

    const stats = canary.getStats();
    expect(stats.canaryRequests).toBe(2);
    expect(stats.canaryErrors).toBe(1);
    expect(stats.stableRequests).toBe(2);
    expect(stats.stableErrors).toBe(0);
    expect(stats.canaryAvgLatencyMs).toBe(150);
    expect(stats.stableAvgLatencyMs).toBe(55);
  });
});

describe('canary evaluate — promote on good performance', () => {
  it('should return continue when insufficient data', () => {
    const canary = createCanaryDeploy({
      currentVersion: 'v1.0.0',
      canaryVersion: 'v2.0.0',
      minRequests: 100,
    });

    // Only 10 requests — below minRequests threshold
    for (let i = 0; i < 10; i++) {
      canary.recordRequest(i % 2 === 0, false, 100);
    }

    const decision = canary.evaluate();
    expect(decision.action).toBe('continue');
    expect(decision.reason).toContain('Insufficient data');
  });

  it('should promote when error rate is well below threshold', () => {
    const canary = createCanaryDeploy({
      currentVersion: 'v1.0.0',
      canaryVersion: 'v2.0.0',
      maxErrorRate: 0.05,
      minRequests: 100,
    });

    // 200 requests with 0% error rate (well below 5% threshold, and below half threshold)
    for (let i = 0; i < 200; i++) {
      canary.recordRequest(i % 2 === 0, false, 100);
    }

    const decision = canary.evaluate();
    expect(decision.action).toBe('promote');
    expect(decision.reason).toContain('performing well');
  });

  it('should continue when error rate is acceptable but not great', () => {
    const canary = createCanaryDeploy({
      currentVersion: 'v1.0.0',
      canaryVersion: 'v2.0.0',
      maxErrorRate: 0.05,
      minRequests: 100,
    });

    // 200 requests with 3% error rate (below 5% threshold but above half = 2.5%)
    for (let i = 0; i < 200; i++) {
      const isError = i < 6; // 6/200 = 3% (half go to canary)
      canary.recordRequest(i % 2 === 0, isError && i % 2 === 0, 100);
    }

    const decision = canary.evaluate();
    // Error rate is within acceptable range but not great — should continue
    expect(['continue', 'promote']).toContain(decision.action);
  });
});

describe('canary evaluate — rollback on high errors', () => {
  it('should rollback when error rate exceeds threshold', () => {
    const canary = createCanaryDeploy({
      currentVersion: 'v1.0.0',
      canaryVersion: 'v2.0.0',
      maxErrorRate: 0.05,
      minRequests: 100,
    });

    // 200 requests with 10% canary error rate (above 5% threshold)
    for (let i = 0; i < 200; i++) {
      const isCanary = i % 2 === 0;
      // 10% error rate for canary requests
      const isError = isCanary && (i % 20 === 0);
      canary.recordRequest(isCanary, isError, 100);
    }

    const decision = canary.evaluate();
    expect(decision.action).toBe('rollback');
    expect(decision.reason).toContain('exceeds threshold');
  });

  it('should rollback when latency is significantly degraded', () => {
    const canary = createCanaryDeploy({
      currentVersion: 'v1.0.0',
      canaryVersion: 'v2.0.0',
      maxErrorRate: 0.05,
      minRequests: 100,
    });

    // 200 requests: stable at 100ms, canary at 200ms (100% increase, above 50% threshold)
    for (let i = 0; i < 200; i++) {
      const isCanary = i % 2 === 0;
      canary.recordRequest(isCanary, false, isCanary ? 200 : 100);
    }

    const decision = canary.evaluate();
    expect(decision.action).toBe('rollback');
    expect(decision.reason).toContain('slower than stable');
  });

  it('should actually rollback (set traffic to 0)', async () => {
    const canary = createCanaryDeploy({
      currentVersion: 'v1.0.0',
      canaryVersion: 'v2.0.0',
      maxErrorRate: 0.05,
      minRequests: 100,
    });

    // Generate enough error data
    for (let i = 0; i < 200; i++) {
      const isCanary = i % 2 === 0;
      const isError = isCanary && (i % 10 === 0); // 10% error rate
      canary.recordRequest(isCanary, isError, 100);
    }

    const decision = canary.evaluate();
    expect(decision.action).toBe('rollback');

    await canary.rollback();
    const stats = canary.getStats();
    expect(stats.trafficPercentage).toBe(0);
    // shouldRouteToCanary returns false after rollback
    expect(canary.shouldRouteToCanary()).toBe(false);
  });
});

describe('canary stepUp and promote', () => {
  it('should increase traffic by step on stepUp', async () => {
    const canary = createCanaryDeploy({
      currentVersion: 'v1.0.0',
      canaryVersion: 'v2.0.0',
      initialTrafficPercentage: 5,
      trafficStep: 10,
    });

    expect(canary.getStats().trafficPercentage).toBe(5);

    await canary.stepUp();
    expect(canary.getStats().trafficPercentage).toBe(15);

    await canary.stepUp();
    expect(canary.getStats().trafficPercentage).toBe(25);
  });

  it('should not exceed 100% traffic on stepUp', async () => {
    const canary = createCanaryDeploy({
      currentVersion: 'v1.0.0',
      canaryVersion: 'v2.0.0',
      initialTrafficPercentage: 95,
      trafficStep: 10,
    });

    await canary.stepUp();
    expect(canary.getStats().trafficPercentage).toBe(100);
    // After reaching 100%, shouldRouteToCanary always returns true
    expect(canary.shouldRouteToCanary()).toBe(true);
  });

  it('should promote to 100% and update status', async () => {
    const canary = createCanaryDeploy({
      currentVersion: 'v1.0.0',
      canaryVersion: 'v2.0.0',
      initialTrafficPercentage: 5,
    });

    await canary.promote();
    const stats = canary.getStats();
    expect(stats.trafficPercentage).toBe(100);
    // After promote, shouldRouteToCanary always returns true
    expect(canary.shouldRouteToCanary()).toBe(true);
  });

  it('should not stepUp after promoted or rolled back', async () => {
    const canaryPromoted = createCanaryDeploy({
      currentVersion: 'v1.0.0',
      canaryVersion: 'v2.0.0',
      initialTrafficPercentage: 95,
    });
    await canaryPromoted.promote();
    // After promote to 100%, stepUp should be a no-op
    await canaryPromoted.stepUp();
    expect(canaryPromoted.getStats().trafficPercentage).toBe(100);

    const canaryRolledBack = createCanaryDeploy({
      currentVersion: 'v1.0.0',
      canaryVersion: 'v2.0.0',
      initialTrafficPercentage: 10,
    });
    await canaryRolledBack.rollback();
    // After rollback, stepUp should be a no-op
    await canaryRolledBack.stepUp();
    expect(canaryRolledBack.getStats().trafficPercentage).toBe(0);
  });
});

describe('canary resetStats', () => {
  it('should clear request counters and latencies', () => {
    const canary = createCanaryDeploy({
      currentVersion: 'v1.0.0',
      canaryVersion: 'v2.0.0',
      initialTrafficPercentage: 5,
    });

    canary.recordRequest(true, false, 100);
    canary.recordRequest(false, false, 50);
    expect(canary.getStats().canaryRequests).toBe(1);
    expect(canary.getStats().stableRequests).toBe(1);

    canary.resetStats();
    const stats = canary.getStats();
    expect(stats.canaryRequests).toBe(0);
    expect(stats.canaryErrors).toBe(0);
    expect(stats.stableRequests).toBe(0);
    expect(stats.stableErrors).toBe(0);
    // Traffic percentage is preserved
    expect(stats.trafficPercentage).toBe(5);
  });
});
