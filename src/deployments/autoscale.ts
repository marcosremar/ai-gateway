/**
 * Pressure-based autoscaling for one deployment (pure: no I/O, no clock of its own — every rule is unit-tested and the
 * simulation bench `scripts/autoscale-sim/` drives it on a virtual clock).
 *
 * The planner (`planner.ts`) keeps its base rules (min / idle base / instant load / floors); this module adds what the
 * live QA of 2026-10-07 showed was missing — a GPU replica boots in 8–9 min, so scaling only when `inflight` passes the
 * target at the tick is too late and too blind:
 *
 *   - **Signals.** Load (requests in flight + waiting + turned away for lack of capacity), p95 latency of the requests
 *     the replicas answered, and the share of them that hit a time limit or a 429. Load above `scaleOutAt` (75 %) of
 *     the live capacity, or latency / errors above their targets, for `windowSeconds` (20 s) in a row → one scale step.
 *   - **Boot-time aware.** Booting replicas count as capacity: latency and error signals (which only measure the ready
 *     replicas) add nothing while one boots; only load that exceeds ready + booting capacity asks for more.
 *   - **Hysteresis.** Out at 75 % of capacity, in only when the load fits in one replica fewer (than the count asked
 *     for, or the live one if larger) at `scaleInAt` (50 %), so a load hovering around a threshold never flaps, and a
 *     create that never succeeded is dropped once its pressure is gone; the planner's `scaleDownDelaySeconds` then
 *     delays the release, and the controller drains it first.
 *   - **Floors.** A warm-up schedule (`warmSchedule`) and a client warm window (`POST …/warm`) keep N replicas up for a
 *     time window regardless of load (a class starting at 9:00 must not switch voice mid-lesson).
 *
 * Design choices to pilot (no published value applies to this workload): 75 % / 50 % / 20 s / p95 and error targets.
 * The 75 % early trigger follows from the boot time: at the measured ~9 min boot, a load growing at the rate of the
 * 4→8→16 ramp of the live test reaches 100 % before a replica started at 100 % could serve.
 */

import type { DeploymentSpec, WarmScheduleEntry } from './types';

export interface AutoscaleSettings {
  /** Fraction of `targetInflightPerReplica` × live replicas above which load is pressure. */
  scaleOutAt: number;
  /** Fraction of the target one replica fewer must carry the load at before scaling in. */
  scaleInAt: number;
  /** How long a signal must stay high before a scale step (ms). */
  windowMs: number;
  /** p95 latency target of answered requests (ms); null = latency is not a signal. */
  latencyP95Ms: number | null;
  /** Share of timed-out / 429 requests above which errors are pressure. */
  errorRate: number;
  /** A replica takes at most `targetInflightPerReplica` × this; the overflow goes to the fallback at once. */
  maxInflightFactor: number;
  /** Longest wait for a draining replica's requests before it is released anyway (ms). */
  drainMs: number;
}

export const AUTOSCALE_DEFAULTS = {
  scaleOutAt: 0.75, scaleInAt: 0.5, windowSeconds: 20, errorRate: 0.1, maxInflightFactor: 1.5, drainSeconds: 120,
} as const;

/** Minimum answered requests in the window before latency and error rate count (fewer is noise). */
export const MIN_SIGNAL_SAMPLES = 5;

export function autoscaleSettings(spec: DeploymentSpec): AutoscaleSettings {
  const a = spec.autoscale ?? {};
  return {
    scaleOutAt: a.scaleOutAt ?? AUTOSCALE_DEFAULTS.scaleOutAt,
    scaleInAt: a.scaleInAt ?? AUTOSCALE_DEFAULTS.scaleInAt,
    windowMs: (a.windowSeconds ?? AUTOSCALE_DEFAULTS.windowSeconds) * 1000,
    latencyP95Ms: a.latencyP95Ms ?? null,
    errorRate: a.errorRate ?? AUTOSCALE_DEFAULTS.errorRate,
    maxInflightFactor: a.maxInflightFactor ?? AUTOSCALE_DEFAULTS.maxInflightFactor,
    drainMs: (a.drainSeconds ?? AUTOSCALE_DEFAULTS.drainSeconds) * 1000,
  };
}

/** Most requests one replica may carry before new ones spill to the fallback (`ceil(target × maxInflightFactor)`). */
export function replicaCapacity(spec: DeploymentSpec): number {
  return Math.max(1, Math.ceil(spec.targetInflightPerReplica * autoscaleSettings(spec).maxInflightFactor));
}

export interface PressureState {
  /** Since when a signal has been high without a break (null = not high). */
  highSince: number | null;
  /** The replica count pressure asks for (sticky: hysteresis lives here). */
  desired: number;
}

export interface PressureInput {
  spec: DeploymentSpec;
  /** Requests in flight + waiting + turned away for lack of capacity (recent). */
  load: number;
  /** Replicas serving or about to (ready + booting), draining ones excluded. */
  live: number;
  booting: number;
  /** p95 latency of answered requests in the recent window, and how many there were. */
  p95Ms: number | null;
  /** Share of recent requests that timed out or got a 429 from the replica. */
  errorRate: number;
  samples: number;
  /** Deployment in use (planner `isActive`): an idle one never scales by pressure. */
  active: boolean;
  now: number;
  state: PressureState;
}

export interface PressureDecision extends PressureState {
  /** Why `desired` is what it is (`load …`, `p95 …`, `errors …`, `low load …`, `steady`, `idle`). */
  reason: string;
  /** Pressure asks for more than `maxReplicas`. */
  capped: boolean;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function pressureDecision(input: PressureInput): PressureDecision {
  const { spec, load, live, booting, now, state } = input;
  if (!input.active) return { desired: 0, highSince: null, reason: 'idle', capped: false };
  const s = autoscaleSettings(spec);
  const target = spec.targetInflightPerReplica;
  const outAt = target * s.scaleOutAt;
  const loadNeed = Math.ceil(load / outAt);
  const loadHigh = live > 0 && load > outAt * live;
  const enough = input.samples >= MIN_SIGNAL_SAMPLES;
  const latencyHigh = enough && s.latencyP95Ms !== null && input.p95Ms !== null && input.p95Ms > s.latencyP95Ms;
  const errorsHigh = enough && input.errorRate > s.errorRate;
  // Latency and errors measure the ready replicas: with one booting, its capacity is on the way — wait for it.
  const high = loadHigh || ((latencyHigh || errorsHigh) && booting === 0);
  let highSince = high ? state.highSince ?? now : null;
  let desired = state.desired;
  let reason = 'steady';
  const why = () => (loadHigh ? `load ${round1(load)} > ${pct(s.scaleOutAt)} of ${live}×${target}`
    : latencyHigh ? `p95 ${Math.round(input.p95Ms!)} ms > ${s.latencyP95Ms} ms` : `errors ${pct(input.errorRate)} > ${pct(s.errorRate)}`);
  const step = loadHigh ? Math.max(loadNeed, live + 1) : live + 1;
  const capped = high && step > spec.maxReplicas && live >= spec.maxReplicas;
  if (capped) {
    desired = spec.maxReplicas; // nothing more to ask: say why, and do not re-arm a window for nothing
    reason = `${why()} (at maxReplicas ${spec.maxReplicas})`;
  } else if (high && desired > live && desired >= Math.min(step, spec.maxReplicas)) {
    // Already asked, the replica is not there yet (its create is in flight or keeps failing): say so instead of a window
    // count that re-arms every 20 s for nothing; the next step needs a full window once the asked replica exists.
    reason = `${why()} (${desired} asked, waiting for ${desired - live})`;
    highSince = now;
  } else if (high && highSince !== null && now - highSince >= s.windowMs) {
    desired = Math.min(spec.maxReplicas, Math.max(desired, step));
    reason = why();
    highSince = now; // the next step needs another full window: one step at a time, no runaway while replicas boot
  } else if (high) {
    reason = `pressure for ${Math.round((now - (highSince ?? now)) / 1000)} s (step after ${s.windowMs / 1000} s)`;
  } else {
    // Hysteresis against the count ASKED for, not only the live one: a replica that was asked but never born (create
    // failing `out of stock`, live QA 2026-10-07: 17 min) left `live` at 1, so `load ≤ 50 % × target × (live − 1)` only
    // held at load 0 and the pending create kept being retried with no pressure left. Comparing with one fewer than
    // max(desired, live) lets the pressure that went away cancel the create it asked for.
    const count = Math.max(desired, live);
    if (count > 0 && load <= s.scaleInAt * target * (count - 1)) {
      const fits = Math.ceil(load / (s.scaleInAt * target));
      if (fits < desired) {
        const pending = desired > live ? `, pending create of ${desired - live} cancelled` : '';
        desired = fits;
        reason = `low load ${round1(load)} ≤ ${pct(s.scaleInAt)} of ${count - 1}×${target}${pending}`;
      }
    }
  }
  return { desired: Math.max(0, desired), highSince, reason, capped };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** p95 of a list of durations (ms), or null when empty. */
export function p95(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export const DEFAULT_WARM_TIME_ZONE = 'Europe/Paris';

/** Weekday (0 = Sunday) and minutes since midnight of `now` in `timeZone`. */
export function localClock(now: number, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(now));
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return { day: DAY_NAMES.indexOf(get('weekday').toLowerCase().slice(0, 3)), minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

export const hhmm = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));

/** Replicas the schedule asks for at `now` (the largest of the entries in their window), 0 outside every window. */
export function scheduleFloor(schedule: WarmScheduleEntry[] | undefined, now: number): number {
  let floor = 0;
  for (const entry of schedule ?? []) {
    const { day, minutes } = localClock(now, entry.timeZone ?? DEFAULT_WARM_TIME_ZONE);
    const start = hhmm(entry.start);
    const end = hhmm(entry.end);
    // An overnight window (22:00–02:00) belongs to the day it started.
    const inWindow = start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
    const startDay = start <= end || minutes >= start ? day : (day + 6) % 7;
    if (inWindow && (!entry.days?.length || entry.days.includes(startDay))) floor = Math.max(floor, entry.minReplicas);
  }
  return floor;
}

/** The floor of replicas at `now`: schedule and client warm window (`POST …/warm`), whichever asks more. */
export function warmFloor(spec: DeploymentSpec, warm: { replicas: number; until: number } | undefined, now: number): number {
  const fromWarm = warm && now < warm.until ? warm.replicas : 0;
  return Math.min(spec.maxReplicas, Math.max(scheduleFloor(spec.warmSchedule, now), fromWarm));
}
