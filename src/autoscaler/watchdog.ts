import type { AutoScalerConfig } from '../types';
import type { IdleTierState, BootingTierState } from '../types';
import type { AutoscalerEngine } from './engine';
import type { SessionTracker } from './session-tracker';
import type { StatePersistence } from './state-persistence';
import type { GpuProviderRegistry } from '../gpu-providers/registry';
import type { GatewayHooks } from '../hooks';
import type { GpuLifecycleLogger } from './lifecycle-logger';
import type { Logger } from '../deps';
import { noopLifecycleLogger } from './lifecycle-logger';
import { emitHook } from '../hooks';
import { cleanupProviderInstance } from './cleanup';
import { defaultLogger } from '../logger';

/** Rate-limit per-user watchdog to 2 min */
const WATCHDOG_INTERVAL_MS = 2 * 60 * 1000;

export interface WatchdogDeps {
  engine: AutoscalerEngine;
  sessionTracker: SessionTracker;
  persistence: StatePersistence;
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
 * Pure function: run one watchdog cycle.
 * Iterates all users with active GPU state and stops idle tiers.
 * Designed to be called from an external cron job or background ticker.
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
    }
  }
}

/**
 * Rate-limited per-user watchdog trigger (called from request handlers).
 * Returns whether the watchdog actually ran.
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
 * Optionally start a background ticker that calls runWatchdogCycle periodically.
 * For apps that still want setInterval behavior (e.g., long-running processes).
 * Returns a cleanup function to stop the ticker.
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
  const logger = deps.lifecycleLogger ?? noopLifecycleLogger;
  const log = deps.logger ?? defaultLogger;
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

  const idleGraceMs = (config.idleGraceMinutes ?? 15) * 60_000;
  const now = Date.now();

  for (let i = totalTiers - 1; i >= neededTiers; i--) {
    const ts = tierStates[i];
    if (!ts || ts.state !== 'ready') continue;

    const idleMs = now - ts.lastHealthyAt;
    if (idleMs < idleGraceMs) continue;

    const tierConfig = config.tiers[i];
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

    const failCount = booting.prevBootFailCount + 1;
    const newIdle: IdleTierState = {
      state: 'idle',
      tierIndex: i,
      bootFailCount: failCount,
      unhealthy: true,
    };
    tierStates[i] = newIdle;

    void logger.log({
      userId, tierIndex: i, provider: tierProvider,
      eventType: 'boot_timeout', durationMs: bootingMs,
      instanceId: booting.discoveredInstanceId,
      endpoint: booting.endpoint, trigger: booting.trigger,
      oldState: 'booting', newState: 'idle',
      error: `Watchdog: stuck booting for ${Math.round(bootingMs / 1000)}s`,
      metadata: { failCount, unhealthy: true, source: 'watchdog' },
    });
  }

  const changed = tierStates.some((ts, i) => ts.state !== prevStates[i]);
  if (changed) {
    void persistence.persistTierStates(userId, tierStates).catch((err) =>
      log.warn('[watchdog] Background persist failed:', err),
    );
  }
}
