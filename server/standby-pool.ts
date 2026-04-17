// ── Standby Pool (Phase B4) ────────────────────────────────────────────────
//
// Keeps N warm, snapshot-restored pods per active profile so that user-
// triggered requests find a ready endpoint with zero cold-start. Only
// operates on snapshot-capable providers (vast-vm, hyperstack); other
// providers get a no-op registration so callers don't need to branch.
//
// Lifecycle:
//   tick (every POOL_TICK_MS):
//     for each registered profile:
//       if healthy < minStandby → deploy another (uses snapshot restore path)
//       if healthy > maxStandby → scale down the oldest idle
//   checkout(profile) → pop a ready pod from the pool (pool refills async)
//   release(profile, podId) → return a pod (optional; pool does not rely on it)
//
// Dependencies:
//   - server/gpu-deploy.ts startDeployWithTiers — deploys via snapshot path.
//   - server/gpu-snapshot.ts — restore attempt runs inside startDeployLoop.
//   - event-bus `gpu.deployed` / `gpu.failed` / `gpu.terminated` — pool
//     listens to track membership transitions.
//
// This module is skipped entirely when B1/B2 have not been rolled out
// (which is the case today; setStandbyPoolConfig is opt-in).

import { createLogger } from '../src/logger';
import { onGatewayEvent } from './event-bus';

const log = createLogger('standby-pool');

export const POOL_TICK_MS = 30_000;
export const POOL_IDLE_TTL_MS = 15 * 60_000;

export type StandbyTier = 'vast-vm' | 'hyperstack';

export interface StandbyProfileConfig {
  profile: string;
  tier: StandbyTier;
  minStandby: number;
  maxStandby: number;
  dockerImage: string;
  gpuTypes: string[];
}

export interface StandbyPodRecord {
  podId: string;
  endpoint: string;
  profile: string;
  tier: StandbyTier;
  deployedAt: number;
  /** true = in pool, available for checkout; false = checked out. */
  inPool: boolean;
  lastCheckedAt: number;
}

// ── State ───────────────────────────────────────────────────────────────────

const profiles = new Map<string, StandbyProfileConfig>();
const pool = new Map<string, StandbyPodRecord>(); // key = podId
let tickTimer: ReturnType<typeof setInterval> | null = null;
let deployInProgressFor: Set<string> = new Set();

// ── Public API ─────────────────────────────────────────────────────────────

export function setStandbyPoolConfig(cfg: StandbyProfileConfig): void {
  profiles.set(cfg.profile, cfg);
  log.log(
    `[standby-pool] profile ${cfg.profile} registered (tier=${cfg.tier}, min=${cfg.minStandby}, max=${cfg.maxStandby})`,
  );
}

export function removeStandbyPoolConfig(profile: string): void {
  profiles.delete(profile);
  // Leave existing pods running — the monitor will scale them down as part
  // of maxStandby=0 sweeps if the profile is re-registered with 0.
}

export function getStandbyPoolStatus(): {
  profiles: StandbyProfileConfig[];
  pods: StandbyPodRecord[];
  healthyByProfile: Record<string, number>;
} {
  const healthy: Record<string, number> = {};
  for (const p of pool.values()) {
    if (p.inPool) healthy[p.profile] = (healthy[p.profile] ?? 0) + 1;
  }
  return {
    profiles: [...profiles.values()],
    pods: [...pool.values()],
    healthyByProfile: healthy,
  };
}

/**
 * Acquire a ready pod from the pool. Returns null if none available; caller
 * is expected to fall back to a fresh deploy. The pool refills async.
 */
export function checkout(profile: string): StandbyPodRecord | null {
  const candidates = [...pool.values()]
    .filter((p) => p.profile === profile && p.inPool)
    .sort((a, b) => a.deployedAt - b.deployedAt);
  const pod = candidates[0];
  if (!pod) return null;
  pod.inPool = false;
  pod.lastCheckedAt = Date.now();
  log.log(`[standby-pool] checkout ${pod.podId} for ${profile}`);
  // Trigger async refill.
  Promise.resolve().then(() => refillProfile(profile)).catch(() => {});
  return pod;
}

export function release(profile: string, podId: string): void {
  const pod = pool.get(podId);
  if (!pod) return;
  pod.inPool = true;
  pod.profile = profile;
  pod.lastCheckedAt = Date.now();
}

// ── Monitor loop ────────────────────────────────────────────────────────────

export function startStandbyPoolMonitor(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    tick().catch((err) => log.warn(`[standby-pool] tick failed: ${err instanceof Error ? err.message : err}`));
  }, POOL_TICK_MS);
  log.log('[standby-pool] monitor started');
  installPoolEventHook();
}

export function stopStandbyPoolMonitor(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

/** Exposed for tests — runs one tick synchronously. */
export async function tick(): Promise<void> {
  for (const cfg of profiles.values()) {
    const healthy = [...pool.values()].filter((p) => p.profile === cfg.profile && p.inPool);
    const now = Date.now();

    // Scale down stale pods (older than TTL and above minStandby).
    if (healthy.length > cfg.minStandby) {
      const sorted = healthy.sort((a, b) => a.deployedAt - b.deployedAt);
      for (const pod of sorted) {
        if (healthy.length <= cfg.minStandby) break;
        if (now - pod.lastCheckedAt > POOL_IDLE_TTL_MS) {
          log.log(`[standby-pool] scaling down idle ${pod.podId} for ${cfg.profile}`);
          pool.delete(pod.podId);
          terminatePod(pod).catch((err) =>
            log.warn(`[standby-pool] terminate failed: ${err instanceof Error ? err.message : err}`),
          );
        }
      }
    }

    // Scale up if below minStandby.
    if (healthy.length < cfg.minStandby) {
      await refillProfile(cfg.profile);
    }
  }
}

async function refillProfile(profile: string): Promise<void> {
  const cfg = profiles.get(profile);
  if (!cfg) return;
  if (deployInProgressFor.has(profile)) return;
  const healthy = [...pool.values()].filter((p) => p.profile === profile && p.inPool).length;
  if (healthy >= cfg.minStandby) return;
  if (pool.size >= cfg.maxStandby + 1) return;

  deployInProgressFor.add(profile);
  try {
    await triggerPoolDeploy(cfg);
  } finally {
    deployInProgressFor.delete(profile);
  }
}

// ── Adapter hooks — injected by server on startup ──────────────────────────

export type PoolDeployFn = (cfg: StandbyProfileConfig) => Promise<StandbyPodRecord | null>;
export type PoolTerminateFn = (pod: StandbyPodRecord) => Promise<void>;

let _deployFn: PoolDeployFn | null = null;
let _terminateFn: PoolTerminateFn | null = null;

export function setPoolAdapters(deployFn: PoolDeployFn, terminateFn: PoolTerminateFn): void {
  _deployFn = deployFn;
  _terminateFn = terminateFn;
}

async function triggerPoolDeploy(cfg: StandbyProfileConfig): Promise<void> {
  if (!_deployFn) {
    log.warn(`[standby-pool] deploy adapter not installed — skipping refill for ${cfg.profile}`);
    return;
  }
  const pod = await _deployFn(cfg);
  if (pod) {
    pool.set(pod.podId, pod);
    log.log(`[standby-pool] refilled ${cfg.profile}: ${pod.podId} @ ${pod.endpoint}`);
  } else {
    log.warn(`[standby-pool] deploy returned null for ${cfg.profile}`);
  }
}

async function terminatePod(pod: StandbyPodRecord): Promise<void> {
  if (!_terminateFn) return;
  await _terminateFn(pod);
}

// ── Event bus hook — clear pool on terminate / failure ─────────────────────

let _hookInstalled = false;
function installPoolEventHook(): void {
  if (_hookInstalled) return;
  _hookInstalled = true;
  onGatewayEvent((event, data) => {
    if (event === 'gpu.terminated' || event === 'gpu.failed') {
      const podId = String(data.podId ?? data.instanceId ?? '');
      if (podId && pool.has(podId)) {
        pool.delete(podId);
        log.log(`[standby-pool] pod ${podId} removed (${event})`);
      }
    }
  });
}

// ── Test hooks ──────────────────────────────────────────────────────────────
export function _resetForTests(): void {
  profiles.clear();
  pool.clear();
  deployInProgressFor = new Set();
  stopStandbyPoolMonitor();
  _deployFn = null;
  _terminateFn = null;
  _hookInstalled = false;
}

export function _seedPodForTests(pod: StandbyPodRecord): void {
  pool.set(pod.podId, pod);
}
