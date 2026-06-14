/**
 * Predictive Pre-Warm — uses historical usage patterns to proactively boot GPUs.
 *
 * Stores hourly-by-day-of-week bucketed request counts (168 buckets per user).
 * Uses incremental moving average to smooth out spikes.
 *
 * Disabled by default.
 */

import type { StateStore, Logger } from '../../deps';
import type { AutoScalerConfig } from '../../types';
import { defaultLogger } from '../../logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PredictiveWarmupConfig {
  /** Disabled by default */
  enabled: boolean;
  /** How often to check for upcoming demand. Default: 15 min */
  checkIntervalMinutes?: number;
  /** Minimum historical hourly requests to trigger pre-warm. Default: 3 */
  minHourlyRequests?: number;
  /** How many minutes before the predicted demand to boot. Default: 10 */
  leadTimeMinutes?: number;
}

const USAGE_KEY_PREFIX = 'predictive:usage:';

function usageKey(userId: string): string {
  return `${USAGE_KEY_PREFIX}${userId}`;
}

/**
 * Convert a Date to a bucket index (0-167).
 * Bucket = dayOfWeek * 24 + hour
 */
function dateToBucket(date: Date): number {
  return date.getDay() * 24 + date.getHours();
}

// ── Usage recording ───────────────────────────────────────────────────────────

/**
 * Record a request for prediction purposes.
 * Call this fire-and-forget on each request — it increments the
 * current hour-of-week bucket using an incremental moving average.
 */
export async function recordUsageForPrediction(
  stateStore: StateStore,
  userId: string,
  logger?: Logger,
): Promise<void> {
  const log = logger ?? defaultLogger;
  const key = usageKey(userId);
  const bucket = dateToBucket(new Date());
  const field = String(bucket);

  try {
    await stateStore.hincrby(key, field, 1);
  } catch (err) {
    log.warn('[predictive-warmup] Failed to record usage:', err);
  }
}

/**
 * #278 — size the warm count to the forecast instead of always booting tier 0.
 *
 * `triggerBoot` warms only the first tier, so a multi-tier user facing a
 * forecasted spike still cold-starts tiers 1..N. This maps predicted hourly
 * requests to the number of tiers to pre-warm: one tier per `reqsPerTier`
 * predicted requests, clamped to `[1, maxTiers]` (always at least one when a
 * warm is warranted). Returns 0 when there are no tiers.
 */
export function warmCountForForecast(
  predictedRequests: number,
  maxTiers: number,
  reqsPerTier = 5,
): number {
  if (maxTiers <= 0) return 0;
  if (predictedRequests <= 0) return Math.min(1, maxTiers);
  const per = Math.max(1, reqsPerTier);
  const want = Math.ceil(predictedRequests / per);
  return Math.max(1, Math.min(maxTiers, want));
}

/**
 * #277 — ROI gate: skip pre-warm for buckets whose past warms didn't pay off.
 *
 * `runPredictiveWarmupForUser` boots whenever predicted ≥ threshold with no
 * check that the demand actually materialised after previous warms for that
 * hour-of-week bucket. This computes the realized-demand hit-rate
 * (`hits / warms`) and returns false when there's enough history
 * (`warms >= minSamples`) and the hit-rate is below `minHitRate` — so a bucket
 * that consistently warmed a GPU nobody used stops wasting money. With
 * insufficient history we allow the warm (explore) to gather data.
 */
export function shouldWarmGivenRoi(
  warms: number,
  hits: number,
  opts: { minSamples?: number; minHitRate?: number } = {},
): boolean {
  const { minSamples = 4, minHitRate = 0.3 } = opts;
  if (warms < minSamples) return true; // not enough data — explore
  const hitRate = warms > 0 ? hits / warms : 0;
  return hitRate >= minHitRate;
}

// ── Prediction ────────────────────────────────────────────────────────────────

/**
 * Check if a user historically has high usage in the upcoming hour.
 */
export async function shouldPreWarm(
  stateStore: StateStore,
  userId: string,
  config: PredictiveWarmupConfig,
): Promise<{ shouldWarm: boolean; predictedRequests: number; bucket: number }> {
  const leadTimeMinutes = config.leadTimeMinutes ?? 10;
  const minHourlyRequests = config.minHourlyRequests ?? 3;

  // Look at the upcoming bucket (current + lead time offset)
  const futureDate = new Date(Date.now() + leadTimeMinutes * 60_000);
  const bucket = dateToBucket(futureDate);

  try {
    const raw = await stateStore.hgetall(usageKey(userId));
    const predictedRequests = raw[String(bucket)] ? parseFloat(raw[String(bucket)]) : 0;

    return {
      shouldWarm: predictedRequests >= minHourlyRequests,
      predictedRequests,
      bucket,
    };
  } catch {
    return { shouldWarm: false, predictedRequests: 0, bucket };
  }
}

// ── Warmup executor ───────────────────────────────────────────────────────────

export interface PredictiveWarmupDeps {
  stateStore: StateStore;
  /** Boot the first tier for a user. Returns true if boot was triggered. */
  triggerBoot: (userId: string) => Promise<boolean>;
  /** List all user IDs with warmup enabled */
  listWarmupUsers: () => Promise<Array<{ userId: string; config: PredictiveWarmupConfig; autoscalerConfig: AutoScalerConfig }>>;
  logger?: Logger;
}

/**
 * Run one warmup check for a specific user.
 */
export async function runPredictiveWarmupForUser(
  deps: PredictiveWarmupDeps,
  userId: string,
  config: PredictiveWarmupConfig,
): Promise<boolean> {
  const log = deps.logger ?? defaultLogger;
  if (!config.enabled) return false;

  const result = await shouldPreWarm(deps.stateStore, userId, config);
  if (!result.shouldWarm) return false;

  try {
    const booted = await deps.triggerBoot(userId);
    if (booted) {
      log.log(
        `[predictive-warmup] Pre-warmed GPU for user ${userId} ` +
        `(bucket=${result.bucket}, predicted=${result.predictedRequests.toFixed(1)} reqs)`,
      );
    }
    return booted;
  } catch (err) {
    log.warn(`[predictive-warmup] Failed to pre-warm for user ${userId}:`, err);
    return false;
  }
}

/**
 * Start a background ticker that periodically checks all warmup-enabled users.
 * Returns a cleanup function to stop the ticker.
 */
export function startPredictiveWarmupTicker(
  deps: PredictiveWarmupDeps,
  intervalMs: number = 15 * 60_000, // 15 min default
): () => void {
  const log = deps.logger ?? defaultLogger;
  const runCycle = async () => {
    try {
      const users = await deps.listWarmupUsers();
      for (const { userId, config } of users) {
        await runPredictiveWarmupForUser(deps, userId, config);
      }
    } catch (err) {
      log.warn('[predictive-warmup] Cycle failed:', err);
    }
  };

  const interval = setInterval(runCycle, intervalMs);
  if (interval.unref) interval.unref();

  return () => clearInterval(interval);
}
