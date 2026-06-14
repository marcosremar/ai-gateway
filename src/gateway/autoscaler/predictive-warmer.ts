// ── Predictive EWMA pre-warmer ────────────────────────────────────────────
//
// Tracks per-minute request counts in a 60-slot ring buffer, forecasts demand
// over the next `forecastWindowMin` minutes using an EWMA over the most
// recent 10 buckets, and nudges the pool manager to scale up when forecast
// exceeds current capacity. The warmer never scales down — cool-off is the
// pool manager's job (idle TTL + maxStandby caps).
//
// This is an autoscaler input, not an autoscaler: `getCapacity` / `ensureCapacity`
// are callbacks the caller wires to the standby-pool or its adapter.

export interface WarmerConfig {
  /** EWMA smoothing factor. Lower = smoother, higher = more responsive. */
  alpha?: number;
  /** How many minutes ahead the forecast covers. */
  forecastWindowMin?: number;
  /** Safety multiplier applied to the raw forecast before comparison. */
  safetyMargin?: number;
  /** Tick interval in ms. */
  tickMs?: number;
}

const DEFAULT_CFG: Required<WarmerConfig> = {
  alpha: 0.3,
  forecastWindowMin: 5,
  safetyMargin: 1.2,
  tickMs: 30_000,
};

const BUCKET_COUNT = 60;
const BUCKET_MS = 60_000;
const EWMA_WINDOW = 10;

/** One-minute request counters. Circular buffer keyed by bucket index. */
const buckets: number[] = new Array(BUCKET_COUNT).fill(0);
/** Epoch-ms of the bucket currently at index `cursor`. */
let bucketEpoch: number[] = new Array(BUCKET_COUNT).fill(0);
let cfg: Required<WarmerConfig> = { ...DEFAULT_CFG };
let tickTimer: ReturnType<typeof setInterval> | null = null;

function bucketIndex(timestampMs: number): number {
  return Math.floor(timestampMs / BUCKET_MS) % BUCKET_COUNT;
}

/** Record one request hit. Defaults to Date.now(). */
export function recordRequest(timestampMs: number = Date.now()): void {
  const idx = bucketIndex(timestampMs);
  const minuteStart = Math.floor(timestampMs / BUCKET_MS) * BUCKET_MS;
  if (bucketEpoch[idx] !== minuteStart) {
    buckets[idx] = 0;
    bucketEpoch[idx] = minuteStart;
  }
  buckets[idx]++;
}

/** Return the EWMA over the last EWMA_WINDOW whole minutes. */
export function currentEwma(now: number = Date.now()): number {
  const currentMinute = Math.floor(now / BUCKET_MS);
  let ewma = 0;
  let initialized = false;
  // Walk oldest → newest so each step weights fresher samples more heavily.
  for (let offset = EWMA_WINDOW; offset >= 1; offset--) {
    const minute = currentMinute - offset;
    const idx = ((minute % BUCKET_COUNT) + BUCKET_COUNT) % BUCKET_COUNT;
    const minuteStart = minute * BUCKET_MS;
    const value = bucketEpoch[idx] === minuteStart ? buckets[idx] : 0;
    if (!initialized) {
      ewma = value;
      initialized = true;
    } else {
      ewma = cfg.alpha * value + (1 - cfg.alpha) * ewma;
    }
  }
  return ewma;
}

/**
 * Forecast request count for the upcoming forecastWindowMin minutes.
 * Simple projection: EWMA extrapolated over the window, with safety margin
 * applied. Returned as a real number; callers ceil when sizing pools.
 */
export function forecastNext(now: number = Date.now()): number {
  const ewma = currentEwma(now);
  return ewma * cfg.forecastWindowMin * cfg.safetyMargin;
}

/**
 * #280 — asymmetric safety margin instead of a flat 20% over-provision.
 *
 * `safetyMargin=1.2` always pads the forecast by 20%, over-provisioning even
 * when GPUs are expensive. This makes the margin a function of the trade-off:
 * a *lower* margin when the GPU is expensive (over-provisioning costs more) and
 * a *higher* margin when a cold start is catastrophic (under-provisioning costs
 * more in latency). Returns a multiplier in `[minMargin, maxMargin]`.
 *
 * @param gpuExpensiveness 0..1, higher = more expensive GPU (pulls margin down).
 * @param coldStartSeverity 0..1, higher = worse to cold-start (pulls margin up).
 */
export function adaptiveSafetyMargin(
  gpuExpensiveness: number,
  coldStartSeverity: number,
  opts: { minMargin?: number; maxMargin?: number; base?: number } = {},
): number {
  const { minMargin = 1.0, maxMargin = 1.5, base = 1.2 } = opts;
  const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
  const exp = clamp01(gpuExpensiveness);
  const cold = clamp01(coldStartSeverity);
  // Each lever moves the margin up to ±0.25 from the base; cold-start pushes up,
  // expensiveness pushes down.
  const margin = base + cold * 0.25 - exp * 0.25;
  return Math.min(maxMargin, Math.max(minMargin, margin));
}

/**
 * #279 — bidirectional capacity recommendation from a forecast.
 *
 * The warmer's tick only ever scales *up* (relies on the pool's idle TTL to
 * cool off), so a transient spike over-provisions and then sits warm for the
 * whole TTL. This pure helper lets the caller also act on a *dropped*
 * forecast: it returns `'down'` when the forecast target (incl. its own
 * hysteresis margin) is well below current capacity, `'up'` when above, and
 * `'hold'` otherwise. `scaleDownMargin` (default 0.5) requires the forecast to
 * fall to ≤50% of capacity before recommending scale-down, so we don't
 * flap around the boundary.
 */
export function forecastVsCapacity(
  forecastTarget: number,
  capacity: number,
  opts: { scaleDownMargin?: number } = {},
): 'up' | 'down' | 'hold' {
  const target = Math.ceil(forecastTarget);
  if (target > capacity) return 'up';
  const scaleDownMargin = opts.scaleDownMargin ?? 0.5;
  if (capacity > 0 && target <= Math.floor(capacity * scaleDownMargin)) return 'down';
  return 'hold';
}

/**
 * Start the predictive loop. `getCapacity` returns the current number of
 * warm slots; `ensureCapacity` is called with the forecast target whenever
 * forecast exceeds capacity. Idempotent: no effect if the target is already
 * met (the caller's ensureCapacity is expected to be idempotent too).
 */
export function startPredictiveWarmer(
  getCapacity: () => number,
  ensureCapacity: (target: number) => Promise<void>,
  userCfg?: WarmerConfig,
): void {
  cfg = { ...DEFAULT_CFG, ...userCfg };
  stopPredictiveWarmer();
  tickTimer = setInterval(() => {
    const forecast = forecastNext();
    const target = Math.ceil(forecast);
    const capacity = getCapacity();
    if (target > capacity) {
      ensureCapacity(target).catch(() => {});
    }
  }, cfg.tickMs);
  // unref so the warmer tick never pins the event loop on shutdown
  // (matches predictive-warmup.ts which already unrefs its ticker).
  if (tickTimer.unref) tickTimer.unref();
}

/** Stop the predictive loop. Safe to call repeatedly. */
export function stopPredictiveWarmer(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

/** Test helper — wipe counters and config back to defaults. */
export function _resetPredictiveWarmerForTests(): void {
  stopPredictiveWarmer();
  buckets.fill(0);
  bucketEpoch.fill(0);
  cfg = { ...DEFAULT_CFG };
}
