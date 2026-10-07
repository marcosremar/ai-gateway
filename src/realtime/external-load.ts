/**
 * Load the controller cannot see by itself: realtime sessions. A WebRTC session talks to its replica directly (UDP),
 * so the gateway's lease counters (`inflight`, `perReplica`) never move while a class is talking — the replica would
 * look idle to the autoscaler. The realtime service polls each replica's `/__aigw/rt/status` and reports its
 * `active`/`max` here.
 *
 * Wiring into the autoscaler (left out of this change on purpose: src/deployments/controller-autoscale.ts and
 * controller-state.ts are being changed by the pending autoscale PR). Two lines, in
 * `src/deployments/controller-autoscale.ts`, where the pressure decision reads the load (`const load = this.demandOf(rt);`):
 *
 *     // TODO(realtime): count realtime sessions as load (src/realtime/external-load.ts)
 *     const load = this.demandOf(rt) + externalInflightEquivalent(rt.record.spec.name, rt.record.spec.targetInflightPerReplica);
 *
 * plus `import { externalInflightEquivalent } from '../realtime/external-load';`. Until then the realtime service keeps
 * the deployment awake (`wake`) while sessions are active, so it does not scale to zero under a class.
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
 * The realtime load in the autoscaler's unit (in-flight requests): a replica full of sessions (`active = max`) reads as
 * `targetInflightPerReplica` requests — one replica's worth of pressure — whatever its session cap.
 */
export function externalInflightEquivalent(deployment: string, targetInflightPerReplica: number, now = Date.now()): number {
  const byReplica = reports.get(deployment);
  if (!byReplica) return 0;
  let load = 0;
  for (const [, r] of byReplica) {
    if (now - r.at > EXTERNAL_LOAD_MAX_AGE_MS || r.max <= 0) continue;
    load += (r.active / r.max) * targetInflightPerReplica;
  }
  return load;
}

/** Tests only. */
export function _resetExternalLoad(): void {
  reports.clear();
}
