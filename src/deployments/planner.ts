/**
 * Pure scaling decision for one deployment. The controller observes (provider list + health probes + request
 * counters), calls `planReplicas`, and executes the returned actions. No I/O here, so every rule is unit-tested.
 *
 * Rules:
 *   - desired = clamp(max(base, ceil((inflight + waiting) / targetInflightPerReplica)), min, max)
 *     where base = max(min, 1) while the deployment is active (a request in flight / waiting, or one in the last
 *     `idleMinutes`) and `min` otherwise — so `minReplicas: 0` scales to zero after the idle window.
 *   - Broken replicas are replaced: provider halted it, boot took longer than `bootTimeoutMinutes`, it stopped
 *     answering health for `unhealthyStrikes` checks in a row, or it reached `maxHours`.
 *   - The idle window counts from the later of the last request and the moment a replica became ready after it,
 *     and a replica booting for the current activity keeps the deployment active: a cold start longer than
 *     `idleMinutes` (a 59 GB speech image boots in ~12 min) is never killed mid-boot by its own idle clock.
 *   - Scale-down above the idle base waits `scaleDownDelaySeconds` of low load (no flapping on bursts) and never
 *     picks a replica with requests in flight. Going idle scales down at once.
 */

import type { DeploymentSpec, ReplicaMachine, ReplicaPhase } from './types';

export const UNHEALTHY_STRIKES = 3;

const HALTED_STATES = new Set(['stopped', 'stopped in place', 'stopping', 'locked', 'archived']);

export interface ObservedReplica {
  machine: ReplicaMachine;
  /** Ready probe answered OK at least once. */
  everReady: boolean;
  /** Ready probe answered OK on the latest check. */
  readyNow: boolean;
  /** Consecutive failed probes since the last success (only counted after `everReady`). */
  failures: number;
  inflight: number;
  /** First successful ready probe (ms). */
  readyAt?: number;
}

export interface PlanInput {
  spec: DeploymentSpec;
  replicas: ObservedReplica[];
  inflight: number;
  waiting: number;
  lastRequestAt: number | null;
  /** Since when the live replica count has been above desired (hysteresis memory), or null. */
  aboveSince: number | null;
  now: number;
}

export interface PlanRelease {
  id: string;
  reason: 'halted' | 'boot-timeout' | 'unhealthy' | 'max-hours' | 'scale-down' | 'paused';
}

export interface Plan {
  desired: number;
  create: number;
  release: PlanRelease[];
  aboveSince: number | null;
  active: boolean;
}

export function replicaPhase(r: ObservedReplica): ReplicaPhase {
  if (HALTED_STATES.has(r.machine.state)) return 'halted';
  if (r.readyNow) return 'ready';
  if (r.everReady) return 'unhealthy';
  return 'booting';
}

type ActivityInput = Pick<PlanInput, 'spec' | 'inflight' | 'waiting' | 'lastRequestAt' | 'now'> & { replicas?: ObservedReplica[] };

export function isActive(input: ActivityInput): boolean {
  if (input.inflight > 0 || input.waiting > 0) return true;
  const last = input.lastRequestAt;
  if (last == null) return false;
  const windowMs = input.spec.idleMinutes * 60_000;
  const replicas = input.replicas ?? [];
  // Still warming up for this activity: a replica created inside the window that has not answered ready yet.
  if (replicas.some(r => !r.everReady && r.machine.createdAt >= last - windowMs && replicaPhase(r) === 'booting')) return true;
  // Cold start: if nothing was ready at the request, the clock starts when the first replica could serve it.
  const servedAtRequest = replicas.some(r => r.readyAt != null && r.readyAt <= last);
  const firstReadyAfter = Math.min(...replicas.map(r => r.readyAt ?? Infinity).filter(t => t > last));
  const idleFrom = servedAtRequest || !Number.isFinite(firstReadyAfter) ? last : firstReadyAfter;
  return input.now - idleFrom < windowMs;
}

export function desiredReplicas(input: ActivityInput): number {
  const { spec } = input;
  if (spec.paused) return 0;
  const active = isActive(input);
  const base = active ? Math.max(spec.minReplicas, spec.minActiveReplicas ?? 1, 1) : spec.minReplicas;
  const byLoad = Math.ceil((input.inflight + input.waiting) / spec.targetInflightPerReplica);
  return Math.min(spec.maxReplicas, Math.max(spec.minReplicas, base, byLoad));
}

function brokenReason(r: ObservedReplica, spec: DeploymentSpec, now: number): PlanRelease['reason'] | null {
  const phase = replicaPhase(r);
  if (phase === 'halted') return 'halted';
  const age = now - r.machine.createdAt;
  if (age >= spec.maxHours * 3_600_000) return 'max-hours';
  if (phase === 'booting' && age >= spec.bootTimeoutMinutes * 60_000) return 'boot-timeout';
  if (phase === 'unhealthy' && r.failures >= UNHEALTHY_STRIKES) return 'unhealthy';
  return null;
}

/** Order in which surplus replicas are removed: not-yet-serving first, then the least busy, then the newest. */
function removalOrder(a: ObservedReplica, b: ObservedReplica): number {
  const rank = (r: ObservedReplica) => (replicaPhase(r) === 'ready' ? 1 : 0);
  return rank(a) - rank(b) || a.inflight - b.inflight || b.machine.createdAt - a.machine.createdAt;
}

export function planReplicas(input: PlanInput): Plan {
  const { spec, now } = input;
  const active = isActive(input);
  const desired = desiredReplicas(input);
  const release: PlanRelease[] = [];

  const live: ObservedReplica[] = [];
  for (const r of input.replicas) {
    const reason = spec.paused ? 'paused' : brokenReason(r, spec, now);
    if (reason) release.push({ id: r.machine.id, reason });
    else live.push(r);
  }

  if (live.length < desired) {
    return { desired, create: desired - live.length, release, aboveSince: null, active };
  }
  if (live.length === desired) return { desired, create: 0, release, aboveSince: null, active };

  const aboveSince = input.aboveSince ?? now;
  const delayOver = now - aboveSince >= spec.scaleDownDelaySeconds * 1000;
  if (active && !delayOver) return { desired, create: 0, release, aboveSince, active };

  const surplus = [...live].filter(r => r.inflight === 0).sort(removalOrder).slice(0, live.length - desired);
  for (const r of surplus) release.push({ id: r.machine.id, reason: 'scale-down' });
  const stillAbove = live.length - surplus.length > desired;
  return { desired, create: 0, release, aboveSince: stillAbove ? aboveSince : null, active };
}
