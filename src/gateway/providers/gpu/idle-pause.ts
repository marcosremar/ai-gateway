// ── Provider-aware idle pause helper ────────────────────────────────────────
//
// Dispatches between `stopInstance` (stop → SHUTOFF, still bills full price on
// Hyperstack) and `hibernate` (suspend-to-disk → bills only IP+disk ~10–15% of
// full cost on Hyperstack). Hyperstack is the only provider in the current
// cascade where this distinction matters: for RunPod, Vast.ai, TensorDock and
// Modal, `stopInstance` already pauses billing, so we keep the existing path.
//
// Callers persist the returned `pausedMode` so the matching resume path can
// dispatch between `startInstance` and `hibernateRestore`.

import type { GpuProviderClient, ProviderCredentials } from './types';

export type PausedMode = 'stop' | 'hibernate';

export interface PauseOptions {
  /**
   * When true AND the provider supports hibernate, call `hibernate()` instead
   * of `stopInstance()`. Defaults to false — explicit opt-in only, so the
   * existing idle-stop behaviour is preserved for every profile that hasn't
   * migrated to the new flag.
   */
  allowHibernate?: boolean;
}

/** Provider id strings where hibernate is a distinct, billing-pausing call. */
const HIBERNATE_CAPABLE_PROVIDERS = new Set(['hyperstack']);

interface HibernateCapable {
  hibernate(instanceId: string, credentials: ProviderCredentials): Promise<void>;
}

function supportsHibernate(
  providerName: string,
  client: GpuProviderClient,
): client is GpuProviderClient & HibernateCapable {
  if (!HIBERNATE_CAPABLE_PROVIDERS.has(providerName)) return false;
  return typeof (client as Partial<HibernateCapable>).hibernate === 'function';
}

/**
 * Pause an instance using the cheapest-available mechanism for the provider.
 *
 * Returns the mode actually used so the caller can persist it — the resume
 * path (gpu-resume-manager / gpu-handlers) must see `pausedMode==='hibernate'`
 * to know it should call `hibernateRestore` instead of `startInstance`.
 */
export async function pauseInstanceForIdle(
  providerName: string,
  vmId: string,
  credentials: ProviderCredentials,
  client: GpuProviderClient,
  opts: PauseOptions = {},
): Promise<PausedMode> {
  if (opts.allowHibernate && supportsHibernate(providerName, client)) {
    await client.hibernate(vmId, credentials);
    return 'hibernate';
  }
  await client.stopInstance(vmId, credentials);
  return 'stop';
}

/**
 * Resume counterpart — dispatches between `startInstance` (classic stop) and
 * `hibernateRestore` (hibernate). Returns void; throws on provider error.
 */
export async function resumeInstanceFromIdle(
  providerName: string,
  vmId: string,
  credentials: ProviderCredentials,
  client: GpuProviderClient,
  pausedMode: PausedMode | undefined,
): Promise<void> {
  if (
    pausedMode === 'hibernate' &&
    HIBERNATE_CAPABLE_PROVIDERS.has(providerName) &&
    typeof (client as Partial<{ hibernateRestore: HibernateCapable['hibernate'] }>).hibernateRestore === 'function'
  ) {
    await (client as unknown as {
      hibernateRestore(id: string, creds: ProviderCredentials): Promise<void>;
    }).hibernateRestore(vmId, credentials);
    return;
  }
  await client.startInstance(vmId, credentials);
}
