import type { PressureDecision, PressureState } from './autoscale';
import type { DeploymentSpec, ScalingMode } from './types';

export const DEFAULT_BOOT_SECONDS = 600;
export const DEFAULT_RESUME_SECONDS = 180;
const BURST_MEMORY_SECONDS = 60;
const EPISODE_GAP_SECONDS = 120;
const TRACE_MAX_MS = 3_600_000;
const TRACE_MAX_SAMPLES = 5_000;

const SCALING_MODES: Record<ScalingMode, { eurPerFallbackMinute: number; trend: boolean; burst: boolean; spare: boolean }> = {
  economy: { eurPerFallbackMinute: 0.02, trend: false, burst: false, spare: false },
  balanced: { eurPerFallbackMinute: 0.1, trend: true, burst: true, spare: false },
  fast: { eurPerFallbackMinute: Infinity, trend: true, burst: true, spare: true },
};

export interface LoadSample { at: number; level: number; refused: number; sessions: number | null }

export function noteLoad(trace: LoadSample[], sample: LoadSample): void {
  const last = trace.at(-1);
  if (last && last.level === sample.level && last.sessions === sample.sessions && sample.refused === 0) return;
  trace.push(sample);
  while (trace.length > TRACE_MAX_SAMPLES || (trace.length > 1 && trace[1].at < sample.at - TRACE_MAX_MS)) trace.shift();
}

export function loadCurve(
  trace: LoadSample[], seconds: number, now: number, refusedHoldMs: number,
): { levels: number[]; loads: number[]; sessions: number[] } {
  const levels: number[] = [];
  const loads: number[] = [];
  const sessions: number[] = [];
  let next = 0;
  let held = 0;
  let level = 0;
  let seated = 0;
  for (let back = seconds - 1; back >= 0; back--) {
    const t = now - back * 1000;
    for (; next < trace.length && trace[next].at <= t; next++) { level = trace[next].level; seated = trace[next].sessions ?? 0; }
    while (held < next && trace[held].at <= t - refusedHoldMs) held++;
    let refused = 0;
    for (let i = held; i < next; i++) refused += trace[i].refused;
    levels.push(level);
    loads.push(level + refused);
    sessions.push(seated);
  }
  return { levels, loads, sessions };
}

export function episodeExcess(loads: number[], capacity: number): number {
  let sum = 0;
  let quiet = 0;
  for (let i = loads.length - 1; i >= 0 && quiet < EPISODE_GAP_SECONDS; i--) {
    const over = loads[i] - capacity;
    if (over > 0) { sum += over; quiet = 0; } else quiet++;
  }
  return sum;
}

export interface ScalingInput {
  spec: DeploymentSpec;
  trace: LoadSample[];
  refusedHoldMs: number;
  now: number;
  live: number;
  maxReplicas: number;
  capNote: string;
  price: number;
  bootSeconds: number;
  idleSeconds: number;
  active: boolean;
  state: PressureState;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const eur = (n: number) => `€${n.toFixed(2)}`;

export function scalingDecision(input: ScalingInput): PressureDecision {
  const { spec, live, state } = input;
  if (!input.active || !spec.scaling) return { desired: 0, highSince: null, reason: 'idle', capped: false };
  const mode = SCALING_MODES[spec.scaling.mode];
  const target = spec.targetInflightPerReplica;
  const horizon = input.bootSeconds + input.idleSeconds;
  const curve = loadCurve(input.trace, Math.max(horizon, BURST_MEMORY_SECONDS), input.now, input.refusedHoldMs);
  const { loads } = curve;
  const sessionsKnown = input.trace.at(-1)?.sessions != null;
  const occupancy = sessionsKnown ? curve.sessions : curve.levels;
  const level = curve.levels[curve.levels.length - 1];
  const occupied = occupancy[occupancy.length - 1];
  const capacity = target * live;
  const peak = Math.max(...loads.slice(-BURST_MEMORY_SECONDS));
  const fallbackMinutes = episodeExcess(loads, capacity) / 60;
  const startCost = input.price * horizon / 3600;
  const trendSeconds = Math.round(input.bootSeconds / 2);
  const recent = curve.sessions.slice(-trendSeconds - 1);
  const rises = recent.flatMap((v, i) => (i > 0 && v > recent[i - 1] ? [i] : []));
  const sustained = sessionsKnown && rises.length > 0 && rises[rises.length - 1] - rises[0] >= trendSeconds / 2
    && recent.length - 1 - rises[rises.length - 1] <= trendSeconds / 2;
  const growth = occupied - recent[0];
  const projected = occupied + 2 * growth;

  const asks: Array<[number, string]> = [];
  if (mode.burst && peak - capacity >= target) {
    asks.push([Math.ceil(peak / target), `burst: load ${round1(peak)} is a full replica above capacity ${capacity}`]);
  }
  if (fallbackMinutes > 0 && fallbackMinutes * mode.eurPerFallbackMinute >= startCost) {
    const worth = Number.isFinite(mode.eurPerFallbackMinute) ? `${eur(fallbackMinutes * mode.eurPerFallbackMinute)} at the ${spec.scaling.mode} rate` : 'fast: any excess';
    asks.push([Math.max(live + 1, Math.ceil(level / target)),
      `fallback took ${round1(fallbackMinutes)} load-minutes above capacity ${capacity} (${worth}) ≥ ${eur(startCost)} for one replica start`]);
  }
  if (mode.trend && sustained && growth > 0 && projected > capacity) {
    asks.push([Math.min(Math.ceil(projected / target), Math.ceil(occupied / target) + 1),
      `trend: sessions at ${round1(occupied)}, +${round1(growth)} in ${trendSeconds} s, ${round1(projected)} by the time a replica is ready > capacity ${capacity}`]);
  }
  if (mode.spare && occupied >= target / 2) asks.push([Math.ceil(occupied / target) + 1, `fast: one spare replica at load ${round1(occupied)}`]);
  const [ask, why] = asks.reduce((best, a) => (a[0] > best[0] ? a : best), [0, 'steady']);

  if (ask > state.desired) {
    const desired = Math.min(input.maxReplicas, ask);
    const startedAt = desired > state.desired ? input.now : state.highSince;
    return { desired, highSince: startedAt, reason: ask > input.maxReplicas ? `${why} (${input.capNote})` : why, capped: false };
  }
  const committed = state.highSince !== null && input.now - state.highSince < horizon * 1000;
  const quiet = Math.max(...loads.slice(-input.idleSeconds));
  const spare = mode.spare && Math.max(...occupancy.slice(-input.idleSeconds)) >= target / 2 ? 1 : 0;
  const keep = Math.max(ask, Math.ceil(quiet / target) + spare);
  if (!committed && keep < state.desired) {
    return { desired: keep, highSince: state.highSince, reason: `low load: peak ${round1(quiet)} in the last ${Math.round(input.idleSeconds / 60)} min fits ${keep}`, capped: false };
  }
  return { desired: state.desired, highSince: state.highSince, reason: 'steady', capped: false };
}

export function median(values: number[] | undefined): number | null {
  if (!values?.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}
