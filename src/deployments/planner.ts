/**
 * Pure scaling decision for one deployment. The controller observes (provider list + health probes + request
 * counters), calls `planReplicas`, and executes the returned actions. No I/O here, so every rule is unit-tested.
 *
 * Rules:
 *   - desired = clamp(max(base, ceil(load / targetInflightPerReplica)), min, max), load = inflight + waiting, or
 *     while active the recent peak `demand` (requests refused for lack of a ready replica included)
 *     where base = max(min, 1) while the deployment is active (a request in flight / waiting, or one in the last
 *     `idleMinutes`) and `min` otherwise — so `minReplicas: 0` scales to zero after the idle window.
 *   - Broken replicas are replaced: provider halted it, boot took longer than `bootTimeoutMinutes`, it stopped
 *     answering health for `unhealthyStrikes` checks in a row. One past `maxHours` is handed over: a replacement is
 *     created (at most `maxReplicas` + 1 up), and it goes once empty, one per tick, when the others ready cover
 *     `desired` — or, `MAX_HOURS_GRACE_MS` later, when at least one other is ready (never the last one serving). A replica with requests in
 *     flight, or that answered one recently (`servedRecently`), is busy, not dead: never released as unhealthy (live
 *     QA 2026-10-07: under 16 concurrent chats the L40S missed its health checks and was replaced twice, 9 min each).
 *   - The idle window counts from the later of the last request and the moment a replica became ready after it,
 *     and a replica booting for the current activity keeps the deployment active: a cold start longer than
 *     `idleMinutes` (a 59 GB speech image boots in ~12 min) is never killed mid-boot by its own idle clock.
 *   - Gateway-wide guard (`pinnedIdleMaxMs`, DEPLOYMENTS_PINNED_IDLE_MAX_MINUTES): replicas kept only by `minReplicas`
 *     go to zero after that long with no request and no change to the spec — a pin left on by mistake (a test, a
 *     class that ended) stops billing. The spec stays: the next request, `wake` or PATCH brings them back.
 *   - A replica whose host ends within `EXPIRY_HANDOVER_MS` (Vast rental end, `expiry.ts`) no longer counts as
 *     capacity, so its replacement is created at once; it keeps serving until enough other replicas are ready, then
 *     is released as `expiring` as soon as it has no request in flight (the router already sends new ones elsewhere).
 *   - Scale-down above the idle base waits `scaleDownDelaySeconds` of low load (no flapping on bursts) and never
 *     releases a replica with requests in flight: with `drainBusy` such surplus is returned in `drain` (no new request,
 *     released once empty). Going idle scales down at once. A ready replica is never surplus while that would leave
 *     fewer ready replicas than `desired`: with one ready and one still booting for `desired` 1, nothing goes until
 *     the boot finishes (simulator 2026-10-07: the only ready replica was released the tick it turned ready).
 *   - `floor` (warm-up schedule / client warm window) and `autoscaleWant` (pressure, `autoscale.ts`) raise `desired`.
 *   - `autoscaleOnly` (a spec with a `scaling` block): load no longer sizes the count, `autoscaleWant` alone does;
 *     `hold` (`scaling.hold`) fixes `desired` at that count, whatever the load, floors and activity.
 *   - A replica still booting is never released for idleness or surplus: the boot finishes and the idle rules apply
 *     from its ready time (live QA 2026-10-07: `idleMinutes: 1` released an L40S at 172 s of its ~9 min boot, and each
 *     sparse request paid a new boot). Only a delete, pause, park (`lastRequestAt` null), the pinned-idle guard or the
 *     boot timeout end a boot early.
 */

import { isExpiring } from './expiry';
import type { DeploymentSpec, ReplicaMachine, ReplicaPhase } from './types';

export const UNHEALTHY_STRIKES = 3;

// `exited`: a Vast container that stopped (it still bills its disk), deleted like any halted replica.
const HALTED_STATES = new Set(['stopped', 'stopped in place', 'stopping', 'locked', 'archived', 'exited']);

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
  /** Answered a forwarded request within the controller's busy grace: alive, whatever the probe says. */
  servedRecently?: boolean;
  /** How long its liveness probe (the front, `/__aigw/ready`) has failed without a break (absent = it answers). */
  downForMs?: number;
  bootStartedAt?: number;
  adoptedPastBoot?: boolean;
}

export const VAST_MIN_BOOT_TIMEOUT_MINUTES = 35;

export function bootTimeoutMinutesOn(spec: Pick<DeploymentSpec, 'bootTimeoutMinutes'>, provider: string | undefined): number {
  return provider === 'vast' ? Math.max(spec.bootTimeoutMinutes, VAST_MIN_BOOT_TIMEOUT_MINUTES) : spec.bootTimeoutMinutes;
}

/** A replica whose front stopped answering this long is dead (crashed host), whatever it served before. */
export const DOWN_GRACE_MS = 30_000;

export const MAX_HOURS_GRACE_MS = 20 * 60_000;

export function outlived(machine: Pick<ReplicaMachine, 'createdAt'>, spec: Pick<DeploymentSpec, 'maxHours'>, now: number, graceMs = 0): boolean {
  return now - machine.createdAt >= spec.maxHours * 3_600_000 + graceMs;
}

export interface PlanInput {
  spec: DeploymentSpec;
  replicas: ObservedReplica[];
  inflight: number;
  waiting: number;
  lastRequestAt: number | null;
  /** Gateway-wide: replicas kept by `minReplicas` alone go to zero after this long unused (0/absent = off). */
  pinnedIdleMaxMs?: number;
  /** When the spec last changed (a PUT/PATCH is intent: it restarts the pinned-idle clock). */
  specUpdatedAt?: number;
  /** Since when the live replica count has been above desired (hysteresis memory), or null. */
  aboveSince: number | null;
  now: number;
  /** Failed probes in a row before an idle, silent replica is replaced. Default `UNHEALTHY_STRIKES`. */
  unhealthyStrikes?: number;
  /**
   * Recent peak load (served + waiting + refused for lack of a ready replica), when above the instant `inflight +
   * waiting`: sizes the replica count while the deployment is active, so a burst still scales out after it ended.
   */
  demand?: number;
  /** Surplus replicas with requests in flight are returned in `drain` instead of being kept (the controller drains). */
  drainBusy?: boolean;
  /** Replicas pressure asks for (`autoscale.ts` `pressureDecision`); applies while active. */
  autoscaleWant?: number;
  /** Replicas a warm-up schedule or a client warm window keeps up now, whatever the load (`warmFloor`). */
  floor?: number;
  autoscaleOnly?: boolean;
  hold?: number;
}

export interface PlanRelease {
  id: string;
  reason: 'halted' | 'boot-timeout' | 'unhealthy' | 'max-hours' | 'scale-down' | 'paused' | 'expiring';
}

export interface Plan {
  desired: number;
  create: number;
  release: PlanRelease[];
  /** Surplus replicas that still have requests in flight: drained (no new request) and released once empty. */
  drain: string[];
  aboveSince: number | null;
  active: boolean;
}

export function replicaPhase(r: ObservedReplica): ReplicaPhase {
  if (HALTED_STATES.has(r.machine.state)) return 'halted';
  if (r.readyNow) return 'ready';
  if (r.everReady) return 'unhealthy';
  return 'booting';
}

type ActivityInput = Pick<PlanInput, 'spec' | 'inflight' | 'waiting' | 'lastRequestAt' | 'now' | 'pinnedIdleMaxMs' | 'specUpdatedAt' | 'demand'
  | 'autoscaleWant' | 'floor' | 'autoscaleOnly' | 'hold'>
  & { replicas?: ObservedReplica[] };

/** A `minReplicas` pin nobody used (no request, no spec change) for `pinnedIdleMaxMs`. */
export function pinnedIdleOver(input: ActivityInput): boolean {
  const max = input.pinnedIdleMaxMs;
  if (!max || input.spec.minReplicas === 0 || input.inflight > 0 || input.waiting > 0) return false;
  const lastUse = Math.max(input.lastRequestAt ?? 0, input.specUpdatedAt ?? 0);
  return input.now - lastUse >= max;
}

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
  if (input.hold !== undefined) return Math.min(spec.maxReplicas, input.hold);
  const floor = input.floor ?? 0;
  if (pinnedIdleOver(input)) return Math.min(spec.maxReplicas, floor);
  const active = isActive(input);
  const base = active ? Math.max(spec.minReplicas, spec.minActiveReplicas ?? 1, 1) : spec.minReplicas;
  const load = Math.max(input.inflight + input.waiting, active ? input.demand ?? 0 : 0);
  const byLoad = input.autoscaleOnly ? 0 : Math.ceil(load / spec.targetInflightPerReplica);
  const pressure = active ? input.autoscaleWant ?? 0 : 0;
  return Math.min(spec.maxReplicas, Math.max(spec.minReplicas, base, byLoad, floor, pressure));
}

function brokenReason(r: ObservedReplica, spec: DeploymentSpec, now: number, strikes: number): PlanRelease['reason'] | null {
  const phase = replicaPhase(r);
  if (phase === 'halted') return 'halted';
  if (phase === 'booting' && now - (r.bootStartedAt ?? r.machine.createdAt) >= bootTimeoutMinutesOn(spec, r.machine.provider) * 60_000) {
    return r.adoptedPastBoot ? 'unhealthy' : 'boot-timeout';
  }
  // Busy is not dead: work in flight or a recent answer keeps it (it gets no new request meanwhile, see `readyNow`).
  if (phase === 'unhealthy' && r.failures >= strikes && r.inflight === 0 && !r.servedRecently) return 'unhealthy';
  // …but a front that has not answered its liveness probe for DOWN_GRACE_MS is a dead machine (nginx answers even under load).
  if (phase === 'unhealthy' && r.failures >= strikes && (r.downForMs ?? 0) >= DOWN_GRACE_MS) return 'unhealthy';
  return null;
}

/** Order in which surplus replicas are removed: not-yet-serving first, then the least busy, then the newest. */
function removalOrder(a: ObservedReplica, b: ObservedReplica): number {
  const rank = (r: ObservedReplica) => (replicaPhase(r) === 'ready' ? 1 : 0);
  return rank(a) - rank(b) || a.inflight - b.inflight || b.machine.createdAt - a.machine.createdAt;
}

export function planReplicas(input: PlanInput): Plan {
  const { spec, now } = input;
  const release: PlanRelease[] = [];

  const live: ObservedReplica[] = [];
  const expiring: ObservedReplica[] = [];
  const aged: ObservedReplica[] = [];
  for (const r of input.replicas) {
    const reason = spec.paused ? 'paused' : brokenReason(r, spec, now, input.unhealthyStrikes ?? UNHEALTHY_STRIKES);
    if (reason) release.push({ id: r.machine.id, reason });
    else if (outlived(r.machine, spec, now)) aged.push(r);
    else if (isExpiring(r.machine, now)) expiring.push(r);
    else live.push(r);
  }
  const kept = input.replicas.filter(r => !release.some(x => x.id === r.machine.id));
  const active = isActive({ ...input, replicas: kept });
  const desired = desiredReplicas({ ...input, replicas: kept });
  const readyLive = live.filter(r => replicaPhase(r) === 'ready').length;
  for (const r of expiring) {
    if (r.inflight === 0 && readyLive >= desired) release.push({ id: r.machine.id, reason: 'expiring' });
  }
  for (const r of aged) if (replicaPhase(r) !== 'ready' && r.inflight === 0) release.push({ id: r.machine.id, reason: 'max-hours' });
  const agedReady = aged.filter(r => replicaPhase(r) === 'ready').sort((x, y) => x.machine.createdAt - y.machine.createdAt);
  const othersReady = readyLive + agedReady.length - 1;
  const retiring = agedReady.find(r => r.inflight === 0
    && (othersReady >= desired || (othersReady > 0 && outlived(r.machine, spec, now, MAX_HOURS_GRACE_MS))));
  if (retiring) release.push({ id: retiring.machine.id, reason: 'max-hours' });

  if (live.length < desired) {
    const room = aged.length ? Math.max(0, spec.maxReplicas + 1 - live.length - aged.length - expiring.length) : Infinity;
    return { desired, create: Math.min(desired - live.length, room), release, drain: [], aboveSince: null, active };
  }
  if (live.length === desired) return { desired, create: 0, release, drain: [], aboveSince: null, active };

  const aboveSince = input.aboveSince ?? now;
  const delayOver = now - aboveSince >= spec.scaleDownDelaySeconds * 1000;
  if (active && !delayOver) return { desired, create: 0, release, drain: [], aboveSince, active };

  // A boot in progress is finished, not thrown away (its cost is already paid), unless parked or the pin guard fired.
  const keepBooting = input.lastRequestAt != null && !spec.paused && !pinnedIdleOver(input);
  // Idle surplus goes at once; surplus with requests in flight is drained (only when `drainBusy`: the controller then
  // stops routing to it and releases it once empty), so a steady trickle can no longer pin a scaled-out replica.
  let readySpare = readyLive - desired;
  const surplus = [...live].filter(r => (input.drainBusy || r.inflight === 0) && !(keepBooting && replicaPhase(r) === 'booting'))
    .sort(removalOrder).slice(0, live.length - desired).filter(r => replicaPhase(r) !== 'ready' || readySpare-- > 0);
  const drain: string[] = [];
  for (const r of surplus) {
    if (r.inflight === 0) release.push({ id: r.machine.id, reason: 'scale-down' });
    else drain.push(r.machine.id);
  }
  const stillAbove = live.length - surplus.length > desired;
  return { desired, create: 0, release, drain, aboveSince: stillAbove ? aboveSince : null, active };
}
