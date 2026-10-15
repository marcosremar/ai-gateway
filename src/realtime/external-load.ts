/**
 * Load the controller cannot see by itself: realtime sessions. A WebRTC session talks to its replica directly (UDP),
 * so the gateway's lease counters (`inflight`, `perReplica`) never move while a class is talking — the replica would
 * look idle to the autoscaler. The realtime service polls each replica's `/__aigw/rt/status` and reports its
 * `active`/`max` here (`active` = distinct session ids on the edge: a learner on WS and WebRTC at once counts once).
 *
 * The controller reads it in two places, with the same number: the pressure decision (`controller-autoscale.ts`
 * `decide`) adds `externalInflightEquivalent` to the load, and `pick` (`controller.ts`) adds `externalInflightOn` to a
 * replica's in-flight count, so a replica full of sessions takes no `/v1/s2s` or stage request.
 *
 * Students, not requests: one learner sends many requests (speculative STT, retries, the WS + WebRTC start race, the
 * SDK's background re-admission, one `/v1/s2s` per turn), all under one session id — the trace id of the SDK's
 * `traceparent`. `noteSession` records one on a deployment (realtime admission, `acquire` with `session`) and
 * `distinctSessions` counts the different ones of the last `windowMs` (at most `SESSION_MEMORY_MS`); `refusedSessions`
 * does the same for realtime admissions refused as `saturated`. Neither feeds the scale-out rule: leases and refusals
 * are still counted per request.
 */

/** A report older than this is ignored (the replica vanished or stopped being polled). */
export const EXTERNAL_LOAD_MAX_AGE_MS = 30_000;

interface Report { active: number; max: number; at: number }

const reports = new Map<string, Map<string, Report>>();

export function reportExternalLoad(deployment: string, replicaId: string, active: number, max: number, now = Date.now()): void {
  if (!Number.isFinite(active) || !Number.isFinite(max) || active < 0 || max < 0) return;
  let byReplica = reports.get(deployment);
  if (!byReplica) { byReplica = new Map(); reports.set(deployment, byReplica); }
  byReplica.set(replicaId, { active, max, at: now });
}

/** Fresh realtime sessions on a deployment: total active, total capacity, replicas reporting. */
export function externalLoadOf(deployment: string, now = Date.now()): { active: number; max: number; replicas: number } {
  const byReplica = reports.get(deployment);
  let active = 0, max = 0, replicas = 0;
  if (!byReplica) return { active, max, replicas };
  for (const [id, r] of byReplica) {
    if (now - r.at > EXTERNAL_LOAD_MAX_AGE_MS) { byReplica.delete(id); continue; }
    active += r.active;
    max += r.max;
    replicas++;
  }
  return { active, max, replicas };
}

/**
 * One replica's realtime load in the autoscaler's unit (in-flight requests): full of sessions (`active = max`) reads as
 * `targetInflightPerReplica` requests — one replica's worth of pressure — whatever its session cap.
 */
export function externalInflightOn(deployment: string, replicaId: string, targetInflightPerReplica: number, now = Date.now()): number {
  const r = reports.get(deployment)?.get(replicaId);
  if (!r || now - r.at > EXTERNAL_LOAD_MAX_AGE_MS || r.max <= 0) return 0;
  return (r.active / r.max) * targetInflightPerReplica;
}

export function externalInflightEquivalent(deployment: string, targetInflightPerReplica: number, now = Date.now()): number {
  let load = 0;
  for (const id of reports.get(deployment)?.keys() ?? []) load += externalInflightOn(deployment, id, targetInflightPerReplica, now);
  return load;
}

export const SESSION_MEMORY_MS = 10 * 60_000;

const seen = new Map<string, Map<string, number>>();

function mark(key: string, session: string, now: number): void {
  let bySession = seen.get(key);
  if (!bySession) { bySession = new Map(); seen.set(key, bySession); }
  for (const [id, at] of bySession) if (now - at > SESSION_MEMORY_MS) bySession.delete(id);
  bySession.set(session, now);
}

function count(key: string, windowMs: number, now: number): number {
  let n = 0;
  for (const at of seen.get(key)?.values() ?? []) if (now - at <= windowMs) n++;
  return n;
}

export function noteSession(deployment: string, session: string, now = Date.now()): void {
  mark(deployment, session, now);
}

export function distinctSessions(deployment: string, windowMs: number, now = Date.now()): number {
  return count(deployment, windowMs, now);
}

export function noteRefusedSession(deployment: string, session: string, now = Date.now()): void {
  mark(`${deployment}|saturated`, session, now);
}

export function refusedSessions(deployment: string, windowMs: number, now = Date.now()): number {
  return count(`${deployment}|saturated`, windowMs, now);
}

export const WANTING_WINDOW_MS = 40_000;

export function sessionsWanting(deployment: string, now = Date.now()): number | null {
  const seated = externalLoadOf(deployment, now);
  const refused = refusedSessions(deployment, WANTING_WINDOW_MS, now);
  return seated.replicas === 0 && refused === 0 ? null : seated.active + refused;
}

/** Tests only. */
export function _resetExternalLoad(): void {
  reports.clear();
  seen.clear();
}
