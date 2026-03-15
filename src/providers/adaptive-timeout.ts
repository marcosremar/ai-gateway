/**
 * Adaptive Timeout Calculator
 *
 * Computes per-provider timeouts based on observed latency history.
 * Uses a lightweight in-memory circular buffer of latency samples,
 * with time-based eviction to stay responsive to changing conditions.
 *
 * Formula: timeout = clamp(p95 * marginMultiplier, minTimeoutMs, maxTimeoutMs)
 * Falls back to the caller-supplied default when insufficient samples exist.
 */

// ─── Configuration ───────────────────────────────────────────────────────────

export interface AdaptiveTimeoutConfig {
  /** Multiplier above p95. Default: 1.5 */
  marginMultiplier?: number;
  /** Absolute minimum timeout in ms. Default: 2_000 */
  minTimeoutMs?: number;
  /** Absolute maximum timeout in ms. Default: 30_000 */
  maxTimeoutMs?: number;
  /** Minimum sample count before adaptive kicks in. Default: 10 */
  minSamples?: number;
  /** Max age of samples in ms. Default: 600_000 (10 min) */
  windowMs?: number;
}

// ─── Internal types ──────────────────────────────────────────────────────────

interface LatencySample {
  latencyMs: number;
  timestamp: number;
}

const DEFAULT_MARGIN_MULTIPLIER = 1.5;
const DEFAULT_MIN_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MIN_SAMPLES = 10;
const DEFAULT_WINDOW_MS = 600_000; // 10 minutes
const MAX_BUFFER_SIZE = 200;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bufferKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/**
 * Compute the p-th percentile from a sorted array of numbers.
 * Uses linear interpolation between adjacent values.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];

  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);

  if (lower === upper) return sorted[lower];

  const fraction = rank - lower;
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

// ─── Main class ──────────────────────────────────────────────────────────────

export class AdaptiveTimeoutCalculator {
  private readonly marginMultiplier: number;
  private readonly minTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly minSamples: number;
  private readonly windowMs: number;

  private buffers = new Map<string, LatencySample[]>();

  constructor(config: AdaptiveTimeoutConfig = {}) {
    this.marginMultiplier = config.marginMultiplier ?? DEFAULT_MARGIN_MULTIPLIER;
    this.minTimeoutMs = config.minTimeoutMs ?? DEFAULT_MIN_TIMEOUT_MS;
    this.maxTimeoutMs = config.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
    this.minSamples = config.minSamples ?? DEFAULT_MIN_SAMPLES;
    this.windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
  }

  /**
   * Compute the adaptive timeout for a provider+model pair.
   * Returns `defaultTimeoutMs` when there are fewer than `minSamples` valid samples.
   */
  getTimeout(provider: string, model: string, defaultTimeoutMs: number): number {
    const key = bufferKey(provider, model);
    const buffer = this.buffers.get(key);

    if (!buffer) return defaultTimeoutMs;

    // Evict stale samples
    const cutoff = Date.now() - this.windowMs;
    const valid = buffer.filter((s) => s.timestamp >= cutoff);

    // Update buffer in-place after eviction
    if (valid.length !== buffer.length) {
      this.buffers.set(key, valid);
    }

    if (valid.length < this.minSamples) return defaultTimeoutMs;

    // Sort for percentile calculation
    const latencies = valid.map((s) => s.latencyMs).sort((a, b) => a - b);
    const p95 = percentile(latencies, 95);
    const adaptive = Math.round(p95 * this.marginMultiplier);

    return Math.max(this.minTimeoutMs, Math.min(this.maxTimeoutMs, adaptive));
  }

  /**
   * Record a successful latency observation for a provider+model pair.
   * Uses a circular buffer capped at MAX_BUFFER_SIZE entries.
   */
  record(provider: string, model: string, latencyMs: number): void {
    const key = bufferKey(provider, model);
    let buffer = this.buffers.get(key);

    if (!buffer) {
      buffer = [];
      this.buffers.set(key, buffer);
    }

    buffer.push({ latencyMs, timestamp: Date.now() });

    // Circular eviction: drop oldest when exceeding capacity
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
    }
  }

  /** Number of valid (non-expired) samples for a given provider+model. */
  sampleCount(provider: string, model: string): number {
    const key = bufferKey(provider, model);
    const buffer = this.buffers.get(key);
    if (!buffer) return 0;

    const cutoff = Date.now() - this.windowMs;
    return buffer.filter((s) => s.timestamp >= cutoff).length;
  }

  /** Clear all recorded samples (useful for testing). */
  clear(): void {
    this.buffers.clear();
  }
}
