/**
 * DeploymentController, part 4 of 7 — pressure autoscaling around the planner (`autoscale.ts` has the pure rules): the
 * request signals (latency, timeouts / 429s), the pressure decision and the warm floor fed to `planReplicas`, draining a
 * scaled-in replica before its release, reclaiming idle capacity of other deployments when the replica cap or the €
 * ceiling blocks one under pressure, and the per-deployment `autoscale` explanation. See controller-state.ts.
 */

import { autoscaleSettings, MIN_SIGNAL_SAMPLES, p95, pressureDecision, warmFloor, type PressureDecision } from './autoscale';
import { ParkingControl } from './controller-parking';
import type { Runtime } from './controller-state';
import { replicaPhase, type Plan } from './planner';
import type { ReplicaMachine } from './types';

/** Window of the latency / error signals. */
export const SIGNAL_WINDOW_MS = 60_000;
/**
 * A replica of another deployment may be taken for one under pressure only after this long with no answered request
 * and no request to its deployment (a class in progress elsewhere is never robbed; a forgotten idle window is).
 */
export const RECLAIM_IDLE_MS = 3 * 60_000;
const MAX_SAMPLES = 2_000;

export abstract class AutoscaleControl extends ParkingControl {
  /** One finished request (`Lease.done`): its duration, and whether it timed out or got a 429. */
  protected recordSample(rt: Runtime, ms: number, bad: boolean, replica?: string): void {
    rt.samples.push({ at: this.now(), ms, bad, ...(replica ? { replica } : {}) });
    if (rt.samples.length > MAX_SAMPLES) rt.samples.splice(0, rt.samples.length - MAX_SAMPLES);
  }

  protected signals(rt: Runtime): { p95Ms: number | null; errorRate: number; samples: number } {
    const since = this.now() - SIGNAL_WINDOW_MS;
    while (rt.samples.length && rt.samples[0].at < since) rt.samples.shift();
    const good = rt.samples.filter(x => !x.bad).map(x => x.ms);
    const n = rt.samples.length;
    return { p95Ms: p95(good), errorRate: n ? (n - good.length) / n : 0, samples: n };
  }

  /** p95 of the requests one replica answered in the signal window, or null below `MIN_SIGNAL_SAMPLES` (noise). */
  protected replicaP95(rt: Runtime, id: string): number | null {
    const since = this.now() - SIGNAL_WINDOW_MS;
    const ms = rt.samples.filter(x => x.replica === id && !x.bad && x.at >= since).map(x => x.ms);
    return ms.length >= MIN_SIGNAL_SAMPLES ? p95(ms) : null;
  }

  /** The pressure decision for this tick (stored in `rt.pressure`) and the warm floor. */
  protected decide(rt: Runtime, live: ReplicaMachine[], active: boolean): { decision: PressureDecision; floor: number } {
    const booting = live.filter(m => replicaPhase(this.observed(m, 0)) === 'booting').length;
    const sig = this.signals(rt);
    const load = this.demandOf(rt);
    const decision = pressureDecision({
      spec: rt.record.spec, load, live: live.length, booting, p95Ms: sig.p95Ms, errorRate: sig.errorRate, samples: sig.samples,
      active, now: this.now(), state: rt.pressure,
    });
    rt.pressure = { highSince: decision.highSince, desired: decision.desired };
    const { spec } = rt.record;
    const floor = warmFloor(spec, rt.record.warm, this.now());
    // The view shows the floor in force (live QA 2026-10-07: `floor: 0` while active with minActiveReplicas 1 read as
    // "nothing kept"): minReplicas, minActiveReplicas while active, and the warm floor; `warmFloor` keeps the warm part.
    const effective = spec.paused ? 0
      : Math.min(spec.maxReplicas, Math.max(spec.minReplicas, active ? spec.minActiveReplicas ?? 1 : 0, floor));
    rt.autoscale = {
      ...rt.autoscale, pressureWant: decision.desired, floor: effective, warmFloor: floor, load, p95Ms: sig.p95Ms,
      errorRate: Math.round(sig.errorRate * 1000) / 1000,
    };
    return { decision, floor };
  }

  /** Why the plan is what it is (logged when it changes). */
  protected explain(rt: Runtime, plan: Plan, decision: PressureDecision, floor: number, blockedBy: string | null): void {
    const { spec } = rt.record;
    const reason = !plan.active && floor === 0 ? 'idle'
      : decision.desired >= plan.desired && decision.desired > 0 && decision.reason !== 'steady' ? decision.reason
        : floor >= plan.desired && floor > 0 ? `warm floor ${floor}`
          : decision.reason !== 'steady' && decision.reason !== 'idle' ? decision.reason : 'base';
    const capped = decision.capped ? `maxReplicas ${spec.maxReplicas}` : null;
    const next = { ...rt.autoscale, desired: plan.desired, reason, blockedBy: blockedBy ?? capped };
    if (next.desired !== rt.autoscale.desired || next.blockedBy !== rt.autoscale.blockedBy) {
      this.log('deployments: autoscale', { deployment: spec.name, desired: next.desired, reason: next.reason, blockedBy: next.blockedBy,
        load: next.load, p95Ms: next.p95Ms, errorRate: next.errorRate, floor });
    }
    rt.autoscale = next;
  }

  /**
   * What the create back-off is waiting for, in words an operator can act on: out of stock in every placement (since
   * when, how many creates, next try) or the last create error. Stable between two tries (no countdown), so the
   * `deployments: autoscale` log only fires when it changes.
   */
  protected backoffNote(rt: Runtime): string {
    const next = new Date(rt.backoffUntil).toISOString().slice(11, 19);
    const so = rt.stockOut;
    if (!so) return `create back-off (${rt.lastError ?? 'last create failed'}; next try ${next}Z)`;
    const since = new Date(so.since).toISOString().slice(11, 19);
    const where = (rt.lastError ?? '').replace(/^create:\s*/, '');
    return `out of stock since ${since}Z: ${so.failures} create${so.failures > 1 ? 's' : ''} failed, next try ${next}Z (${where})`;
  }

  /**
   * Drains: the plan's busy surplus stops getting requests; a draining replica is released (or parked) once empty or
   * after `drainSeconds`; when the plan wants replicas again, draining ones are taken back before any create. Returns
   * how many creates are still needed.
   */
  protected async settleDrains(rt: Runtime, plan: Plan, create: number): Promise<number> {
    const name = rt.record.spec.name;
    for (const id of plan.drain) if (!this.draining.has(id)) {
      this.draining.set(id, this.now());
      this.log('deployments: draining replica', { deployment: name, id, inflight: rt.perReplica.get(id) ?? 0 });
    }
    const mine = this.machines.filter(m => m.deployment === name && this.draining.has(m.id));
    for (const m of mine) {
      if (create <= 0) break;
      this.draining.delete(m.id); // back in service: cheaper than a 9 min boot
      create--;
    }
    const { drainMs } = autoscaleSettings(rt.record.spec);
    for (const m of mine.filter(x => this.draining.has(x.id))) {
      const empty = (rt.perReplica.get(m.id) ?? 0) === 0;
      if (!empty && this.now() - this.draining.get(m.id)! < drainMs) continue;
      this.draining.delete(m.id);
      if (rt.record.spec.idleAction === 'stop') await this.parkReplica(m);
      else await this.release(m, empty ? 'scale-down' : 'drain-timeout');
    }
    for (const id of [...this.draining.keys()]) if (!this.machines.some(m => m.id === id)) this.draining.delete(id);
    return create;
  }

  /**
   * The replica cap or the € ceiling blocks a deployment under pressure: free one replica of another deployment that
   * sits idle (no answered request and no request to its deployment for `RECLAIM_IDLE_MS`, above its own floor). The
   * donor then counts as idle until its next request (no ping-pong). Returns a note, or null when nothing could go.
   */
  protected async reclaimFor(rt: Runtime): Promise<string | null> {
    const now = this.now();
    const candidates = this.machines.filter((m) => {
      const donor = this.deployments.get(m.deployment);
      if (!donor || donor === rt || this.draining.has(m.id) || this.parkedNow(m) || this.stoppingNow(m)) return false;
      const p = this.probes.get(m.id);
      if (!p?.readyNow || (donor.perReplica.get(m.id) ?? 0) > 0) return false;
      if (now - Math.max(p.lastServedAt ?? 0, p.readyAt ?? 0) < RECLAIM_IDLE_MS) return false;
      if (donor.record.lastRequestAt != null && now - donor.record.lastRequestAt < RECLAIM_IDLE_MS) return false;
      const live = this.machines.filter(x => x.deployment === m.deployment && !this.parkedNow(x) && !this.draining.has(x.id)).length;
      return live > Math.max(donor.record.spec.minReplicas, warmFloor(donor.record.spec, donor.record.warm, now));
    });
    const victim = candidates.sort((a, b) => (this.probes.get(a.id)?.lastServedAt ?? 0) - (this.probes.get(b.id)?.lastServedAt ?? 0))[0];
    if (!victim) return null;
    const donor = this.deployments.get(victim.deployment)!;
    donor.reclaimedAt = now;
    this.log('deployments: reclaiming idle replica for a deployment under pressure', { from: victim.deployment, id: victim.id, to: rt.record.spec.name });
    if (donor.record.spec.idleAction === 'stop') await this.parkReplica(victim);
    else await this.release(victim, 'reclaimed');
    return `reclaimed idle replica of '${victim.deployment}'`;
  }
}
