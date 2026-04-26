// ── In-memory Metrics & Latency Tracking ────────────────────────────────────
// Global request counters, latency ring buffer, provider metrics.
// Extracted from server/state.ts — Phase 5 DDD migration.

// ── In-memory metrics ───────────────────────────────────────────────────────

export const LATENCY_RING_SIZE = 1000;
export const latencyRing: number[] = [];
export let latencyRingIdx = 0;
export let latencyRingGeneration = 0;
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
let _p95CacheGeneration = 0;
const P95_CACHE_TTL_MS = 5_000;

export function getP95Latency(): number | null {
  if (latencyRing.length < MIN_LATENCY_SAMPLES) return null;
  const now = Date.now();
  // Return cached value if still fresh and no new samples have been recorded
  // (use generation counter instead of length, since the ring buffer overwrites
  // in place without changing length once full)
  if (_p95Cache !== null && now - _p95CacheTime < P95_CACHE_TTL_MS && _p95CacheGeneration === latencyRingGeneration) {
    return _p95Cache;
  }
  const sorted = [...latencyRing].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  _p95Cache = sorted[Math.max(0, idx)];
  _p95CacheTime = now;
  _p95CacheGeneration = latencyRingGeneration;
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
  latencyRingGeneration++;
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

// ── Latency trend detection ─────────────────────────────────────────────────

const TREND_MIN_SAMPLES = 20;

/**
 * Compute linear regression slope on the latency ring buffer.
 * Returns trend based on whether recent half is >20% different from first half.
 */
export function getLatencyTrend(): { trend: 'stable' | 'degrading' | 'improving'; slopeMs: number; samples: number } {
  const n = latencyRing.length;
  if (n < TREND_MIN_SAMPLES) {
    return { trend: 'stable', slopeMs: 0, samples: n };
  }

  // Unwrap the ring buffer into chronological order (oldest first).
  // When the ring is full, latencyRingIdx points to the oldest entry.
  // When not full, the array is already in order and idx == 0.
  let chronological: number[];
  if (n < LATENCY_RING_SIZE) {
    // Ring hasn't wrapped — array is already in order
    chronological = latencyRing;
  } else {
    // Ring has wrapped: entries [idx..n-1] are oldest, [0..idx-1] are newest
    chronological = [
      ...latencyRing.slice(latencyRingIdx),
      ...latencyRing.slice(0, latencyRingIdx),
    ];
  }

  const half = Math.floor(n / 2);
  const firstHalf = chronological.slice(0, half);
  const secondHalf = chronological.slice(half);

  const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

  const changePct = firstAvg === 0 ? 0 : (secondAvg - firstAvg) / firstAvg;

  // Simple linear regression for slopeMs (ms per sample)
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += chronological[i];
    sumXY += i * chronological[i];
    sumXX += i * i;
  }
  const slopeMs = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);

  if (Math.abs(changePct) < 0.2) {
    return { trend: 'stable', slopeMs, samples: n };
  }
  return { trend: changePct > 0 ? 'degrading' : 'improving', slopeMs, samples: n };
}

// ── Setters ─────────────────────────────────────────────────────────────────

export function setLatencyRingIdx(v: number) { latencyRingIdx = v; }
export function setPendingDbWrites(v: number) { pendingDbWrites = v; }
export function setConsecutiveDbFailures(v: number) { consecutiveDbFailures = v; }
