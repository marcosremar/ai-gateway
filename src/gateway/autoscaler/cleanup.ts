import type { GpuTierConfig } from '../../types';
import type { GpuProviderRegistry } from '../providers/gpu/registry';
import type { GatewayHooks } from '../../hooks';
import type { Logger } from '../../deps';
import { emitHook } from '../../hooks';
import { defaultLogger } from '../../logger';

/**
 * #230 — resolve the instance id to clean up.
 *
 * `cleanupProviderInstance` early-returned unless `tierConfig.instanceId` was
 * set, so an auto-provisioned tier that only has a runtime-`discoveredInstanceId`
 * (passed by the caller) was never cleaned and leaked. This prefers an explicit
 * resolved id (the discovered instance) and falls back to the static config id.
 * Returns `undefined` when neither is available. Pure + exported for testing.
 */
export function resolveCleanupInstanceId(
  tierConfig: Pick<GpuTierConfig, 'instanceId'>,
  resolvedInstanceId?: string,
): string | undefined {
  const id = (resolvedInstanceId && resolvedInstanceId.trim()) || tierConfig.instanceId;
  return id && id.trim() ? id : undefined;
}

/**
 * Stop/delete a provider instance. Non-fatal — logs on failure but never throws.
 *
 * @param resolvedInstanceId - #230: optional runtime-discovered instance id used
 *   when the tier config carries no static `instanceId` (auto-provisioned tiers).
 */
export async function cleanupProviderInstance(
  tierConfig: GpuTierConfig,
  registry: GpuProviderRegistry,
  reason: string,
  logger?: Logger,
  hooks?: GatewayHooks,
  resolvedInstanceId?: string,
): Promise<void> {
  const log = logger ?? defaultLogger;
  const instanceId = resolveCleanupInstanceId(tierConfig, resolvedInstanceId);
  if (!instanceId || !tierConfig.apiKey) return;
  const client = registry.get(tierConfig.provider);
  if (!client) return;
  try {
    await client.stopInstance(instanceId, {
      apiKey: tierConfig.apiKey,
      authId: tierConfig.authId,
    });
    log.log(`[Autoscaler] Stopped instance ${instanceId}: ${reason}`);
  } catch (err) {
    log.warn(`[Autoscaler] Failed to stop ${instanceId} (${reason}):`, err);
    emitHook(hooks, 'onError', {
      source: 'cleanup', provider: tierConfig.provider,
      instanceId,
      operation: 'cleanupStop', message: err instanceof Error ? err.message : String(err),
      retryable: true, timestamp: Date.now(),
    });
  }
}
