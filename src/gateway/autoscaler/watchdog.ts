import type { AutoScalerConfig } from '../../types';
import type { IdleTierState, BootingTierState } from '../../types';
import type { AutoscalerEngine } from './engine';
import type { SessionTracker } from './session-tracker';
import type { StatePersistence } from './state-persistence';
import type { GpuProviderRegistry } from '../providers/gpu/registry';
import type { GatewayHooks } from '../../hooks';
import type { GpuLifecycleLogger } from './lifecycle-logger';
import type { Logger } from '../../deps';
import { fileLifecycleLogger } from './file-lifecycle-logger';
import { emitHook } from '../../hooks';
import { cleanupProviderInstance } from './cleanup';
import { handleBootTimeout } from './boot-timeout';
import { defaultLogger } from '../../logger';

/** Rate-limit per-user watchdog to 2 min */
const WATCHDOG_INTERVAL_MS = parseInt(process.env.WATCHDOG_INTERVAL_MS || String(2 * 60 * 1000), 10);

/**
 * Dependencies required by the watchdog functions.
 *
 * The watchdog iterates over users with active GPU state and stops idle
 * tiers. It needs access to the autoscaler engine, session tracker,
 * persistence layer, and GPU provider registry.
 */
export interface WatchdogDeps {
  /** The autoscaler engine that manages tier states */
  engine: AutoscalerEngine;
  /** Tracks active sessions per user */
  sessionTracker: SessionTracker;
  /** Persists tier state to durable storage */
  persistence: StatePersistence;
  /** Registry of GPU provider clients */
  registry: GpuProviderRegistry;
  /** Load config for a given user. Provided by host app. */
  loadConfig: (userId: string) => Promise<AutoScalerConfig | null>;
  /** Gateway hooks for scale-down events */
  hooks?: GatewayHooks;
  /** Persistent lifecycle logger */
  lifecycleLogger?: GpuLifecycleLogger;
  /** Logger for structured output */
  logger?: Logger;
}

/**
 * Run one complete watchdog cycle.
 *
 * Iterates all users with active GPU state and stops idle tiers. On the
 * first call, preloads from the database to catch orphaned GPUs. Also
 * evicts idle users to prevent unbounded state map growth.
 *
 * Designed to be called from an external cron job or via `startBackgroundTicker`.
 *
 * @param deps - Watchdog dependencies (engine, session tracker, persistence, etc.)
 *
 * @example
 * ```typescript
 * // Run as a one-off cycle
 * await runWatchdogCycle({ engine, sessionTracker, persistence, registry, loadConfig });
 *
 * // Or set up a background ticker
 * const stop = startBackgroundTicker(deps);
 * // ... later: stop();
 * ```
 */
export async function runWatchdogCycle(deps: WatchdogDeps): Promise<void> {
  const { engine, persistence, loadConfig } = deps;
  const log = deps.logger ?? defaultLogger;
  const stateMap = engine.getStateMap();

  // On first call, preload from DB to catch orphaned GPUs
  const activeUserIds = await persistence.findUsersWithActiveGpus();
  for (const userId of activeUserIds) {
    if (stateMap.has(userId)) continue;
    const config = await loadConfig(userId);
    if (!config?.tiers?.length) continue;
    await engine.initTierStatesFromDb(userId, config.tiers);
  }

  // Evict idle users to prevent unbounded stateMap growth
  engine.evictIdleUsers();

  // Iterate all users with active state
  for (const [userId, tierStates] of stateMap) {
    const hasActive = tierStates.some(
      (ts) => ts.state === 'ready' || ts.state === 'booting',
    );
    if (!hasActive) continue;

    try {
      const config = await loadConfig(userId);
      if (!config) continue;
      await runWatchdogForUser(deps, userId, config);
    } catch (err) {
      log.warn('[watchdog] failed for user', userId, err);
      emitHook(deps.hooks, 'onError', {
        source: 'watchdog', userId, operation: 'runWatchdogForUser',
        message: err instanceof Error ? err.message : String(err),
        retryable: true, timestamp: Date.now(),
      });
    }
  }
}

/**
 * Schedule a rate-limited per-user watchdog run.
 *
 * Runs the watchdog for a specific user, but only if the cooldown interval
 * has elapsed since the last run for that user. The actual work happens
 * asynchronously (fire-and-forget).
 *
 * @param deps - Watchdog dependencies
 * @param userId - User whose GPU tiers should be checked
 * @param config - User's autoscaler configuration
 * @param lastWatchdogMap - Map tracking the last run time per user (shared across calls)
 *
 * @example
 * ```typescript
 * const lastRunMap = new Map<string, number>();
 *
 * // Called from a request handler
 * scheduleWatchdog(deps, userId, config, lastRunMap);
 * // Runs at most once every 2 minutes per user
 * ```
 */
export function scheduleWatchdog(
  deps: WatchdogDeps,
  userId: string,
  config: AutoScalerConfig,
  lastWatchdogMap: Map<string, number>,
): void {
  const last = lastWatchdogMap.get(userId) ?? 0;
  if (Date.now() - last < WATCHDOG_INTERVAL_MS) return;
  lastWatchdogMap.set(userId, Date.now());
  const log = deps.logger ?? defaultLogger;
  void runWatchdogForUser(deps, userId, config).catch((err) =>
    log.warn('[watchdog] failed:', err),
  );
}

/**
 * Start a background ticker that runs `runWatchdogCycle` at a fixed interval.
 *
 * Useful for long-running processes that want `setInterval`-style periodic
 * execution without an external cron scheduler. The returned cleanup
 * function stops the timer.
 *
 * @param deps - Watchdog dependencies
 * @param intervalMs - Interval between cycles in milliseconds (default: 2 minutes, or `WATCHDOG_INTERVAL_MS` env var)
 * @returns A cleanup function to stop the ticker
 *
 * @example
 * ```typescript
 * // Start the ticker
 * const stopTicker = startBackgroundTicker(deps);
 *
 * // Or with a custom interval (every 30 seconds)
 * const stop = startBackgroundTicker(deps, 30_000);
 *
 * // Stop when shutting down
 * process.on('SIGTERM', () => {
 *   stopTicker();
 * });
 * ```
 */
export function startBackgroundTicker(deps: WatchdogDeps, intervalMs: number = WATCHDOG_INTERVAL_MS): () => void {
  const log = deps.logger ?? defaultLogger;
  const interval = setInterval(() => {
    void runWatchdogCycle(deps).catch((err) =>
      log.warn('[watchdog-bg] cycle failed:', err),
    );
  }, intervalMs);
  if (interval.unref) interval.unref();
  return () => clearInterval(interval);
}

async function runWatchdogForUser(
  deps: WatchdogDeps,
  userId: string,
  config: AutoScalerConfig,
): Promise<void> {
  const { engine, sessionTracker, persistence, registry, hooks } = deps;
  const logger = deps.lifecycleLogger ?? fileLifecycleLogger;
  const log = deps.logger ?? defaultLogger;

  // Wait for any in-flight engine decision before mutating tier state.
  // Without this, watchdog can race the engine: e.g., engine decides "I need
  // tier 1, boot it" and starts the boot, while watchdog (running concurrently)
  // sees tier 0 as idle and stops it — leaving the user with NO ready tiers
  // mid-decision. The persistence layer eventually corrects it, but the window
  // is observable as a brief outage.
  if (engine.isDecisionInFlight(userId)) {
    log.log(`[watchdog] User ${userId}: decision in flight, awaiting before sweep`);
    await engine.waitForDecision(userId);
  }

  const stateMap = engine.getStateMap();
  const tierStates = stateMap.get(userId) ?? [];
  if (tierStates.length === 0) return;

  const prevStates = tierStates.map((ts) => ts.state);

  const activeSessions = await sessionTracker.countActiveSessions(userId, config.windowMinutes);
  const th = Math.max(config.threshold, 1);
  const totalTiers = config.tiers.length;

  const neededTiers =
    activeSessions >= th
      ? Math.min(1 + Math.floor((activeSessions - th) / th), totalTiers)
      : 0;

  const idleGraceMs = (config.idleGraceMinutes ?? 8) * 60_000;
  const now = Date.now();

  for (let i = totalTiers - 1; i >= neededTiers; i--) {
    const ts = tierStates[i];
    if (!ts || ts.state !== 'ready') continue;

    // Never shut down tiers marked as alwaysActive
    const tierConfig = config.tiers[i];
    if (tierConfig?.alwaysActive) continue;

    const idleMs = now - ts.lastHealthyAt;
    if (idleMs < idleGraceMs) continue;

    if (!tierConfig?.apiKey || !tierConfig?.instanceId) {
      tierStates[i] = { state: 'idle', tierIndex: i } satisfies IdleTierState;
      continue;
    }

    const client = registry.get(tierConfig.provider);
    if (!client) {
      tierStates[i] = { state: 'idle', tierIndex: i } satisfies IdleTierState;
      continue;
    }

    try {
      await client.stopInstance(tierConfig.instanceId, {
        apiKey: tierConfig.apiKey,
        authId: tierConfig.authId,
      });
      tierStates[i] = { state: 'idle', tierIndex: i } satisfies IdleTierState;
      const idleMinutes = Math.round(idleMs / 60000);
      log.log(`[watchdog] Stopped idle GPU tier ${i} (${tierConfig.provider}) after ${idleMinutes}min`);
      emitHook(hooks, 'onScaleDown', {
        userId, tierIndex: i, provider: tierConfig.provider,
        reason: 'idle', idleMinutes, timestamp: Date.now(),
      });
      void logger.log({
        userId, tierIndex: i, provider: tierConfig.provider,
        eventType: 'scale_down', trigger: 'idle',
        instanceId: tierConfig.instanceId,
        endpoint: ts.endpoint,
        oldState: 'ready', newState: 'idle',
        metadata: { idleMinutes, activeSessions },
      });
    } catch (err) {
      log.warn(`[watchdog] Failed to stop tier ${i}:`, err);
      emitHook(hooks, 'onError', {
        source: 'watchdog', userId, tierIndex: i, provider: tierConfig.provider,
        instanceId: tierConfig.instanceId,
        operation: 'stopTier', message: err instanceof Error ? err.message : String(err),
        retryable: true, timestamp: Date.now(),
      });
    }
  }

  // ── Cleanup tiers stuck in 'booting' for too long ──
  // Use provider-specific boot time * 2 (matching engine logic) instead of hardcoded 15 min
  const DEFAULT_MAX_BOOT_MS = 30 * 60_000; // 30 min absolute fallback
  for (let i = 0; i < totalTiers; i++) {
    const ts = tierStates[i];
    if (!ts || ts.state !== 'booting') continue;

    const booting = ts as BootingTierState;
    const bootingMs = now - booting.bootTriggeredAt;
    const tierProvider = config.tiers[i]?.provider ?? '';
    const providerBootSecs = registry.get(tierProvider)?.bootTimeSecs ?? 120;
    const maxBootMs = providerBootSecs > 0 ? providerBootSecs * 2 * 1000 : DEFAULT_MAX_BOOT_MS;
    if (bootingMs < maxBootMs) continue;

    log.warn(`[watchdog] Tier ${i} stuck booting for ${Math.round(bootingMs / 1000)}s, forcing cleanup`);

    const tierConfig = config.tiers[i];
    if (tierConfig) {
      await cleanupProviderInstance(tierConfig, registry, `stuck booting tier ${i} (${Math.round(bootingMs / 1000)}s)`);
    }

    // Route through the shared boot-timeout helper (same path engine.ts and
    // health-checker.ts use) so a stuck boot gets an exponential cooldown and
    // only flips the tier to `unhealthy` once failCount >= MAX_BOOT_FAILURES.
    // The previous inline state hard-coded `unhealthy: true` on the FIRST stuck
    // boot and set no cooldownUntil, which permanently removed the tier from
    // autoscaling (tier-selector skips unhealthy tiers) until a gateway restart.
    const { newState, logEntry } = handleBootTimeout(i, booting, tierConfig, maxBootMs, now, 'watchdog');
    tierStates[i] = newState;

    void logger.log({ userId, ...logEntry });
  }

  const changed = tierStates.some((ts, i) => ts.state !== prevStates[i]);
  if (changed) {
    void persistence.persistTierStates(userId, tierStates).catch((err) => {
      log.warn('[watchdog] Background persist failed:', err);
      emitHook(hooks, 'onError', {
        source: 'watchdog', userId, operation: 'persistTierStates',
        message: err instanceof Error ? err.message : String(err),
        errorCode: 'PERSIST_FAILED', retryable: true, timestamp: Date.now(),
      });
    });
  }
}
