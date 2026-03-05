import type { GpuTierConfig } from '../types';
import type { GpuProviderRegistry } from '../gpu-providers/registry';
import type { Logger } from '../deps';
import { defaultLogger } from '../logger';

/**
 * Stop/delete a provider instance. Non-fatal — logs on failure but never throws.
 */
export async function cleanupProviderInstance(
  tierConfig: GpuTierConfig,
  registry: GpuProviderRegistry,
  reason: string,
  logger?: Logger,
): Promise<void> {
  const log = logger ?? defaultLogger;
  if (!tierConfig.instanceId || !tierConfig.apiKey) return;
  const client = registry.get(tierConfig.provider);
  if (!client) return;
  try {
    await client.stopInstance(tierConfig.instanceId, {
      apiKey: tierConfig.apiKey,
      authId: tierConfig.authId,
    });
    log.log(`[Autoscaler] Stopped instance ${tierConfig.instanceId}: ${reason}`);
  } catch (err) {
    log.warn(`[Autoscaler] Failed to stop ${tierConfig.instanceId} (${reason}):`, err);
  }
}
