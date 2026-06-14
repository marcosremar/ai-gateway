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
  /** Whether the originating request succeeded. Failures are excluded from the
   *  p95 used to derive the timeout (#346). Defaults to true. */
  success?: boolean;
}

/** Cached p95-derived timeout for a key, valid while the buffer is unchanged. */
interface TimeoutCacheEntry {
  /** Buffer length the cached value was computed from (cache invalidation). */
  bufferLen: number;
  /** Computed adaptive timeout (already clamped). */
  timeout: number;
  /** When the value was cached (short max-age guards against window eviction). */
  computedAt: number;
}

/** Max age of a cached p95 timeout before it is recomputed. */
const TIMEOUT_CACHE_TTL_MS = 1_000;

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
  /** Per-key memo of the last computed p95 timeout (hot-path optimization). */
  private timeoutCache = new Map<string, TimeoutCacheEntry>();

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

    const now = Date.now();
    const cutoff = now - this.windowMs;
    const valid: LatencySample[] = [];

    for (let i = buffer.length - 1; i >= 0; i--) {
      if (buffer[i].timestamp >= cutoff) {
        valid.unshift(buffer[i]);
      }
    }

    if (valid.length !== buffer.length) {
      if (valid.length === 0) {
        this.buffers.delete(key);
      } else {
        this.buffers.set(key, valid);
      }
    }

    if (valid.length < this.minSamples) return defaultTimeoutMs;

    // Serve from the memo when the buffer is unchanged and the entry is fresh.
    // getTimeout runs once per provider per request and re-sorts the whole
    // buffer each time; this avoids the repeated sort/allocation (#345).
    const now2 = Date.now();
    const cached = this.timeoutCache.get(key);
    if (cached && cached.bufferLen === valid.length && now2 - cached.computedAt < TIMEOUT_CACHE_TTL_MS) {
      return cached.timeout;
    }

    // Derive the p95 from SUCCESSFUL samples only (#346). A provider that fails
    // fast records a tiny `elapsed`; including those failures pulls the
    // percentile down and starves slow-but-correct retries with too tight a
    // timeout. Fall back to all valid samples if there are too few successes.
    const successOnly = valid.filter((s) => s.success !== false);
    const sampleSet = successOnly.length >= this.minSamples ? successOnly : valid;
    const latencies = sampleSet.map((s) => s.latencyMs).sort((a, b) => a - b);
    const p95 = percentile(latencies, 95);
    const adaptive = Math.round(p95 * this.marginMultiplier);

    const timeout = Math.max(this.minTimeoutMs, Math.min(this.maxTimeoutMs, adaptive));
    this.timeoutCache.set(key, { bufferLen: valid.length, timeout, computedAt: now2 });
    return timeout;
  }

  /**
   * Record a latency observation for a provider+model pair.
   * Uses a circular buffer capped at MAX_BUFFER_SIZE entries.
   *
   * @param success Whether the request succeeded. Pass `false` for failures so
   *   they are excluded from the timeout percentile (#346). Defaults to true.
   */
  record(provider: string, model: string, latencyMs: number, success = true): void {
    const key = bufferKey(provider, model);
    let buffer = this.buffers.get(key);

    const now = Date.now();
    const cutoff = now - this.windowMs;

    if (!buffer) {
      buffer = [];
      this.buffers.set(key, buffer);
    } else {
      const valid: LatencySample[] = [];
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i].timestamp >= cutoff) {
          valid.unshift(buffer[i]);
        }
      }
      buffer.length = 0;
      buffer.push(...valid);
    }

    buffer.push({ latencyMs, timestamp: now, success });

    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
    }

    // A new sample changes the percentile — drop the memo so the next
    // getTimeout recomputes (#345).
    this.timeoutCache.delete(key);
  }

  /**
   * Record a timeout for a provider+model pair (#344).
   *
   * On a timeout the previous code fed `effectiveTimeout` (the ceiling) into the
   * p95 history; because the timeout is derived FROM that p95, recording the cap
   * ratchets future timeouts upward and keeps slow providers in rotation longer
   * (more cost/latency). Instead we record the timeout as a *failure* sample at
   * a penalized fraction of the cap (default 0.75×), so it neither inflates the
   * percentile nor counts as a fast success.
   *
   * @param effectiveTimeoutMs The timeout value that elapsed.
   * @param penaltyFactor Fraction of the cap to record (0–1). Default 0.75.
   */
  recordTimeout(provider: string, model: string, effectiveTimeoutMs: number, penaltyFactor = 0.75): void {
    const clamped = Math.max(0, Math.min(1, penaltyFactor));
    this.record(provider, model, Math.round(effectiveTimeoutMs * clamped), false);
  }

  /** Number of valid (non-expired) samples for a given provider+model. */
  sampleCount(provider: string, model: string): number {
    const key = bufferKey(provider, model);
    const buffer = this.buffers.get(key);
    if (!buffer) return 0;

    const cutoff = Date.now() - this.windowMs;
    let count = 0;
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (buffer[i].timestamp >= cutoff) count++;
    }
    return count;
  }

  /** Clear all recorded samples (useful for testing). */
  clear(): void {
    this.buffers.clear();
    this.timeoutCache.clear();
  }
}
