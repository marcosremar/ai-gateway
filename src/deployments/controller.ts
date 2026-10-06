/**
 * DeploymentController — keeps every deployment at its planned replica count and hands ready replicas to callers.
 *
 * Loop (every `reconcileMs`, and right away when a request finds no ready replica):
 *   list machines by namespace tag → probe each → `planReplicas` → release / create.
 * Machines tagged with this namespace but belonging to no known deployment are released (orphans: their token is
 * gone with the spec, so nothing could reach them anyway).
 *
 * Single-process by design: run ONE gateway replica per namespace (two would both scale the same deployment).
 */

import { randomBytes } from 'crypto';
import { replicaCloudInit } from './cloud-init';
import { packFiles } from './file-pack';
import { planReplicas, replicaPhase, type ObservedReplica } from './planner';
import { BUILTIN_PROFILES } from './profiles';
import { buildSpec, parsePartialSpec, NAME_RE, SpecError, USER_DATA_KEY_MAX_BYTES } from './spec';
import type {
  DeploymentBackend, DeploymentRecord, DeploymentSpec, DeploymentStore, DeploymentView, Profile, ReplicaMachine, ReplicaProbe,
} from './types';

export class DeploymentError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterSeconds?: number) {
    super(message);
  }
}

interface ProbeState { everReady: boolean; readyNow: boolean; failures: number }

interface Runtime {
  record: DeploymentRecord;
  inflight: number;
  waiting: number;
  perReplica: Map<string, number>;
  aboveSince: number | null;
  lastError: string | null;
  creating: number;
  backoffUntil: number;
  createFailures: number;
  lastPersistedRequestAt: number | null;
  waiters: Set<() => void>;
}

export interface ControllerOptions {
  backend: DeploymentBackend;
  store: DeploymentStore;
  probe: ReplicaProbe;
  namespace?: string;
  /** Cap on replicas across all deployments (protects the bill). */
  maxTotalReplicas?: number;
  reconcileMs?: number;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface Lease {
  machine: ReplicaMachine;
  token: string;
  /** Call once the forwarded request finished. `failed` = connection-level failure (marks the replica suspect). */
  done(failed?: boolean): void;
}

const CREATE_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000];

export class DeploymentController {
  private readonly deployments = new Map<string, Runtime>();
  private readonly profiles = new Map<string, Profile>();
  private machines: ReplicaMachine[] = [];
  private readonly probes = new Map<string, ProbeState>();
  private reconciling: Promise<void> | null = null;
  private rerun = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastListError: string | null = null;
  readonly namespace: string;
  private readonly now: () => number;
  private readonly log: (msg: string, data?: Record<string, unknown>) => void;

  constructor(private readonly opts: ControllerOptions) {
    this.namespace = opts.namespace ?? 'default';
    if (!NAME_RE.test(this.namespace)) throw new Error(`invalid deployments namespace '${this.namespace}'`);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  async init(): Promise<void> {
    const { deployments, profiles } = await this.opts.store.load();
    for (const p of BUILTIN_PROFILES) this.profiles.set(p.name, p);
    for (const p of profiles) this.profiles.set(p.name, p);
    for (const record of deployments) this.deployments.set(record.spec.name, this.runtime(record));
  }

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

  private runtime(record: DeploymentRecord): Runtime {
    return {
      record, inflight: 0, waiting: 0, perReplica: new Map(), aboveSince: null, lastError: null, creating: 0,
      backoffUntil: 0, createFailures: 0, lastPersistedRequestAt: record.lastRequestAt, waiters: new Set(),
    };
  }

  // ── Profiles ──────────────────────────────────────────────────────────────

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

  // ── Deployments ───────────────────────────────────────────────────────────

  async put(
    name: string, body: Record<string, unknown>, meta: { app?: string; appImage?: string } = {},
  ): Promise<{ view: DeploymentView; created: boolean }> {
    const existing = this.deployments.get(name);
    const spec = buildSpec(name, body, { profiles: this.profiles, previous: existing?.record.spec });
    const initBytes = Buffer.byteLength(replicaCloudInit(spec, 'x'.repeat(32)));
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
    return true;
  }

  /** Marks the deployment as in use (scales from zero) without sending a request. */
  wake(name: string): DeploymentView {
    const rt = this.require(name);
    rt.record.lastRequestAt = this.now();
    this.kick();
    return this.view(name)!;
  }

  list(): DeploymentView[] {
    return [...this.deployments.keys()].sort().map(n => this.view(n)!);
  }

  get(name: string): DeploymentView | null {
    return this.view(name);
  }

  private require(name: string): Runtime {
    const rt = this.deployments.get(name);
    if (!rt) throw new DeploymentError(404, `deployment '${name}' not found`);
    return rt;
  }

  // ── Routing ───────────────────────────────────────────────────────────────

  private readyMachines(name: string): ReplicaMachine[] {
    return this.machines.filter(m => m.deployment === name && m.ip && this.probes.get(m.id)?.readyNow
      && replicaPhase(this.observed(m, 0)) === 'ready');
  }

  private pick(rt: Runtime, exclude: Set<string>): ReplicaMachine | null {
    const ready = this.readyMachines(rt.record.spec.name).filter(m => !exclude.has(m.id));
    if (!ready.length) return null;
    return ready.reduce((best, m) => ((rt.perReplica.get(m.id) ?? 0) < (rt.perReplica.get(best.id) ?? 0) ? m : best));
  }

  /**
   * A ready replica for one request, waiting through a cold start up to `waitMs`. Throws `DeploymentError`
   * 503 (+ Retry-After) when none became ready in time.
   */
  async acquire(name: string, opts: { waitMs?: number; exclude?: Set<string>; signal?: AbortSignal } = {}): Promise<Lease> {
    const rt = this.require(name);
    const { spec } = rt.record;
    if (spec.paused) throw new DeploymentError(409, `deployment '${name}' is paused`);
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
      const msg = rt.lastError ? `no ready replica yet (last error: ${rt.lastError})` : 'replicas are starting';
      throw new DeploymentError(503, `deployment '${name}': ${msg}`, 30);
    }

    rt.inflight++;
    rt.perReplica.set(machine.id, (rt.perReplica.get(machine.id) ?? 0) + 1);
    rt.record.lastRequestAt = this.now();
    if (rt.inflight > spec.targetInflightPerReplica * this.readyMachines(name).length) this.kick();
    const chosen = machine;
    let released = false;
    return {
      machine: chosen,
      token: rt.record.replicaToken,
      done: (failed = false) => {
        if (released) return;
        released = true;
        rt.inflight--;
        const n = (rt.perReplica.get(chosen.id) ?? 1) - 1;
        if (n <= 0) rt.perReplica.delete(chosen.id); else rt.perReplica.set(chosen.id, n);
        rt.record.lastRequestAt = this.now();
        if (failed) {
          const p = this.probes.get(chosen.id);
          if (p) { p.readyNow = false; p.failures++; }
          this.kick();
        }
      },
    };
  }

  private persistRequestTime(rt: Runtime): void {
    const at = rt.record.lastRequestAt;
    if (at == null || (rt.lastPersistedRequestAt != null && at - rt.lastPersistedRequestAt < 60_000)) return;
    rt.lastPersistedRequestAt = at;
    void this.opts.store.saveDeployment(rt.record).catch(() => {});
  }

  // ── Reconcile ─────────────────────────────────────────────────────────────

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

  private observed(m: ReplicaMachine, inflight: number): ObservedReplica {
    const p = this.probes.get(m.id) ?? { everReady: false, readyNow: false, failures: 0 };
    return { machine: m, everReady: p.everReady, readyNow: p.readyNow, failures: p.failures, inflight };
  }

  private async reconcileOnce(): Promise<void> {
    let listed: ReplicaMachine[];
    try {
      listed = await this.opts.backend.listReplicas(this.namespace);
      this.lastListError = null;
    } catch (err) {
      // A failed list must never read as "nothing is running" (that would create duplicates).
      this.lastListError = err instanceof Error ? err.message : String(err);
      this.log('deployments: list failed', { error: this.lastListError });
      return;
    }
    // Keep machines we just created that the provider list does not show yet.
    const recent = this.machines.filter(m => !listed.some(l => l.id === m.id) && this.now() - m.createdAt < 120_000
      && this.deployments.has(m.deployment));
    // The list may lack what the create call returned (IP early on, the catalog price): keep the known values.
    this.machines = [...listed.map((l) => {
      const known = this.machines.find(m => m.id === l.id);
      return { ...l, ip: l.ip ?? known?.ip ?? null, pricePerHour: l.pricePerHour ?? known?.pricePerHour ?? null };
    }), ...recent];
    for (const id of [...this.probes.keys()]) if (!this.machines.some(m => m.id === id)) this.probes.delete(id);

    const orphans = this.machines.filter(m => !this.deployments.has(m.deployment));
    for (const m of orphans) await this.release(m, 'orphan');

    await Promise.all(this.machines.filter(m => this.deployments.has(m.deployment)).map(m => this.probeOne(m)));

    for (const [name, rt] of this.deployments) {
      const mine = this.machines.filter(m => m.deployment === name);
      const plan = planReplicas({
        spec: rt.record.spec,
        replicas: mine.map(m => this.observed(m, rt.perReplica.get(m.id) ?? 0)),
        inflight: rt.inflight,
        waiting: rt.waiting,
        lastRequestAt: rt.record.lastRequestAt,
        aboveSince: rt.aboveSince,
        now: this.now(),
      });
      rt.aboveSince = plan.aboveSince;
      for (const r of plan.release) {
        const m = mine.find(x => x.id === r.id);
        if (m) await this.release(m, r.reason);
      }
      const toCreate = plan.create - rt.creating;
      for (let i = 0; i < toCreate; i++) this.createReplica(rt);
      if (this.readyMachines(name).length) for (const w of [...rt.waiters]) w();
    }
  }

  private async probeOne(m: ReplicaMachine): Promise<void> {
    const rt = this.deployments.get(m.deployment);
    if (!rt || !m.ip) return;
    const p = this.probes.get(m.id) ?? { everReady: false, readyNow: false, failures: 0 };
    let ok = false;
    try {
      ok = await this.opts.probe.ready(m, rt.record.spec, rt.record.replicaToken);
    } catch {
      ok = false;
    }
    if (ok) { p.everReady = true; p.readyNow = true; p.failures = 0; }
    else { p.readyNow = false; if (p.everReady) p.failures++; }
    this.probes.set(m.id, p);
  }

  private async release(m: ReplicaMachine, reason: string): Promise<void> {
    this.log('deployments: releasing replica', { deployment: m.deployment, id: m.id, reason });
    try {
      await this.opts.backend.releaseReplica(m);
      this.machines = this.machines.filter(x => x.id !== m.id);
      this.probes.delete(m.id);
    } catch (err) {
      const rt = this.deployments.get(m.deployment);
      if (rt) rt.lastError = `release ${m.id}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private totalReplicas(): number {
    let creating = 0;
    for (const rt of this.deployments.values()) creating += rt.creating;
    return this.machines.length + creating;
  }

  /** The spec as the machine sees it: the provider's own registry credentials when the caller sent none. */
  private withRegistryAuth(spec: DeploymentSpec): DeploymentSpec {
    if (spec.registryAuth || spec.bootScript) return spec;
    const auth = this.opts.backend.registryAuthFor?.(spec.image);
    return auth ? { ...spec, registryAuth: auth } : spec;
  }

  private createReplica(rt: Runtime): void {
    const spec = rt.record.spec;
    if (this.now() < rt.backoffUntil) return;
    const cap = this.opts.maxTotalReplicas ?? 6;
    if (this.totalReplicas() >= cap) {
      rt.lastError = `replica cap reached (${cap} across all deployments)`;
      return;
    }
    rt.creating++;
    void (async () => {
      try {
        const price = await this.opts.backend.hourlyPrice(spec.zone, spec.machineType);
        if (price == null) throw new Error(`${spec.machineType} is not sold in ${spec.zone}`);
        if (price > spec.maxEurPerHour) {
          throw new Error(`${spec.machineType} costs €${price}/h in ${spec.zone}, above maxEurPerHour €${spec.maxEurPerHour}`);
        }
        this.log('deployments: creating replica', { deployment: spec.name, type: spec.machineType, zone: spec.zone, price });
        const machine = await this.opts.backend.createReplica({
          spec, replicaToken: rt.record.replicaToken, namespace: this.namespace,
          cloudInit: replicaCloudInit(this.withRegistryAuth(spec), rt.record.replicaToken),
          ...(spec.files ? { files: packFiles(Object.fromEntries(Object.entries(spec.files).map(([k, v]) => [k, new Uint8Array(Buffer.from(v, 'base64'))]))).chunks } : {}),
        });
        if (this.deployments.get(spec.name) !== rt) {
          await this.opts.backend.releaseReplica(machine); // deleted while creating
          return;
        }
        this.machines.push({ ...machine, pricePerHour: machine.pricePerHour ?? price });
        rt.createFailures = 0;
        rt.lastError = null;
      } catch (err) {
        rt.lastError = `create: ${err instanceof Error ? err.message : String(err)}`;
        rt.backoffUntil = this.now() + CREATE_BACKOFF_MS[Math.min(rt.createFailures, CREATE_BACKOFF_MS.length - 1)];
        rt.createFailures++;
        this.log('deployments: create failed', { deployment: spec.name, error: rt.lastError });
      } finally {
        rt.creating--;
      }
    })();
  }

  // ── Views ─────────────────────────────────────────────────────────────────

  tokenOf(name: string): string | null {
    return this.deployments.get(name)?.record.replicaToken ?? null;
  }

  health(): { deployments: number; replicas: number; listError: string | null } {
    return { deployments: this.deployments.size, replicas: this.machines.length, listError: this.lastListError };
  }

  private view(name: string): DeploymentView | null {
    const rt = this.deployments.get(name);
    if (!rt) return null;
    const { env, registryAuth, bootScript, files, ...publicSpec } = rt.record.spec;
    const now = this.now();
    const replicas = this.machines.filter(m => m.deployment === name).map(m => ({
      id: m.id,
      phase: replicaPhase(this.observed(m, 0)),
      ip: m.ip,
      providerState: m.state,
      zone: m.zone,
      machineType: m.machineType,
      pricePerHour: m.pricePerHour,
      ageSeconds: Math.round((now - m.createdAt) / 1000),
      inflight: rt.perReplica.get(m.id) ?? 0,
    }));
    const ready = replicas.filter(r => r.phase === 'ready').length;
    const desired = planReplicas({
      spec: rt.record.spec, replicas: [], inflight: rt.inflight, waiting: rt.waiting,
      lastRequestAt: rt.record.lastRequestAt, aboveSince: null, now,
    }).desired;
    const status: DeploymentView['status'] = rt.record.spec.paused ? 'paused'
      : replicas.length === 0 && rt.creating === 0 ? 'scaled-to-zero'
        : ready === 0 ? 'warming'
          : ready < desired ? 'degraded' : 'ready';
    return {
      name,
      spec: {
        ...publicSpec, envKeys: Object.keys(env), privateRegistry: Boolean(registryAuth), bootScript: Boolean(bootScript),
        fileKeys: Object.keys(files ?? {}),
      },
      status,
      desiredReplicas: desired,
      replicas,
      inflight: rt.inflight,
      waiting: rt.waiting,
      lastRequestAt: rt.record.lastRequestAt ? new Date(rt.record.lastRequestAt).toISOString() : null,
      lastError: rt.lastError,
      invokeUrl: `/v1/deployments/${name}/invoke/`,
      app: rt.record.app ?? null,
      appImage: rt.record.appImage ?? null,
    };
  }
}

export type { DeploymentSpec };
