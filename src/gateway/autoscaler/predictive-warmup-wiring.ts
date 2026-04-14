/**
 * Predictive warmup wiring — connects the existing predictive-warmup.ts
 * module to the autoscaler engine.
 *
 * Call `initPredictiveWarmup(deps)` once at server startup to begin the
 * background ticker. Call `recordRequest(userId)` on each API request to
 * build the usage pattern database.
 *
 * This module was created because the predictive-warmup engine existed
 * but was never wired into any server entry point. The engine, ticker,
 * and prediction logic are all implemented — this file just connects
 * the dots.
 */

import type { StateStore, Logger } from '../../deps';
import {
  startPredictiveWarmupTicker,
  recordUsageForPrediction,
  type PredictiveWarmupDeps,
} from './predictive-warmup';
import { createLogger } from '../../logger';

const log = createLogger('predictive-warmup');

let cleanup: (() => void) | null = null;
let stateStoreRef: StateStore | null = null;

/**
 * Initialize the predictive warmup background ticker.
 * Call once at server startup.
 *
 * @param deps.stateStore KV store for usage pattern persistence
 * @param deps.triggerBoot Function to boot the first GPU tier for a user
 * @param deps.listWarmupUsers Function to list users with warmup enabled
 * @param intervalMs Check interval (default: 15 min)
 * @returns Cleanup function to stop the ticker
 */
export function initPredictiveWarmup(deps: PredictiveWarmupDeps, intervalMs?: number): () => void {
  if (cleanup) {
    log.warn('Predictive warmup already initialized — stopping previous ticker');
    cleanup();
  }

  stateStoreRef = deps.stateStore;
  cleanup = startPredictiveWarmupTicker(deps, intervalMs);
  log.log({ intervalMs: intervalMs ?? 15 * 60_000 }, 'Predictive warmup ticker started');
  return cleanup;
}

/**
 * Record a request for usage prediction. Call on every API request that
 * touches GPU-relevant endpoints (speech, transcribe, chat).
 * No-op if state store is not configured.
 */
export async function recordRequest(userId: string): Promise<void> {
  if (!stateStoreRef) return;
  await recordUsageForPrediction(stateStoreRef, userId, log);
}

/**
 * Stop the ticker and clean up resources.
 */
export function stopPredictiveWarmup(): void {
  if (cleanup) {
    cleanup();
    cleanup = null;
    stateStoreRef = null;
    log.log({}, 'Predictive warmup ticker stopped');
  }
}
