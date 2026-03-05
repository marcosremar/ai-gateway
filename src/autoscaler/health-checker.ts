/**
 * Health Checker — probes non-idle tiers and processes results.
 *
 * Extracted from engine.ts Step 1 (health probing + result processing).
 */

import type {
  GpuTierConfig,
  GpuTierState,
  IdleTierState,
  BootingTierState,
  ReadyTierState,
} from '../types';
import type { GpuProviderRegistry } from '../gpu-providers/registry';
import type { GatewayHooks } from '../hooks';
import type { GpuLifecycleLogger } from './lifecycle-logger';
import type { Logger } from '../deps';
import { emitHook } from '../hooks';
import { handleBootTimeout } from './boot-timeout';

export interface HealthCheckResult {
  tierIndex: number;
  healthy: boolean;
}

/**
 * Probe health of all non-idle tiers in parallel.
 * Falls back to SSH health check for tiers with sshHost/sshPort (Vast.ai without direct ports).
 * Falls back to monitor endpoint for TensorDock tiers where the app isn't ready
 * but the monitor reports setup is in progress (keeps boot timer alive).
 */
export async function probeAllTiers(
  tierStates: GpuTierState[],
  probeHealth: (endpoint: string) => Promise<boolean>,
  tierConfigs?: GpuTierConfig[],
  registry?: GpuProviderRegistry,
): Promise<HealthCheckResult[]> {
  const checks = tierStates
    .filter((ts): ts is BootingTierState | ReadyTierState => ts.state !== 'idle')
    .map(async (ts) => {
      let healthy = await probeHealth(ts.endpoint);
      // SSH fallback for Vast.ai instances without direct port access
      if (!healthy && ts.sshHost && ts.sshPort) {
        const { probeGpuHealthSsh } = await import('./health');
        healthy = await probeGpuHealthSsh(ts.sshHost, ts.sshPort);
      }
      // Monitor fallback for providers with checkHealth (e.g. TensorDock).
      // When the app isn't ready but the monitor reports a non-failed phase,
      // we return false (not healthy yet) but DON'T trigger a boot timeout —
      // the monitor proves the VM is alive and setting up.
      // Note: we don't set healthy=true here; the app must pass the real health
      // check. But we use `monitorAlive` to inform processHealthResults.
      if (!healthy && ts.state === 'booting' && tierConfigs && registry) {
        const tierConfig = tierConfigs[ts.tierIndex];
        if (tierConfig) {
          const client = registry.get(tierConfig.provider);
          if (client?.checkHealth && ts.discoveredInstanceId) {
            try {
              const monitorHealthy = await client.checkHealth(
                ts.discoveredInstanceId,
                { apiKey: tierConfig.apiKey!, authId: tierConfig.authId },
              );
              if (monitorHealthy) {
                healthy = true;
              }
            } catch {
              // Monitor unreachable — no-op
            }
          }
        }
      }
      return { tierIndex: ts.tierIndex, healthy };
    });

  return Promise.all(checks);
}

export interface ProcessHealthOpts {
  cleanupInstance: (config: GpuTierConfig, registry: GpuProviderRegistry, reason: string) => Promise<void>;
  lifecycleLogger: GpuLifecycleLogger;
  hooks?: GatewayHooks;
  logger: Logger;
}

/**
 * Process health check results — mutates tierStates in place.
 * Transitions booting→ready on healthy, booting→idle on timeout,
 * ready→idle on unhealthy, and refreshes lastHealthyAt on ready+healthy.
 */
export function processHealthResults(
  userId: string,
  tierStates: GpuTierState[],
  tiers: GpuTierConfig[],
  healthResults: HealthCheckResult[],
  registry: GpuProviderRegistry,
  opts: ProcessHealthOpts,
): void {
  const { cleanupInstance, lifecycleLogger, hooks, logger } = opts;

  for (const { tierIndex, healthy } of healthResults) {
    const ts = tierStates[tierIndex];
    if (!ts) continue;

    if (ts.state === 'booting' && healthy) {
      // Boot succeeded — transition to ready
      const bootDurationMs = Date.now() - ts.bootTriggeredAt;
      const newReady: ReadyTierState = {
        state: 'ready',
        tierIndex: ts.tierIndex,
        endpoint: ts.endpoint,
        lastHealthyAt: Date.now(),
        trigger: ts.trigger,
        bootedAt: ts.bootTriggeredAt,
        sshHost: ts.sshHost,
        sshPort: ts.sshPort,
      };
      tierStates[tierIndex] = newReady;
      const tierProvider = tiers[tierIndex]?.provider ?? '';
      emitHook(hooks, 'onHealthChange', {
        userId, tierIndex, provider: tierProvider,
        previousState: 'booting', newState: 'ready', endpoint: ts.endpoint, timestamp: Date.now(),
      });
      void lifecycleLogger.log({
        userId, tierIndex, provider: tierProvider,
        eventType: 'boot_ok', durationMs: bootDurationMs,
        instanceId: ts.discoveredInstanceId,
        endpoint: ts.endpoint, trigger: ts.trigger,
        oldState: 'booting', newState: 'ready',
        metadata: { bootTriggeredAt: ts.bootTriggeredAt },
      });
    } else if (ts.state === 'booting' && !healthy) {
      // Still booting — check for timeout
      const tierProvider = tiers[tierIndex]?.provider ?? '';
      const bootTimeSecs = registry.get(tierProvider)?.bootTimeSecs ?? 120;
      const maxBootMs = bootTimeSecs * 2 * 1000;
      const now = Date.now();
      const elapsed = now - ts.bootTriggeredAt;

      if (elapsed > maxBootMs) {
        logger.warn(`[autoscaler] Tier ${tierIndex} (${tierProvider}) boot timed out after ${Math.round(elapsed / 1000)}s — reverting to idle`);
        const { newState, logEntry, cleanupConfig } = handleBootTimeout(
          tierIndex, ts, tiers[tierIndex], maxBootMs, now, 'health-probe',
        );
        tierStates[tierIndex] = newState;
        void lifecycleLogger.log({ userId, ...logEntry });

        if (newState.unhealthy) {
          logger.warn(`[autoscaler] Tier ${tierIndex} marked unhealthy after ${newState.bootFailCount} consecutive boot failures`);
        }
        if (cleanupConfig) {
          void cleanupInstance(cleanupConfig, registry, `boot timeout tier ${tierIndex}`);
        }
      }
    } else if (ts.state === 'ready' && !healthy) {
      // Ready tier went unhealthy — fallback
      const tierProvider = tiers[tierIndex]?.provider ?? '';
      logger.warn(`[autoscaler] Tier ${tierIndex} (${tierProvider}) unhealthy — marking for fallback`);
      const newIdle: IdleTierState = { state: 'idle', tierIndex, unhealthy: true };
      tierStates[tierIndex] = newIdle;
      emitHook(hooks, 'onHealthChange', {
        userId, tierIndex, provider: tierProvider,
        previousState: 'ready', newState: 'idle', endpoint: ts.endpoint, timestamp: Date.now(),
      });
      void lifecycleLogger.log({
        userId, tierIndex, provider: tierProvider,
        eventType: 'health_lost', endpoint: ts.endpoint,
        oldState: 'ready', newState: 'idle',
        metadata: { lastHealthyAt: ts.lastHealthyAt },
      });

      const tierConfig = tiers[tierIndex];
      if (tierConfig) {
        void cleanupInstance(tierConfig, registry, `unhealthy tier ${tierIndex}`);
      }
    } else if (ts.state === 'ready' && healthy) {
      // Still healthy — refresh timestamp
      tierStates[tierIndex] = { ...ts, lastHealthyAt: Date.now() };
    }
  }
}
