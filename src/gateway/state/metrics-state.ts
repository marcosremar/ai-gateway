// ── In-memory Metrics & Latency Tracking ────────────────────────────────────
// Global request counters, latency ring buffer, provider metrics.
// Extracted from server/state.ts — Phase 5 DDD migration.

// ── In-memory metrics ───────────────────────────────────────────────────────

export const LATENCY_RING_SIZE = 1000;
export const latencyRing: number[] = [];
export let latencyRingIdx = 0;
export const metricsCounters = {
  requestsTotal: 0,
  errorsTotal: 0,
  dbLogFailures: 0,
  byStage: {} as Record<string, number>,
  byProvider: {} as Record<string, number>,
  totalInputTokens: 0,
  totalOutputTokens: 0,
};

export let pendingDbWrites = 0;
export let consecutiveDbFailures = 0;
export const DB_FAILURE_WARN_THRESHOLD = 10;

// ── Provider performance metrics ─────────────────────────────────────────────

export const providerMetrics: Record<string, {
  requests: number; totalLatencyMs: number; errors: number;
  inputTokens: number; outputTokens: number;
}> = {};

// ── Latency-based GPU routing ───────────────────────────────────────────────

/** P95 latency threshold: if GPU P95 exceeds this, prefer cloud providers. */
const GPU_P95_THRESHOLD_MS = 3_000;
/** Minimum samples before latency-based routing kicks in. */
const MIN_LATENCY_SAMPLES = 5;

/**
 * Compute P95 latency from the latency ring buffer.
 * Returns null if not enough samples.
 * Cached for 5s to avoid O(n log n) sort on every request.
 */
let _p95Cache: number | null = null;
let _p95CacheTime = 0;
let _p95CacheSampleCount = 0;
const P95_CACHE_TTL_MS = 5_000;

export function getP95Latency(): number | null {
  if (latencyRing.length < MIN_LATENCY_SAMPLES) return null;
  const now = Date.now();
  // Return cached value if still fresh and sample count hasn't changed
  if (_p95Cache !== null && now - _p95CacheTime < P95_CACHE_TTL_MS && _p95CacheSampleCount === latencyRing.length) {
    return _p95Cache;
  }
  const sorted = [...latencyRing].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  _p95Cache = sorted[Math.max(0, idx)];
  _p95CacheTime = now;
  _p95CacheSampleCount = latencyRing.length;
  return _p95Cache;
}

/**
 * Record a GPU request latency sample.
 */
export function recordGpuLatency(ms: number): void {
  if (latencyRing.length < LATENCY_RING_SIZE) {
    latencyRing.push(ms);
  } else {
    latencyRing[latencyRingIdx] = ms;
    setLatencyRingIdx((latencyRingIdx + 1) % LATENCY_RING_SIZE);
  }
}

/**
 * Whether GPU should be preferred over cloud based on recent latency.
 * Returns true if: GPU is available AND (not enough data OR P95 is under threshold).
 */
export function isGpuLatencyAcceptable(): boolean {
  const p95 = getP95Latency();
  if (p95 === null) return true; // not enough data — give GPU a chance
  return p95 < GPU_P95_THRESHOLD_MS;
}

// ── Setters ─────────────────────────────────────────────────────────────────

export function setLatencyRingIdx(v: number) { latencyRingIdx = v; }
export function setPendingDbWrites(v: number) { pendingDbWrites = v; }
export function setConsecutiveDbFailures(v: number) { consecutiveDbFailures = v; }
