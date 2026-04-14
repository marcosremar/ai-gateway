// ── GPU Orphan Cleanup — sweep and terminate untracked instances ──────────────

import { cleanupProviderInstances } from '../src/gpu-providers/deploy-orchestrator';
import { createLogger } from '../src/logger';
import {
  deployState, deployApiKey, deployVastApiKey, deployTensordockApiKey,
  deployTensordockAuthId, deployModalApiKey,
} from './state';
import { runpod, vast, tensordock, modal } from './providers';

const log = createLogger('gpu-deploy');

export const POD_NAME_PREFIX = 'parle-autoscale-';

/**
 * Instance IDs that are currently part of an active race deploy.
 * The orphan sweep must not terminate these — they are legitimately booting.
 * Populated by startDeployRace, cleared when race resolves.
 */
export const activeRaceInstanceIds = new Set<string>();

/**
 * Find and terminate ALL pods matching our naming prefix.
 * This prevents orphaned pods from accumulating costs when the gateway restarts
 * or when deploy requests race.
 *
 * @param apiKey RunPod API key
 * @param knownPodIds Pods we already know about (will also be terminated)
 */
export async function cleanupAllPods(apiKey: string, knownPodIds: string[] = []): Promise<void> {
  try {
    const instances = await runpod.listInstances({ apiKey });
    const toTerminate = instances.filter(inst =>
      (inst.instanceName || '').startsWith(POD_NAME_PREFIX) && inst.status !== 'EXITED'
    );

    if (toTerminate.length === 0) return;

    log.log(`[gpu] Cleaning up ${toTerminate.length} existing pod(s)...`);
    await Promise.allSettled(
      toTerminate.map(async (inst) => {
        try {
          await runpod.deleteInstance(inst.instanceId, { apiKey });
          log.log(`[gpu] Terminated orphan pod ${inst.instanceId} (${inst.instanceName})`);
        } catch (err) {
          log.warn(`[gpu] Failed to terminate pod ${inst.instanceId} (${inst.instanceName}): ${err instanceof Error ? err.message : err}`);
        }
      })
    );
  } catch (err) {
    log.warn(`[gpu] Failed to list pods for cleanup: ${err}`);
    // Fall back to terminating only known pods
    for (const podId of knownPodIds) {
      try { await runpod.deleteInstance(podId, { apiKey }); }
      catch (e) { log.warn(`[gpu] Failed to terminate known pod ${podId}: ${e instanceof Error ? e.message : e}`); }
    }
  }
}



export const cleanupVastInstances = (apiKey: string) =>
  cleanupProviderInstances(vast, { apiKey }, ['running', 'active', 'loading', 'creating', 'created'], 'Vast.ai');

export const cleanupTensordockInstances = (apiKey: string, authId?: string) =>
  cleanupProviderInstances(tensordock, { apiKey, authId }, ['running', 'active', 'deploying', 'creating'], 'TensorDock');

export const cleanupModalApps = (apiKey: string) =>
  cleanupProviderInstances(modal, { apiKey }, ['running', 'deployed', 'active'], 'Modal');

// ── Orphan instance sweep ─────────────────────────────────────────────────

let orphanSweepTimer: ReturnType<typeof setInterval> | null = null;
const ORPHAN_SWEEP_INTERVAL_MS = 10 * 60_000; // every 10 minutes

/**
 * Scan all providers for instances we don't track and terminate them.
 * Safe to call at any time — only kills instances NOT matching the active
 * deploy or standby deploy podId.
 */
export async function sweepOrphanInstances(): Promise<{ found: number; terminated: number }> {
  const tracked = new Set<string>();
  if (deployState.podId) tracked.add(deployState.podId);
  const { standbyDeployState } = await import('./state');
  if (standbyDeployState.podId) tracked.add(standbyDeployState.podId);
  // Include all active race candidates — they are legitimately booting, not orphans
  for (const id of activeRaceInstanceIds) tracked.add(id);

  let found = 0;
  let terminated = 0;

  // ── RunPod ──
  const rpKey = deployApiKey || process.env.RUNPOD_API_KEY || '';
  if (rpKey) {
    try {
      const instances = await runpod.listInstances({ apiKey: rpKey });
      const orphans = instances.filter(i =>
        (i.instanceName || '').startsWith(POD_NAME_PREFIX) &&
        i.status !== 'EXITED' &&
        !tracked.has(i.instanceId),
      );
      found += orphans.length;
      for (const inst of orphans) {
        try {
          await runpod.deleteInstance(inst.instanceId, { apiKey: rpKey });
          terminated++;
          log.log(`[orphan-sweep] RunPod ${inst.instanceId} (${inst.instanceName}) terminated`);
        } catch (err) {
          log.warn(`[orphan-sweep] RunPod ${inst.instanceId} delete failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      log.warn(`[orphan-sweep] RunPod list failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Vast.ai ──
  const vastKey = deployVastApiKey || process.env.VAST_API_KEY || '';
  if (vastKey) {
    try {
      const instances = await vast.listInstances({ apiKey: vastKey });
      const orphans = instances.filter(i => {
        const st = i.status?.toLowerCase() ?? '';
        return ['running', 'active', 'loading', 'creating', 'created'].includes(st)
          && !tracked.has(i.instanceId);
      });
      found += orphans.length;
      for (const inst of orphans) {
        try {
          await vast.deleteInstance(inst.instanceId, { apiKey: vastKey });
          terminated++;
          log.log(`[orphan-sweep] Vast ${inst.instanceId} (${inst.gpuType}) terminated`);
        } catch (err) {
          log.warn(`[orphan-sweep] Vast ${inst.instanceId} delete failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      log.warn(`[orphan-sweep] Vast list failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── TensorDock ──
  const tdKey = deployTensordockApiKey || process.env.TENSORDOCK_API_KEY || '';
  const tdAuth = deployTensordockAuthId || process.env.TENSORDOCK_AUTH_ID || '';
  if (tdKey) {
    try {
      const instances = await tensordock.listInstances({ apiKey: tdKey, authId: tdAuth });
      const orphans = instances.filter(i => {
        const st = i.status?.toLowerCase() ?? '';
        return ['running', 'active', 'deploying', 'creating'].includes(st)
          && !tracked.has(i.instanceId);
      });
      found += orphans.length;
      for (const inst of orphans) {
        try {
          await tensordock.deleteInstance(inst.instanceId, { apiKey: tdKey, authId: tdAuth });
          terminated++;
          log.log(`[orphan-sweep] TensorDock ${inst.instanceId} terminated`);
        } catch (err) {
          log.warn(`[orphan-sweep] TensorDock ${inst.instanceId} delete failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      log.warn(`[orphan-sweep] TensorDock list failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Modal ──
  const modalKey = deployModalApiKey || process.env.MODAL_TOKEN_ID || '';
  if (modalKey) {
    try {
      const instances = await modal.listInstances({ apiKey: modalKey });
      const orphans = instances.filter(i => {
        const st = i.status?.toLowerCase() ?? '';
        return ['running', 'deployed', 'active'].includes(st)
          && !tracked.has(i.instanceId);
      });
      found += orphans.length;
      for (const inst of orphans) {
        try {
          await modal.deleteInstance(inst.instanceId, { apiKey: modalKey });
          terminated++;
          log.log(`[orphan-sweep] Modal ${inst.instanceId} terminated`);
        } catch (err) {
          log.warn(`[orphan-sweep] Modal ${inst.instanceId} delete failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      log.warn(`[orphan-sweep] Modal list failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (found > 0) {
    log.log(`[orphan-sweep] Found ${found} orphan(s), terminated ${terminated}`);
  }
  return { found, terminated };
}

let orphanSweepInitialTimer: ReturnType<typeof setTimeout> | null = null;

/** Start periodic orphan sweep. Safe to call multiple times. */
export function startOrphanSweep(): void {
  if (orphanSweepTimer || orphanSweepInitialTimer) return;
  // Run initial sweep after a short delay (let startup finish first)
  orphanSweepInitialTimer = setTimeout(() => {
    orphanSweepInitialTimer = null;
    sweepOrphanInstances().catch(err =>
      log.warn(`[orphan-sweep] Initial sweep failed: ${err instanceof Error ? err.message : err}`),
    );
  }, 15_000);
  // Then every 10 minutes
  orphanSweepTimer = setInterval(() => {
    sweepOrphanInstances().catch(err =>
      log.warn(`[orphan-sweep] Periodic sweep failed: ${err instanceof Error ? err.message : err}`),
    );
  }, ORPHAN_SWEEP_INTERVAL_MS);
  log.log(`[orphan-sweep] Started (interval: ${ORPHAN_SWEEP_INTERVAL_MS / 60_000}min)`);
}

/** Stop periodic orphan sweep. */
export function stopOrphanSweep(): void {
  if (orphanSweepInitialTimer) { clearTimeout(orphanSweepInitialTimer); orphanSweepInitialTimer = null; }
  if (orphanSweepTimer) {
    clearInterval(orphanSweepTimer);
    orphanSweepTimer = null;
  }
}
