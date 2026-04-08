import type { SettingsStore, Logger } from '../deps';
import type { GpuProviderRegistry } from '../gpu-providers/registry';
import type { GatewayHooks } from '../hooks';
import { emitHook } from '../hooks';
import { defaultLogger } from '../logger';

/** Rate-limit reconcile to once per 10 min per user */
const RECONCILE_INTERVAL_MS = parseInt(process.env.RECONCILE_INTERVAL_MS || String(10 * 60 * 1000), 10);

/**
 * Grace period: don't clear DB entries for instances persisted within this window.
 * This prevents reconcile from racing with the engine during boot (the engine
 * persists the instance, but the provider may not yet have it visible in the API).
 * Default: 25 minutes — covers boot timeout (2× bootTimeSecs ≈ 20 min) plus margin.
 */
const PERSIST_GRACE_MS = parseInt(process.env.PERSIST_GRACE_MS || String(25 * 60 * 1000), 10);

export interface ReconcileDeps {
  settingsStore: SettingsStore;
  registry: GpuProviderRegistry;
  hooks?: GatewayHooks;
  logger?: Logger;
}

/**
 * Fire-and-forget reconcile: checks all configured machines against their providers
 * and clears stale DB entries. Rate-limited to once per 10 min per user.
 */
export function scheduleReconcile(
  deps: ReconcileDeps,
  userId: string,
  lastReconcileMap: Map<string, number>,
): void {
  const last = lastReconcileMap.get(userId) ?? 0;
  if (Date.now() - last < RECONCILE_INTERVAL_MS) return;
  lastReconcileMap.set(userId, Date.now());

  const log = deps.logger ?? defaultLogger;
  void reconcileStaleConfigs(deps, userId).catch((err) => {
    log.warn('[autoscaler] Auto-reconcile failed:', err);
    emitHook(deps.hooks, 'onError', {
      source: 'autoscaler', userId, operation: 'reconcile',
      message: err instanceof Error ? err.message : String(err),
      retryable: true, timestamp: Date.now(),
    });
  });
}

/**
 * Returns true if this entry was persisted recently enough that we should
 * skip clearing it, even if the provider API can't find the instance.
 * This prevents a race where reconcile clears an entry that the engine
 * just persisted during boot, before the provider API reflects it.
 *
 * Falls back to `createdAt` if `persistedAt` is missing — legacy entries
 * persisted before this field was added still get a sensible grace window.
 */
function isWithinGracePeriod(machine: Record<string, unknown>): boolean {
  const persistedAt = (machine.persistedAt as number | undefined)
    ?? (machine.createdAt as number | undefined);
  if (!persistedAt) return false;
  return Date.now() - persistedAt < PERSIST_GRACE_MS;
}

/**
 * Wrap a getInstanceStatus call to distinguish "definitely not found" (returns null
 * from a successful API call) from "could not check" (network error, timeout, 5xx).
 *
 * Why this matters: previously the code did `.catch(() => null)` which conflated
 * "API said pod is gone" with "I couldn't reach the API". On a transient API error,
 * reconcile would clear the DB entry — but the pod might still be running on the
 * provider, accruing $$$. This wrapper returns 'TRANSIENT_ERROR' on caught errors
 * so the caller can keep the entry instead of deleting it.
 */
async function safeStatusCheck(
  fn: () => Promise<string | null>,
): Promise<string | null | 'TRANSIENT_ERROR'> {
  try {
    return await fn();
  } catch {
    return 'TRANSIENT_ERROR';
  }
}

async function reconcileStaleConfigs(deps: ReconcileDeps, userId: string): Promise<void> {
  const { settingsStore, registry } = deps;
  const log = deps.logger ?? defaultLogger;
  const ai = await settingsStore.get(userId) as Record<string, unknown>;

  const skypilot = ai.skypilot as Record<string, unknown> | undefined;
  const tensordockApiKey = (skypilot?.tensordockApiKey as string) ?? process.env.TENSORDOCK_API_TOKEN;
  const tensordockAuthId = skypilot?.tensordockAuthId as string | undefined;
  const runpodApiKey = skypilot?.runpodApiKey as string | undefined;
  const vastApiKey = (skypilot?.vastApiKey as string | undefined) ?? process.env.VAST_API_KEY;

  const machineKeys = ['runpodPod', 'runpodPod2', 'tensordockInstance', 'tensordockInstance2', 'vastInstance', 'vastInstance2'] as const;
  const patch: Record<string, null | Record<string, unknown>> = {};
  let changed = false;

  for (const key of machineKeys) {
    const machine = ai[key] as Record<string, unknown> | null | undefined;
    if (!machine) continue;

    if (key.startsWith('runpod')) {
      const podId = machine.podId as string | undefined;
      if (!podId || !runpodApiKey) { patch[key] = null; changed = true; continue; }

      const client = registry.get('runpod');
      if (!client) { patch[key] = null; changed = true; continue; }

      const status = await safeStatusCheck(() => client.getInstanceStatus(podId, { apiKey: runpodApiKey }));
      if (status === 'TRANSIENT_ERROR') {
        log.warn(`[autoscaler] Auto-reconcile: ${key} (podId=${podId}) status check failed (transient) — keeping entry`);
        continue;
      }
      if (status === null) {
        if (isWithinGracePeriod(machine)) {
          log.log(`[autoscaler] Auto-reconcile: skipping ${key} (podId=${podId}) — within grace period`);
          continue;
        }
        log.log(`[autoscaler] Auto-reconcile: cleared stale ${key} (podId=${podId})`);
        patch[key] = null;
        changed = true;
      } else {
        if (machine.status !== status) {
          patch[key] = { ...machine, status };
          changed = true;
        }
      }
    } else if (key.startsWith('tensordock')) {
      const instanceId = machine.instanceId as string | undefined;
      if (!instanceId || !tensordockApiKey) { patch[key] = null; changed = true; continue; }

      const client = registry.get('tensordock');
      if (!client) { patch[key] = null; changed = true; continue; }

      const status = await safeStatusCheck(() =>
        client.getInstanceStatus(instanceId, { apiKey: tensordockApiKey, authId: tensordockAuthId })
      );
      if (status === 'TRANSIENT_ERROR') {
        log.warn(`[autoscaler] Auto-reconcile: ${key} (instanceId=${instanceId}) status check failed (transient) — keeping entry`);
        continue;
      }
      if (status === null) {
        if (isWithinGracePeriod(machine)) {
          log.log(`[autoscaler] Auto-reconcile: skipping ${key} (instanceId=${instanceId}) — within grace period`);
          continue;
        }
        log.log(`[autoscaler] Auto-reconcile: cleared stale ${key} (instanceId=${instanceId})`);
        patch[key] = null;
        changed = true;
      } else {
        if (machine.status !== status) {
          patch[key] = { ...machine, status };
          changed = true;
        }
      }
    } else if (key.startsWith('vast')) {
      const instanceId = machine.instanceId as string | undefined;
      if (!instanceId || !vastApiKey) { patch[key] = null; changed = true; continue; }

      const client = registry.get('vast');
      if (!client) { patch[key] = null; changed = true; continue; }

      const status = await safeStatusCheck(() => client.getInstanceStatus(instanceId, { apiKey: vastApiKey }));
      if (status === 'TRANSIENT_ERROR') {
        log.warn(`[autoscaler] Auto-reconcile: ${key} (instanceId=${instanceId}) status check failed (transient) — keeping entry`);
        continue;
      }
      if (status === null) {
        if (isWithinGracePeriod(machine)) {
          log.log(`[autoscaler] Auto-reconcile: skipping ${key} (instanceId=${instanceId}) — within grace period`);
          continue;
        }
        log.log(`[autoscaler] Auto-reconcile: cleared stale ${key} (instanceId=${instanceId})`);
        patch[key] = null;
        changed = true;
      } else {
        if (machine.status !== status) {
          patch[key] = { ...machine, status };
          changed = true;
        }
      }
    }
  }

  if (changed) {
    await settingsStore.patch(userId, patch);
  }
}
