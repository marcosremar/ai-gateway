// ── GPU Orphan Cleanup — sweep and terminate untracked instances ──────────────

import { cleanupProviderInstances } from '../src/gpu-providers/deploy-orchestrator';
import { createLogger } from '../src/logger';
import {
  deployState, deployApiKey, deployVastApiKey, deployTensordockApiKey,
  deployTensordockAuthId, deployModalApiKey, deployHyperstackApiKey,
} from './state';
import { runpod, vast, tensordock, modal, hyperstack } from './providers';
import { logGpuEvent } from '../src/gateway/autoscaler/file-lifecycle-logger';
import {
  isBillableInstanceStatus,
  isTerminalInstanceStatus,
  normalizeInstanceStatus,
} from '../src/gateway/providers/gpu/instance-status';

const log = createLogger('gpu-deploy');

/**
 * Whether the operator has *explicitly* opted into the "kill every untracked
 * instance, even those without our naming prefix" behavior for a provider.
 *
 * Historically `isAccountOwned()` alone implied "nuke untracked". That was a
 * footgun: a single env var could erase third-party VMs in shared accounts
 * with no second confirmation. Forensic incident 2026-04-26 (5090 inst-35616469
 * disappeared with no audit trail) showed how dangerous a too-broad sweep is.
 *
 * Now nuking untracked requires BOTH:
 *   1. `<PROVIDER>_ACCOUNT_OWNED=1`         — affirms account is dedicated
 *   2. `AIGW_<PROVIDER>_NUKE_UNTRACKED=1`  — affirms operator wants kill-all
 *
 * Default behavior is fail-closed: empty prefix list → terminate nothing.
 */
function nukeUntrackedAllowed(provider: 'vast' | 'runpod' | 'tensordock' | 'modal' | 'hyperstack'): boolean {
  if (!isAccountOwned(provider)) return false;
  switch (provider) {
    case 'vast':       return process.env.AIGW_VAST_NUKE_UNTRACKED === '1';
    case 'runpod':     return process.env.AIGW_RUNPOD_NUKE_UNTRACKED === '1';
    case 'tensordock': return process.env.AIGW_TENSORDOCK_NUKE_UNTRACKED === '1';
    case 'modal':      return process.env.AIGW_MODAL_NUKE_UNTRACKED === '1';
    case 'hyperstack': return process.env.AIGW_HYPERSTACK_NUKE_UNTRACKED === '1';
  }
}

function modalStopsUntrackedByDefault(): boolean {
  return process.env.AIGW_MODAL_STOP_UNTRACKED !== '0';
}

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
 * All providers default to `false` (safety-first) and must be opted in via env
 * var. Vast.ai accounts are often shared with ad-hoc SSH experiments, so the
 * gateway must not assume every untracked machine belongs to it.
 */
export function isAccountOwned(provider: 'vast' | 'runpod' | 'tensordock' | 'modal' | 'hyperstack'): boolean {
  switch (provider) {
    case 'vast':       return process.env.VAST_ACCOUNT_OWNED === '1';
    case 'runpod':     return process.env.RUNPOD_ACCOUNT_OWNED === '1';
    case 'tensordock': return process.env.TENSORDOCK_ACCOUNT_OWNED === '1';
    case 'modal':      return process.env.MODAL_ACCOUNT_OWNED === '1';
    case 'hyperstack': return process.env.HYPERSTACK_ACCOUNT_OWNED === '1';
  }
}

/**
 * Prefix list to apply for a provider (empty array = no filter = kill-all).
 *
 * Returns [] only when BOTH `<PROVIDER>_ACCOUNT_OWNED=1` AND
 * `AIGW_<PROVIDER>_NUKE_UNTRACKED=1` are set. Returns the safe default
 * (GATEWAY_NAME_PREFIXES) otherwise — including when only ACCOUNT_OWNED
 * is set without the explicit nuke-untracked opt-in. This matches the
 * post-incident-2026-04-26 double-flag policy enforced by sweepOrphanInstances().
 */
export function prefixesForProvider(provider: 'vast' | 'runpod' | 'tensordock' | 'modal' | 'hyperstack'): string[] {
  if (provider === 'modal' && modalStopsUntrackedByDefault()) return [];
  return nukeUntrackedAllowed(provider) ? [] : GATEWAY_NAME_PREFIXES;
}

function getModalApiKey(): string {
  if (deployModalApiKey) return deployModalApiKey;
  if (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) {
    return `${process.env.MODAL_TOKEN_ID}:${process.env.MODAL_TOKEN_SECRET}`;
  }
  return process.env.MODAL_API_KEY || process.env.MODAL_TOKEN_ID || '';
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
    const toTerminate = instances.filter(inst => {
      // listInstances returns canonical statuses; skip dead ones (EXITED → stopped).
      if (isTerminalInstanceStatus(inst.status) || normalizeInstanceStatus(inst.status) === 'unknown') {
        return false;
      }
      return (inst.instanceName || '').startsWith(POD_NAME_PREFIX);
    });

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



// Canonical statuses from normalized listInstances (plus stopped — Vast EXITED
// instances still appear in the account and need orphan cleanup).
const VAST_SWEEP_STATUSES = ['running', 'booting', 'stopped'];

// Grace window — don't orphan-sweep instances created within this many ms.
// Vast race deploys take 5-10 min before the winner+loser bookkeeping
// finishes. Any instance newer than this is most likely still being
// orchestrated and we've previously destroyed paused-but-not-yet-resumed
// instances via the sweep. Override with VAST_ORPHAN_GRACE_MS.
const VAST_ORPHAN_GRACE_MS = parseInt(
  process.env.VAST_ORPHAN_GRACE_MS || String(45 * 60_000),
  10,
);
export async function cleanupVastInstances(apiKey: string, knownInstanceIds: string[] = []): Promise<void> {
  for (const instanceId of knownInstanceIds.filter(Boolean)) {
    try {
      await vast.deleteInstance(instanceId, { apiKey });
      console.log(`[gpu] Terminated known Vast.ai instance ${instanceId}`);
    } catch (err) {
      console.warn(`[gpu] Failed to terminate known Vast.ai instance ${instanceId}: ${err}`);
    }
  }

  await cleanupProviderInstances(
    vast,
    { apiKey },
    VAST_SWEEP_STATUSES,
    'Vast.ai',
    console.log,
    console.warn,
    prefixesForProvider('vast'),
  );
}

// Direct cleanup helpers route through prefixesForProvider() so the
// `AIGW_<PROVIDER>_NUKE_UNTRACKED=1` opt-in is honored consistently with
// sweepOrphanInstances. Previously these helpers hard-coded
// GATEWAY_NAME_PREFIXES, silently dropping the operator opt-in.
export const cleanupTensordockInstances = (apiKey: string, authId?: string) =>
  cleanupProviderInstances(tensordock, { apiKey, authId }, ['running', 'booting'], 'TensorDock', console.log, console.warn, prefixesForProvider('tensordock'));

export const cleanupModalApps = (apiKey: string) =>
  cleanupProviderInstances(
    modal,
    { apiKey },
    ['running', 'booting'],
    'Modal',
    console.log,
    console.warn,
    nukeUntrackedAllowed('modal') ? [] : GATEWAY_NAME_PREFIXES,
  );

export const cleanupHyperstackInstances = (apiKey: string) =>
  cleanupProviderInstances(hyperstack, { apiKey }, ['running', 'booting'], 'Hyperstack', console.log, console.warn, prefixesForProvider('hyperstack'));

// ── Orphan instance sweep ─────────────────────────────────────────────────

let orphanSweepTimer: ReturnType<typeof setInterval> | null = null;
const ORPHAN_SWEEP_INTERVAL_MS = 10 * 60_000; // every 10 minutes
let modalIdleSweepTimer: ReturnType<typeof setInterval> | null = null;
function parsePositiveMs(value: string | undefined, fallbackMs: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}
const MODAL_IDLE_SWEEP_INTERVAL_MS = parsePositiveMs(process.env.MODAL_IDLE_SWEEP_INTERVAL_MS, 60_000);
const MODAL_IDLE_GRACE_MS = parsePositiveMs(process.env.MODAL_IDLE_GRACE_MS, 5 * 60_000);
const modalIdleSince = new Map<string, number>();

function isModalIdleCandidate(status: string): boolean {
  // Modal "Tasks" means a container/process exists, not necessarily that a
  // user request is in flight. Treat billable apps as idle candidates
  // unless the gateway is actively tracking them.
  if (isBillableInstanceStatus(status)) return true;
  const normalized = status.toLowerCase();
  return normalized.startsWith('ephemeral') || normalized.includes('detached');
}

function shouldStopModalIdleApp(instanceId: string, status: string, now: number): boolean {
  if (!isModalIdleCandidate(status)) {
    modalIdleSince.delete(instanceId);
    return false;
  }
  const firstSeenIdle = modalIdleSince.get(instanceId);
  if (!firstSeenIdle) {
    modalIdleSince.set(instanceId, now);
    return false;
  }
  return now - firstSeenIdle >= MODAL_IDLE_GRACE_MS;
}

async function collectTrackedInstanceIds(): Promise<Set<string>> {
  const tracked = new Set<string>();
  if (deployState.podId) tracked.add(deployState.podId);
  const { standbyDeployState } = await import('./state');
  if (standbyDeployState.podId) tracked.add(standbyDeployState.podId);
  for (const id of activeRaceInstanceIds) tracked.add(id);

  try {
    const { deployState: ds } = await import('./state');
    for (const t of (ds.transitions || []).slice(-10)) {
      const detail = t.detail || '';
      const matches = detail.match(/\binst-\d+|\bap-[a-zA-Z0-9]+|\b[a-z0-9]{8,}\b/g);
      if (matches) for (const id of matches) tracked.add(id);
    }
  } catch { /* best effort */ }

  return tracked;
}

function getSweepSafetyAbortReason(): string | null {
  const status = (deployState.status || '').toLowerCase();
  if (status === 'ready' && !deployState.podId) {
    return "deployState.status=ready but podId is empty (desync guard)";
  }

  if (status && !['idle', 'ready', 'error', 'stopped', 'terminated'].includes(status)) {
    return `deploy is in progress (status=${status})`;
  }

  const TRANSITION_GRACE_MS = 3 * 60_000;
  const lastTransition = deployState.transitions?.[deployState.transitions.length - 1];
  if (lastTransition && Date.now() - lastTransition.ts < TRANSITION_GRACE_MS) {
    return `within ${TRANSITION_GRACE_MS / 1000}s post-transition grace`;
  }

  return null;
}

async function sweepModalIdleApps(tracked: Set<string>, trigger = 'orphan-sweep'): Promise<{ found: number; terminated: number }> {
  let found = 0;
  let terminated = 0;
  const modalKey = getModalApiKey();
  if (!modalKey) return { found, terminated };

  try {
    const instances = await modal.listInstances({ apiKey: modalKey });
    const mPrefixes = prefixesForProvider('modal');
    const now = Date.now();
    const orphans = instances.filter(i => {
      const st = i.status?.toLowerCase() ?? '';
      if (!['running', 'deployed', 'active', 'ephemeral', 'detached', 'initializing'].includes(st)
        && !st.startsWith('ephemeral')
        && !st.includes('detached')) {
        modalIdleSince.delete(i.instanceId);
        return false;
      }
      if (tracked.has(i.instanceId)) {
        modalIdleSince.delete(i.instanceId);
        return false;
      }
      const eligible =
        mPrefixes.length === 0
          ? modalStopsUntrackedByDefault() || nukeUntrackedAllowed('modal')
          : mPrefixes.some(p => (i.instanceName || '').startsWith(p));
      if (!eligible) {
        modalIdleSince.delete(i.instanceId);
        return false;
      }
      const shouldStop = shouldStopModalIdleApp(i.instanceId, st, now);
      if (!shouldStop && isModalIdleCandidate(st)) {
        const idleMs = now - (modalIdleSince.get(i.instanceId) ?? now);
        log.log(`[orphan-sweep] Modal ${i.instanceId} (${i.instanceName || '?'}) idle ${Math.round(idleMs / 1000)}s/${Math.round(MODAL_IDLE_GRACE_MS / 1000)}s — waiting before stop`);
      }
      return shouldStop;
    });
    found += orphans.length;
    for (const inst of orphans) {
      logGpuEvent({
        eventType: 'orphan_terminate_attempt',
        provider: 'modal',
        instanceId: inst.instanceId,
        trigger,
        oldState: inst.status || 'unknown',
        newState: 'terminating',
        metadata: { source: 'orphan-sweep', instanceName: inst.instanceName, msg: 'Will terminate idle Modal app after grace window' },
      });
      try {
        await modal.deleteInstance(inst.instanceId, { apiKey: modalKey });
        modalIdleSince.delete(inst.instanceId);
        terminated++;
        log.log(`[orphan-sweep] Modal ${inst.instanceId} terminated`);
        logGpuEvent({
          eventType: 'orphan_terminated',
          provider: 'modal',
          instanceId: inst.instanceId,
          trigger,
          oldState: 'terminating',
          newState: 'terminated',
          metadata: { source: 'orphan-sweep', instanceName: inst.instanceName, msg: 'Modal idle app terminated' },
        });
      } catch (err) {
        log.warn(`[orphan-sweep] Modal ${inst.instanceId} delete failed: ${err instanceof Error ? err.message : err}`);
        logGpuEvent({
          eventType: 'orphan_terminate_failed',
          provider: 'modal',
          instanceId: inst.instanceId,
          trigger,
          oldState: 'terminating',
          newState: 'unknown',
          metadata: { source: 'orphan-sweep', instanceName: inst.instanceName, msg: `delete failed: ${err instanceof Error ? err.message : String(err)}` },
        });
      }
    }
  } catch (err) {
    log.warn(`[orphan-sweep] Modal list failed: ${err instanceof Error ? err.message : err}`);
  }

  return { found, terminated };
}

/**
 * Scan all providers for gateway-owned instances we don't track and terminate
 * them. Safe to call at any time — skips the active deploy, standby deploy,
 * active race candidates, and non-prefixed instances unless the provider is
 * explicitly marked account-owned.
 */
export async function sweepOrphanInstances(): Promise<{ found: number; terminated: number }> {
  const sweepStartedAt = Date.now();
  logGpuEvent({
    eventType: 'sweep_started',
    provider: 'multi',
    trigger: 'orphan-sweep',
    metadata: {
      source: 'orphan-sweep',
      msg: `Sweep tick start; flags: vast=${nukeUntrackedAllowed('vast')} runpod=${nukeUntrackedAllowed('runpod')} td=${nukeUntrackedAllowed('tensordock')} modal=${nukeUntrackedAllowed('modal')} hyperstack=${nukeUntrackedAllowed('hyperstack')}`,
    },
  });

  const tracked = await collectTrackedInstanceIds();

  const abortReason = getSweepSafetyAbortReason();
  if (abortReason) {
    log.log(`[orphan-sweep] skipping — ${abortReason}`);
    logGpuEvent({
      eventType: 'sweep_aborted',
      provider: 'multi',
      trigger: 'orphan-sweep',
      metadata: { source: 'orphan-sweep', msg: `aborted: ${abortReason}` },
    });
    return { found: 0, terminated: 0 };
  }

  let found = 0;
  let terminated = 0;

  // ── RunPod ──
  const rpKey = deployApiKey || process.env.RUNPOD_API_KEY || '';
  if (rpKey) {
    try {
      const instances = await runpod.listInstances({ apiKey: rpKey });
      const rpPrefixes = prefixesForProvider('runpod');
      const orphans = instances.filter(i => {
        // Canonical: EXITED → stopped. Also skip error/unknown dead states.
        if (isTerminalInstanceStatus(i.status) || normalizeInstanceStatus(i.status) === 'unknown') {
          return false;
        }
        if (tracked.has(i.instanceId)) return false;
        if (rpPrefixes.length === 0) return nukeUntrackedAllowed('runpod');
        return rpPrefixes.some(p => (i.instanceName || '').startsWith(p));
      });
      found += orphans.length;
      for (const inst of orphans) {
        // Log INTENT before the delete request so we have a forensic trail
        // even if the API call hangs/crashes mid-flight (otherwise the only
        // record is the terminated state on the provider, with no "who killed me").
        logGpuEvent({
          eventType: 'orphan_terminate_attempt',
          provider: 'runpod',
          instanceId: inst.instanceId,
          trigger: 'orphan-sweep',
          oldState: 'running',
          newState: 'terminating',
          metadata: { source: 'orphan-sweep', instanceName: inst.instanceName, msg: `Will terminate untracked RunPod pod` },
        });
        // Re-check tracked just before delete — a race deploy starting
        // mid-sweep may have added the instance ID to activeRaceInstanceIds.
        // Without this last-mile check, the brand-new candidate gets killed
        // because the snapshot at sweep start didn't include it.
        if (activeRaceInstanceIds.has(inst.instanceId) || tracked.has(inst.instanceId)) {
          log.log(`[orphan-sweep] RunPod ${inst.instanceId} skipped — became tracked mid-sweep (race candidate)`);
          continue;
        }
        try {
          await runpod.deleteInstance(inst.instanceId, { apiKey: rpKey });
          terminated++;
          log.log(`[orphan-sweep] RunPod ${inst.instanceId} (${inst.instanceName}) terminated`);
          logGpuEvent({
            eventType: 'orphan_terminated',
            provider: 'runpod',
            instanceId: inst.instanceId,
            trigger: 'orphan-sweep',
            oldState: 'terminating',
            newState: 'terminated',
            metadata: { source: 'orphan-sweep', instanceName: inst.instanceName, msg: 'RunPod orphan terminated' },
          });
        } catch (err) {
          log.warn(`[orphan-sweep] RunPod ${inst.instanceId} delete failed: ${err instanceof Error ? err.message : err}`);
          logGpuEvent({
            eventType: 'orphan_terminate_failed',
            provider: 'runpod',
            instanceId: inst.instanceId,
            trigger: 'orphan-sweep',
            oldState: 'terminating',
            newState: 'unknown',
            metadata: { source: 'orphan-sweep', instanceName: inst.instanceName, msg: `delete failed: ${err instanceof Error ? err.message : String(err)}` },
          });
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
      const vastPrefixes = prefixesForProvider('vast');
      const now = Date.now();
      const orphans = instances.filter(i => {
        const st = i.status?.toLowerCase() ?? '';
        if (!VAST_SWEEP_STATUSES.includes(st)) return false;
        if (tracked.has(i.instanceId)) return false;
        // Grace window: skip very new instances. Race deploys take ~5-10min
        // and the winner/loser bookkeeping happens AFTER the API call —
        // pre-emptively destroying these races a paused-not-yet-tracked pod.
        const startedAtMs = (i as { startDateMs?: number; createdAtMs?: number }).startDateMs
          || (i as { createdAtMs?: number }).createdAtMs
          || 0;
        if (startedAtMs > 0 && now - startedAtMs < VAST_ORPHAN_GRACE_MS) {
          return false;
        }
        if (vastPrefixes.length === 0) return nukeUntrackedAllowed('vast');
        return vastPrefixes.some(p => (i.instanceName || '').startsWith(p));
      });
      found += orphans.length;
      for (const inst of orphans) {
        logGpuEvent({
          eventType: 'orphan_terminate_attempt',
          provider: 'vast',
          instanceId: inst.instanceId,
          trigger: 'orphan-sweep',
          oldState: inst.status || 'unknown',
          newState: 'terminating',
          metadata: { source: 'orphan-sweep', gpuType: inst.gpuType, instanceName: inst.instanceName, msg: 'Will terminate untracked Vast instance' },
        });
        try {
          await vast.deleteInstance(inst.instanceId, { apiKey: vastKey });
          terminated++;
          log.log(`[orphan-sweep] Vast ${inst.instanceId} (${inst.gpuType}) terminated`);
          logGpuEvent({
            eventType: 'orphan_terminated',
            provider: 'vast',
            instanceId: inst.instanceId,
            trigger: 'orphan-sweep',
            oldState: 'terminating',
            newState: 'terminated',
            metadata: { source: 'orphan-sweep', gpuType: inst.gpuType, instanceName: inst.instanceName, msg: 'Vast orphan terminated' },
          });
        } catch (err) {
          log.warn(`[orphan-sweep] Vast ${inst.instanceId} delete failed: ${err instanceof Error ? err.message : err}`);
          logGpuEvent({
            eventType: 'orphan_terminate_failed',
            provider: 'vast',
            instanceId: inst.instanceId,
            trigger: 'orphan-sweep',
            oldState: 'terminating',
            newState: 'unknown',
            metadata: { source: 'orphan-sweep', gpuType: inst.gpuType, instanceName: inst.instanceName, msg: `delete failed: ${err instanceof Error ? err.message : String(err)}` },
          });
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
        if (!isBillableInstanceStatus(i.status)) return false;
        if (tracked.has(i.instanceId)) return false;
        if (tdPrefixes.length === 0) return nukeUntrackedAllowed('tensordock');
        return tdPrefixes.some(p => (i.instanceName || '').startsWith(p));
      });
      found += orphans.length;
      for (const inst of orphans) {
        logGpuEvent({
          eventType: 'orphan_terminate_attempt',
          provider: 'tensordock',
          instanceId: inst.instanceId,
          trigger: 'orphan-sweep',
          oldState: inst.status || 'unknown',
          newState: 'terminating',
          metadata: { source: 'orphan-sweep', instanceName: inst.instanceName, msg: 'Will terminate untracked TensorDock instance' },
        });
        try {
          await tensordock.deleteInstance(inst.instanceId, { apiKey: tdKey, authId: tdAuth });
          terminated++;
          log.log(`[orphan-sweep] TensorDock ${inst.instanceId} terminated`);
          logGpuEvent({
            eventType: 'orphan_terminated',
            provider: 'tensordock',
            instanceId: inst.instanceId,
            trigger: 'orphan-sweep',
            oldState: 'terminating',
            newState: 'terminated',
            metadata: { source: 'orphan-sweep', instanceName: inst.instanceName, msg: 'TensorDock orphan terminated' },
          });
        } catch (err) {
          log.warn(`[orphan-sweep] TensorDock ${inst.instanceId} delete failed: ${err instanceof Error ? err.message : err}`);
          logGpuEvent({
            eventType: 'orphan_terminate_failed',
            provider: 'tensordock',
            instanceId: inst.instanceId,
            trigger: 'orphan-sweep',
            oldState: 'terminating',
            newState: 'unknown',
            metadata: { source: 'orphan-sweep', instanceName: inst.instanceName, msg: `delete failed: ${err instanceof Error ? err.message : String(err)}` },
          });
        }
      }
    } catch (err) {
      log.warn(`[orphan-sweep] TensorDock list failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Modal ──
  const modalSweep = await sweepModalIdleApps(tracked);
  found += modalSweep.found;
  terminated += modalSweep.terminated;

  // ── Hyperstack ──
  const hyperstackKey = deployHyperstackApiKey || process.env.HYPERSTACK_API_KEY || '';
  if (hyperstackKey) {
    try {
      const instances = await hyperstack.listInstances({ apiKey: hyperstackKey });
      const hPrefixes = prefixesForProvider('hyperstack');
      const orphans = instances.filter(i => {
        if (!isBillableInstanceStatus(i.status)) return false;
        if (tracked.has(i.instanceId)) return false;
        if (hPrefixes.length === 0) return nukeUntrackedAllowed('hyperstack');
        return hPrefixes.some(p => (i.instanceName || '').startsWith(p));
      });
      found += orphans.length;
      for (const inst of orphans) {
        logGpuEvent({
          eventType: 'orphan_terminate_attempt',
          provider: 'hyperstack',
          instanceId: inst.instanceId,
          trigger: 'orphan-sweep',
          oldState: inst.status || 'unknown',
          newState: 'terminating',
          metadata: { source: 'orphan-sweep', instanceName: inst.instanceName, msg: 'Will terminate untracked Hyperstack VM' },
        });
        try {
          await hyperstack.deleteInstance(inst.instanceId, { apiKey: hyperstackKey });
          terminated++;
          log.log(`[orphan-sweep] Hyperstack ${inst.instanceId} terminated`);
          logGpuEvent({
            eventType: 'orphan_terminated',
            provider: 'hyperstack',
            instanceId: inst.instanceId,
            trigger: 'orphan-sweep',
            oldState: 'terminating',
            newState: 'terminated',
            metadata: { source: 'orphan-sweep', instanceName: inst.instanceName, msg: 'Hyperstack orphan terminated' },
          });
        } catch (err) {
          log.warn(`[orphan-sweep] Hyperstack ${inst.instanceId} delete failed: ${err instanceof Error ? err.message : err}`);
          logGpuEvent({
            eventType: 'orphan_terminate_failed',
            provider: 'hyperstack',
            instanceId: inst.instanceId,
            trigger: 'orphan-sweep',
            oldState: 'terminating',
            newState: 'unknown',
            metadata: { source: 'orphan-sweep', instanceName: inst.instanceName, msg: `delete failed: ${err instanceof Error ? err.message : String(err)}` },
          });
        }
      }
    } catch (err) {
      log.warn(`[orphan-sweep] Hyperstack list failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (found > 0) {
    log.log(`[orphan-sweep] Found ${found} orphan(s), terminated ${terminated}`);
  }
  logGpuEvent({
    eventType: 'sweep_finished',
    provider: 'multi',
    trigger: 'orphan-sweep',
    metadata: {
      source: 'orphan-sweep',
      msg: `Sweep tick finished in ${Date.now() - sweepStartedAt}ms; found=${found} terminated=${terminated}`,
    },
  });
  return { found, terminated };
}

let orphanSweepInitialTimer: ReturnType<typeof setTimeout> | null = null;

/** Start periodic orphan sweep. Safe to call multiple times. */
export function startOrphanSweep(): void {
  if (orphanSweepTimer || orphanSweepInitialTimer) return;
  // Announce sweep policy explicitly at startup so an operator reading the
  // server log knows whether the sweep will only clean gateway-prefixed
  // instances or has explicit kill-all permissions for dedicated accounts.
  // There is no global disable switch: orphan cleanup is a cost-control guard.
  const policy = {
    enabled: true,
    intervalMin: ORPHAN_SWEEP_INTERVAL_MS / 60_000,
    modalIdleIntervalSec: MODAL_IDLE_SWEEP_INTERVAL_MS / 1000,
    modalIdleGraceSec: MODAL_IDLE_GRACE_MS / 1000,
    modalStopUntrackedByDefault: modalStopsUntrackedByDefault(),
    nukeUntracked: {
      vast:       nukeUntrackedAllowed('vast'),
      runpod:     nukeUntrackedAllowed('runpod'),
      tensordock: nukeUntrackedAllowed('tensordock'),
      modal:      nukeUntrackedAllowed('modal'),
      hyperstack: nukeUntrackedAllowed('hyperstack'),
    },
    accountOwned: {
      vast:       isAccountOwned('vast'),
      runpod:     isAccountOwned('runpod'),
      tensordock: isAccountOwned('tensordock'),
      modal:      isAccountOwned('modal'),
      hyperstack: isAccountOwned('hyperstack'),
    },
  };
  log.log(`[orphan-sweep] ENABLED interval=${policy.intervalMin}min — nukeUntracked: ${JSON.stringify(policy.nukeUntracked)}`);
  logGpuEvent({
    eventType: 'sweep_policy',
    provider: 'multi',
    trigger: 'startup',
    metadata: { source: 'orphan-sweep', msg: `Sweep policy: ${JSON.stringify(policy)}` },
  });
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
  modalIdleSweepTimer = setInterval(() => {
    const abortReason = getSweepSafetyAbortReason();
    if (abortReason) {
      log.log(`[orphan-sweep] Modal idle sweep skipped — ${abortReason}`);
      return;
    }
    collectTrackedInstanceIds()
      .then(tracked => sweepModalIdleApps(tracked, 'modal-idle-sweep'))
      .catch(err => log.warn(`[orphan-sweep] Modal idle sweep failed: ${err instanceof Error ? err.message : err}`));
  }, MODAL_IDLE_SWEEP_INTERVAL_MS);
  if (modalIdleSweepTimer.unref) modalIdleSweepTimer.unref();
  log.log(`[orphan-sweep] Started (interval: ${ORPHAN_SWEEP_INTERVAL_MS / 60_000}min, modal idle: ${MODAL_IDLE_GRACE_MS / 60_000}min)`);
}

/** Stop periodic orphan sweep. */
export function stopOrphanSweep(): void {
  if (orphanSweepInitialTimer) { clearTimeout(orphanSweepInitialTimer); orphanSweepInitialTimer = null; }
  if (orphanSweepTimer) {
    clearInterval(orphanSweepTimer);
    orphanSweepTimer = null;
  }
  if (modalIdleSweepTimer) {
    clearInterval(modalIdleSweepTimer);
    modalIdleSweepTimer = null;
  }
}
