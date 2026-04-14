/**
 * Boot Timeout — shared helper for handling boot timeout logic.
 *
 * Consolidates the triplicated boot timeout pattern from:
 *   - engine.ts (pre-probe timeout, health probe timeout)
 *   - initTierStatesFromDb (stale boot on load)
 *   - watchdog.ts (stuck booting cleanup)
 */

import type { GpuTierConfig, IdleTierState, BootingTierState } from '../../types';
import type { GpuLifecycleLogEntry } from './lifecycle-logger';
import { MAX_BOOT_FAILURES, BOOT_COOLDOWN_BASE_MS, BOOT_COOLDOWN_MAX_MS } from './engine';

export interface BootTimeoutResult {
  /** The new idle state to replace the booting tier */
  newState: IdleTierState;
  /** Lifecycle log entry for the timeout event */
  logEntry: Omit<GpuLifecycleLogEntry, 'userId'>;
  /** If set, the tier config to pass to cleanupInstance */
  cleanupConfig?: GpuTierConfig;
}

/**
 * Compute the new idle state and log entry when a booting tier times out.
 * Pure function — no side effects; the caller applies the state change and cleanup.
 */
export function handleBootTimeout(
  tierIndex: number,
  ts: BootingTierState,
  tierConfig: GpuTierConfig | undefined,
  maxBootMs: number,
  now: number,
  source: string,
): BootTimeoutResult {
  const elapsed = now - ts.bootTriggeredAt;
  const failCount = ts.prevBootFailCount + 1;
  const cooldownMs = Math.min(
    BOOT_COOLDOWN_BASE_MS * Math.pow(2, Math.min(failCount - 1, 15)),
    BOOT_COOLDOWN_MAX_MS,
  );

  const newState: IdleTierState = {
    state: 'idle',
    tierIndex,
    bootFailCount: failCount,
    cooldownUntil: now + cooldownMs,
    ...(failCount >= MAX_BOOT_FAILURES ? { unhealthy: true } : {}),
  };

  const logEntry: Omit<GpuLifecycleLogEntry, 'userId'> = {
    tierIndex,
    provider: tierConfig?.provider ?? '',
    eventType: 'boot_timeout',
    durationMs: elapsed,
    instanceId: ts.discoveredInstanceId,
    endpoint: ts.endpoint,
    trigger: ts.trigger,
    oldState: 'booting',
    newState: 'idle',
    error: `${source} timeout after ${Math.round(elapsed / 1000)}s (max=${Math.round(maxBootMs / 1000)}s)`,
    metadata: { failCount, unhealthy: failCount >= MAX_BOOT_FAILURES, source },
  };

  let cleanupConfig: GpuTierConfig | undefined;
  if (tierConfig) {
    cleanupConfig = ts.discoveredInstanceId
      ? { ...tierConfig, instanceId: ts.discoveredInstanceId }
      : tierConfig;
  }

  return { newState, logEntry, cleanupConfig };
}
