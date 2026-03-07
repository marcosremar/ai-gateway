/**
 * Tier Lifecycle Management — explicit control over GPU tier instances.
 *
 * Provides stop/start/delete/restart/deploy operations that transparently
 * resolve credentials, call the provider API, update engine state, and log events.
 */

import type { AutoscalerEngine } from './engine';
import type { GpuProviderRegistry } from '../gpu-providers/registry';
import type { GpuLifecycleLogger } from './lifecycle-logger';
import type { AutoScalerConfig, GpuTierConfig, GpuTierState, IdleTierState, BootingTierState, ReadyTierState } from '../types';
import type { Logger } from '../deps';
import { defaultLogger } from '../logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TierActionResult {
  ok: boolean;
  previousState?: string;
  newState?: string;
  instanceId?: string;
  provider?: string;
  error?: string;
}

export interface TierDetail {
  tierIndex: number;
  provider: string;
  state: string;
  endpoint?: string;
  instanceId?: string;
  /** Provider-reported status (e.g. 'running', 'stopped', 'exited') */
  providerStatus?: string | null;
  bootedAt?: number;
  bootTriggeredAt?: number;
  lastHealthyAt?: number;
  unhealthy?: boolean;
  bootFailCount?: number;
  cooldownUntil?: number;
  /** True when user explicitly stopped this tier — auto-boot is suppressed */
  manualStop?: boolean;
  gpuTypes?: string[];
}

export interface TierLifecycleDeps {
  engine: AutoscalerEngine;
  registry: GpuProviderRegistry;
  lifecycleLogger: GpuLifecycleLogger;
  loadConfig: (userId: string) => Promise<AutoScalerConfig | null>;
  logger?: Logger;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveInstanceId(tierConfig: GpuTierConfig, tierState: GpuTierState): string | undefined {
  if (tierConfig.instanceId) return tierConfig.instanceId;
  if ('discoveredInstanceId' in tierState) return (tierState as BootingTierState).discoveredInstanceId;
  return undefined;
}

function resolveCreds(tierConfig: GpuTierConfig) {
  if (!tierConfig.apiKey) throw new Error('Missing apiKey for tier');
  return { apiKey: tierConfig.apiKey, authId: tierConfig.authId };
}

// ── Lifecycle Functions ───────────────────────────────────────────────────────

/** Stop a running tier instance (pause billing). Idempotent on idle tiers. */
export async function stopTier(deps: TierLifecycleDeps, userId: string, tierIndex: number): Promise<TierActionResult> {
  const log = deps.logger ?? defaultLogger;
  try {
    // Always cancel boot poller first to prevent state transitions during stop
    deps.engine.cancelBootPoller(userId, tierIndex);

    const config = await deps.loadConfig(userId);
    if (!config?.tiers?.[tierIndex]) return { ok: false, error: 'Tier not found in config' };

    const tierConfig = config.tiers[tierIndex];
    const tierStates = deps.engine.getPoolStatus(userId);
    const tierState = tierStates[tierIndex] ?? { state: 'idle', tierIndex } as IdleTierState;
    const previousState = tierState.state;

    // If idle, ensure manualStop is set (idempotent) and return success
    if (tierState.state === 'idle') {
      if (!(tierState as IdleTierState).manualStop) {
        deps.engine.setTierState(userId, tierIndex, { ...tierState, manualStop: true } as IdleTierState);
      }
      return { ok: true, previousState: 'idle', newState: 'idle', provider: tierConfig.provider };
    }

    const instanceId = resolveInstanceId(tierConfig, tierState);
    if (!instanceId || !tierConfig.apiKey) {
      // No instance to stop — just update state (manualStop prevents auto-reboot)
      deps.engine.setTierState(userId, tierIndex, { state: 'idle', tierIndex, manualStop: true } as IdleTierState);
      return { ok: true, previousState, newState: 'idle', provider: tierConfig.provider };
    }

    const client = deps.registry.get(tierConfig.provider);
    if (!client) return { ok: false, error: `Provider "${tierConfig.provider}" not registered` };

    try {
      await client.stopInstance(instanceId, resolveCreds(tierConfig));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 404 = already gone, treat as success
      if (!msg.includes('not found') && !msg.includes('404')) {
        return { ok: false, error: msg, instanceId, provider: tierConfig.provider };
      }
    } finally {
      // Re-cancel poller in case it was re-triggered during the async stop
      deps.engine.cancelBootPoller(userId, tierIndex);
    }

    // manualStop prevents the autoscaler from immediately re-booting this tier
    deps.engine.setTierState(userId, tierIndex, { state: 'idle', tierIndex, manualStop: true } as IdleTierState);

    void deps.lifecycleLogger.log({
      userId, tierIndex, provider: tierConfig.provider,
      eventType: 'tier_stopped', instanceId,
      oldState: previousState, newState: 'idle',
      endpoint: 'endpoint' in tierState ? (tierState as ReadyTierState).endpoint : undefined,
    });

    log.log(`[tier-lifecycle] Stopped tier ${tierIndex} (${tierConfig.provider}) instance=${instanceId}`);
    return { ok: true, previousState, newState: 'idle', instanceId, provider: tierConfig.provider };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Start/resume a stopped tier instance. */
export async function startTier(deps: TierLifecycleDeps, userId: string, tierIndex: number): Promise<TierActionResult> {
  const log = deps.logger ?? defaultLogger;
  try {
    const config = await deps.loadConfig(userId);
    if (!config?.tiers?.[tierIndex]) return { ok: false, error: 'Tier not found in config' };

    const tierConfig = config.tiers[tierIndex];
    const tierStates = deps.engine.getPoolStatus(userId);
    const tierState = tierStates[tierIndex] ?? { state: 'idle', tierIndex } as IdleTierState;
    const previousState = tierState.state;

    // Already booting/ready — nothing to do
    if (tierState.state === 'booting' || tierState.state === 'ready') {
      return { ok: true, previousState, newState: tierState.state, provider: tierConfig.provider };
    }

    // Clear manualStop flag — user explicitly wants this tier running
    if (tierState.state === 'idle' && (tierState as IdleTierState).manualStop) {
      deps.engine.setTierState(userId, tierIndex, { ...tierState, manualStop: undefined } as IdleTierState);
    }

    const instanceId = tierConfig.instanceId;
    if (!instanceId || !tierConfig.apiKey) {
      return { ok: false, error: 'No instanceId or apiKey configured for this tier' };
    }

    const client = deps.registry.get(tierConfig.provider);
    if (!client) return { ok: false, error: `Provider "${tierConfig.provider}" not registered` };

    await client.startInstance(instanceId, resolveCreds(tierConfig));

    const newState: BootingTierState = {
      state: 'booting',
      tierIndex,
      endpoint: tierConfig.endpoint ?? '',
      bootTriggeredAt: Date.now(),
      trigger: 'manual',
      prevBootFailCount: (tierState as IdleTierState).bootFailCount ?? 0,
    };
    deps.engine.setTierState(userId, tierIndex, newState);

    void deps.lifecycleLogger.log({
      userId, tierIndex, provider: tierConfig.provider,
      eventType: 'tier_started', instanceId,
      oldState: previousState, newState: 'booting',
      trigger: 'manual',
    });

    log.log(`[tier-lifecycle] Started tier ${tierIndex} (${tierConfig.provider}) instance=${instanceId}`);
    return { ok: true, previousState, newState: 'booting', instanceId, provider: tierConfig.provider };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Destroy a tier instance permanently. */
export async function deleteTier(deps: TierLifecycleDeps, userId: string, tierIndex: number): Promise<TierActionResult> {
  const log = deps.logger ?? defaultLogger;
  try {
    // Always cancel boot poller first to prevent state transitions during delete
    deps.engine.cancelBootPoller(userId, tierIndex);

    const config = await deps.loadConfig(userId);
    if (!config?.tiers?.[tierIndex]) return { ok: false, error: 'Tier not found in config' };

    const tierConfig = config.tiers[tierIndex];
    const tierStates = deps.engine.getPoolStatus(userId);
    const tierState = tierStates[tierIndex] ?? { state: 'idle', tierIndex } as IdleTierState;
    const previousState = tierState.state;

    const instanceId = resolveInstanceId(tierConfig, tierState);
    if (instanceId && tierConfig.apiKey) {
      const client = deps.registry.get(tierConfig.provider);
      if (client) {
        // Stop first, then delete
        try { await client.stopInstance(instanceId, resolveCreds(tierConfig)); } catch (err) {
          const stopMsg = err instanceof Error ? err.message : String(err);
          if (!stopMsg.includes('not found') && !stopMsg.includes('404')) {
            log.warn(`[tier-lifecycle] stopInstance(${instanceId}) failed (non-fatal, will try delete): ${stopMsg}`);
          }
        }
        try { await client.deleteInstance(instanceId, resolveCreds(tierConfig)); } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('not found') && !msg.includes('404')) {
            return { ok: false, error: msg, instanceId, provider: tierConfig.provider };
          }
        }
      }
    }

    deps.engine.setTierState(userId, tierIndex, { state: 'idle', tierIndex, manualStop: true } as IdleTierState);

    void deps.lifecycleLogger.log({
      userId, tierIndex, provider: tierConfig.provider,
      eventType: 'tier_deleted', instanceId,
      oldState: previousState, newState: 'idle',
    });

    log.log(`[tier-lifecycle] Deleted tier ${tierIndex} (${tierConfig.provider}) instance=${instanceId ?? 'none'}`);
    return { ok: true, previousState, newState: 'idle', instanceId, provider: tierConfig.provider };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Restart a tier: stop then start. */
export async function restartTier(deps: TierLifecycleDeps, userId: string, tierIndex: number): Promise<TierActionResult> {
  const log = deps.logger ?? defaultLogger;
  try {
    const stopResult = await stopTier(deps, userId, tierIndex);
    if (!stopResult.ok) return stopResult;

    const startResult = await startTier(deps, userId, tierIndex);

    void deps.lifecycleLogger.log({
      userId, tierIndex,
      provider: startResult.provider ?? stopResult.provider ?? 'unknown',
      eventType: 'tier_restarted',
      instanceId: startResult.instanceId ?? stopResult.instanceId,
      oldState: stopResult.previousState,
      newState: startResult.newState,
    });

    log.log(`[tier-lifecycle] Restarted tier ${tierIndex}`);
    return {
      ok: startResult.ok,
      previousState: stopResult.previousState,
      newState: startResult.newState,
      instanceId: startResult.instanceId ?? stopResult.instanceId,
      provider: startResult.provider ?? stopResult.provider,
      error: startResult.error,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Deploy a new instance from scratch (create via provider API). */
export async function deployTier(deps: TierLifecycleDeps, userId: string, tierIndex: number): Promise<TierActionResult> {
  const log = deps.logger ?? defaultLogger;
  try {
    const config = await deps.loadConfig(userId);
    if (!config?.tiers?.[tierIndex]) return { ok: false, error: 'Tier not found in config' };

    const tierConfig = config.tiers[tierIndex];
    if (!tierConfig.apiKey) return { ok: false, error: 'No apiKey configured for this tier' };

    const tierStates = deps.engine.getPoolStatus(userId);
    const tierState = tierStates[tierIndex] ?? { state: 'idle', tierIndex } as IdleTierState;
    const previousState = tierState.state;

    // If currently running, stop/delete first
    if (tierState.state !== 'idle') {
      await deleteTier(deps, userId, tierIndex);
    }

    const client = deps.registry.get(tierConfig.provider);
    if (!client) return { ok: false, error: `Provider "${tierConfig.provider}" not registered` };

    const created = await client.createInstance(
      {
        gpuTypes: tierConfig.gpuTypes ?? [],
        dockerImage: tierConfig.dockerImage,
        hfToken: tierConfig.hfToken,
        env: tierConfig.env,
        storageGb: tierConfig.storageGb,
        region: tierConfig.region,
      },
      { apiKey: tierConfig.apiKey, authId: tierConfig.authId, hfToken: tierConfig.hfToken },
      userId,
    );

    const newState: BootingTierState = {
      state: 'booting',
      tierIndex,
      endpoint: created.endpoint ?? tierConfig.endpoint ?? '',
      bootTriggeredAt: Date.now(),
      trigger: 'manual',
      prevBootFailCount: 0,
      discoveredInstanceId: created.instanceId,
    };
    deps.engine.setTierState(userId, tierIndex, newState);

    void deps.lifecycleLogger.log({
      userId, tierIndex, provider: tierConfig.provider,
      eventType: 'tier_deployed',
      instanceId: created.instanceId,
      endpoint: created.endpoint,
      oldState: previousState, newState: 'booting',
      trigger: 'manual',
    });

    log.log(`[tier-lifecycle] Deployed new instance for tier ${tierIndex} (${tierConfig.provider}): ${created.instanceId}`);
    return {
      ok: true,
      previousState,
      newState: 'booting',
      instanceId: created.instanceId,
      provider: tierConfig.provider,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Get detailed status for a single tier. */
export async function getTierDetail(deps: TierLifecycleDeps, userId: string, tierIndex: number): Promise<TierDetail | null> {
  const config = await deps.loadConfig(userId);
  if (!config?.tiers?.[tierIndex]) return null;

  const tierConfig = config.tiers[tierIndex];
  const tierStates = deps.engine.getPoolStatus(userId);
  const tierState = tierStates[tierIndex] ?? { state: 'idle', tierIndex } as IdleTierState;

  const instanceId = resolveInstanceId(tierConfig, tierState);
  let providerStatus: string | null = null;

  if (instanceId && tierConfig.apiKey) {
    const client = deps.registry.get(tierConfig.provider);
    if (client) {
      try {
        providerStatus = await client.getInstanceStatus(instanceId, resolveCreds(tierConfig));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        (deps.logger ?? defaultLogger).warn(`[tier-lifecycle] getInstanceStatus(${instanceId}, ${tierConfig.provider}) failed: ${msg}`);
        providerStatus = null;
      }
    }
  }

  const detail: TierDetail = {
    tierIndex,
    provider: tierConfig.provider,
    state: tierState.state,
    instanceId,
    providerStatus,
    gpuTypes: tierConfig.gpuTypes,
  };

  if (tierState.state === 'ready') {
    detail.endpoint = (tierState as ReadyTierState).endpoint;
    detail.lastHealthyAt = (tierState as ReadyTierState).lastHealthyAt;
    detail.bootedAt = (tierState as ReadyTierState).bootedAt;
  } else if (tierState.state === 'booting') {
    detail.endpoint = (tierState as BootingTierState).endpoint;
    detail.bootTriggeredAt = (tierState as BootingTierState).bootTriggeredAt;
  } else {
    detail.unhealthy = (tierState as IdleTierState).unhealthy;
    detail.bootFailCount = (tierState as IdleTierState).bootFailCount;
    detail.cooldownUntil = (tierState as IdleTierState).cooldownUntil;
    detail.manualStop = (tierState as IdleTierState).manualStop;
  }

  return detail;
}

/** Get detailed status for all tiers. */
export async function getAllTierDetails(deps: TierLifecycleDeps, userId: string): Promise<TierDetail[]> {
  const config = await deps.loadConfig(userId);
  if (!config?.tiers?.length) return [];

  const details: TierDetail[] = [];
  for (let i = 0; i < config.tiers.length; i++) {
    const detail = await getTierDetail(deps, userId, i);
    if (detail) details.push(detail);
  }
  return details;
}
