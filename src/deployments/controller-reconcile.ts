/**
 * DeploymentController, part 4 of 6 — the planning tick: every `reconcileMs` (and on demand) list machines per provider
 * → release orphans → probe → `planReplicas` per deployment → release / park / power on / create. See controller-state.ts.
 */

import { isParked } from './controller-state';
import { ParkingControl } from './controller-parking';
import { planReplicas } from './planner';
import { usesScaleway, usesVast } from './spec';
import type { DeploymentBackend, DeploymentProvider, DeploymentSpec, ReplicaMachine } from './types';

/** A parked replica just powered on still lists as stopped for a while: do not power it on again before this. */
const PARKED_START_GRACE_MS = 90_000;

export abstract class ReconcileLoop extends ParkingControl {
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.reconcile(), this.opts.reconcileMs ?? 20_000);
    this.timer.unref?.();
    void this.reconcile();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Schedules a reconcile now (coalesced with one in progress). */
  kick(): void {
    void this.reconcile();
  }

  reconcile(): Promise<void> {
    if (this.reconciling) {
      this.rerun = true;
      return this.reconciling;
    }
    this.reconciling = (async () => {
      try {
        do {
          this.rerun = false;
          await this.reconcileOnce();
        } while (this.rerun);
      } finally {
        this.reconciling = null;
      }
    })();
    return this.reconciling;
  }

  protected async reconcileOnce(): Promise<void> {
    // Each provider lists on its own. A failed list must never read as "nothing is running" (that would create
    // duplicates): that provider's known machines are kept as they were, and deployments that may land on it
    // neither create nor release this tick; the other providers' deployments carry on.
    const listed: ReplicaMachine[] = [];
    const failed = new Set<DeploymentProvider>();
    const errors: string[] = [];
    await Promise.all((Object.entries(this.backends) as Array<[DeploymentProvider, DeploymentBackend]>).map(async ([provider, backend]) => {
      try {
        listed.push(...(await backend.listReplicas(this.namespace)).map(m => ({ ...m, provider })));
      } catch (err) {
        failed.add(provider);
        errors.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }));
    this.lastListError = errors.length ? errors.sort().join('; ') : null;
    if (errors.length) this.log('deployments: list failed', { error: this.lastListError });
    // Even with every list failed the tick goes on in release-only mode (below): a failing list (Vast 429s) must never
    // keep an idle, billing replica up.
    const unlisted = this.machines.filter(m => failed.has(this.providerOf(m)));
    // Keep machines we just created that the provider list does not show yet.
    const recent = this.machines.filter(m => !failed.has(this.providerOf(m)) && !listed.some(l => l.id === m.id)
      && this.now() - m.createdAt < 120_000 && this.deployments.has(m.deployment));
    // The list may lack what the create call returned (IP early on, the catalog price): keep the known values.
    this.machines = [...listed.map((l) => {
      const known = this.machines.find(m => m.id === l.id);
      return { ...l, ip: l.ip ?? known?.ip ?? null, pricePerHour: l.pricePerHour ?? known?.pricePerHour ?? null };
    }), ...recent, ...unlisted].filter(m => !this.creatingIds.has(m.id));
    for (const id of [...this.probes.keys()]) if (!this.machines.some(m => m.id === id)) this.probes.delete(id);
    for (const id of [...this.gates.keys()]) if (!this.machines.some(m => m.id === id)) this.gates.delete(id);
    for (const id of [...this.poweredOnAt.keys()]) if (!this.machines.some(m => m.id === id)) this.poweredOnAt.delete(id);
    this.trackParking(failed);

    const orphans = this.machines.filter(m => !this.deployments.has(m.deployment) && !failed.has(this.providerOf(m)));
    for (const m of orphans) await this.release(m, 'orphan');

    await Promise.all(this.machines.filter(m => this.deployments.has(m.deployment) && !this.parkedNow(m) && !this.stoppingNow(m))
      .map(m => this.probeOne(m)));

    for (const [name, rt] of this.deployments) {
      // The deployment may live on a provider whose list failed: its known machines are planned (stale, but a release only
      // needs the id) and only the releases run; no create, no power-on until a list answers.
      const releaseOnly = this.touchesFailed(rt.record.spec, failed);
      const all = this.machines.filter(m => m.deployment === name);
      // `idleAction: 'stop'`: powered-off replicas are parked — outside the plan, powered back on before creating any.
      // Ones still `stopping` are neither parked nor live: left alone until the list shows `stopped`.
      let parked = rt.record.spec.idleAction === 'stop' ? all.filter(m => isParked(m) && !this.stoppingNow(m)) : [];
      const mine = all.filter(m => !parked.includes(m) && !this.stoppingNow(m));
      const plan = planReplicas({
        spec: rt.record.spec,
        replicas: mine.map(m => this.observed(m, rt.perReplica.get(m.id) ?? 0)),
        inflight: rt.inflight,
        waiting: rt.waiting,
        lastRequestAt: rt.record.lastRequestAt,
        aboveSince: rt.aboveSince,
        now: this.now(),
        ...(this.opts.pinnedIdleMaxMs ? { pinnedIdleMaxMs: this.opts.pinnedIdleMaxMs, specUpdatedAt: rt.record.updatedAt } : {}),
      });
      rt.aboveSince = plan.aboveSince;
      for (const r of plan.release) {
        const m = mine.find(x => x.id === r.id);
        if (!m) continue;
        if (r.reason === 'scale-down' && rt.record.spec.idleAction === 'stop') await this.parkReplica(m);
        else await this.release(m, r.reason);
      }
      if (releaseOnly) continue;
      if (rt.record.spec.paused) for (const m of parked) await this.release(m, 'paused');
      parked = await this.releaseForgotten(parked);
      let toCreate = plan.create - rt.creating;
      for (const m of rt.record.spec.paused ? [] : parked) {
        if (toCreate <= 0) break;
        toCreate--;
        if (this.now() - (rt.starting.get(m.id) ?? -Infinity) < PARKED_START_GRACE_MS) continue;
        const refusal = this.capRefusal(m.pricePerHour ?? 0);
        if (refusal) { rt.lastError = refusal; break; }
        await this.unpark(rt, m);
      }
      for (let i = 0; i < toCreate; i++) this.createReplica(rt);
      if (this.readyMachines(name).length) for (const w of [...rt.waiters]) w();
    }
  }

  /** The deployment may have (or create) machines on a provider whose list just failed. */
  protected touchesFailed(spec: DeploymentSpec, failed: Set<DeploymentProvider>): boolean {
    if (!failed.size) return false;
    return (failed.has('scaleway') && usesScaleway(spec)) || (failed.has('vast') && usesVast(spec))
      || this.machines.some(m => m.deployment === spec.name && failed.has(this.providerOf(m)));
  }
}
