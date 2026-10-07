/**
 * Deterministic autoscaling simulation: the real `DeploymentController` (planner, pressure autoscaler, probes, drains,
 * caps) on a virtual clock, over a simulated cloud and simulated clients. No network, no timers, no randomness: the same
 * scenario always gives the same timeline.
 *
 * Model (calibrated on the live QA of 2026-10-07, `parle-speech` on an L40S):
 *   - a replica boots in `bootMs` (9 min); its front answers the liveness probe only once booted;
 *   - it serves `parallel` requests at full speed (LLM_PARALLEL 8); beyond, every request slows proportionally:
 *     latency = baseMs × max(1, inflight / parallel);
 *   - its health check times out (probe `busy`) while it carries `probeBusyAt` requests or more;
 *   - the gateway route hedges to the cloud fallback (`fallbackMs`, 1.2 s) after the delay the controller gives
 *     (`hedgeDelayMs`, adaptive: from `hedgeMs` 1.5 s up to 3/4 of the 4 s attempt timeout; `adaptiveHedge: false` = the
 *     old fixed 1.5 s): from then on the request runs twice (`doubleRuns`); if the replica is slower than hedge +
 *     fallback, its request is aborted (`cancelled`) and the fallback answers (`slow`); a replica slower than
 *     `timeoutMs` is given up (`timeout`) and the fallback answers after it;
 *   - a request refused by the controller (cold, saturated) is answered by the fallback at once.
 *   - clients keep `concurrency(t)` requests open per deployment (closed loop: a finished request is replaced).
 */

import { DeploymentController, type ControllerOptions, type Lease } from '../../src/deployments/controller';
import { MemoryDeploymentStore } from '../../src/deployments/store';
import type {
  CreateReplicaInput, DeploymentBackend, DeploymentSpec, DeploymentView, ProbeResult, ReplicaMachine, ReplicaProbe,
} from '../../src/deployments/types';

export interface ReplicaModel {
  bootMs: number;
  parallel: number;
  baseMs: number;
  probeBusyAt: number;
  hedgeMs: number;
  fallbackMs: number;
  price: number;
  /** The route's per-attempt timeout on the deployment (DEPLOYMENT_CHAT_TIMEOUT_MS). */
  timeoutMs: number;
  /** Hedge delay from `DeploymentController.hedgeDelayMs` (production) or the fixed `hedgeMs` (before 2026-10-07). */
  adaptiveHedge: boolean;
}

export const L40S_MODEL: ReplicaModel = {
  bootMs: 9 * 60_000, parallel: 8, baseMs: 1_500, probeBusyAt: 12, hedgeMs: 1_500, fallbackMs: 1_200, price: 1.47,
  timeoutMs: 4_000, adaptiveHedge: true,
};

/** The adaptive hedge's cap, as serve-providers.ts computes it (`HEDGE_CAP_OF_TIMEOUT` of the attempt timeout). */
const HEDGE_CAP_OF_TIMEOUT = 0.75;

export interface ScaleEvent {
  t: number; deployment: string; type: 'create' | 'release' | 'create-failed'; id: string; reason?: string; inflight?: number;
}

interface SimMachine { machine: ReplicaMachine; bootAt: number; crashed: boolean }

export class SimClock {
  constructor(public t: number) {}
  now = () => this.t;
}

class SimCloud implements DeploymentBackend {
  readonly provider = 'scaleway' as const;
  readonly machines = new Map<string, SimMachine>();
  readonly events: ScaleEvent[] = [];
  private seq = 0;

  /** Virtual time windows [from, to) in which every create fails `out of stock` (as Scaleway's 412). */
  stockOut: Array<[number, number]> = [];

  constructor(private readonly clock: SimClock, private readonly model: ReplicaModel, private readonly inflightOn: (id: string) => number) {}

  async createReplica(input: CreateReplicaInput): Promise<ReplicaMachine> {
    if (this.stockOut.some(([from, to]) => this.clock.t >= from && this.clock.t < to)) {
      this.events.push({ t: this.clock.t, deployment: input.spec.name, type: 'create-failed', id: '', reason: 'out_of_stock' });
      throw Object.assign(new Error(`scaleway HTTP 412: {"type":"out_of_stock","message":"${input.spec.machineType} out of stock"}`), { status: 412 });
    }
    const id = `fr-par-2:sim-${++this.seq}`;
    const machine: ReplicaMachine = {
      id, deployment: input.spec.name, ip: `10.0.0.${this.seq}`, state: 'running', createdAt: this.clock.t,
      zone: input.spec.zone, machineType: input.spec.machineType, pricePerHour: this.model.price,
    };
    this.machines.set(id, { machine, bootAt: this.clock.t + this.model.bootMs, crashed: false });
    this.events.push({ t: this.clock.t, deployment: input.spec.name, type: 'create', id });
    return { ...machine };
  }

  async listReplicas(): Promise<ReplicaMachine[]> {
    return [...this.machines.values()].map(m => ({ ...m.machine }));
  }

  async releaseReplica(machine: ReplicaMachine, reason?: string): Promise<void> {
    if (!this.machines.delete(machine.id)) return;
    this.events.push({ t: this.clock.t, deployment: machine.deployment, type: 'release', id: machine.id, reason, inflight: this.inflightOn(machine.id) });
  }

  async hourlyPrice(): Promise<number | null> {
    return this.model.price;
  }
}

class SimProbe implements ReplicaProbe {
  constructor(private readonly cloud: SimCloud, private readonly clock: SimClock, private readonly model: ReplicaModel,
    private readonly inflightOn: (id: string) => number) {}

  async ready(m: ReplicaMachine): Promise<boolean> {
    return (await this.check(m)) === 'ready';
  }

  async check(m: ReplicaMachine): Promise<ProbeResult> {
    const sim = this.cloud.machines.get(m.id);
    if (!sim || sim.crashed || this.clock.t < sim.bootAt) return 'down';
    return this.inflightOn(m.id) >= this.model.probeBusyAt ? 'busy' : 'ready';
  }
}

interface SimRequest {
  deployment: string;
  /** When the client gets its answer. */
  end: number;
  /** When the replica's part ends (answer, abort by the hedge winner, or timeout). */
  leaseEnd: number;
  lease: Lease | null;
  replica: string | null;
  outcome: 'ok' | 'cancelled' | 'timeout';
}

export interface LoadSpec {
  name: string;
  spec: Record<string, unknown>;
  /** Concurrent client requests at virtual second `s` since the start. */
  concurrency: (s: number) => number;
}

export interface TimelineRow {
  t: string;
  deployment: string;
  load: number;
  ready: number;
  booting: number;
  draining: number;
  desired: number;
  reason: string;
  blockedBy: string;
  gpu: number;
  fallback: number;
  /** Requests of the row's period that ran on the GPU and on the fallback both (hedge fired before the GPU answered). */
  double: number;
  p95: string;
}

export interface SimResult {
  rows: TimelineRow[];
  events: ScaleEvent[];
  /** Requests per deployment: answered by a replica, by the fallback (refused or hedged), failed (5xx: none possible here). */
  served: Record<string, { gpu: number; fallback: number; failed: number }>;
  /** Fallback-served requests per deployment and minute (for "no voice switch mid-class" checks). */
  fallbackByMinute: Record<string, number[]>;
  /** Replicas released while they had requests in flight, other than by drain timeout or crash. */
  killedBusy: ScaleEvent[];
  /** Requests that ran twice (GPU + fallback) because the hedge fired before the GPU answered, per deployment. */
  doubleRuns: Record<string, number>;
  /** Client-seen latency per deployment (ms): p50 / p95 over the whole run. */
  latency: Record<string, { p50: number; p95: number; n: number }>;
  views: () => DeploymentView[];
}

export interface Scenario {
  name: string;
  durationMin: number;
  loads: LoadSpec[];
  model?: Partial<ReplicaModel>;
  controller?: Partial<ControllerOptions>;
  /** Minutes [from, to) of the run in which every create fails `out of stock`. */
  outOfStock?: Array<[number, number]>;
  /** Virtual start (ms since epoch), for warm-up schedules. Default 2026-10-07T08:00:00Z. */
  start?: number;
  /** Things to do at a given second (crash a replica, call warm…). */
  at?: Record<number, (sim: Simulation) => Promise<void> | void>;
  /** Timeline row every N seconds (default 60). */
  rowEverySeconds?: number;
  /** Mean of the reconcile tick, as in production (20 s). */
  reconcileSeconds?: number;
}

export class Simulation {
  readonly clock: SimClock;
  readonly model: ReplicaModel;
  readonly cloud: SimCloud;
  readonly controller: DeploymentController;
  private readonly requests: SimRequest[] = [];
  private readonly perReplica = new Map<string, number>();
  private readonly latencies = new Map<string, number[]>();
  private readonly doubles = new Map<string, number>();

  constructor(readonly scenario: Scenario) {
    this.clock = new SimClock(scenario.start ?? Date.parse('2026-10-07T08:00:00Z'));
    this.model = { ...L40S_MODEL, ...scenario.model };
    const inflightOn = (id: string) => this.perReplica.get(id) ?? 0;
    this.cloud = new SimCloud(this.clock, this.model, inflightOn);
    this.cloud.stockOut = (scenario.outOfStock ?? []).map(([a, b]) => [this.clock.t + a * 60_000, this.clock.t + b * 60_000]);
    this.controller = new DeploymentController({
      backend: this.cloud, store: new MemoryDeploymentStore(), probe: new SimProbe(this.cloud, this.clock, this.model, inflightOn),
      namespace: 'sim', now: this.clock.now, maxTotalReplicas: 6, maxEurPerHour: 0, ...scenario.controller,
    });
  }

  /** A replica dies (its front stops answering, its requests fail). */
  crash(deployment: string): string | null {
    const victim = [...this.cloud.machines.values()].find(m => m.machine.deployment === deployment && !m.crashed && this.clock.t >= m.bootAt);
    if (!victim) return null;
    victim.crashed = true;
    for (const r of this.requests) if (r.replica === victim.machine.id && r.lease) {
      r.lease.done(true);
      r.lease = null;
      r.leaseEnd = this.clock.t;
      this.bump(r.replica, -1);
      r.replica = null; // the route falls back
    }
    return victim.machine.id;
  }

  private bump(id: string, by: number): void {
    const n = (this.perReplica.get(id) ?? 0) + by;
    if (n <= 0) this.perReplica.delete(id); else this.perReplica.set(id, n);
  }

  private async settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await this.controller.reconcile();
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  private answer(deployment: string, end: number, extra: Omit<SimRequest, 'deployment' | 'end' | 'leaseEnd'> & { leaseEnd?: number }): void {
    const list = this.latencies.get(deployment) ?? [];
    list.push(end - this.clock.t);
    this.latencies.set(deployment, list);
    this.requests.push({ deployment, end, leaseEnd: extra.leaseEnd ?? end, ...extra });
  }

  /** The route: hedge delay read at the attempt's start (before `acquire`), as provider-routing.ts does. */
  private async startRequest(load: LoadSpec, served: SimResult['served']): Promise<void> {
    const now = this.clock.t;
    const m = this.model;
    const hedgeMs = m.adaptiveHedge ? this.controller.hedgeDelayMs(load.name, m.hedgeMs, Math.round(m.timeoutMs * HEDGE_CAP_OF_TIMEOUT)) : m.hedgeMs;
    let lease: Lease | null = null;
    try { lease = await this.controller.acquire(load.name, { waitMs: 0 }); } catch { lease = null; }
    if (!lease) { // cold or saturated: the chain moves to the fallback at once, nothing runs twice
      served[load.name].fallback++;
      this.answer(load.name, now + m.fallbackMs, { lease: null, replica: null, outcome: 'ok' });
      return;
    }
    const id = lease.machine.id;
    this.bump(id, 1);
    const gpuMs = m.baseMs * Math.max(1, (this.perReplica.get(id) ?? 0) / m.parallel);
    const hedged = hedgeMs != null && gpuMs > hedgeMs && hedgeMs < m.timeoutMs;
    if (hedged) this.doubles.set(load.name, (this.doubles.get(load.name) ?? 0) + 1);
    const fallbackDone = hedged ? hedgeMs! + m.fallbackMs : Infinity;
    if (gpuMs <= Math.min(fallbackDone, m.timeoutMs)) {
      served[load.name].gpu++;
      this.answer(load.name, now + gpuMs, { lease, replica: id, outcome: 'ok' });
    } else if (fallbackDone <= m.timeoutMs) { // the hedge won: the GPU call is aborted
      served[load.name].fallback++;
      this.answer(load.name, now + fallbackDone, { lease, replica: id, outcome: 'cancelled' });
    } else { // the attempt timed out: the chain moves on after it (or the hedge already running answers)
      served[load.name].fallback++;
      this.answer(load.name, now + Math.min(fallbackDone, m.timeoutMs + m.fallbackMs), { lease, replica: id, outcome: 'timeout', leaseEnd: now + m.timeoutMs });
    }
  }

  async run(): Promise<SimResult> {
    const { scenario } = this;
    await this.controller.init();
    for (const load of scenario.loads) await this.controller.put(load.name, load.spec);
    const served: SimResult['served'] = Object.fromEntries(scenario.loads.map(l => [l.name, { gpu: 0, fallback: 0, failed: 0 }]));
    const fallbackByMinute: SimResult['fallbackByMinute'] = Object.fromEntries(scenario.loads.map(l => [l.name, []]));
    const rows: TimelineRow[] = [];
    const every = scenario.rowEverySeconds ?? 60;
    const tick = scenario.reconcileSeconds ?? 20;
    const last: Record<string, { gpu: number; fallback: number; double: number }> = {};
    await this.settle();
    for (let s = 0; s <= scenario.durationMin * 60; s++) {
      if (s > 0) this.clock.t += 1000;
      await scenario.at?.[s]?.(this);
      // Finish what ended.
      for (let i = this.requests.length - 1; i >= 0; i--) {
        const r = this.requests[i];
        if (r.lease && r.replica && r.leaseEnd <= this.clock.t) {
          this.bump(r.replica, -1);
          // The lease ends at its exact time (not the next 1 s step): the controller's latency samples stay exact.
          const tick = this.clock.t;
          this.clock.t = r.leaseEnd;
          r.lease.done(r.outcome === 'ok' ? false : r.outcome);
          this.clock.t = tick;
          r.lease = null;
        }
        if (r.end <= this.clock.t) this.requests.splice(i, 1);
      }
      // Top up each deployment to its concurrency.
      for (const load of scenario.loads) {
        const open = this.requests.filter(r => r.deployment === load.name).length;
        const before = served[load.name].fallback;
        for (let i = open; i < load.concurrency(s); i++) await this.startRequest(load, served);
        const minute = Math.floor(s / 60);
        fallbackByMinute[load.name][minute] = (fallbackByMinute[load.name][minute] ?? 0) + served[load.name].fallback - before;
      }
      if (s % tick === 0) await this.settle();
      else for (let i = 0; i < 20; i++) await Promise.resolve();
      if (s % every === 0) {
        for (const load of scenario.loads) {
          const v = this.controller.get(load.name)!;
          const prev = last[load.name] ?? { gpu: 0, fallback: 0, double: 0 };
          const now = { ...served[load.name], double: this.doubles.get(load.name) ?? 0 };
          rows.push({
            t: `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`,
            deployment: load.name,
            load: load.concurrency(s),
            ready: v.replicas.filter(r => r.phase === 'ready' && !r.draining).length,
            booting: v.replicas.filter(r => r.phase === 'booting').length,
            draining: v.replicas.filter(r => r.draining).length,
            desired: v.autoscale.desired,
            reason: v.autoscale.reason,
            blockedBy: v.autoscale.blockedBy ?? '',
            gpu: now.gpu - prev.gpu,
            fallback: now.fallback - prev.fallback,
            double: now.double - prev.double,
            p95: v.autoscale.p95Ms == null ? '' : String(Math.round(v.autoscale.p95Ms)),
          });
          last[load.name] = { gpu: now.gpu, fallback: now.fallback, double: now.double };
        }
      }
    }
    const killedBusy = this.cloud.events.filter(e => e.type === 'release' && (e.inflight ?? 0) > 0 && e.reason !== 'drain-timeout');
    const latency = Object.fromEntries(scenario.loads.map((l) => {
      const sorted = [...(this.latencies.get(l.name) ?? [])].sort((a, b) => a - b);
      const q = (p: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]) : 0);
      return [l.name, { p50: q(0.5), p95: q(0.95), n: sorted.length }];
    }));
    const doubleRuns = Object.fromEntries(scenario.loads.map(l => [l.name, this.doubles.get(l.name) ?? 0]));
    return { rows, events: this.cloud.events, served, fallbackByMinute, killedBusy, doubleRuns, latency, views: () => this.controller.list() };
  }
}

/** Runs one scenario. */
export function simulate(scenario: Scenario): Promise<SimResult> {
  return new Simulation(scenario).run();
}

/** Fixed-width timeline table for reports. */
export function formatTimeline(title: string, rows: TimelineRow[]): string {
  const cols: Array<[keyof TimelineRow, string]> = [
    ['t', 't'], ['deployment', 'deployment'], ['load', 'load'], ['ready', 'ready'], ['booting', 'boot'], ['draining', 'drain'],
    ['desired', 'want'], ['gpu', 'gpu'], ['fallback', 'fb'], ['double', '2x'], ['p95', 'p95ms'], ['reason', 'reason'], ['blockedBy', 'blockedBy'],
  ];
  const cell = (r: TimelineRow, k: keyof TimelineRow) => String(r[k]);
  const width = cols.map(([k, h]) => Math.max(h.length, ...rows.map(r => Math.min(72, cell(r, k).length))));
  const line = (vals: string[]) => vals.map((v, i) => v.slice(0, 72).padEnd(width[i])).join(' | ').trimEnd();
  return [`### ${title}`, line(cols.map(c => c[1])), width.map(w => '-'.repeat(w)).join('-|-'), ...rows.map(r => line(cols.map(([k]) => cell(r, k))))].join('\n');
}

/** The speech deployment as it ran live (parle-speech, 2026-10-07), in a form `put` accepts. */
export const SPEECH_SPEC: Record<string, unknown> = {
  image: 'ghcr.io/parle/speech-stack:1', port: 8000, machineType: 'L40S-1-48G', zone: 'fr-par-2', gpu: true,
  minReplicas: 0, maxReplicas: 2, targetInflightPerReplica: 8, idleMinutes: 1, scaleDownDelaySeconds: 0,
  bootTimeoutMinutes: 20, maxEurPerHour: 2, coldStartWaitSeconds: 0,
};

export type { DeploymentSpec };
