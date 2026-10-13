import { activeWindow } from './autoscale';
import type { BootPhase, BootState } from './boot-track';
import type { DeploymentRecord } from './types';

export const STUCK_RETRY_MAX = 2;
export const STUCK_RETRY_COOLDOWN_MS = 3 * 60_000;
const ATTEMPTS_KEPT = 10;

export interface StuckRetry {
  at: number;
  replicaId: string;
  where: string;
  phase: BootPhase;
  minutes: number;
  attempt: number;
  next: { replicaId: string; where: string } | null;
}

export interface StuckRetryState { episodeStart: number; lastAt: number; exhausted: boolean; attempts: StuckRetry[] }

export const freshStuckRetry = (): StuckRetryState => ({ episodeStart: 0, lastAt: -Infinity, exhausted: false, attempts: [] });

export const episodeAttempts = (s: StuckRetryState) => s.attempts.filter(a => a.at >= s.episodeStart).length;

export function wantedNow(record: Pick<DeploymentRecord, 'spec' | 'warm' | 'lastRequestAt'>, load: { waiting: number; inflight: number }, now: number): boolean {
  const { spec } = record;
  if (spec.paused) return false;
  return load.waiting > 0 || load.inflight > 0 || spec.minReplicas > 0 || Boolean(activeWindow(spec.warmSchedule, now))
    || (record.warm !== undefined && record.warm.until > now)
    || (record.lastRequestAt !== null && now - record.lastRequestAt < spec.idleMinutes * 60_000);
}

export type StuckVerdict = 'off' | 'unwanted' | 'exhausted' | 'cooldown' | 'refused' | 'retry';

export function stuckVerdict(input: { enabled: boolean; wanted: boolean; state: StuckRetryState; refusal: string | null; now: number }): StuckVerdict {
  if (!input.enabled) return 'off';
  if (!input.wanted) return 'unwanted';
  if (episodeAttempts(input.state) >= STUCK_RETRY_MAX) return 'exhausted';
  if (input.now - input.state.lastAt < STUCK_RETRY_COOLDOWN_MS) return 'cooldown';
  return input.refusal ? 'refused' : 'retry';
}

export function noteStuckRetry(s: StuckRetryState, stuck: BootState, where: string, now: number): StuckRetry {
  if (!episodeAttempts(s)) s.episodeStart = now;
  const entry: StuckRetry = {
    at: now, replicaId: stuck.replicaId!, where, phase: stuck.phase, minutes: Math.round(stuck.phaseMinutes), attempt: episodeAttempts(s) + 1, next: null,
  };
  s.attempts = [...s.attempts, entry].slice(-ATTEMPTS_KEPT);
  s.lastAt = now;
  return entry;
}

export function closeEpisode(s: StuckRetryState, now: number): void {
  s.episodeStart = now;
  s.exhausted = false;
}
