/**
 * DeploymentController, part 1 of 7 — the state every other part reads: the deployments and their runtime counters, the
 * machine list, the probe/gate/parking bookkeeping, and the derived counts behind the cost guards (replica cap, € ceiling).
 *
 * The controller is split by who owns what (pure move of the former `controller.ts`, 2026-10-07); each part extends the
 * previous one and `DeploymentController` (controller.ts) is the public class:
 *   controller-state.ts → controller-replicas.ts (create / release / probe) → controller-parking.ts (stop / park) →
 *   controller-scaling.ts (the `scaling` block: load trace, budget ledger, measured boot times, capacity view) →
 *   controller-autoscale.ts (pressure, drains, reclaim) → controller-reconcile.ts (the planning tick) →
 *   controller-views.ts (views, health) → controller.ts (API, leases).
 */

import { createHmac } from 'crypto';
import { activeWindow, type PressureState } from './autoscale';
import { filesByUrl } from './boot-files';
import { bootTimeoutMinutesOn, replicaPhase, type ObservedReplica } from './planner';
import { NAME_RE } from './spec';
import type { GateState } from './rtt-gate';
import { externalInflightOn } from '../realtime/external-load';
import type {
  DeploymentBackend, DeploymentProvider, DeploymentRecord, DeploymentSpec, DeploymentStore, PendingNetworkRelease, Profile, ReplicaMachine,
  RegistryAuth, ReplicaProbe, ScalingMode,
} from './types';

export class DeploymentError extends Error {
  /**
   * `saturated`: replicas are ready but all at capacity (the caller should spill to its fallback, not wait).
   * `stage_out`: the asked stage is out of rotation on every ready replica after repeated failures (same: fall back).
   */
  constructor(readonly status: number, message: string, readonly retryAfterSeconds?: number, readonly code?: 'saturated' | 'stage_out' | 'reserved') {
    super(message);
  }
}

export interface ProbeState {
  everReady: boolean;
  readyNow: boolean;
  failures: number;
  readyAt?: number;
  /** Last time the replica answered a forwarded request (lease ended `ok`): a replica that just served is alive. */
  lastServedAt?: number;
  erroredSinceServed?: boolean;
  /**
   * Alive but saturated: its health check timed out (or a request hit its time limit) while it had work. It keeps
   * serving what it has and gets no NEW request beyond `targetInflightPerReplica` until a probe answers again; it is
   * never released for this (live QA 2026-10-07: 16 concurrent chats made the L40S `unhealthy` and it was replaced).
   */
  busy?: boolean;
  /** Since when the liveness probe (the replica's front) has failed without a break: the machine is gone, not busy. */
  downSince?: number;
}

/**
 * How a forwarded request ended, as `Lease.done` hears it. `true`/`'failed'` = connection-level failure (refused,
 * reset); `'timeout'` = the replica took longer than the caller's limit (busy, not dead); `'cancelled'` = the caller
 * gave up for its own reasons (a hedged fallback won, the client went away) and says nothing about the replica;
 * `'overloaded'` = the replica answered 429 (its own queue is full): busy, and pressure for the autoscaler.
 * Two more only matter to the lease's stage (`acquire` `stage`, `STAGE_STRIKES`): `'errored'` = the replica answered
 * 5xx (alive, so `ok` for its health, a strike for the stage); `'abandoned'` = the caller gave up before the first byte
 * (`cancelled` for its health; a strike for the stage once it had waited the route's hedge delay).
 */
export type LeaseOutcome = 'ok' | 'failed' | 'timeout' | 'cancelled' | 'overloaded' | 'errored' | 'abandoned';

export interface Runtime {
  record: DeploymentRecord;
  inflight: number;
  waiting: number;
  perReplica: Map<string, number>;
  aboveSince: number | null;
  lastError: string | null;
  creating: number;
  backoffUntil: number;
  createFailures: number;
  bootFailures: number;
  /** Creates that failed for lack of stock in every placement, in a row, and since when (null after a success). */
  stockOut: { since: number; failures: number } | null;
  lastPersistedRequestAt: number | null;
  waiters: Set<() => void>;
  /** Parked replicas (`idleAction: 'stop'`) being powered back on, by id → when: not started twice while the list lags. */
  starting: Map<string, number>;
  /** Why the last create attempt was refused by the € ceiling (kept visible while siblings of the same tick succeed). */
  spendNote: string | null;
  /** Where the last create landed (or failed) and which candidates were skipped. */
  lastPlacement: string | null;
  /** Hosts the RTT gate released since the last replica that passed it (kept in `lastPlacement` across creates). */
  rejected: string[];
  /** Requests turned away with no ready replica (cold, or every replica saturated), by time: demand the fallback took. */
  refusedAt: number[];
  /** Highest recent load (served + waiting + just refused) and when: what scale-up plans on (`demandOf`). */
  demandPeak: { value: number; at: number };
  /** Finished requests of the last `SIGNAL_WINDOW_MS`: duration and whether it timed out / got a 429 (autoscale signals). */
  samples: Array<{ at: number; ms: number; bad: boolean; replica?: string }>;
  /** Pressure autoscaler memory (`autoscale.ts`). */
  pressure: PressureState;
  /** The last scaling decision, for the view and the logs. */
  autoscale: AutoscaleView;
  /** The route's hedge delay (DEPLOYMENT_HEDGE_MS), learnt from `hedgeDelayMs`; unset = no latency-based spill. */
  hedgeBaseMs?: number;
  /** When another deployment under pressure took this one's idle replica (it then counts as idle until a new request). */
  reclaimedAt: number | null;
  bootTimeouts: number;
  lostAt: number | null;
}

/** Why the deployment has the replica count it has (`GET /v1/deployments` → `autoscale`). */
export interface AutoscaleView {
  desired: number;
  /** What pressure alone asks for. */
  pressureWant: number;
  reason: string;
  /** What keeps `desired` from being reached (replica cap, € ceiling, maxReplicas, back-off), or null. */
  blockedBy: string | null;
  /** Replicas kept whatever the load right now: minReplicas, minActiveReplicas while active, warm schedule / window. */
  floor: number;
  /** The part of `floor` a warm-up schedule or a client warm window asks for. */
  warmFloor: number;
  load: number;
  p95Ms: number | null;
  errorRate: number;
}

export interface ControllerOptions {
  /** One backend per provider (Scaleway, Vast); at least one. */
  backends?: Partial<Record<DeploymentProvider, DeploymentBackend>>;
  /** Single-backend shorthand (kept for callers and tests from before `backends`). */
  backend?: DeploymentBackend;
  store: DeploymentStore;
  publicUrl?: string;
  probe: ReplicaProbe;
  namespace?: string;
  /** Cap on RUNNING replicas across all deployments (protects the bill); parked (stopped) ones do not count. */
  maxTotalReplicas?: number;
  /** Cap on parked (stopped) replicas across all deployments: they bill disk only, but they must not pile up. Default 8. */
  maxStoppedReplicas?: number;
  /** Ceiling (EUR/h) on the summed price of the running replicas of all deployments. Default 6; 0 = off. */
  maxEurPerHour?: number;
  /** A parked replica unused this long is deleted (a forgotten park bills its disk forever). Default 72 h; 0 = off. */
  parkedMaxMs?: number;
  /** Pause between retries of the release of a machine whose deployment was deleted while it was created. Default 2 s. */
  releaseRetryMs?: number;
  reconcileMs?: number;
  maxColdStartWaitSeconds?: number;
  /** Replicas kept only by `minReplicas` go to zero after this long unused (planner `pinnedIdleOver`); 0 = off. */
  pinnedIdleMaxMs?: number;
  /**
   * A replica that answered a request this recently is never released as unhealthy, whatever its probe says (a busy
   * LLM queue delays the health check, it does not mean death). Default 120 s (DEPLOYMENTS_BUSY_GRACE_SECONDS).
   */
  busyGraceMs?: number;
  /** Consecutive failed probes (with no recent answer and nothing in flight) before a replica is replaced. Default 3. */
  unhealthyStrikes?: number;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  sessions?: (deployment: string) => number | null;
  defaultScalingMode?: ScalingMode;
  checkImage?: (image: string, auth: RegistryAuth | null) => Promise<string | null>;
}

export interface Lease {
  machine: ReplicaMachine;
  token: string;
  /** The deployment is exposed (`exposure`): its token-gated front is on `PROBE_PORT`, not :80. */
  exposed: boolean;
  /** Aborted when the controller releases this replica or the provider stops listing it. */
  signal?: AbortSignal;
  /**
   * Call once the forwarded request finished. `true`/`'failed'` = connection-level failure (marks the replica suspect),
   * `'timeout'` = it was too slow (busy), `'cancelled'` = the caller aborted it (hedge lost, client gone): neutral.
   */
  done(failed?: boolean | LeaseOutcome): void;
}

export const DEFAULT_MAX_STOPPED = 8;
export const DEFAULT_MAX_EUR_PER_HOUR = 6;

export const machineTypesOf = (spec: DeploymentSpec): Set<string> => new Set(
  [spec.machineType, ...(spec.placements ?? []).flatMap(p => p.machineType ?? []), ...(spec.candidates ?? []).map(c => c.machineType)]);
export const DEFAULT_PARKED_MAX_MS = 72 * 3_600_000;
export const DEFAULT_BUSY_GRACE_MS = 120_000;
export const ERRORED_GRACE_MS = 20_000;
export const DEFAULT_MAX_COLD_START_WAIT_SECONDS = 240;
/**
 * A request turned away for lack of a ready replica counts as load for this long (≈ the time the fallback takes to
 * answer it, Little's law with W ≈ 1.5 s — the cloud LLM's p50 measured live on 2026-10-07 was 1.0–1.9 s): 16 refused
 * at once read as 16 concurrent, one a second as ~1.5.
 */
export const REFUSED_HOLD_MS = 1_500;
/** Scale-up remembers the peak load this long: a burst whose hedged requests end in 2 s is still seen by the next tick. */
export const DEMAND_MEMORY_MS = 60_000;

/** Powered off by the provider's normal stop (not billed for compute): a parked replica under `idleAction: 'stop'`. */
export function isParked(m: ReplicaMachine): boolean {
  return m.state === 'stopped';
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function replicaTokenFor(deploymentSecret: string, tokenKey: string | undefined): string {
  return tokenKey ? createHmac('sha256', deploymentSecret).update(`aigw-replica-v1:${tokenKey}`).digest('base64url') : deploymentSecret;
}

export abstract class ControllerState {
  protected readonly deployments = new Map<string, Runtime>();
  protected readonly tokenKeys = new Map<string, string>();
  protected readonly profiles = new Map<string, Profile>();
  protected machines: ReplicaMachine[] = [];
  /**
   * Machines the provider already created but `createReplica` has not finished configuring (user_data, power-on).
   * The list shows them `stopped` in that window: planned like any machine they read as halted and were deleted
   * mid-create, and the create then failed with a 404 on its own server (production stress 2026-10-06). They stay out
   * of `machines` (and of every plan) until the create returns; `rt.creating` already counts them.
   */
  protected readonly creatingIds = new Set<string>();
  /**
   * Machines being powered off (`idleAction: 'stop'`), by id → since when: the provider lists them `stopping` (or still
   * `running`) for a while, and a stopping machine read as `halted` was deleted — parked replica lost, a new one
   * created with no demand (production 2026-10-06 18:31). They stay out of every plan until the list shows `stopped`.
   */
  protected readonly stopping = new Map<string, number>();
  /** Parked machines, id → since when the controller first saw them stopped (the forgotten-park limit). */
  protected readonly parkedSince = new Map<string, number>();
  /** Last power-on of a parked replica, id → when: `maxHours` and the boot timeout count from here, not from creation. */
  protected readonly poweredOnAt = new Map<string, number>();
  protected readonly startRefused = new Map<string, number>();
  /** Creates in flight: the price each is expected to bill, so concurrent creates cannot jointly pass the € ceiling. */
  protected readonly pendingSpend = new Set<{ cost: number; deployment?: string; provider?: DeploymentProvider; machineType?: string }>();
  protected readonly probes = new Map<string, ProbeState>();
  protected readonly replicaGone = new Map<string, AbortController>();
  protected goneSignal(id: string): AbortSignal {
    let gone = this.replicaGone.get(id);
    if (!gone) this.replicaGone.set(id, gone = new AbortController());
    return gone.signal;
  }
  protected abortRequestsOfGoneReplicas(): void {
    for (const [id, gone] of this.replicaGone) {
      if (this.machines.some(m => m.id === id)) continue;
      gone.abort(new Error(`replica ${id} was released`));
      this.replicaGone.delete(id);
    }
  }
  protected readonly releasing = new Map<string, { machine: ReplicaMachine; at: number }>();
  /** Replicas being drained before a scale-down, id → since: no new request; released once empty or after `drainSeconds`. */
  protected readonly draining = new Map<string, number>();
  protected readonly networkReleases = new Map<string, PendingNetworkRelease>();
  protected readonly stageStrikes = new Map<string, { failures: number; outUntil: number }>();
  protected reconciling: Promise<void> | null = null;
  protected rerun = false;
  protected timer: ReturnType<typeof setInterval> | null = null;
  protected lastListError: string | null = null;
  protected failedZones = new Set<string>();
  protected readonly backends: Partial<Record<DeploymentProvider, DeploymentBackend>>;
  /** Provider of a machine that does not say (fakes, records from before `provider`). */
  protected readonly defaultProvider: DeploymentProvider;
  /** RTT gate per replica (backends with `measureRtt`, i.e. Vast), by machine id. */
  protected readonly gates = new Map<string, GateState>();
  protected readonly udp = new Map<string, 'ok' | 'blocked'>();
  /** Machines created before this process started were adopted: measured for the view, never released by the gate. */
  protected readonly startedAt: number;
  readonly namespace: string;
  protected readonly now: () => number;
  protected readonly log: (msg: string, data?: Record<string, unknown>) => void;

  constructor(protected readonly opts: ControllerOptions) {
    this.namespace = opts.namespace ?? 'default';
    if (!NAME_RE.test(this.namespace)) throw new Error(`invalid deployments namespace '${this.namespace}'`);
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.log = opts.log ?? (() => {});
    this.backends = opts.backends ?? (opts.backend ? { [opts.backend.provider]: opts.backend } : {});
    const providers = Object.keys(this.backends) as DeploymentProvider[];
    if (!providers.length) throw new Error('deployments controller needs at least one backend');
    this.defaultProvider = providers.includes('scaleway') ? 'scaleway' : providers[0];
  }

  protected backendOf(provider: DeploymentProvider | undefined): DeploymentBackend {
    const backend = this.backends[provider ?? this.defaultProvider];
    if (!backend) throw new Error(`no backend configured for provider '${provider}'`);
    return backend;
  }

  protected forVast(rt: Runtime, spec: DeploymentSpec): DeploymentSpec {
    const bootTimeoutMinutes = bootTimeoutMinutesOn(spec, 'vast');
    return filesByUrl({ ...spec, bootTimeoutMinutes }, rt.record.replicaToken, this.opts.publicUrl, this.now());
  }

  protected providerOf(m: ReplicaMachine): DeploymentProvider {
    return m.provider ?? this.defaultProvider;
  }

  protected listStale(m: ReplicaMachine, failed: Set<DeploymentProvider>): boolean {
    const provider = this.providerOf(m);
    return failed.has(provider) || this.failedZones.has(`${provider}/${m.zone}`);
  }

  protected get maxColdStartWaitSeconds(): number {
    return this.opts.maxColdStartWaitSeconds ?? DEFAULT_MAX_COLD_START_WAIT_SECONDS;
  }

  protected runtime(record: DeploymentRecord): Runtime {
    return {
      record, inflight: 0, waiting: 0, perReplica: new Map(), aboveSince: null, lastError: null, creating: 0,
      backoffUntil: 0, createFailures: 0, bootFailures: 0, stockOut: null, lastPersistedRequestAt: record.lastRequestAt, waiters: new Set(), starting: new Map(),
      lastPlacement: null, rejected: [], spendNote: null, refusedAt: [], demandPeak: { value: 0, at: 0 },
      samples: [], pressure: { highSince: null, desired: 0 }, reclaimedAt: null, bootTimeouts: 0, lostAt: null,
      autoscale: { desired: 0, pressureWant: 0, reason: 'idle', blockedBy: null, floor: 0, warmFloor: 0, load: 0, p95Ms: null, errorRate: 0 },
    };
  }

  protected require(name: string): Runtime {
    const rt = this.deployments.get(name);
    if (!rt) throw new DeploymentError(404, `deployment '${name}' not found`);
    return rt;
  }

  protected readyMachines(name: string): ReplicaMachine[] {
    return this.machines.filter(m => m.deployment === name && m.ip && this.probes.get(m.id)?.readyNow
      && replicaPhase(this.observed(m, 0)) === 'ready');
  }

  protected stageOut(id: string, stage: string | undefined): boolean {
    return stage !== undefined && (this.stageStrikes.get(`${id}|${stage}`)?.outUntil ?? 0) > this.now();
  }

  protected stagesOut(id: string): string[] {
    return [...this.stageStrikes.keys()].filter(k => k.startsWith(`${id}|`)).map(k => k.slice(id.length + 1)).filter(s => this.stageOut(id, s));
  }

  protected noteLost(deployment: string | undefined): void {
    const rt = deployment ? this.deployments.get(deployment) : undefined;
    if (rt) rt.lostAt = this.now();
  }

  /** Answered a forwarded request within `busyGraceMs`. */
  protected servedRecently(p: ProbeState | undefined): boolean {
    if (p?.lastServedAt == null) return false;
    const grace = this.opts.busyGraceMs ?? DEFAULT_BUSY_GRACE_MS;
    return this.now() - p.lastServedAt < (p.erroredSinceServed ? Math.min(grace, ERRORED_GRACE_MS) : grace);
  }

  /** Requests refused in the last `REFUSED_HOLD_MS` (older ones pruned). */
  protected recentRefusals(rt: Runtime): number {
    const since = this.now() - REFUSED_HOLD_MS;
    while (rt.refusedAt.length && rt.refusedAt[0] < since) rt.refusedAt.shift();
    return rt.refusedAt.length;
  }

  /** Records the load seen right now; the peak is kept for `DEMAND_MEMORY_MS`. */
  protected noteDemand(rt: Runtime): void {
    const load = rt.inflight + rt.waiting + this.recentRefusals(rt);
    const now = this.now();
    if (load >= rt.demandPeak.value || now - rt.demandPeak.at >= DEMAND_MEMORY_MS) rt.demandPeak = { value: load, at: now };
  }

  /**
   * The load scale-up plans on: what runs now, or the recent peak. Sampling `inflight` alone at the tick missed every
   * burst (live QA 2026-10-07: 16–40 concurrent, `desired` stayed 1 — hedged requests had ended, cold ones had fallen back).
   */
  protected demandOf(rt: Runtime): number {
    const now = rt.inflight + rt.waiting + this.recentRefusals(rt);
    const peak = this.now() - rt.demandPeak.at < DEMAND_MEMORY_MS ? rt.demandPeak.value : 0;
    return Math.max(now, peak);
  }

  /** Ready replicas still taking requests (not draining). */
  protected servingMachines(name: string): ReplicaMachine[] {
    return this.readyMachines(name).filter(m => !this.draining.has(m.id));
  }

  protected busyOn(rt: Runtime, replicaId: string): number {
    const spec = rt.record.spec;
    return (rt.perReplica.get(replicaId) ?? 0) + Math.ceil(externalInflightOn(spec.name, replicaId, spec.targetInflightPerReplica, this.now()));
  }

  protected observed(m: ReplicaMachine, inflight: number): ObservedReplica {
    const p = this.probes.get(m.id) ?? { everReady: false, readyNow: false, failures: 0 };
    // A parked replica powered back on boots again: its boot (timeout, booting phase) AND its `maxHours` lifetime count
    // from the last power-on, not from the day the machine was created (a parked replica is not running).
    const startedAt = this.poweredOnAt.get(m.id);
    const machine = startedAt !== undefined ? { ...m, createdAt: Math.max(m.createdAt, startedAt) } : m;
    return {
      machine, everReady: p.everReady, readyNow: p.readyNow, failures: p.failures, inflight,
      ...(p.readyAt ? { readyAt: p.readyAt } : {}), ...(this.servedRecently(p) ? { servedRecently: true } : {}),
      ...(p.downSince !== undefined ? { downForMs: this.now() - p.downSince } : {}),
      ...(machine.createdAt < this.startedAt ? { bootStartedAt: this.startedAt } : {}),
      ...(this.adoptedPastBoot(machine) ? { adoptedPastBoot: true } : {}),
    };
  }

  protected adoptedPastBoot(m: ReplicaMachine): boolean {
    const spec = this.deployments.get(m.deployment)?.record.spec;
    return !!spec && m.createdAt + bootTimeoutMinutesOn(spec, this.providerOf(m)) * 60_000 <= this.startedAt;
  }

  protected parkedNow(m: ReplicaMachine): boolean {
    return this.deployments.get(m.deployment)?.record.spec.idleAction === 'stop' && isParked(m);
  }

  /** Being powered off by this gateway (or listed `stopping` under `idleAction: 'stop'`): not stopped yet, so not parked. */
  protected stoppingNow(m: ReplicaMachine): boolean {
    return this.stopping.has(m.id) && this.deployments.get(m.deployment)?.record.spec.idleAction === 'stop';
  }

  /** Stopped (parked or stopping) replicas, the count `DEPLOYMENTS_MAX_STOPPED` limits. */
  protected stoppedCount(): number {
    return this.machines.filter(m => (this.parkedNow(m) && !this.isStarting(m)) || this.stoppingNow(m)).length;
  }

  protected isStarting(m: ReplicaMachine): boolean {
    return this.deployments.get(m.deployment)?.starting.has(m.id) ?? false;
  }

  /** Billing compute right now: everything but parked machines (a parked one just powered on counts again). */
  protected runningMachines(): ReplicaMachine[] {
    return this.machines.filter(m => !this.parkedNow(m) || this.isStarting(m));
  }

  /** Summed catalog price (EUR/h) of the running replicas, plus the creates in flight. */
  protected burnEurPerHour(): number {
    let sum = 0;
    for (const m of this.runningMachines()) sum += m.pricePerHour ?? 0;
    for (const p of this.pendingSpend) sum += p.cost;
    return sum;
  }

  /** Why one more running replica billing `price` EUR/h is refused (replica cap, € ceiling), or null. */
  protected capRefusal(price: number): string | null {
    const cap = this.opts.maxTotalReplicas ?? 6;
    if (this.totalReplicas() >= cap) return `replica cap reached (${cap} across all deployments, DEPLOYMENTS_MAX_REPLICAS; held by ${this.slotHolders()})`;
    return this.spendRefusal(price);
  }

  protected slotHolders(): string {
    const held = new Map<string, number>();
    for (const m of this.runningMachines()) held.set(m.deployment, (held.get(m.deployment) ?? 0) + 1);
    for (const [name, rt] of this.deployments) if (rt.creating) held.set(name, (held.get(name) ?? 0) + rt.creating);
    return [...held].sort().map(([name, n]) => `${name} ${n}`).join(', ') || 'none';
  }

  protected reservedAgainst(name: string, machineType: string): { reason: string; endsAt: number } | null {
    const now = this.now();
    for (const [holder, rt] of this.deployments) {
      const { reserveQuota, paused } = rt.record.spec;
      if (!reserveQuota || holder === name || paused || rt.record.spec.machineType !== machineType) continue;
      const window = activeWindow(reserveQuota.windows, now);
      if (!window) continue;
      const others = this.machines.filter(m => m.machineType === machineType && m.deployment !== holder).length
        + [...this.pendingSpend].filter(s => s.machineType === machineType && s.deployment !== holder).length;
      if (others < reserveQuota.quota - window.replicas) continue;
      return {
        endsAt: window.endsAt,
        reason: `${machineType} is reserved for deployment '${holder}' until ${new Date(window.endsAt).toISOString()} `
          + `(${window.replicas} of a quota of ${reserveQuota.quota}; other deployments hold ${others}): '${name}' may not take one now`,
      };
    }
    return null;
  }

  protected reservationBlock(rt: Runtime): { reason: string; endsAt: number } | null {
    let block: { reason: string; endsAt: number } | null = null;
    for (const type of machineTypesOf(rt.record.spec)) {
      const refused = this.reservedAgainst(rt.record.spec.name, type);
      if (!refused) return null;
      block ??= refused;
    }
    return block;
  }

  /** The € ceiling alone (a create in flight already holds its replica slot). */
  protected spendRefusal(price: number): string | null {
    const ceiling = this.opts.maxEurPerHour ?? DEFAULT_MAX_EUR_PER_HOUR;
    const burn = this.burnEurPerHour();
    if (ceiling > 0 && burn + price > ceiling + 1e-9) {
      return `spend ceiling reached: running replicas bill €${round3(burn)}/h and this one €${round3(price)}/h, `
        + `above the €${ceiling}/h ceiling across all deployments (DEPLOYMENTS_MAX_EUR_PER_HOUR)`;
    }
    return null;
  }

  /** Running replicas plus creates in flight: what `maxTotalReplicas` limits (parked replicas cost no compute). */
  protected totalReplicas(): number {
    let creating = 0;
    for (const rt of this.deployments.values()) creating += rt.creating;
    return this.runningMachines().length + this.releasing.size + creating;
  }

  protected replicaToken(rt: Runtime, machine: ReplicaMachine): string {
    const tokenKey = machine.tokenKey ?? this.tokenKeys.get(machine.id);
    return replicaTokenFor(rt.record.secretPins?.[tokenKey ?? `id:${machine.id}`] ?? rt.record.replicaToken, tokenKey);
  }
}
