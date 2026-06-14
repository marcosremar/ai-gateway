/**
 * TTFAC (Time To First Audio Chunk) Tracker
 *
 * Tracks TTFAC and total latency per TTS provider:model pair using a
 * circular buffer of recent samples. Used to rank TTS providers so that
 * real-time voice pipelines prefer the provider with the lowest startup
 * latency (time until the first audio byte is available for playback).
 *
 * Blended ranking score:
 *   score = ttfacP50 * ttfacWeight + totalP50 * (1 - ttfacWeight)
 *
 * Lower score = faster first audio = better for real-time.
 */

import type { FallbackEntry } from './fallback';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TtfacSample {
  ttfacMs: number;
  totalMs: number;
  timestamp: number;
  /** Whether the request succeeded. Failed requests are excluded from
   *  ranking percentiles so a fast-failing provider can't rank first (#350).
   *  Defaults to true for backward-compatible callers. */
  success?: boolean;
}

export interface TtfacStats {
  ttfacP50: number | null;
  ttfacP95: number | null;
  totalP50: number | null;
  sampleCount: number;
}

export interface TtfacRoutingConfig {
  /** Enable TTFAC-aware routing. Default: false */
  enabled?: boolean;
  /** Weight of TTFAC vs total latency. 1.0 = pure TTFAC, 0.0 = pure total. Default: 0.7 */
  ttfacWeight?: number;
  /** Minimum samples before a provider is eligible for ranking. Default: 3 */
  minSamples?: number;
  /** Maximum number of samples to retain per provider:model. Default: 30 */
  windowSize?: number;
  /** Maximum age of samples in ms. Default: 600_000 (10 minutes) */
  windowTimeMs?: number;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_ENABLED = false;
const DEFAULT_TTFAC_WEIGHT = 0.7;
const DEFAULT_MIN_SAMPLES = 3;
const DEFAULT_WINDOW_SIZE = 30;
const DEFAULT_WINDOW_TIME_MS = 600_000; // 10 minutes

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sampleKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/** Compute the p-th percentile from a sorted array of numbers. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ─── Tracker ──────────────────────────────────────────────────────────────────

export class TtfacTracker {
  private readonly enabled: boolean;
  private readonly ttfacWeight: number;
  private readonly minSamples: number;
  private readonly windowSize: number;
  private readonly windowTimeMs: number;

  private readonly buffers = new Map<string, TtfacSample[]>();

  constructor(config?: TtfacRoutingConfig) {
    this.enabled = config?.enabled ?? DEFAULT_ENABLED;
    this.ttfacWeight = config?.ttfacWeight ?? DEFAULT_TTFAC_WEIGHT;
    this.minSamples = config?.minSamples ?? DEFAULT_MIN_SAMPLES;
    this.windowSize = config?.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.windowTimeMs = config?.windowTimeMs ?? DEFAULT_WINDOW_TIME_MS;
  }

  /**
   * Record a TTFAC + total latency sample for a provider:model pair.
   * `success` defaults to true; pass false for failed requests so they are
   * excluded from the ranking percentiles (#350).
   */
  record(provider: string, model: string, ttfacMs: number, totalMs: number, success = true): void {
    const key = sampleKey(provider, model);
    let buf = this.buffers.get(key);
    if (!buf) {
      buf = [];
      this.buffers.set(key, buf);
    }

    buf.push({ ttfacMs, totalMs, timestamp: Date.now(), success });

    // Evict overflow (circular buffer — drop oldest)
    while (buf.length > this.windowSize) {
      buf.shift();
    }
  }

  /**
   * Get TTFAC/total stats for a provider:model pair.
   *
   * Percentiles and `sampleCount` are computed over SUCCESSFUL samples only —
   * a fast failure has a meaningless TTFAC (instant reject) and must not pull
   * the p50 down and rank a broken provider first (#350). `samples` recorded
   * without an explicit success flag are treated as successful.
   */
  getStats(provider: string, model: string): TtfacStats {
    const key = sampleKey(provider, model);
    const samples = this.activeSamples(key).filter((s) => s.success !== false);

    if (samples.length === 0) {
      return { ttfacP50: null, ttfacP95: null, totalP50: null, sampleCount: 0 };
    }

    const ttfacSorted = samples.map((s) => s.ttfacMs).sort((a, b) => a - b);
    const totalSorted = samples.map((s) => s.totalMs).sort((a, b) => a - b);

    return {
      ttfacP50: percentile(ttfacSorted, 50),
      ttfacP95: percentile(ttfacSorted, 95),
      totalP50: percentile(totalSorted, 50),
      sampleCount: samples.length,
    };
  }

  /**
   * Reorder fallback entries by blended TTFAC score.
   *
   * - Only entries with >= minSamples are eligible for reordering.
   * - Proven-fast (scored) entries are moved to the FRONT, sorted by blended
   *   score (lower = better). Entries without enough data keep their relative
   *   order behind the scored ones.
   * - Previously, scored entries were pinned to the slots they *already*
   *   occupied, so a proven-fast provider could never overtake a high-priority
   *   unscored entry sitting at index 0 (#351).
   * - Returns a new array (does not mutate the input).
   */
  rankByTtfac(entries: FallbackEntry[]): FallbackEntry[] {
    if (!this.enabled || entries.length <= 1) {
      return [...entries];
    }

    // Compute scores for entries that have enough data
    const scored: Array<{ entry: FallbackEntry; score: number }> = [];
    const unscored: FallbackEntry[] = [];

    for (const entry of entries) {
      const stats = this.getStats(entry.provider, entry.model ?? '*');

      if (stats.sampleCount >= this.minSamples && stats.ttfacP50 !== null && stats.totalP50 !== null) {
        const score = stats.ttfacP50 * this.ttfacWeight + stats.totalP50 * (1 - this.ttfacWeight);
        scored.push({ entry, score });
      } else {
        unscored.push(entry);
      }
    }

    // Sort scored entries by blended score (lower = better) and place them
    // ahead of the unscored (cold) entries, which keep their configured order.
    scored.sort((a, b) => a.score - b.score);

    return [...scored.map((s) => s.entry), ...unscored];
  }

  /**
   * Seed data from benchmark results. Each result is recorded as a sample
   * with the current timestamp. Useful for bootstrapping before live data
   * is available.
   */
  seedFromBenchmark(
    results: Array<{ provider: string; model: string; ttfacMs: number; totalMs: number }>,
  ): void {
    for (const r of results) {
      this.record(r.provider, r.model, r.ttfacMs, r.totalMs);
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  /** Return samples that are within the time window, evicting stale ones. */
  private activeSamples(key: string): TtfacSample[] {
    const buf = this.buffers.get(key);
    if (!buf || buf.length === 0) return [];

    const cutoff = Date.now() - this.windowTimeMs;

    // Remove expired samples from the front (oldest first)
    while (buf.length > 0 && buf[0].timestamp < cutoff) {
      buf.shift();
    }

    // Remove empty buffer keys to prevent unbounded Map growth
    if (buf.length === 0) {
      this.buffers.delete(key);
      return [];
    }

    return buf;
  }
}

/** Default module-level singleton */
export const defaultTtfacTracker = new TtfacTracker();
