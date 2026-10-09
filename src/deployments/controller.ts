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
import { isDeepStrictEqual } from 'util';
import { replicaCloudInit } from './cloud-init';
import { DeploymentError, type Lease, type LeaseOutcome, type Runtime } from './controller-state';
import { ControllerViews } from './controller-views';
import { replicaCapacity } from './autoscale';
import { isExpiring } from './expiry';
import { externalInflightOn, noteSession } from '../realtime/external-load';
import { BUILTIN_PROFILES } from './profiles';
import { holdOf, splitHold } from './scaling-spec';
import { buildSpec, parsePartialSpec, NAME_RE, SpecError, USER_DATA_KEY_MAX_BYTES, usesScaleway } from './spec';
import type { DeploymentRecord, DeploymentSpec, DeploymentView, Profile, ReplicaMachine } from './types';

/** Adaptive hedge: a request is hedged only once it is this much slower than its replica's recent p95. */
export const HEDGE_P95_FACTOR = 1.2;
export const STAGE_STRIKES = 3;
export const STAGE_COOLDOWN_MS = 30_000;

export {
  DeploymentError, DEFAULT_MAX_COLD_START_WAIT_SECONDS, DEFAULT_MAX_EUR_PER_HOUR, DEFAULT_MAX_STOPPED, DEFAULT_PARKED_MAX_MS, type ControllerOptions, type Lease,
  type LeaseOutcome,
} from './controller-state';

export class DeploymentController extends ControllerViews {
  async init(): Promise<void> {
    const { deployments, profiles, networkReleases } = await this.opts.store.load();
    for (const pending of networkReleases ?? []) this.networkReleases.set(pending.network.ipId, pending);
    for (const p of BUILTIN_PROFILES) this.profiles.set(p.name, p);
    for (const p of profiles) this.profiles.set(p.name, p);
    const mode = this.opts.defaultScalingMode;
    const defaulted = mode ? deployments.filter(r => !r.spec.scaling) : [];
    for (const record of defaulted) record.spec = { ...record.spec, scaling: { mode: mode! } };
    if (defaulted.length) this.log('deployments: no scaling block, running under the default mode', { mode, deployments: defaulted.map(r => r.spec.name) });
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
    name: string, input: Record<string, unknown>, meta: { app?: string; appImage?: string } = {},
  ): Promise<{ view: DeploymentView; created: boolean }> {
    const { body, hold: rawHold } = splitHold(input);
    const existing = this.deployments.get(name);
    const cap = this.opts.maxTotalReplicas ?? 6;
    if (typeof body.maxReplicas === 'number' && body.maxReplicas > cap) {
      throw new SpecError(`maxReplicas ${body.maxReplicas} is above this gateway's replica cap of ${cap} across all deployments (DEPLOYMENTS_MAX_REPLICAS)`);
    }
    const spec = buildSpec(name, body, { profiles: this.profiles, previous: existing?.record.spec });
    if (!spec.scaling && this.opts.defaultScalingMode) spec.scaling = { mode: this.opts.defaultScalingMode };
    const initBytes = usesScaleway(spec) ? Buffer.byteLength(replicaCloudInit(spec, 'x'.repeat(32))) : 0;
    if (initBytes > USER_DATA_KEY_MAX_BYTES) {
      throw new SpecError(`generated cloud-init is ${initBytes} bytes; Scaleway takes at most ${USER_DATA_KEY_MAX_BYTES} (shrink bootScript/env)`);
    }
    const now = this.now();
    const hold = rawHold === undefined ? existing?.record.hold : holdOf(rawHold, spec.maxReplicas, now);
    if (existing) {
      if (!isDeepStrictEqual(existing.record.spec, spec)) Object.assign(existing, { backoffUntil: 0, createFailures: 0, stockOut: null });
      existing.record = {
        ...existing.record, spec, updatedAt: now, hold,
        ...(existing.record.app || !meta.app ? {} : { app: meta.app }),
        ...(meta.appImage ? { appImage: meta.appImage } : {}),
      };
      await this.opts.store.saveDeployment(existing.record);
      const backend = this.backends.scaleway;
      if (existing.record.network && spec.exposure && backend?.ensureNetwork) {
        void this.networkOf(existing, backend).catch((err) => { existing.lastError = `network: ${err instanceof Error ? err.message : String(err)}`; });
      }
    } else {
      const owed = spec.exposure ? [...this.networkReleases.values()].find(p => p.deployment === name && p.network.zone === spec.zone) : undefined;
      const record: DeploymentRecord = {
        spec, replicaToken: randomBytes(24).toString('base64url'), createdAt: now, updatedAt: now, lastRequestAt: null,
        ...(meta.app ? { app: meta.app } : {}),
        ...(meta.appImage ? { appImage: meta.appImage } : {}),
        ...(owed ? { network: owed.network } : {}),
        ...(hold ? { hold } : {}),
      };
      this.deployments.set(name, this.runtime(record));
      if (owed) this.networkReleases.delete(owed.network.ipId);
      await this.opts.store.saveDeployment(record);
      if (owed) await this.opts.store.deleteNetworkRelease(owed.network.ipId);
    }
    this.kick();
    return { view: this.view(name)!, created: !existing };
  }

  async remove(name: string): Promise<boolean> {
    const rt = this.deployments.get(name);
    if (!rt) return false;
    this.deployments.delete(name);
    for (const w of rt.waiters) w();
    const { network } = rt.record;
    const owed = network ? { deployment: name, network, since: this.now(), attempts: 0, lastAttemptAt: null, lastError: null } : undefined;
    if (owed) this.networkReleases.set(owed.network.ipId, owed);
    await this.opts.store.deleteDeployment(name, owed);
    const mine = this.machines.filter(m => m.deployment === name);
    this.machines = this.machines.filter(m => m.deployment !== name);
    await Promise.all(mine.map(m => this.release(m, 'deleted')));
    if (owed) void this.settleNetworkReleases();
    return true;
  }

  /**
   * Marks the deployment as in use (scales from zero) without sending a request. Persisted like a request's time: a
   * deployment used only through `wake` (realtime sessions) must not read as never used after a restart.
   */
  wake(name: string): DeploymentView {
    const rt = this.require(name);
    rt.record.lastRequestAt = this.now();
    this.persistRequestTime(rt);
    this.kick();
    return this.view(name)!;
  }

  /**
   * Pre-warm (`POST /v1/deployments/:name/warm`): keep `replicas` up for `untilMinutes`, whatever the load — a client
   * that knows a class starts in 10 min asks for it so the voice never switches to the fallback mid-lesson. A later call
   * replaces the window; `park` ends it; once it expires the normal rules apply. Counts as a request (wakes it).
   */
  async warm(name: string, replicas: number, untilMinutes: number): Promise<DeploymentView> {
    const rt = this.require(name);
    const { spec } = rt.record;
    if (!Number.isInteger(replicas) || replicas < 0 || replicas > spec.maxReplicas) {
      throw new SpecError(`replicas must be an integer 0–${spec.maxReplicas} (the deployment's maxReplicas)`);
    }
    if (typeof untilMinutes !== 'number' || !Number.isFinite(untilMinutes) || untilMinutes <= 0 || untilMinutes > 12 * 60) {
      throw new SpecError('untilMinutes must be a number in (0, 720]');
    }
    const now = this.now();
    rt.record = { ...rt.record, lastRequestAt: now, warm: { replicas, until: now + untilMinutes * 60_000 } };
    rt.reclaimedAt = null;
    await this.opts.store.saveDeployment(rt.record);
    this.log('deployments: warm window', { deployment: name, replicas, untilMinutes });
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
    rt.pressure = { highSince: null, desired: 0 };
    this.forgetLoad(rt);
    if (rt.record.warm) rt.record = { ...rt.record, warm: undefined };
    await this.opts.store.saveDeployment(rt.record);
    this.kick();
    return this.view(name)!;
  }

  private leaseSeq = 0;
  private readonly leasedSeq = new Map<string, number>();

  private pick(rt: Runtime, exclude: Set<string>, stage?: string): ReplicaMachine | null {
    const ready = this.readyMachines(rt.record.spec.name).filter(m => !exclude.has(m.id) && !this.stageOut(m.id, stage));
    if (!ready.length) return null;
    // A host about to be taken back (`expiry.ts`) only serves while nothing else can: new requests drain it.
    const now = this.now();
    const lasting = ready.filter(m => !isExpiring(m, now));
    // A replica takes at most `target × maxInflightFactor` (bounded queue: the overflow spills to the fallback at once and
    // its health check still answers); a busy one (health check timed out under load) nothing beyond its target, nor
    // one whose answers beyond its target would be slower than the route's hedge (`tooSlowBeyondTarget`). Its realtime
    // sessions count in the same unit (external-load.ts): one whose realtime slots are all taken takes nothing.
    const target = rt.record.spec.targetInflightPerReplica;
    const capacity = replicaCapacity(rt.record.spec);
    const sessions = (m: ReplicaMachine) => externalInflightOn(rt.record.spec.name, m.id, target, now);
    const load = (m: ReplicaMachine) => (rt.perReplica.get(m.id) ?? 0) + sessions(m);
    const open = (lasting.length ? lasting : ready).filter((m) => {
      const n = load(m);
      return !this.draining.has(m.id) && sessions(m) < target && n < capacity && (!this.probes.get(m.id)?.busy || n < target)
        && !this.tooSlowBeyondTarget(rt, m.id, n, target);
    });
    if (!open.length) return null;
    const turn = (m: ReplicaMachine) => this.leasedSeq.get(m.id) ?? 0;
    return open.reduce((best, m) => (load(m) < load(best) || (load(m) === load(best) && turn(m) < turn(best)) ? m : best));
  }

  /**
   * Adaptive hedge (live QA 2026-10-07: at ≥ 16 concurrent chats on one L40S the fixed 1.5 s hedge fired before the busy
   * GPU answered, so ~60 % of the requests ran twice — GPU + OpenRouter): how long a route should wait for this
   * deployment before it starts the fallback in parallel, read when the attempt starts (just before `acquire`).
   *   - No replica would take it (cold, every one busy, at capacity or too slow beyond its target, see `pick`):
   *     `acquire` refuses at once and the chain spills — nothing runs twice, the delay never matters (`baseMs`).
   *   - Otherwise the latency this request should see on the replica it would go to — its recent p95, scaled by the
   *     queue it joins beyond `targetInflightPerReplica` — × `HEDGE_P95_FACTOR`, between `baseMs` and `capMs`: only a
   *     request slower than its replica usually is gets hedged, and one queued for a slot it gets soon is not.
   * Calling it also tells the controller the route's hedge (`baseMs`), which `pick` uses to spill instead of queueing
   * a request the hedge would duplicate anyway. Returns null when hedging is off (`baseMs` ≤ 0).
   */
  hedgeDelayMs(name: string, baseMs: number, capMs: number): number | null {
    if (baseMs <= 0) return null;
    const cap = Math.max(baseMs, capMs);
    const rt = this.deployments.get(name);
    if (!rt) return baseMs;
    rt.hedgeBaseMs = baseMs;
    const machine = rt.record.spec.paused ? null : this.pick(rt, new Set<string>());
    if (!machine) return baseMs;
    const n = rt.perReplica.get(machine.id) ?? 0;
    const target = rt.record.spec.targetInflightPerReplica;
    const recent = this.replicaP95(rt, machine.id);
    if (recent == null) return n >= target ? cap : baseMs;
    const expected = recent * Math.max(1, (n + 1) / target);
    return Math.min(cap, Math.max(baseMs, Math.round(expected * HEDGE_P95_FACTOR)));
  }

  /**
   * Beyond its target a replica only queues: a request whose expected latency there (recent p95 × the queue it joins)
   * is past the route's hedge would be run twice (GPU, then the hedged fallback) — spill it now instead. Only for a
   * deployment routed with an adaptive hedge (`hedgeDelayMs` seen), and only with enough recent samples.
   */
  private tooSlowBeyondTarget(rt: Runtime, id: string, n: number, target: number): boolean {
    if (n < target || !rt.hedgeBaseMs) return false;
    const recent = this.replicaP95(rt, id);
    return recent != null && recent * ((n + 1) / target) > rt.hedgeBaseMs * HEDGE_P95_FACTOR;
  }

  /**
   * A ready replica for one request, waiting through a cold start up to `waitMs`. Throws `DeploymentError`
   * 503 (+ Retry-After) when none became ready in time.
   *
   * `noWake` (no-wake mode, gateway/proxy/no-wake.ts): a ready replica is used as usual, but with none ready the call
   * fails at once with 503 and touches nothing — no wait, no `lastRequestAt`, no reconcile — so a cold deployment
   * stays cold.
   */
  async acquire(
    name: string,
    opts: { waitMs?: number; exclude?: Set<string>; signal?: AbortSignal; noWake?: boolean; stage?: string; session?: string } = {},
  ): Promise<Lease> {
    const rt = this.require(name);
    const { spec } = rt.record;
    if (spec.paused) throw new DeploymentError(409, `deployment '${name}' is paused`);
    if (opts.session) noteSession(name, opts.session, this.now());
    const serving = this.servingMachines(name);
    if (serving.length && serving.every(m => this.stageOut(m.id, opts.stage))) {
      throw new DeploymentError(503, `deployment '${name}': ${opts.stage} is out of rotation on every ready replica after repeated failures`,
        STAGE_COOLDOWN_MS / 1000, 'stage_out');
    }
    if (opts.noWake && !this.pick(rt, opts.exclude ?? new Set<string>(), opts.stage)) {
      // A saturated (not cold) deployment still sees the demand, so it scales out; a cold one stays untouched.
      if (this.readyMachines(name).length) { rt.refusedAt.push(this.now()); this.noteDemand(rt); }
      throw new DeploymentError(503, `deployment '${name}': no ready replica (no-wake: not woken)`, 30);
    }
    rt.record.lastRequestAt = this.now();
    this.persistRequestTime(rt);
    const deadline = this.now() + Math.min(opts.waitMs ?? spec.coldStartWaitSeconds * 1000, this.maxColdStartWaitSeconds * 1000);
    const exclude = opts.exclude ?? new Set<string>();

    let machine = this.pick(rt, exclude, opts.stage);
    const spent = machine || serving.length ? null : this.budgetRefusal(rt);
    if (spent) throw new DeploymentError(503, `deployment '${name}': ${spent}`, 3600);
    // Saturated and the caller has a fallback (waitMs 0): no wait — refused below as `saturated`.
    const spill = !machine && opts.waitMs === 0 && this.servingMachines(name).length > 0;
    if (!machine && !spill) {
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
          machine = this.pick(rt, exclude, opts.stage);
        }
      } finally {
        rt.waiting--;
      }
    }
    if (!machine) {
      rt.refusedAt.push(this.now());
      this.noteDemand(rt);
      if (this.demandOf(rt) > spec.targetInflightPerReplica * this.readyMachines(name).length) this.kick();
      if (this.servingMachines(name).length) {
        // Ready but every replica at capacity: the caller spills to its fallback now (no GPU queue up to a timeout).
        throw new DeploymentError(503, `deployment '${name}': every ready replica is at capacity`, 1, 'saturated');
      }
      const msg = rt.lastError ? `no ready replica yet (last error: ${rt.lastError})` : 'replicas are starting';
      throw new DeploymentError(503, `deployment '${name}': ${msg}`, 30);
    }

    rt.inflight++;
    this.leasedSeq.set(machine.id, ++this.leaseSeq);
    const startedAt = this.now();
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
        this.traceLoad(rt);
        const reported: LeaseOutcome = failed === true ? 'failed' : failed === false ? 'ok' : failed;
        this.noteStage(rt, chosen.id, opts.stage, reported, this.now() - startedAt);
        const outcome = reported === 'abandoned' ? 'cancelled' : reported === 'errored' ? 'ok' : reported;
        if (outcome !== 'cancelled') this.recordSample(rt, this.now() - startedAt, outcome !== 'ok', chosen.id);
        this.leaseEnded(chosen.id, outcome);
        const next = rt.waiters.values().next().value; // a slot freed: one waiting request may take it
        if (next) next();
      },
    };
  }

  private noteStage(rt: Runtime, id: string, stage: string | undefined, outcome: LeaseOutcome, ms: number): void {
    if (!stage || outcome === 'cancelled' || outcome === 'overloaded') return;
    const key = `${id}|${stage}`;
    const strikes = this.stageStrikes.get(key) ?? { failures: 0, outUntil: 0 };
    if (outcome === 'ok') {
      if (strikes.outUntil) this.log('deployments: stage back in rotation', { deployment: rt.record.spec.name, id, stage });
      this.stageStrikes.delete(key);
      return;
    }
    if (outcome === 'abandoned' && !(rt.hedgeBaseMs && ms >= rt.hedgeBaseMs)) return;
    strikes.failures++;
    if (strikes.failures >= STAGE_STRIKES && strikes.outUntil <= this.now()) {
      strikes.outUntil = this.now() + STAGE_COOLDOWN_MS;
      this.log('deployments: stage out of rotation', { deployment: rt.record.spec.name, id, stage, failures: strikes.failures, outcome });
    }
    this.stageStrikes.set(key, strikes);
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
    if (outcome === 'timeout' || outcome === 'overloaded' || this.servedRecently(p)) { p.busy = true; return; }
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
