/**
 * Host rental end (Vast). A Vast host is rented until the owner's contract ends (`end_date` on the offer and on the
 * instance); at that moment the instance is taken away, whatever it is serving. Two rules keep that invisible to the
 * caller of a deployment:
 *
 *   - an offer that ends in less than `MIN_HOST_LEFT_MS` is never rented (a class or a bench must not land on a host
 *     about to go);
 *   - a replica whose host ends within `EXPIRY_HANDOVER_MS` stops counting toward the deployment's capacity, so the
 *     planner creates its replacement; it keeps serving until the replacement is ready, then takes no new request
 *     (the router prefers the others) and is released once its in-flight requests are done.
 *
 * Scaleway machines have no end date (`expiresAt` absent): nothing here applies to them.
 */

import type { ReplicaMachine } from './types';

/** An offer whose rental ends sooner than this is not rented. */
export const MIN_HOST_LEFT_MS = 24 * 3_600_000;
/** A replica whose host ends within this gets a replacement and is drained onto it. */
export const EXPIRY_HANDOVER_MS = 3_600_000;

function asNumber(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * When a Vast offer or instance stops being ours (ms), or null when the API does not say. `end_date` is a Unix time
 * (seconds; a value already in ms is accepted); `duration` (seconds left) is the fallback.
 */
export function vastEndsAt(endDate: unknown, duration: unknown, now: number): number | null {
  const end = asNumber(endDate);
  if (end !== null) return end < 1e11 ? Math.round(end * 1000) : Math.round(end);
  const left = asNumber(duration);
  return left !== null ? now + Math.round(left * 1000) : null;
}

/** The host ends within the handover window: replace it now, while it still serves. */
export function isExpiring(machine: Pick<ReplicaMachine, 'expiresAt'>, now: number): boolean {
  return machine.expiresAt != null && machine.expiresAt - now < EXPIRY_HANDOVER_MS;
}
