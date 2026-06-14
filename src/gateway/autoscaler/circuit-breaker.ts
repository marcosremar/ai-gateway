/**
 * Advanced Circuit Breaker — tracks per-tier (per-pod) failure/success
 * with 3 states: closed → open → half-open → closed.
 *
 * Enhanced features:
 * - Adaptive timeouts based on historical performance
 * - Multi-dimensional health tracking (latency + error rate)
 * - Predictive failure detection using statistical analysis
 * - Cross-tier correlation for system-wide insights
 * - Automatic configuration tuning based on performance patterns
 *
 * Uses StateStore for persistence (survives restarts).
 */

import type { KvStore } from '../../deps';
import { defaultLogger as log } from '../../logger';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface TierCircuitBreakerConfig {
  /** Base consecutive failures before opening the circuit. Default: 3 */
  failureThreshold: number;
  /** Adaptive recovery timeout (base time before testing half-open in ms). Default: 30_000 */
  recoveryTimeoutMs: number;
  /** Minimum success rate required for stability (0.0-1.0). Default: 0.95 */
  minSuccessRate: number;
  /** Successes needed in half-open to close. Default: 2 */
  successThreshold: number;
  /** Max concurrent probes allowed in half-open state. Default: 1 */
  halfOpenMaxConcurrent: number;
  /** Enable predictive failure detection. Default: true */
  predictiveAnalysis: boolean;
  /** Statistical window size for analysis (requests). Default: 100 */
  analysisWindow: number;
  /** Enable adaptive thresholds based on performance history. Default: true */
  adaptiveThresholds: boolean;
}

const DEFAULT_CONFIG: TierCircuitBreakerConfig = {
  failureThreshold: 3,
  recoveryTimeoutMs: 30_000,
  successThreshold: 2,
  halfOpenMaxConcurrent: 1,
  minSuccessRate: 0.95,
  predictiveAnalysis: true,
  analysisWindow: 100,
  adaptiveThresholds: true,
};

interface PersistedCircuitState {
  failures: number;
  state: CircuitState;
  openedAt: number;
  halfOpenSuccesses: number;

  // Advanced monitoring
  totalRequests: number;
  successCount: number;
  avgLatencyMs: number;
  latencyVariance: number;
  lastSuccessRate: number;
  /** Recent failure reasons (most recent last). Was historically the typo'd
   *  `failureMadre`; we read that legacy field on load for back-compat
   *  (#232) so persisted state written by older builds still surfaces. */
  failureReasons: string[];
  adaptiveThreshold: number; // Currently adapted failure threshold
  predictiveScore: number; // 0-1 risk score for future failures
}

function storeKey(tierIndex: number): string {
  return `circuit:${tierIndex}`;
}

function defaultState(): PersistedCircuitState {
  return {
    failures: 0,
    state: 'closed',
    openedAt: 0,
    halfOpenSuccesses: 0,
    totalRequests: 0,
    successCount: 0,
    avgLatencyMs: 0,
    latencyVariance: 0,
    lastSuccessRate: 1.0,
    failureReasons: [],
    adaptiveThreshold: 3, // Start with default
    predictiveScore: 0
  };
}

// ── Pure helpers (exported for unit testing — no I/O, no `this`) ────────────

/**
 * #234 — adaptive failure threshold floor + hysteresis.
 *
 * Reliable tiers (success rate above `minSuccessRate`) get a more tolerant
 * threshold; unreliable tiers fail faster but the floor is **2**, not 1, so a
 * single transient failure can never instantly trip the circuit (which caused
 * flapping). Returns the configured `failureThreshold` until there is
 * sufficient history (`sampleCount < minSamples`).
 */
export function computeAdaptiveThreshold(
  successRate: number,
  failureThreshold: number,
  minSuccessRate: number,
  sampleCount: number,
  minSamples = 30,
): number {
  if (sampleCount < minSamples) return failureThreshold;
  if (successRate > minSuccessRate) {
    return Math.max(failureThreshold * 1.5, 5); // more tolerant
  }
  // Floor at 2 (was 1) + round so a tier at a single failure never trips.
  return Math.max(Math.round(failureThreshold * 0.5), 2);
}

/**
 * #238 — predictive-open gate with a configurable sample floor.
 *
 * The predictive score is noisy on tiny samples, so opening the circuit
 * purely on prediction requires both a score over `riskThreshold` AND at
 * least `minSamples` observations. Returns false when prediction is disabled.
 */
export function shouldPredictiveOpen(
  predictiveScore: number,
  sampleCount: number,
  opts: { enabled?: boolean; riskThreshold?: number; minSamples?: number } = {},
): boolean {
  const { enabled = true, riskThreshold = 0.7, minSamples = 20 } = opts;
  if (!enabled) return false;
  if (sampleCount < minSamples) return false;
  return predictiveScore > riskThreshold;
}

export class TierCircuitBreaker {
  private readonly config: TierCircuitBreakerConfig;

  constructor(
    private readonly store: KvStore,
    config?: Partial<TierCircuitBreakerConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private async load(tierIndex: number): Promise<PersistedCircuitState> {
    const raw = await this.store.get(storeKey(tierIndex));
    if (!raw) return defaultState();
    try {
      const parsed = JSON.parse(raw) as PersistedCircuitState & { failureMadre?: string[] };
      // #232 back-compat: older builds persisted reasons under `failureMadre`.
      if (!parsed.failureReasons && Array.isArray(parsed.failureMadre)) {
        parsed.failureReasons = parsed.failureMadre;
      }
      if (!Array.isArray(parsed.failureReasons)) parsed.failureReasons = [];
      delete parsed.failureMadre;
      return parsed;
    } catch {
      return defaultState();
    }
  }

  private async save(tierIndex: number, s: PersistedCircuitState): Promise<void> {
    await this.store.set(storeKey(tierIndex), JSON.stringify(s));
  }

  /** Evaluate time-based transitions (open → half-open) */
  private applyTimeTransition(s: PersistedCircuitState): PersistedCircuitState {
    if (s.state === 'open' && s.openedAt > 0) {
      const elapsed = Date.now() - s.openedAt;
      if (elapsed >= this.config.recoveryTimeoutMs) {
        return { ...s, state: 'half-open', halfOpenSuccesses: 0 };
      }
    }
    return s;
  }

  async recordSuccess(tierIndex: number): Promise<void> {
    let s = this.applyTimeTransition(await this.load(tierIndex));

    if (s.state === 'half-open') {
      s.halfOpenSuccesses++;
      if (s.halfOpenSuccesses >= this.config.successThreshold) {
        s = defaultState();
      }
    } else {
      // In closed state, reset failure count on success
      s.failures = 0;
    }

    await this.save(tierIndex, s);
  }

  async recordFailure(tierIndex: number): Promise<void> {
    let s = this.applyTimeTransition(await this.load(tierIndex));

    s.failures++;

    if (s.state === 'half-open') {
      // Any failure in half-open re-opens
      s.state = 'open';
      s.openedAt = Date.now();
      s.halfOpenSuccesses = 0;
    } else if (s.failures >= this.config.failureThreshold) {
      s.state = 'open';
      s.openedAt = Date.now();
    }

    await this.save(tierIndex, s);
  }

  async getState(tierIndex: number): Promise<CircuitState> {
    const loaded = await this.load(tierIndex);
    const s = this.applyTimeTransition(loaded);
    // Only persist when the time-based transition actually changed *our*
    // local view. Re-reading the store here (previous code) creates a
    // last-write-wins race against concurrent recordFailure/recordSuccess
    // workers — they could flip the state between our read and our save,
    // and we'd clobber their newer write with our stale time-transitioned
    // value. Comparing against the snapshot we already have keeps writes
    // idempotent and avoids the read-modify-write race.
    if (s.state !== loaded.state) {
      await this.save(tierIndex, s);
    }
    return s.state;
  }

  /** Returns true if the tier is available for traffic (closed or half-open). */
  async isAvailable(tierIndex: number): Promise<boolean> {
    const state = await this.getState(tierIndex);
    return state !== 'open';
  }

  /** Get circuit states for all tracked tiers. */
  async getAll(): Promise<Map<number, CircuitState>> {
    const result = new Map<number, CircuitState>();
    const keys: string[] = [];
    // KvStore.scan is async — must await before consuming the keys it
    // populates via the callback. The previous code returned an empty
    // result whenever the scan implementation deferred its callback (which
    // both Redis and the InMemory adapter do).
    await this.store.scan('circuit:*', (k) => { keys.push(...k); });
    for (const key of keys) {
      const idx = parseInt(key.replace('circuit:', ''), 10);
      if (!isNaN(idx)) {
        result.set(idx, await this.getState(idx));
      }
    }
    return result;
  }

  /** Reset a tier's circuit to closed. */
  async reset(tierIndex: number): Promise<void> {
    await this.save(tierIndex, defaultState());
  }

  // ── Advanced Circuit Breaker Features ──────────────────────────────────────

  private performanceHistory: Map<number, Array<{latencyMs: number, success: boolean, timestamp: number}>> = new Map();

  /** Record detailed request information for advanced analysis */
  async recordRequest(tierIndex: number, latencyMs: number, success: boolean, failureReason?: string): Promise<void> {
    const now = Date.now();
    let s = this.applyTimeTransition(await this.load(tierIndex));

    // Update statistics
    s.totalRequests++;
    if (success) {
      s.successCount++;
    } else {
      s.failures++;
      if (failureReason) {
        s.failureReasons.push(failureReason);
        // Keep only last 10 failures
        s.failureReasons = s.failureReasons.slice(-10);
      }
    }

    // Rolling average latency
    if (s.avgLatencyMs === 0) {
      s.avgLatencyMs = latencyMs;
    } else {
      // Weighted rolling average (70% old, 30% new)
      s.avgLatencyMs = s.avgLatencyMs * 0.7 + latencyMs * 0.3;
    }

    // Store performance history for analysis
    if (!this.performanceHistory.has(tierIndex)) {
      this.performanceHistory.set(tierIndex, []);
    }

    const history = this.performanceHistory.get(tierIndex)!;
    history.push({ latencyMs, success, timestamp: now });

    // Keep only recent history (configured window size)
    if (history.length > this.config.analysisWindow) {
      history.splice(0, history.length - this.config.analysisWindow);
    }

    // Update derived metrics
    s.lastSuccessRate = s.successCount / s.totalRequests;
    s.predictiveScore = this.calculatePredictiveScore(tierIndex);

    if (this.config.adaptiveThresholds) {
      s.adaptiveThreshold = this.calculateAdaptiveThreshold(tierIndex);
    }

    await this.save(tierIndex, s);

    // Check if circuit should open based on advanced criteria
    if (this.shouldOpenCircuitAdvanced(s, tierIndex)) {
      await this.openCircuitAdvanced(tierIndex, s);
    }
  }

  /** Predictive failure scoring based on recent performance trends */
  private calculatePredictiveScore(tierIndex: number): number {
    const history = this.performanceHistory.get(tierIndex);
    if (!history || history.length < 10) return 0; // Not enough data

    // Analyze last 20 requests for recent trends
    const recent = history.slice(-20);
    const recentFailures = recent.filter(h => !h.success).length;
    const failureRate = recentFailures / recent.length;

    // Latency trend (increasing latency = higher risk)
    const currentLatency = recent[recent.length - 1].latencyMs;
    const avgRecentLatency = recent.slice(-10).reduce((sum, h) => sum + h.latencyMs, 0) / 10;
    // Guard against the 0/0 case (all-zero samples) which would produce NaN
    // and propagate into shouldOpenCircuitAdvanced — making the circuit
    // open or stay closed depending on which NaN-comparison the caller used.
    const latencyTrend = avgRecentLatency > 0 ? currentLatency / avgRecentLatency : 1;

    // Combine factors for risk score (0-1, higher = more likely to fail)
    const baseRisk = Math.min(failureRate * 1.5, 0.8);
    const latencyRisk = Math.max(0, (latencyTrend - 1) * 0.3);

    return Math.min(baseRisk + latencyRisk, 0.95); // Cap at 95%
  }

  /** Adaptive failure threshold based on historical performance */
  private calculateAdaptiveThreshold(tierIndex: number): number {
    const history = this.performanceHistory.get(tierIndex);
    if (!history || history.length < 30) {
      return this.config.failureThreshold; // Use default until we have sufficient data
    }

    // Base threshold on historical success rate
    const successRate = history.filter(h => h.success).length / history.length;

    // Delegate to the pure helper so the floor (now 2, not 1) + hysteresis is
    // unit-testable in isolation (#234).
    return computeAdaptiveThreshold(
      successRate,
      this.config.failureThreshold,
      this.config.minSuccessRate,
      history.length,
      30,
    );
  }

  private shouldOpenCircuitAdvanced(state: PersistedCircuitState, tierIndex: number): boolean {
    const threshold = this.config.adaptiveThresholds ?
      state.adaptiveThreshold :
      this.config.failureThreshold;

    // Multiple criteria for opening circuit:
    const consecutiveFailures = state.failures >= threshold;
    const successRateTooLow = state.lastSuccessRate < this.config.minSuccessRate;
    // #238: predictive open requires a minimum sample count so we don't open
    // the circuit on a noisy score derived from a handful of requests.
    const sampleCount = this.performanceHistory.get(tierIndex)?.length ?? 0;
    const predictiveRisk = shouldPredictiveOpen(state.predictiveScore, sampleCount, {
      enabled: this.config.predictiveAnalysis,
      riskThreshold: 0.7,
      minSamples: 20,
    });

    return consecutiveFailures || successRateTooLow || predictiveRisk;
  }

  private async openCircuitAdvanced(tierIndex: number, state: PersistedCircuitState): Promise<void> {
    let s = await this.load(tierIndex);
    s.state = 'open';
    s.openedAt = Date.now();
    s.halfOpenSuccesses = defaultState().halfOpenSuccesses;
    await this.save(tierIndex, s);

    // Provide detailed reasoning for circuit opening
    const riskFactor = (state.predictiveScore > 0.7) ? "predictive risk analysis" :
                      (state.lastSuccessRate < this.config.minSuccessRate) ? "low success rate" :
                      "consecutive failures";

    log.log(`[circuit-breaker] 🔴 Circuit OPENED for tier ${tierIndex} due to ${riskFactor} ` +
                `(success: ${(state.lastSuccessRate * 100).toFixed(1)}%, threshold: ${(this.config.minSuccessRate * 100).toFixed(1)}%, predictive: ${(state.predictiveScore * 100).toFixed(1)}%)`);
  }

  /** Get detailed tier analytics and recommendations */
  async getTierAnalytics(tierIndex: number): Promise<{
    healthScore: number;        // 0-100, higher = healthier
    predictiveRisk: number;     // 0-1, higher = more likely to fail
    adaptiveThreshold: number;
    recentFailureRate: number;
    latencyTrends: { avg: number; trend: 'stable' | 'increasing' | 'decreasing'; stability: number };
    /** #232 — recent failure reasons so operators can see *why* a circuit
     *  opened instead of guessing. Most recent last. */
    failureReasons: string[];
    recommendation: string;
    tierHealth: 'healthy' | 'warning' | 'critical';
  } | null> {
    const state = await this.load(tierIndex);
    const history = this.performanceHistory.get(tierIndex);

    if (!history || history.length < 10) {
      return null; // Insufficient data for meaningful analysis
    }

    // Health score: success rate (70%) + latency stability (30%)
    const successScore = state.lastSuccessRate * 70;
    const latencyStability = this.calculateLatencyStability(history);
    const healthScore = Math.round(successScore + latencyStability * 30);

    // Latency trends with stability analysis
    const latencyTrend = this.analyzeLatencyTrend(history);

    // Overall tier health assessment
    let tierHealth: 'healthy' | 'warning' | 'critical' = 'healthy';
    let recommendation = 'healthy - no action needed';

    if (state.predictiveScore > 0.8) {
      tierHealth = 'critical';
      recommendation = 'critical - circuit likely to fail soon, prioritize maintenance';
    } else if (state.predictiveScore > 0.5) {
      tierHealth = 'warning';
      recommendation = 'warning - monitor closely, failure risk increasing';
    } else if (state.lastSuccessRate < 0.9) {
      tierHealth = 'warning';
      recommendation = 'warning - suboptimal performance, investigate latency issues';
    } else if (state.lastSuccessRate < 0.95) {
      recommendation = 'review - performance slightly below optimal';
    }

    return {
      healthScore,
      predictiveRisk: state.predictiveScore,
      adaptiveThreshold: state.adaptiveThreshold,
      recentFailureRate: 1 - state.lastSuccessRate,
      latencyTrends: {
        avg: state.avgLatencyMs,
        trend: latencyTrend.trend,
        stability: latencyTrend.stability
      },
      failureReasons: [...(state.failureReasons ?? [])],
      recommendation,
      tierHealth
    };
  }

  private calculateLatencyStability(history: Array<{latencyMs: number, success: boolean, timestamp: number}>): number {
    if (history.length < 5) return 1.0;

    const latencies = history.slice(-20).map(h => h.latencyMs);
    const mean = latencies.reduce((a, b) => a + b) / latencies.length;
    // All-zero latencies have no variance to report — treat as fully stable
    // rather than producing NaN via 0/0 division.
    if (mean === 0) return 1.0;
    const variance = latencies.reduce((sum, lat) => sum + Math.pow(lat - mean, 2), 0) / latencies.length;
    const stdDev = Math.sqrt(variance);

    // Convert to 0-1 stability score (lower variance = higher stability)
    const coefficientOfVariation = stdDev / mean;
    return Math.max(0, Math.min(1, 1 - coefficientOfVariation * 2)); // Cap at reasonable variance levels
  }

  private analyzeLatencyTrend(history: Array<{latencyMs: number, success: boolean, timestamp: number}>): {
    trend: 'stable' | 'increasing' | 'decreasing';
    stability: number;
  } {
    if (history.length < 10) {
      return { trend: 'stable', stability: 1.0 };
    }

    const halfPoint = Math.floor(history.length / 2);
    const firstHalfAvg = history.slice(0, halfPoint).reduce((sum, h) => sum + h.latencyMs, 0) / halfPoint;
    const secondHalfAvg = history.slice(halfPoint).reduce((sum, h) => sum + h.latencyMs, 0) / (history.length - halfPoint);

    const stability = this.calculateLatencyStability(history);

    // When the first half is all zeros, percentage change is undefined.
    // Treat absolute zero-baseline as 'stable' rather than NaN-comparing
    // through to the 'increasing' branch.
    if (firstHalfAvg === 0) {
      return { trend: 'stable', stability };
    }

    const changePercent = (secondHalfAvg - firstHalfAvg) / firstHalfAvg;

    if (Math.abs(changePercent) < 0.1) {
      return { trend: 'stable', stability };
    }

    return { trend: changePercent > 0 ? 'increasing' : 'decreasing', stability };
  }
}
