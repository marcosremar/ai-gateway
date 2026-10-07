/**
 * DeploymentController — keeps every deployment at its planned replica count and hands ready replicas to callers.
 *
 * Loop (every `reconcileMs`, and right away when a request finds no ready replica):
 *   list machines by namespace tag → probe each → `planReplicas` → release / create.
 * Machines tagged with this namespace but belonging to no known deployment are released (orphans: their token is
 * gone with the spec, so nothing could reach them anyway).
 *
 * Single-process by design: run ONE gateway replica per namespace (two would both scale the same deployment).
 *
 * The implementation is split by responsibility owner into `controller-*.ts` (layout in controller-state.ts); this file
 * is the public class: lifecycle, profiles, deployment CRUD, wake/park, and leases (`acquire`).
 */

import { randomBytes } from 'crypto';
import { replicaCloudInit } from './cloud-init';
import { DeploymentError, type Lease, type LeaseOutcome, type Runtime } from './controller-state';
import { ControllerViews } from './controller-views';
import { isExpiring } from './expiry';
import { BUILTIN_PROFILES } from './profiles';
import { buildSpec, parsePartialSpec, NAME_RE, SpecError, USER_DATA_KEY_MAX_BYTES, usesScaleway } from './spec';
import type { DeploymentRecord, DeploymentSpec, DeploymentView, Profile, ReplicaMachine } from './types';

export {
  DeploymentError, DEFAULT_MAX_EUR_PER_HOUR, DEFAULT_MAX_STOPPED, DEFAULT_PARKED_MAX_MS, type ControllerOptions, type Lease,
  type LeaseOutcome,
} from './controller-state';

export class DeploymentController extends ControllerViews {
  async init(): Promise<void> {
    const { deployments, profiles } = await this.opts.store.load();
    for (const p of BUILTIN_PROFILES) this.profiles.set(p.name, p);
    for (const p of profiles) this.profiles.set(p.name, p);
    for (const record of deployments) this.deployments.set(record.spec.name, this.runtime(record));
  }

  listProfiles(): Profile[] {
    return [...this.profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async putProfile(name: string, body: Record<string, unknown>): Promise<Profile> {
    if (!NAME_RE.test(name)) throw new SpecError('profile name must be 2–40 chars of [a-z0-9-]');
    const profile: Profile = { name, spec: parsePartialSpec(body), builtin: false };
    this.profiles.set(name, profile);
    await this.opts.store.saveProfile(profile);
    return profile;
  }

  async deleteProfile(name: string): Promise<boolean> {
    const existing = this.profiles.get(name);
    if (!existing || existing.builtin) return false;
    this.profiles.delete(name);
    const builtin = BUILTIN_PROFILES.find(p => p.name === name);
    if (builtin) this.profiles.set(name, builtin);
    await this.opts.store.deleteProfile(name);
    return true;
  }

  async put(
    name: string, body: Record<string, unknown>, meta: { app?: string; appImage?: string } = {},
  ): Promise<{ view: DeploymentView; created: boolean }> {
    const existing = this.deployments.get(name);
    const cap = this.opts.maxTotalReplicas ?? 6;
    if (typeof body.maxReplicas === 'number' && body.maxReplicas > cap) {
      throw new SpecError(`maxReplicas ${body.maxReplicas} is above this gateway's replica cap of ${cap} across all deployments (DEPLOYMENTS_MAX_REPLICAS)`);
    }
    const spec = buildSpec(name, body, { profiles: this.profiles, previous: existing?.record.spec });
    const initBytes = usesScaleway(spec) ? Buffer.byteLength(replicaCloudInit(spec, 'x'.repeat(32))) : 0;
    if (initBytes > USER_DATA_KEY_MAX_BYTES) {
      throw new SpecError(`generated cloud-init is ${initBytes} bytes; Scaleway takes at most ${USER_DATA_KEY_MAX_BYTES} (shrink bootScript/env)`);
    }
    const now = this.now();
    if (existing) {
      existing.record = {
        ...existing.record, spec, updatedAt: now,
        ...(existing.record.app || !meta.app ? {} : { app: meta.app }),
        ...(meta.appImage ? { appImage: meta.appImage } : {}),
      };
      await this.opts.store.saveDeployment(existing.record);
    } else {
      const record: DeploymentRecord = {
        spec, replicaToken: randomBytes(24).toString('base64url'), createdAt: now, updatedAt: now, lastRequestAt: null,
        ...(meta.app ? { app: meta.app } : {}),
        ...(meta.appImage ? { appImage: meta.appImage } : {}),
      };
      this.deployments.set(name, this.runtime(record));
      await this.opts.store.saveDeployment(record);
    }
    this.kick();
    return { view: this.view(name)!, created: !existing };
  }

  async remove(name: string): Promise<boolean> {
    const rt = this.deployments.get(name);
    if (!rt) return false;
    this.deployments.delete(name);
    for (const w of rt.waiters) w();
    await this.opts.store.deleteDeployment(name);
    const mine = this.machines.filter(m => m.deployment === name);
    this.machines = this.machines.filter(m => m.deployment !== name);
    await Promise.all(mine.map(m => this.release(m, 'deleted')));
    if (rt.record.network) void this.releaseNetwork(name, rt.record.network);
    return true;
  }

  /** Marks the deployment as in use (scales from zero) without sending a request. */
  wake(name: string): DeploymentView {
    const rt = this.require(name);
    rt.record.lastRequestAt = this.now();
    this.kick();
    return this.view(name)!;
  }

  /**
   * The caller is done with the deployment now (its traffic bypasses the gateway, so the idle clock cannot see it):
   * forget the last use, and the next tick scales to `minReplicas` — powering off under `idleAction: 'stop'`. A
   * request or `wake` brings it back; in-flight requests are never cut (the planner keeps busy replicas).
   */
  async park(name: string): Promise<DeploymentView> {
    const rt = this.require(name);
    rt.record.lastRequestAt = null;
    rt.lastPersistedRequestAt = null;
    rt.aboveSince = null;
    rt.refusedAt = [];
    rt.demandPeak = { value: 0, at: 0 };
    await this.opts.store.saveDeployment(rt.record);
    this.kick();
    return this.view(name)!;
  }

  private pick(rt: Runtime, exclude: Set<string>): ReplicaMachine | null {
    const ready = this.readyMachines(rt.record.spec.name).filter(m => !exclude.has(m.id));
    if (!ready.length) return null;
    // A host about to be taken back (`expiry.ts`) only serves while nothing else can: new requests drain it.
    const now = this.now();
    const lasting = ready.filter(m => !isExpiring(m, now));
    // A busy replica (health check timed out under load) keeps its work but takes nothing beyond its target.
    const target = rt.record.spec.targetInflightPerReplica;
    const open = (lasting.length ? lasting : ready).filter(m => !this.probes.get(m.id)?.busy || (rt.perReplica.get(m.id) ?? 0) < target);
    if (!open.length) return null;
    return open.reduce((best, m) => ((rt.perReplica.get(m.id) ?? 0) < (rt.perReplica.get(best.id) ?? 0) ? m : best));
  }

  /**
   * A ready replica for one request, waiting through a cold start up to `waitMs`. Throws `DeploymentError`
   * 503 (+ Retry-After) when none became ready in time.
   *
   * `noWake` (no-wake mode, gateway/proxy/no-wake.ts): a ready replica is used as usual, but with none ready the call
   * fails at once with 503 and touches nothing — no wait, no `lastRequestAt`, no reconcile — so a cold deployment
   * stays cold.
   */
  async acquire(name: string, opts: { waitMs?: number; exclude?: Set<string>; signal?: AbortSignal; noWake?: boolean } = {}): Promise<Lease> {
    const rt = this.require(name);
    const { spec } = rt.record;
    if (spec.paused) throw new DeploymentError(409, `deployment '${name}' is paused`);
    if (opts.noWake && !this.pick(rt, opts.exclude ?? new Set<string>())) {
      // A saturated (not cold) deployment still sees the demand, so it scales out; a cold one stays untouched.
      if (this.readyMachines(name).length) { rt.refusedAt.push(this.now()); this.noteDemand(rt); }
      throw new DeploymentError(503, `deployment '${name}': no ready replica (no-wake: not woken)`, 30);
    }
    rt.record.lastRequestAt = this.now();
    this.persistRequestTime(rt);
    const deadline = this.now() + (opts.waitMs ?? spec.coldStartWaitSeconds * 1000);
    const exclude = opts.exclude ?? new Set<string>();

    let machine = this.pick(rt, exclude);
    if (!machine) {
      rt.waiting++;
      this.kick();
      try {
        while (!machine) {
          const left = deadline - this.now();
          if (left <= 0 || opts.signal?.aborted || !this.deployments.has(name)) break;
          await new Promise<void>((resolve) => {
            const t = setTimeout(done, Math.min(left, 5_000));
            function done() { clearTimeout(t); rt.waiters.delete(done); resolve(); }
            rt.waiters.add(done);
          });
          machine = this.pick(rt, exclude);
        }
      } finally {
        rt.waiting--;
      }
    }
    if (!machine) {
      rt.refusedAt.push(this.now());
      this.noteDemand(rt);
      if (this.demandOf(rt) > spec.targetInflightPerReplica * this.readyMachines(name).length) this.kick();
      const msg = rt.lastError ? `no ready replica yet (last error: ${rt.lastError})` : 'replicas are starting';
      throw new DeploymentError(503, `deployment '${name}': ${msg}`, 30);
    }

    rt.inflight++;
    rt.perReplica.set(machine.id, (rt.perReplica.get(machine.id) ?? 0) + 1);
    rt.record.lastRequestAt = this.now();
    this.noteDemand(rt);
    if (rt.inflight > spec.targetInflightPerReplica * this.readyMachines(name).length) this.kick();
    const chosen = machine;
    let released = false;
    return {
      machine: chosen,
      token: rt.record.replicaToken,
      exposed: !!rt.record.spec.exposure,
      done: (failed: boolean | LeaseOutcome = false) => {
        if (released) return;
        released = true;
        rt.inflight--;
        const n = (rt.perReplica.get(chosen.id) ?? 1) - 1;
        if (n <= 0) rt.perReplica.delete(chosen.id); else rt.perReplica.set(chosen.id, n);
        rt.record.lastRequestAt = this.now();
        this.leaseEnded(chosen.id, failed === true ? 'failed' : failed === false ? 'ok' : failed);
      },
    };
  }

  /**
   * What one request says about its replica. `ok`: alive (the busy grace starts). `timeout`: slow, so busy — never a
   * strike (live QA 2026-10-07: hedged losers aborted under 16 concurrent chats counted as connection failures, 3 of
   * them marked the L40S unhealthy in seconds). `cancelled`: nothing. `failed`: suspect, unless it just answered others.
   */
  private leaseEnded(id: string, outcome: LeaseOutcome): void {
    const p = this.probes.get(id);
    if (!p || outcome === 'cancelled') return;
    if (outcome === 'ok') { p.lastServedAt = this.now(); p.failures = 0; return; }
    if (outcome === 'timeout' || this.servedRecently(p)) { p.busy = true; return; }
    p.readyNow = false;
    p.failures++;
    this.kick();
  }

  private persistRequestTime(rt: Runtime): void {
    const at = rt.record.lastRequestAt;
    if (at == null || (rt.lastPersistedRequestAt != null && at - rt.lastPersistedRequestAt < 60_000)) return;
    rt.lastPersistedRequestAt = at;
    void this.opts.store.saveDeployment(rt.record).catch(() => {});
  }
}

export type { DeploymentSpec };
