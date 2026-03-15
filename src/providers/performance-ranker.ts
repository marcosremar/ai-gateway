/**
 * Performance Ranker
 *
 * Maintains in-memory latency samples per provider:model:stage key and
 * uses them to reorder fallback chains by real observed performance.
 *
 * Features:
 *   1. Circular buffer of recent latency samples per key (bounded by count + age)
 *   2. Computes p50/p95 percentiles and success rate
 *   3. Detects gradual degradation (current p50 vs historical baseline)
 *   4. Exposes rankChain() to reorder FallbackEntry[] by real performance
 *
 * In-memory only — no Redis, no external deps.
 */

import type { FallbackEntry } from './fallback';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PerformanceSample {
  latencyMs: number;
  success: boolean;
  timestamp: number;
}

export interface PerformanceStats {
  p50: number | null;
  p95: number | null;
  successRate: number;
  sampleCount: number;
  trend: 'improving' | 'stable' | 'degrading';
}

export interface PerformanceRankerConfig {
  /** Max number of samples to keep per key (default: 50) */
  windowSize?: number;
  /** Max age of samples in ms (default: 600_000 = 10 min) */
  windowTimeMs?: number;
  /** Minimum samples before ranking kicks in (default: 5) */
  minSamples?: number;
  /**
   * Ratio of current p50 vs baseline p50 that flags degradation.
   * E.g. 2.0 means "if current p50 is 2x baseline, mark as degrading".
   * Default: 2.0
   */
  degradationThreshold?: number;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function sampleKey(stage: string, provider: string, model: string): string {
  return `${provider}:${model}:${stage}`;
}

/**
 * Compute the p-th percentile from a sorted array of numbers.
 * Uses linear interpolation between nearest ranks.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];

  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);

  if (lower === upper) return sorted[lower];

  const weight = idx - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_SIZE = 50;
const DEFAULT_WINDOW_TIME_MS = 600_000; // 10 minutes
const DEFAULT_MIN_SAMPLES = 5;
const DEFAULT_DEGRADATION_THRESHOLD = 2.0;

// ─── PerformanceRanker ───────────────────────────────────────────────────────

export class PerformanceRanker {
  private buffers = new Map<string, PerformanceSample[]>();

  private readonly windowSize: number;
  private readonly windowTimeMs: number;
  private readonly minSamples: number;
  private readonly degradationThreshold: number;

  constructor(config: PerformanceRankerConfig = {}) {
    this.windowSize = config.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.windowTimeMs = config.windowTimeMs ?? DEFAULT_WINDOW_TIME_MS;
    this.minSamples = config.minSamples ?? DEFAULT_MIN_SAMPLES;
    this.degradationThreshold = config.degradationThreshold ?? DEFAULT_DEGRADATION_THRESHOLD;
  }

  /**
   * Record a performance sample for a provider:model:stage combination.
   * Evicts oldest samples when the buffer exceeds windowSize.
   */
  record(
    stage: string,
    provider: string,
    model: string,
    latencyMs: number,
    success: boolean,
  ): void {
    const key = sampleKey(stage, provider, model);
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = [];
      this.buffers.set(key, buffer);
    }

    buffer.push({ latencyMs, success, timestamp: Date.now() });

    // Evict oldest if over windowSize (circular buffer behavior)
    while (buffer.length > this.windowSize) {
      buffer.shift();
    }
  }

  /**
   * Get active (non-expired) samples for a key.
   * Also prunes expired entries from the buffer.
   */
  private getActiveSamples(key: string): PerformanceSample[] {
    const buffer = this.buffers.get(key);
    if (!buffer || buffer.length === 0) return [];

    const cutoff = Date.now() - this.windowTimeMs;
    // Find the first sample that is within the window
    const firstValid = buffer.findIndex((s) => s.timestamp >= cutoff);

    if (firstValid === -1) {
      // All samples expired
      this.buffers.delete(key);
      return [];
    }

    if (firstValid > 0) {
      // Prune expired samples from the front
      buffer.splice(0, firstValid);
    }

    return buffer;
  }

  /**
   * Compute performance statistics for a provider:model:stage combination.
   */
  getStats(stage: string, provider: string, model: string): PerformanceStats {
    const key = sampleKey(stage, provider, model);
    const samples = this.getActiveSamples(key);

    if (samples.length === 0) {
      return { p50: null, p95: null, successRate: 0, sampleCount: 0, trend: 'stable' };
    }

    const successCount = samples.filter((s) => s.success).length;
    const successRate = successCount / samples.length;

    // Compute percentiles from successful samples only (failed requests have
    // meaningless latency — often a timeout ceiling or instant rejection)
    const successLatencies = samples
      .filter((s) => s.success)
      .map((s) => s.latencyMs)
      .sort((a, b) => a - b);

    const p50 = successLatencies.length > 0 ? percentile(successLatencies, 50) : null;
    const p95 = successLatencies.length > 0 ? percentile(successLatencies, 95) : null;

    const trend = this.computeTrend(samples);

    return { p50, p95, successRate, sampleCount: samples.length, trend };
  }

  /**
   * Detect trend by comparing the p50 of the first half vs second half of samples.
   */
  private computeTrend(samples: PerformanceSample[]): 'improving' | 'stable' | 'degrading' {
    const successful = samples.filter((s) => s.success);
    if (successful.length < 4) return 'stable'; // need at least 2 per half

    const mid = Math.floor(successful.length / 2);
    const firstHalf = successful.slice(0, mid).map((s) => s.latencyMs).sort((a, b) => a - b);
    const secondHalf = successful.slice(mid).map((s) => s.latencyMs).sort((a, b) => a - b);

    const baselineP50 = percentile(firstHalf, 50);
    const currentP50 = percentile(secondHalf, 50);

    if (baselineP50 === 0) return 'stable';

    const ratio = currentP50 / baselineP50;

    if (ratio >= this.degradationThreshold) return 'degrading';
    if (ratio <= 1 / this.degradationThreshold) return 'improving';
    return 'stable';
  }

  /**
   * Returns true if a provider:model:stage is currently degraded.
   * Degradation is detected when the recent p50 is >= degradationThreshold * baseline p50.
   */
  isDegraded(stage: string, provider: string, model: string): boolean {
    const stats = this.getStats(stage, provider, model);
    return stats.trend === 'degrading';
  }

  /**
   * Compute a composite score for ranking. Lower is better.
   *
   * Score formula:
   *   - Start with p50 latency (lower is better)
   *   - Penalize low success rates: multiply by (2 - successRate)
   *     At 100% success → 1x. At 50% success → 1.5x. At 0% → 2x.
   *   - Penalize degrading providers: multiply by degradationThreshold
   *
   * Returns null if there are not enough samples to rank.
   */
  private scoreEntry(stage: string, provider: string, model: string): number | null {
    const stats = this.getStats(stage, provider, model);
    if (stats.sampleCount < this.minSamples || stats.p50 === null) return null;

    let score = stats.p50;
    // Penalize low success rate
    score *= 2 - stats.successRate;
    // Extra penalty if degrading
    if (stats.trend === 'degrading') {
      score *= this.degradationThreshold;
    }
    return score;
  }

  /**
   * Reorder a FallbackEntry[] chain by real performance for the given stage.
   *
   * Entries with enough samples are sorted by composite score (lower = better).
   * Entries without enough data keep their original relative order but are placed
   * after all scored entries — this preserves the user's configured priority for
   * new/cold providers while promoting proven performers.
   *
   * Returns a new array; does not mutate the input.
   */
  rankChain(stage: string, chain: FallbackEntry[]): FallbackEntry[] {
    if (chain.length <= 1) return [...chain];

    const scored: Array<{ entry: FallbackEntry; score: number }> = [];
    const unscored: FallbackEntry[] = [];

    for (const entry of chain) {
      const score = this.scoreEntry(stage, entry.provider, entry.model ?? '*');
      if (score !== null) {
        scored.push({ entry, score });
      } else {
        unscored.push(entry);
      }
    }

    // Sort scored entries: lower score = better = comes first
    scored.sort((a, b) => a.score - b.score);

    return [...scored.map((s) => s.entry), ...unscored];
  }

  /**
   * Clear all samples (useful for testing or reset).
   */
  clear(): void {
    this.buffers.clear();
  }

  /**
   * Number of tracked keys (for monitoring).
   */
  get size(): number {
    return this.buffers.size;
  }
}

/** Default module-level singleton */
export const defaultPerformanceRanker = new PerformanceRanker();
