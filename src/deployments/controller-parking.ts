/**
 * DeploymentController, part 3 of 6 — `idleAction: 'stop'`: powering replicas off (park) and back on, the `stopping`
 * set (a machine being powered off is neither live nor parked), and the forgotten-park limit. See controller-state.ts.
 */

import { DEFAULT_MAX_STOPPED, DEFAULT_PARKED_MAX_MS, type Runtime } from './controller-state';
import { ReplicaLifecycle } from './controller-replicas';
import type { DeploymentProvider, ReplicaMachine } from './types';

/** The provider lists `stopping` for a minute or two after a stop; past this the machine is planned like any other. */
const STOPPING_MAX_MS = 10 * 60_000;

export abstract class ParkingControl extends ReplicaLifecycle {
  /** Bookkeeping of parked / stopping machines from the fresh list (`failed`: providers whose list did not answer). */
  protected trackParking(failed: Set<DeploymentProvider>): void {
    const now = this.now();
    for (const m of this.machines) {
      if (failed.has(this.providerOf(m))) continue;
      const stop = this.deployments.get(m.deployment)?.record.spec.idleAction === 'stop';
      if (stop && m.state === 'stopping' && !this.stopping.has(m.id)) this.stopping.set(m.id, now); // adopted mid-stop
      if (this.stopping.has(m.id) && (m.state === 'stopped' || now - this.stopping.get(m.id)! > STOPPING_MAX_MS)) this.stopping.delete(m.id);
    }
    for (const id of [...this.stopping.keys()]) if (!this.machines.some(m => m.id === id)) this.stopping.delete(id);
    const parkedIds = new Set(this.machines.filter(m => this.parkedNow(m) && !this.stoppingNow(m)).map(m => m.id));
    for (const id of parkedIds) if (!this.parkedSince.has(id)) this.parkedSince.set(id, now);
    for (const id of [...this.parkedSince.keys()]) if (!parkedIds.has(id)) this.parkedSince.delete(id);
  }

  /** Parked replicas left unused past `parkedMaxMs` are deleted; returns the ones that stay. */
  protected async releaseForgotten(parked: ReplicaMachine[]): Promise<ReplicaMachine[]> {
    const max = this.opts.parkedMaxMs ?? DEFAULT_PARKED_MAX_MS;
    if (!max) return parked;
    const keep: ReplicaMachine[] = [];
    for (const m of parked) {
      const since = this.parkedSince.get(m.id) ?? this.now();
      if (this.now() - since >= max) await this.release(m, 'parked-too-long');
      else keep.push(m);
    }
    return keep;
  }

  /** `idleAction: 'stop'`: power off, keeping disk, IP and firewall (the next demand powers it back on). */
  protected async parkReplica(m: ReplicaMachine): Promise<void> {
    const backend = this.backendOf(this.providerOf(m));
    const cap = this.opts.maxStoppedReplicas ?? DEFAULT_MAX_STOPPED;
    // No stop on this backend (Vast), or too many parked already: delete like `idleAction: 'delete'`.
    if (!backend.stopReplica || this.stoppedCount() >= cap) return this.release(m, 'scale-down');
    this.log('deployments: parking replica (power off)', { deployment: m.deployment, id: m.id });
    try {
      await backend.stopReplica(m);
      this.stopping.set(m.id, this.now());
      this.poweredOnAt.delete(m.id);
      this.probes.delete(m.id);
    } catch (err) {
      const rt = this.deployments.get(m.deployment);
      if (rt) rt.lastError = `stop ${m.id}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  protected async unpark(rt: Runtime, m: ReplicaMachine): Promise<void> {
    rt.starting.set(m.id, this.now());
    this.poweredOnAt.set(m.id, this.now());
    this.log('deployments: powering parked replica on', { deployment: m.deployment, id: m.id });
    try {
      await this.backendOf(this.providerOf(m)).startReplica!(m);
    } catch (err) {
      this.poweredOnAt.delete(m.id);
      rt.lastError = `start ${m.id}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
