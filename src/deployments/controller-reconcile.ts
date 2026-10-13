/**
 * DeploymentController, part 5 of 7 — the planning tick: every `reconcileMs` (and on demand) list machines per provider
 * → release orphans → probe → `planReplicas` per deployment → release / park / power on / create. See controller-state.ts.
 */

import { isParked, type Runtime } from './controller-state';
import { AutoscaleControl } from './controller-autoscale';
import { CREATE_BACKOFF_MS } from './controller-replicas';
import { isActive, planReplicas, replicaPhase } from './planner';
import { usesScaleway, usesVast } from './spec';
import { placementsOf } from './placements';
import { PartialListError } from '../cpu-providers/scaleway-client';
import { withoutLogContext } from '../logger';
import type { DeploymentBackend, DeploymentProvider, DeploymentSpec, ReplicaMachine } from './types';

/**
 * A parked replica just powered on still lists as stopped for a while: do not power it on again before this. One the
 * provider had no stock for is not tried again before this either, and meanwhile does not count as capacity.
 */
const PARKED_START_GRACE_MS = 90_000;
const FRESH_STATE_ORPHAN_GRACE_MS = 5 * 60_000;
const RELEASE_SETTLE_MS = 10 * 60_000;
const BOOT_TIMEOUT_BACKOFF_MS = [0, 10 * 60_000, 30 * 60_000, 60 * 60_000];

export abstract class ReconcileLoop extends AutoscaleControl {
  private stopped = false;

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.reconcile(), this.opts.reconcileMs ?? 20_000);
    this.timer.unref?.();
    void this.reconcile();
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const writes = (async () => {
      await this.reconciling?.catch(() => {});
      await this.opts.store.settled?.();
    })();
    await Promise.race([writes, new Promise<void>(r => { deadline = setTimeout(r, timeoutMs); })]);
    clearTimeout(deadline);
  }

  /** Schedules a reconcile now (coalesced with one in progress). */
  kick(): void {
    void this.reconcile();
  }

  reconcile(): Promise<void> {
    if (this.stopped) return this.reconciling ?? Promise.resolve();
    if (this.reconciling) {
      this.rerun = true;
      return this.reconciling;
    }
    this.reconciling = withoutLogContext(async () => {
      try {
        do {
          this.rerun = false;
          await this.reconcileOnce();
        } while (this.rerun);
      } finally {
        this.reconciling = null;
      }
    });
    return this.reconciling;
  }

  protected async reconcileOnce(): Promise<void> {
    // Each provider lists on its own. A failed list must never read as "nothing is running" (that would create
    // duplicates): that provider's known machines are kept as they were, and deployments that may land on it
    // neither create nor release this tick; the other providers' deployments carry on.
    const listed: ReplicaMachine[] = [];
    const failed = new Set<DeploymentProvider>();
    const failedZones = new Set<string>();
    const errors: string[] = [];
    await Promise.all((Object.entries(this.backends) as Array<[DeploymentProvider, DeploymentBackend]>).map(async ([provider, backend]) => {
      try {
        listed.push(...(await backend.listReplicas(this.namespace)).map(m => ({ ...m, provider })));
      } catch (err) {
        if (err instanceof PartialListError) {
          listed.push(...(err.items as ReplicaMachine[]).map(m => ({ ...m, provider })));
          for (const zone of err.failedZones) failedZones.add(`${provider}/${zone}`);
        } else failed.add(provider);
        errors.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }));
    this.failedZones = failedZones;
    this.settleReleases(listed, failed);
    this.lastListError = errors.length ? errors.sort().join('; ') : null;
    if (errors.length) this.log('deployments: list failed', { error: this.lastListError });
    // Even with every list failed the tick goes on in release-only mode (below): a failing list (Vast 429s) must never
    // keep an idle, billing replica up.
    const unlisted = this.machines.filter(m => this.listStale(m, failed) && !listed.some(l => l.id === m.id));
    // Keep machines we just created that the provider list does not show yet.
    const recent = this.machines.filter(m => !this.listStale(m, failed) && !listed.some(l => l.id === m.id)
      && this.now() - m.createdAt < 120_000 && this.deployments.has(m.deployment));
    for (const l of listed.filter(x => !this.releasing.has(x.id))) {
      const rt = this.deployments.get(l.deployment);
      if (rt && rt.record.lastRequestAt == null && rt.record.spec.minReplicas === 0 && l.createdAt < this.startedAt
        && !this.machines.some(m => m.id === l.id) && replicaPhase(this.observed(l, 0)) !== 'halted') rt.record.lastRequestAt = this.startedAt;
    }
    for (const m of this.machines.filter(x => !this.listStale(x, failed) && !listed.some(l => l.id === x.id) && !recent.includes(x))) {
      const rt = this.deployments.get(m.deployment);
      const busy = rt ? this.busyOn(rt, m.id) : 0;
      if (busy > 0) this.log('deployments: replica gone', { deployment: m.deployment, id: m.id, busy });
    }
    // The list may lack what the create call returned (IP early on, the catalog price): keep the known values.
    const before = this.machines;
    this.machines = [...listed.filter(l => !this.releasing.has(l.id)).map((l) => {
      const known = this.machines.find(m => m.id === l.id);
      return { ...l, ip: l.ip ?? known?.ip ?? null, pricePerHour: l.pricePerHour ?? known?.pricePerHour ?? null };
    }), ...recent, ...unlisted].filter(m => !this.creatingIds.has(m.id));
    for (const [id, p] of [...this.probes]) {
      if (this.machines.some(m => m.id === id)) continue;
      if (p.readyNow) this.noteLost(before.find(m => m.id === id)?.deployment);
      this.probes.delete(id);
    }
    this.abortRequestsOfGoneReplicas();
    for (const id of [...this.gates.keys()]) if (!this.machines.some(m => m.id === id)) this.gates.delete(id);
    for (const id of [...this.udp.keys()]) if (!this.machines.some(m => m.id === id)) this.udp.delete(id);
    for (const id of [...this.poweredOnAt.keys()]) if (!this.machines.some(m => m.id === id)) this.poweredOnAt.delete(id);
    for (const id of [...this.startRefused.keys()]) if (!this.machines.some(m => m.id === id)) this.startRefused.delete(id);
    for (const key of [...this.stageStrikes.keys()]) if (!this.machines.some(m => key.startsWith(`${m.id}|`))) this.stageStrikes.delete(key);
    this.trackParking(failed);

    const orphans = this.machines.filter(m => !this.deployments.has(m.deployment) && !this.listStale(m, failed));
    if (this.opts.store.fresh && this.now() - this.startedAt < FRESH_STATE_ORPHAN_GRACE_MS) {
      if (orphans.length) this.log('deployments: no state file, orphans kept during the start grace', { ids: orphans.map(m => m.id) });
    } else for (const m of orphans) await this.release(m, 'orphan');

    await Promise.all(this.machines.filter(m => this.deployments.has(m.deployment) && !this.parkedNow(m) && !this.stoppingNow(m))
      .map(m => this.probeOne(m)));

    for (const [name, rt] of this.deployments) await this.reconcileDeployment(name, rt, failed);
    await this.settleNetworkReleases();
  }

  /** One deployment's tick: pressure decision → plan → releases / drains → power-ons / creates (or reclaim when capped). */
  protected async reconcileDeployment(name: string, rt: Runtime, failed: Set<DeploymentProvider>): Promise<void> {
    // The deployment may live on a provider whose list failed: its known machines are planned (stale, but a release only
    // needs the id) and only the releases run; no create, no power-on until a list answers.
    const releaseOnly = this.touchesFailed(rt.record.spec, failed);
    for (const m of this.machines.filter(x => x.deployment === name && x.bootError && !this.probes.get(x.id)?.everReady)) {
      rt.lastError = `boot failed on the provider: ${m.bootError}`;
      rt.backoffUntil = this.now() + CREATE_BACKOFF_MS[Math.min(rt.bootFailures, CREATE_BACKOFF_MS.length - 1)];
      rt.bootFailures++;
      this.log('deployments: boot failed on the provider', { deployment: name, id: m.id, error: m.bootError });
      await this.release(m, 'boot-failed');
    }
    const all = this.machines.filter(m => m.deployment === name);
    // `idleAction: 'stop'`: powered-off replicas are parked — outside the plan, powered back on before creating any.
    // Ones still `stopping` are neither parked nor live: left alone until the list shows `stopped`. Draining ones are
    // on their way out: outside the plan too (taken back by `settleDrains` if the plan wants them again).
    let parked = rt.record.spec.idleAction === 'stop' ? all.filter(m => isParked(m) && !this.stoppingNow(m)) : [];
    const mine = all.filter(m => !parked.includes(m) && !this.stoppingNow(m) && !this.draining.has(m.id));
    // A deployment whose idle replica was reclaimed counts as idle until its next request (no ping-pong).
    const reclaimed = rt.reclaimedAt != null && rt.reclaimedAt >= (rt.record.lastRequestAt ?? 0);
    const lastRequestAt = reclaimed ? null : rt.record.lastRequestAt;
    const replicas = mine.map(m => this.observed(m, this.busyOn(rt, m.id)));
    const base = {
      spec: this.planSpec(rt), inflight: rt.inflight, waiting: rt.waiting, lastRequestAt, now: this.now(),
      // Recent peak, not the instant: a burst served by hedges or refused while cold still asks for capacity.
      demand: this.demandOf(rt),
    };
    const live = mine.filter(m => replicaPhase(this.observed(m, 0)) !== 'halted');
    const { decision, floor } = this.decide(rt, live, isActive({ ...base, replicas }));
    const plan = planReplicas({
      ...base, replicas, aboveSince: rt.aboveSince, drainBusy: true, autoscaleWant: decision.desired, floor, ...this.planExtras(rt),
      ...(this.opts.unhealthyStrikes ? { unhealthyStrikes: this.opts.unhealthyStrikes } : {}),
      ...(this.opts.pinnedIdleMaxMs ? { pinnedIdleMaxMs: this.opts.pinnedIdleMaxMs, specUpdatedAt: rt.record.updatedAt } : {}),
    });
    rt.aboveSince = plan.aboveSince;
    for (const r of plan.release) {
      const m = mine.find(x => x.id === r.id);
      if (!m) continue;
      if (r.reason === 'scale-down' && rt.record.spec.idleAction === 'stop') await this.parkReplica(m);
      else await this.release(m, r.reason);
      if (r.reason === 'boot-timeout') this.backOffAfterBootTimeout(rt);
    }
    let toCreate = await this.settleDrains(rt, plan, plan.create - rt.creating);
    if (releaseOnly) { this.explain(rt, plan, decision, floor, 'provider list failed'); return; }
    if (rt.record.spec.paused) for (const m of parked) await this.release(m, 'paused');
    parked = await this.releaseForgotten(parked);
    let blockedBy: string | null = null;
    for (const m of rt.record.spec.paused ? [] : parked) {
      if (toCreate <= 0) break;
      if (this.now() - (this.startRefused.get(m.id) ?? -Infinity) < PARKED_START_GRACE_MS) continue;
      toCreate--;
      if (this.now() - (rt.starting.get(m.id) ?? -Infinity) < PARKED_START_GRACE_MS) continue;
      const refusal = this.capRefusal(m.pricePerHour ?? 0, name);
      if (refusal) { rt.lastError = refusal; blockedBy = refusal; break; }
      if (!(await this.unpark(rt, m))) toCreate++;
    }
    if (toCreate > 0) {
      const price = all.find(m => m.pricePerHour != null)?.pricePerHour ?? 0;
      let refusal = this.capRefusal(price, name);
      // Under pressure and capped: take idle capacity from another deployment first (it frees on this tick).
      if (refusal && plan.active) {
        const note = await this.reclaimFor(rt);
        if (note) { refusal = this.capRefusal(price, name); blockedBy = refusal ? `${refusal} (${note}, more needed)` : null; }
        else blockedBy = refusal;
      } else blockedBy = refusal ?? (this.now() < rt.backoffUntil ? this.backoffNote(rt) : null);
    }
    for (let i = 0; i < toCreate; i++) this.createReplica(rt);
    this.explain(rt, plan, decision, floor, blockedBy);
    if (this.readyMachines(name).length) for (const w of [...rt.waiters]) w();
  }

  private settleReleases(listed: ReplicaMachine[], failed: Set<DeploymentProvider>): void {
    for (const [id, { machine, at }] of this.releasing) {
      if (this.listStale(machine, failed)) continue;
      const gone = !listed.some(l => l.id === id);
      if (!gone && this.now() - at < RELEASE_SETTLE_MS) continue;
      this.releasing.delete(id);
      const rt = this.deployments.get(machine.deployment);
      if (gone && rt && /quota/i.test(rt.lastError ?? '')) rt.backoffUntil = 0;
    }
  }

  private backOffAfterBootTimeout(rt: Runtime): void {
    rt.bootTimeouts++;
    const wait = BOOT_TIMEOUT_BACKOFF_MS[Math.min(rt.bootTimeouts - 1, BOOT_TIMEOUT_BACKOFF_MS.length - 1)];
    rt.backoffUntil = Math.max(rt.backoffUntil, this.now() + wait);
    if (wait) rt.lastError = `boot-timeout ${rt.bootTimeouts} times in a row: next create in ${Math.round(wait / 60_000)} min`;
  }

  /** The deployment may have (or create) machines on a provider whose list just failed. */
  protected touchesFailed(spec: DeploymentSpec, failed: Set<DeploymentProvider>): boolean {
    if (!failed.size && !this.failedZones.size) return false;
    const places = [...placementsOf(spec), ...(spec.candidates ?? []).map(c => ({ provider: c.provider ?? spec.provider, zone: c.zone ?? spec.zone }))];
    return (failed.has('scaleway') && usesScaleway(spec)) || (failed.has('vast') && usesVast(spec))
      || places.some(p => this.failedZones.has(`${p.provider}/${p.zone}`))
      || this.machines.some(m => m.deployment === spec.name && this.listStale(m, failed));
  }
}
