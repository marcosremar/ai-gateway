// ── GPU Orphan Cleanup — sweep and terminate untracked instances ──────────────

import { cleanupProviderInstances } from '../src/gpu-providers/deploy-orchestrator';
import { createLogger } from '../src/logger';
import {
  deployState, deployApiKey, deployVastApiKey, deployTensordockApiKey,
  deployTensordockAuthId, deployModalApiKey, deployHyperstackApiKey,
} from './state';
import { runpod, vast, tensordock, modal, hyperstack } from './providers';

const log = createLogger('gpu-deploy');

export const POD_NAME_PREFIX = 'parle-autoscale-';

/**
 * Name prefixes that identify instances created by this gateway across all
 * GPU providers. Cleanup / orphan-sweep logic must only touch instances
 * matching one of these — anything else is a third-party VM in the same
 * provider account and MUST be left alone.
 *
 * - `parle-autoscale-` — legacy prefix used by RunPod/TensorDock/Vast clients
 * - `ai-gateway-`      — current prefix used by the Hyperstack client
 *                        (see hyperstack-client.ts createInstance)
 */
export const GATEWAY_NAME_PREFIXES: string[] = [POD_NAME_PREFIX, 'ai-gateway-'];

/**
 * Instance IDs that are currently part of an active race deploy.
 * The orphan sweep must not terminate these — they are legitimately booting.
 * Populated by startDeployRace, cleared when race resolves.
 */
export const activeRaceInstanceIds = new Set<string>();

/**
 * Per-provider "gateway-owned account" flag. When set, the orphan sweep
 * ignores the GATEWAY_NAME_PREFIXES safety filter for that provider and
 * terminates EVERY untracked instance, regardless of name.
 *
 * Use this ONLY when the provider account is dedicated to ai-gateway and
 * contains no other workloads. Otherwise you will nuke third-party VMs.
 *
 * Vast.ai defaults to `true` based on explicit user instruction; the others
 * default to `false` (safety-first) and must be opted in via env var.
 */
export function isAccountOwned(provider: 'vast' | 'runpod' | 'tensordock' | 'modal' | 'hyperstack'): boolean {
  switch (provider) {
    case 'vast':       return (process.env.VAST_ACCOUNT_OWNED ?? '1') !== '0';
    case 'runpod':     return process.env.RUNPOD_ACCOUNT_OWNED === '1';
    case 'tensordock': return process.env.TENSORDOCK_ACCOUNT_OWNED === '1';
    case 'modal':      return process.env.MODAL_ACCOUNT_OWNED === '1';
    case 'hyperstack': return process.env.HYPERSTACK_ACCOUNT_OWNED === '1';
  }
}

/** Prefix list to apply for a provider (empty array = no filter = kill-all). */
export function prefixesForProvider(provider: 'vast' | 'runpod' | 'tensordock' | 'modal' | 'hyperstack'): string[] {
  return isAccountOwned(provider) ? [] : GATEWAY_NAME_PREFIXES;
}

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



// Vast.ai account is treated as gateway-owned: no name-prefix filter,
// and every lifecycle state (including `exited`, which still charges storage)
// is swept. Every instance in the account is the gateway's responsibility.
const VAST_SWEEP_STATUSES = ['running', 'active', 'loading', 'creating', 'created', 'exited', 'stopped'];
export const cleanupVastInstances = (apiKey: string) =>
  cleanupProviderInstances(vast, { apiKey }, VAST_SWEEP_STATUSES, 'Vast.ai', console.log, console.warn, []);

export const cleanupTensordockInstances = (apiKey: string, authId?: string) =>
  cleanupProviderInstances(tensordock, { apiKey, authId }, ['running', 'active', 'deploying', 'creating'], 'TensorDock', console.log, console.warn, GATEWAY_NAME_PREFIXES);

export const cleanupModalApps = (apiKey: string) =>
  cleanupProviderInstances(modal, { apiKey }, ['running', 'deployed', 'active'], 'Modal', console.log, console.warn, GATEWAY_NAME_PREFIXES);

export const cleanupHyperstackInstances = (apiKey: string) =>
  cleanupProviderInstances(hyperstack, { apiKey }, ['running', 'active', 'creating', 'booting'], 'Hyperstack', console.log, console.warn, GATEWAY_NAME_PREFIXES);

// ── Orphan instance sweep ─────────────────────────────────────────────────

let orphanSweepTimer: ReturnType<typeof setInterval> | null = null;
const ORPHAN_SWEEP_INTERVAL_MS = 10 * 60_000; // every 10 minutes

/**
 * Scan all providers for instances we don't track and terminate them.
 * Safe to call at any time — only kills instances NOT matching the active
 * deploy or standby deploy podId.
 */
export async function sweepOrphanInstances(): Promise<{ found: number; terminated: number }> {
  // Kill switch — set AIGW_ORPHAN_SWEEP_DISABLED=1 in dev/test sessions to
  // prevent the periodic sweep from accidentally killing pods (known false-
  // positive when deployState.podId desyncs after race-resolution edge cases).
  if (process.env.AIGW_ORPHAN_SWEEP_DISABLED === '1') {
    return { found: 0, terminated: 0 };
  }

  const tracked = new Set<string>();
  if (deployState.podId) tracked.add(deployState.podId);
  const { standbyDeployState } = await import('./state');
  if (standbyDeployState.podId) tracked.add(standbyDeployState.podId);
  // Include all active race candidates — they are legitimately booting, not orphans
  for (const id of activeRaceInstanceIds) tracked.add(id);

  // Defense-in-depth: if there's a "ready" deploy but the podId field is
  // empty (the desync bug), refuse to sweep — better to leak than to nuke an
  // active pod the user is working with.
  if (deployState.status === 'ready' && !deployState.podId) {
    log.warn(`[orphan-sweep] deployState.status=ready but podId='' — aborting sweep to avoid killing active pod`);
    return { found: 0, terminated: 0 };
  }

  // Defense-in-depth #2: skip sweep for 3 minutes after any transition.
  // Race-winner resolution can leave deployState.podId pointing at the WRONG
  // instance when 2 candidates become healthy nearly simultaneously. Giving
  // time for state to stabilize prevents killing the true winner.
  const TRANSITION_GRACE_MS = 3 * 60_000;
  const lastTransition = deployState.transitions?.[deployState.transitions.length - 1];
  if (lastTransition && Date.now() - lastTransition.ts < TRANSITION_GRACE_MS) {
    log.log(`[orphan-sweep] skipping — last transition ${Math.round((Date.now() - lastTransition.ts) / 1000)}s ago (grace ${TRANSITION_GRACE_MS / 1000}s)`);
    return { found: 0, terminated: 0 };
  }

  // Defense-in-depth #3: also track recent podIds from persisted deploys.
  // If a pod was recently the active deploy (even if replaced), don't nuke it
  // until the operator explicitly terminates. This avoids the case where the
  // winner's ID got overwritten by a loser.
  try {
    const { deployState: ds } = await import('./state');
    // If the race recently completed, check transitions for any podId mentioned
    for (const t of (ds.transitions || []).slice(-10)) {
      const detail = t.detail || '';
      // Detail strings sometimes contain instance IDs; be permissive
      const match = detail.match(/inst-\d+/g);
      if (match) for (const id of match) tracked.add(id);
    }
  } catch { /* best effort */ }

  let found = 0;
  let terminated = 0;

  // ── RunPod ──
  const rpKey = deployApiKey || process.env.RUNPOD_API_KEY || '';
  if (rpKey) {
    try {
      const instances = await runpod.listInstances({ apiKey: rpKey });
      const rpPrefixes = prefixesForProvider('runpod');
      const orphans = instances.filter(i => {
        if (i.status === 'EXITED') return false;
        if (tracked.has(i.instanceId)) return false;
        if (rpPrefixes.length === 0) return true; // account-owned → everything
        return rpPrefixes.some(p => (i.instanceName || '').startsWith(p));
      });
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
      // Vast.ai account is gateway-owned — every untracked instance is an orphan,
      // regardless of name prefix OR status (exited VMs still charge storage).
      const orphans = instances.filter(i => {
        const st = i.status?.toLowerCase() ?? '';
        return VAST_SWEEP_STATUSES.includes(st) && !tracked.has(i.instanceId);
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
      const tdPrefixes = prefixesForProvider('tensordock');
      const orphans = instances.filter(i => {
        const st = i.status?.toLowerCase() ?? '';
        if (!['running', 'active', 'deploying', 'creating'].includes(st)) return false;
        if (tracked.has(i.instanceId)) return false;
        if (tdPrefixes.length === 0) return true;
        return tdPrefixes.some(p => (i.instanceName || '').startsWith(p));
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
      const mPrefixes = prefixesForProvider('modal');
      const orphans = instances.filter(i => {
        const st = i.status?.toLowerCase() ?? '';
        if (!['running', 'deployed', 'active'].includes(st)) return false;
        if (tracked.has(i.instanceId)) return false;
        if (mPrefixes.length === 0) return true;
        return mPrefixes.some(p => (i.instanceName || '').startsWith(p));
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

  // ── Hyperstack ──
  const hyperstackKey = deployHyperstackApiKey || process.env.HYPERSTACK_API_KEY || '';
  if (hyperstackKey) {
    try {
      const instances = await hyperstack.listInstances({ apiKey: hyperstackKey });
      const hPrefixes = prefixesForProvider('hyperstack');
      const orphans = instances.filter(i => {
        const st = i.status?.toLowerCase() ?? '';
        if (!['running', 'active', 'creating', 'booting'].includes(st)) return false;
        if (tracked.has(i.instanceId)) return false;
        if (hPrefixes.length === 0) return true;
        return hPrefixes.some(p => (i.instanceName || '').startsWith(p));
      });
      found += orphans.length;
      for (const inst of orphans) {
        try {
          await hyperstack.deleteInstance(inst.instanceId, { apiKey: hyperstackKey });
          terminated++;
          log.log(`[orphan-sweep] Hyperstack ${inst.instanceId} terminated`);
        } catch (err) {
          log.warn(`[orphan-sweep] Hyperstack ${inst.instanceId} delete failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      log.warn(`[orphan-sweep] Hyperstack list failed: ${err instanceof Error ? err.message : err}`);
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
