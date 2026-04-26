/**
 * Canary deployment support for AI Gateway.
 *
 * Gradually shifts traffic from old version to new version,
 * monitoring error rates and latency. Automatically rolls back
 * if the new version shows degradation.
 *
 * @example
 * ```ts
 * import { createCanaryDeploy } from './canary';
 *
 * const canary = createCanaryDeploy({
 *   currentVersion: 'v0.1.0',
 *   canaryVersion: 'v0.2.0',
 *   trafficPercentage: 5, // Start with 5% traffic
 *   maxErrorRate: 0.05,   // 5% error rate threshold
 * });
 *
 * // Route request
 * const useCanary = canary.shouldRouteToCanary(request);
 *
 * // Promote canary to 100%
 * await canary.promote(100);
 *
 * // Rollback on errors
 * await canary.rollback();
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('canary');

export interface CanaryConfig {
  /** Current stable version */
  currentVersion: string;
  /** New version to test */
  canaryVersion: string;
  /** Initial traffic percentage to canary (0-100) */
  initialTrafficPercentage?: number;
  /** Max error rate before rollback (0-1) */
  maxErrorRate?: number;
  /** Min requests before evaluation (default: 100) */
  minRequests?: number;
  /** Step size for traffic increase (default: 10) */
  trafficStep?: number;
  /** Evaluation interval in ms (default: 60_000) */
  evaluationIntervalMs?: number;
}

export interface CanaryStats {
  canaryRequests: number;
  canaryErrors: number;
  canaryAvgLatencyMs: number;
  stableRequests: number;
  stableErrors: number;
  stableAvgLatencyMs: number;
  trafficPercentage: number;
  status: 'pending' | 'ramping' | 'promoted' | 'rolled_back';
}

export interface CanaryDecision {
  action: 'promote' | 'rollback' | 'continue';
  reason: string;
  confidence: number; // 0-1
}

const DEFAULT_CONFIG: Required<CanaryConfig> = {
  currentVersion: 'v0.0.0',
  canaryVersion: 'v0.0.0',
  initialTrafficPercentage: 5,
  maxErrorRate: 0.05,
  minRequests: 100,
  trafficStep: 10,
  evaluationIntervalMs: 60_000,
};

export function createCanaryDeploy(config: CanaryConfig) {
  const cfg: Required<CanaryConfig> = { ...DEFAULT_CONFIG, ...config };

  let trafficPercentage = cfg.initialTrafficPercentage;
  let status: CanaryStats['status'] = 'pending';
  const stats: CanaryStats = {
    canaryRequests: 0,
    canaryErrors: 0,
    canaryAvgLatencyMs: 0,
    stableRequests: 0,
    stableErrors: 0,
    stableAvgLatencyMs: 0,
    trafficPercentage,
    status,
  };

  const latencies: { canary: number[]; stable: number[] } = { canary: [], stable: [] };

  return {
    /**
     * Determine if a request should go to the canary version.
     */
    shouldRouteToCanary(): boolean {
      if (status === 'rolled_back') return false;
      if (status === 'promoted') return true;
      return Math.random() * 100 < trafficPercentage;
    },

    /**
     * Record a request result for canary analysis.
     */
    recordRequest(isCanary: boolean, error: boolean, latencyMs: number): void {
      if (isCanary) {
        stats.canaryRequests++;
        if (error) stats.canaryErrors++;
        latencies.canary.push(latencyMs);
      } else {
        stats.stableRequests++;
        if (error) stats.stableErrors++;
        latencies.stable.push(latencyMs);
      }

      // Keep only recent latencies (last 1000)
      if (latencies.canary.length > 1000) latencies.canary.shift();
      if (latencies.stable.length > 1000) latencies.stable.shift();

      // Update averages
      stats.canaryAvgLatencyMs =
        latencies.canary.length > 0
          ? latencies.canary.reduce((a, b) => a + b, 0) / latencies.canary.length
          : 0;
      stats.stableAvgLatencyMs =
        latencies.stable.length > 0
          ? latencies.stable.reduce((a, b) => a + b, 0) / latencies.stable.length
          : 0;
    },

    /**
     * Evaluate canary health and make a decision.
     */
    evaluate(): CanaryDecision {
      const totalReqs = stats.canaryRequests + stats.stableRequests;

      if (totalReqs < cfg.minRequests) {
        return {
          action: 'continue',
          reason: `Insufficient data: ${totalReqs}/${cfg.minRequests} requests`,
          confidence: 0,
        };
      }

      // Reject promote when canary has zero samples — no signal to act on.
      // Without this guard, canaryErrorRate=0 (the 0/0 fallback) trips the
      // "performing well" branch and promotes an unexercised canary.
      if (stats.canaryRequests === 0) {
        return {
          action: 'continue',
          reason: `No canary samples yet (${stats.stableRequests} stable, 0 canary)`,
          confidence: 0,
        };
      }

      const canaryErrorRate = stats.canaryRequests > 0
        ? stats.canaryErrors / stats.canaryRequests
        : 0;

      // Check error rate threshold
      if (canaryErrorRate > cfg.maxErrorRate) {
        return {
          action: 'rollback',
          reason: `Canary error rate ${canaryErrorRate.toFixed(3)} exceeds threshold ${cfg.maxErrorRate}`,
          confidence: 0.95,
        };
      }

      // Check latency degradation
      if (stats.stableAvgLatencyMs > 0) {
        const latencyIncrease =
          (stats.canaryAvgLatencyMs - stats.stableAvgLatencyMs) / stats.stableAvgLatencyMs;

        if (latencyIncrease > 0.5) { // 50% increase is too much
          return {
            action: 'rollback',
            reason: `Canary latency ${stats.canaryAvgLatencyMs.toFixed(0)}ms is ${latencyIncrease.toFixed(1)}× slower than stable`,
            confidence: 0.8,
          };
        }
      }

      // Canary is healthy — suggest promotion
      if (canaryErrorRate < cfg.maxErrorRate * 0.5) { // Half the threshold
        return {
          action: 'promote',
          reason: `Canary performing well (error rate: ${(canaryErrorRate * 100).toFixed(2)}%)`,
          confidence: 0.9,
        };
      }

      return {
        action: 'continue',
        reason: `Canary within acceptable range (error rate: ${(canaryErrorRate * 100).toFixed(2)}%)`,
        confidence: 0.7,
      };
    },

    /**
     * Increase canary traffic by the configured step.
     */
    async stepUp(): Promise<void> {
      if (status === 'rolled_back' || status === 'promoted') return;

      trafficPercentage = Math.min(100, trafficPercentage + cfg.trafficStep);
      stats.trafficPercentage = trafficPercentage;
      status = trafficPercentage >= 100 ? 'promoted' : 'ramping';

      log.log(
        { canaryVersion: cfg.canaryVersion, trafficPercentage, status },
        'Canary traffic increased',
      );
    },

    /**
     * Promote canary to 100% traffic.
     */
    async promote(toPercentage = 100): Promise<void> {
      trafficPercentage = toPercentage;
      stats.trafficPercentage = toPercentage;
      status = 'promoted';

      log.log(
        { canaryVersion: cfg.canaryVersion, trafficPercentage },
        'Canary promoted',
      );
    },

    /**
     * Rollback canary to 0% traffic.
     */
    async rollback(): Promise<void> {
      trafficPercentage = 0;
      stats.trafficPercentage = 0;
      status = 'rolled_back';

      log.log(
        { canaryVersion: cfg.canaryVersion, reason: 'Manual rollback' },
        'Canary rolled back',
      );
    },

    /**
     * Get current canary stats.
     */
    getStats(): CanaryStats {
      return { ...stats };
    },

    /**
     * Reset canary stats for a new evaluation cycle.
     */
    resetStats(): void {
      stats.canaryRequests = 0;
      stats.canaryErrors = 0;
      stats.canaryAvgLatencyMs = 0;
      stats.stableRequests = 0;
      stats.stableErrors = 0;
      stats.stableAvgLatencyMs = 0;
      latencies.canary.length = 0;
      latencies.stable.length = 0;
    },
  };
}
