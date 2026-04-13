/**
 * Predictive Pre-Warm — uses historical usage patterns to proactively boot GPUs.
 *
 * Stores hourly-by-day-of-week bucketed request counts (168 buckets per user).
 * Uses incremental moving average to smooth out spikes.
 *
 * Disabled by default.
 */

import type { StateStore, Logger } from '../deps';
import type { AutoScalerConfig } from '../types';
import { defaultLogger } from '../logger';

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

// 168 = 7 days * 24 hours
const TOTAL_BUCKETS = 168;
const USAGE_KEY_PREFIX = 'predictive:usage:';
const USAGE_TTL_SECS = 30 * 24 * 60 * 60; // 30 days

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
