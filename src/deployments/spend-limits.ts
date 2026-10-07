/**
 * Cost limits of the deployments controller, read from env (one place, so `index.ts` stays a list of wiring):
 *   DEPLOYMENTS_MAX_STOPPED        parked (stopped) replicas allowed across all deployments; default 8. They bill disk
 *                                  only, so they do not use the running cap (`DEPLOYMENTS_MAX_REPLICAS`) but must not pile up.
 *   DEPLOYMENTS_MAX_EUR_PER_HOUR   ceiling on the summed hourly price of all running replicas; default 6, 0 = off. A create
 *                                  that would pass it is refused with a clear `lastError`.
 *   DEPLOYMENTS_PARKED_MAX_HOURS   a parked replica unused this long is deleted (a forgotten park bills its disk
 *                                  forever); default 72 (a weekend), 0 = off.
 */

import { DEFAULT_MAX_EUR_PER_HOUR, DEFAULT_MAX_STOPPED, DEFAULT_PARKED_MAX_MS } from './controller';

function num(raw: string | undefined, fallback: number, min: number): number {
  const v = raw?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function spendLimitsFromEnv(env: Record<string, string | undefined>): {
  maxStoppedReplicas: number; maxEurPerHour: number; parkedMaxMs: number;
} {
  return {
    maxStoppedReplicas: Math.floor(num(env.DEPLOYMENTS_MAX_STOPPED, DEFAULT_MAX_STOPPED, 0)),
    maxEurPerHour: num(env.DEPLOYMENTS_MAX_EUR_PER_HOUR, DEFAULT_MAX_EUR_PER_HOUR, 0),
    parkedMaxMs: num(env.DEPLOYMENTS_PARKED_MAX_HOURS, DEFAULT_PARKED_MAX_MS / 3_600_000, 0) * 3_600_000,
  };
}
