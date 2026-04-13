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
 *   5. Persistence: toJSON()/fromJSON() + auto-save to disk for restart resilience
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
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
  /** Path to persist snapshots on disk. Null disables persistence. */
  persistPath?: string | null;
  /** How often to auto-save to disk in ms (default: 60_000 = 1 min) */
  persistIntervalMs?: number;
}

/** Serialized format for disk persistence */
interface PerformanceSnapshot {
  version: 1;
  savedAt: number;
  buffers: Record<string, PerformanceSample[]>;
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
  private lastBufferClean = Date.now();

  private readonly windowSize: number;
  private readonly windowTimeMs: number;
  private readonly minSamples: number;
  private readonly degradationThreshold: number;
  private readonly persistPath: string | null;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

  constructor(config: PerformanceRankerConfig = {}) {
    this.windowSize = config.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.windowTimeMs = config.windowTimeMs ?? DEFAULT_WINDOW_TIME_MS;
    this.minSamples = config.minSamples ?? DEFAULT_MIN_SAMPLES;
    this.degradationThreshold = config.degradationThreshold ?? DEFAULT_DEGRADATION_THRESHOLD;
    this.persistPath = config.persistPath ?? null;

    // Auto-load from disk if path configured
    if (this.persistPath) {
      this.loadFromDisk();
      const intervalMs = config.persistIntervalMs ?? 60_000;
      this.persistTimer = setInterval(() => this.saveToDisk(), intervalMs);
      // Don't prevent process exit
      if (this.persistTimer && typeof this.persistTimer === 'object' && 'unref' in this.persistTimer) {
        this.persistTimer.unref();
      }
    }
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

    this.dirty = true;
  }

  /**
   * Get active (non-expired) samples for a key.
   * Also prunes expired entries from the buffer.
   */
  /** Evict stale buffer keys that have no recent samples. */
  private evictStaleBuffers(): void {
    const now = Date.now();
    if (now - this.lastBufferClean < 5 * 60_000) return;
    this.lastBufferClean = now;
    const cutoff = now - this.windowTimeMs * 2;
    for (const [key, samples] of this.buffers) {
      if (samples.length === 0 || samples[samples.length - 1].timestamp < cutoff) {
        this.buffers.delete(key);
      }
    }
  }

  private getActiveSamples(key: string): PerformanceSample[] {
    this.evictStaleBuffers();
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
   *   - Inactivity decay: blend score toward a high neutral value as samples age,
   *     so stale providers gradually lose their ranking advantage
   *
   * Returns null if there are not enough samples to rank.
   */
  private scoreEntry(stage: string, provider: string, model: string): number | null {
    const key = sampleKey(stage, provider, model);
    const samples = this.getActiveSamples(key);
    const stats = this.getStats(stage, provider, model);
    if (stats.sampleCount < this.minSamples || stats.p50 === null) return null;

    let score = stats.p50;
    // Penalize low success rate
    score *= 2 - stats.successRate;
    // Extra penalty if degrading
    if (stats.trend === 'degrading') {
      score *= this.degradationThreshold;
    }

    // Inactivity decay: if newest sample is old, blend score toward a high
    // neutral value so stale providers don't keep a privileged ranking.
    // At half the window age, decay is ~30%; at full window age, ~63%.
    if (samples.length > 0) {
      const newestTs = samples[samples.length - 1].timestamp;
      const ageFraction = (Date.now() - newestTs) / this.windowTimeMs;
      if (ageFraction > 0.1) { // only apply after 10% of window has passed
        const NEUTRAL_SCORE = 500; // ms — a "mediocre" latency as neutral anchor
        const decayFactor = Math.exp(-ageFraction * 1.5); // τ ≈ 67% of windowTimeMs
        score = score * decayFactor + NEUTRAL_SCORE * (1 - decayFactor);
      }
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

  // ─── Persistence ──────────────────────────────────────────────────────────

  /** Serialize current state for disk persistence. */
  toJSON(): PerformanceSnapshot {
    const buffers: Record<string, PerformanceSample[]> = {};
    for (const [key, samples] of this.buffers) {
      if (samples.length > 0) {
        buffers[key] = samples;
      }
    }
    return { version: 1, savedAt: Date.now(), buffers };
  }

  /** Restore state from a snapshot. Expired samples are pruned on next access. */
  fromJSON(snapshot: PerformanceSnapshot): void {
    this.buffers.clear();
    if (!snapshot || snapshot.version !== 1 || !snapshot.buffers) return;

    const cutoff = Date.now() - this.windowTimeMs;
    for (const [key, samples] of Object.entries(snapshot.buffers)) {
      // Only restore samples that are still within the time window
      const valid = samples.filter(s => s.timestamp >= cutoff);
      if (valid.length > 0) {
        this.buffers.set(key, valid.slice(-this.windowSize));
      }
    }
  }

  /** Save snapshot to disk (no-op if no persistPath or no changes). */
  saveToDisk(): void {
    if (!this.persistPath || !this.dirty) return;
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify(this.toJSON()), 'utf-8');
      this.dirty = false;
    } catch (e) {
      console.warn('[perf-ranker] saveToDisk failed:', e instanceof Error ? e.message : e);
    }
  }

  /** Load snapshot from disk (no-op if file missing or corrupt). */
  private loadFromDisk(): void {
    if (!this.persistPath) return;
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const snapshot = JSON.parse(raw) as PerformanceSnapshot;
      this.fromJSON(snapshot);
      const keys = this.buffers.size;
      const samples = [...this.buffers.values()].reduce((s, b) => s + b.length, 0);
      if (keys > 0) {
        console.log(`[perf-ranker] Restored ${samples} samples across ${keys} keys from disk`);
      }
    } catch (e) {
      console.warn('[perf-ranker] loadFromDisk failed, starting fresh:', e instanceof Error ? e.message : e);
    }
  }

  /** Stop auto-save timer and flush final snapshot. Call on shutdown. */
  dispose(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    this.saveToDisk();
  }

  /**
   * Clear all samples (useful for testing or reset).
   */
  clear(): void {
    this.buffers.clear();
    this.dirty = true;
  }

  /**
   * Number of tracked keys (for monitoring).
   */
  get size(): number {
    return this.buffers.size;
  }
}

/** Default module-level singleton (with disk persistence) */
export function createDefaultPerformanceRanker(): PerformanceRanker {
  try {
    const configDir = process.env.AI_GATEWAY_CONFIG_DIR || path.join(os.homedir(), '.ai-gateway');
    const persistPath = path.join(configDir, 'perf-ranker.json');
    return new PerformanceRanker({ persistPath });
  } catch {
    return new PerformanceRanker();
  }
}

export const defaultPerformanceRanker = createDefaultPerformanceRanker();
