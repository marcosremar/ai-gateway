// ── Temperature-aware request router ──────────────────────────────────────
//
// Picks the hottest pool slot for an incoming request so the caller observes
// the lowest possible wake latency. Modeled after the four temperature tiers
// observed in our cold-start benchmarks:
//
//   T0_warm       ~26 ms   — model resident on GPU, serve immediately.
//   T1_offloaded  ~1.3 s   — VM up, model swapped to CPU; /tmp/bench.onload.
//   T2_stopped    ~65 s    — VM in SHUTOFF/hibernate; provider start required.
//   T4_cold       ~205 s   — fresh deploy from scratch.
//
// This module only owns the T0/T1 transition (SSH-driven offload wake). T2
// and T4 require the pool manager / autoscaler because they cross provider
// API boundaries and cost accounting gates. Callers who receive the
// "requires pool manager" throw should escalate to the standby-pool or the
// cold-deploy path.

import { onloadVm, type SshTarget } from '../providers/gpu/vm-offload';

/** Four discrete wake tiers tracked per pool slot. */
export type PoolSlotTier = 'T0_warm' | 'T1_offloaded' | 'T2_stopped' | 'T4_cold';

/**
 * One entry in the temperature-aware pool. The router never mutates
 * vmId / endpoint / sshHost — those belong to the pool manager. It only
 * transitions `tier` when a wake completes successfully and remembers the
 * in-flight `wakePromise` to dedupe concurrent wake calls.
 */
export interface PoolSlot {
  vmId: string;
  endpoint: string;
  sshHost?: string;
  sshPort?: number;
  tier: PoolSlotTier;
  lastRequestAt: number;
  wakePromise?: Promise<void>;
}

/**
 * SSH execution contract used to wake T1 slots. Takes a host and a shell
 * script and returns its stdout. Tests swap this in; production wiring
 * delegates to onloadVm which already handles the /tmp/bench.onload
 * protocol.
 */
export interface SshExec {
  (host: string, script: string, timeoutMs?: number): Promise<string>;
}

/** Estimated wake duration per tier in milliseconds. */
const WAKE_ESTIMATE_MS: Record<PoolSlotTier, number> = {
  T0_warm: 0,
  T1_offloaded: 1_300,
  T2_stopped: 65_000,
  T4_cold: 205_000,
};

const TIER_PRIORITY: Record<PoolSlotTier, number> = {
  T0_warm: 0,
  T1_offloaded: 1,
  T2_stopped: 2,
  T4_cold: 3,
};

/**
 * Pick the hottest slot — coldest tier first, then least-recently-used within
 * that tier. Returns estimated wake latency in ms for the selected slot so
 * callers can decide whether to wait or fall through to a cold deploy.
 */
export function pickHottestSlot(slots: PoolSlot[]): {
  slot: PoolSlot | null;
  estimatedWakeMs: number;
} {
  if (!slots.length) return { slot: null, estimatedWakeMs: 0 };
  const sorted = [...slots].sort((a, b) => {
    const tierDiff = TIER_PRIORITY[a.tier] - TIER_PRIORITY[b.tier];
    if (tierDiff !== 0) return tierDiff;
    return a.lastRequestAt - b.lastRequestAt;
  });
  const slot = sorted[0];
  return { slot, estimatedWakeMs: WAKE_ESTIMATE_MS[slot.tier] };
}

/**
 * Minimal-ssh wake used by the router. Production callers can pass a real
 * ssh executor; the default adapter wires directly into `onloadVm`.
 */
function buildOnloadCaller(ssh?: SshExec): (slot: PoolSlot) => Promise<boolean> {
  if (ssh) {
    return async (slot) => {
      if (!slot.sshHost) return false;
      await ssh(slot.sshHost, 'touch /tmp/bench.onload && while [ ! -f /tmp/bench.ready ]; do sleep 0.25; done', 5_000);
      return true;
    };
  }
  return async (slot) => {
    if (!slot.sshHost || !slot.sshPort) return false;
    const target: SshTarget = { host: slot.sshHost, port: slot.sshPort };
    return onloadVm(target, { timeoutMs: 5_000 });
  };
}

/**
 * Wake a slot to T0. No-op for T0. T1 issues an onload via SSH and flips
 * the tier on success. T2/T4 require the pool manager (provider start /
 * fresh deploy), so the router throws rather than pretending to handle them.
 * Concurrent calls on the same slot share a single in-flight promise.
 */
export async function wakeSlot(slot: PoolSlot, ssh?: SshExec): Promise<void> {
  if (slot.tier === 'T0_warm') return;
  if (slot.tier === 'T2_stopped' || slot.tier === 'T4_cold') {
    throw new Error(`wakeSlot: tier=${slot.tier} requires pool manager`);
  }
  if (slot.wakePromise) return slot.wakePromise;
  const onload = buildOnloadCaller(ssh);
  const p = (async () => {
    try {
      const ok = await onload(slot);
      if (ok) slot.tier = 'T0_warm';
      else throw new Error(`wakeSlot: onload failed for ${slot.vmId}`);
    } finally {
      slot.wakePromise = undefined;
    }
  })();
  slot.wakePromise = p;
  return p;
}
