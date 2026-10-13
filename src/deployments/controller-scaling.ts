import type { PressureDecision } from './autoscale';
import { autoscaleSettings } from './autoscale';
import { DEFAULT_RT_MAX_SESSIONS } from './cloud-init';
import { placementsOf } from './placements';
import { ParkingControl } from './controller-parking';
import { activeWindow } from './autoscale';
import { isParked, machineTypesOf, REFUSED_HOLD_MS, round3, type Runtime } from './controller-state';
import {
  DEFAULT_BOOT_SECONDS, DEFAULT_RESUME_SECONDS, median, noteLoad, scalingDecision, type LoadSample,
} from './scaling-policy';
import type { CapacityEntry, CapacityTime, CapacityView, DeploymentSpec, ReplicaMachine } from './types';

const MEASURED_KEEP = 5;
const SPEND_SAVE_MS = 60_000;
const SESSION_DRAIN_MS = 30 * 60_000;
const CONFIDENT_SAMPLES = 3;

interface ScalingState { trace: LoadSample[]; refusals: { at: number; n: number }; spendSavedAt: number; warnedMonth: string | null }

const measuredKey = (machineType: string, image: string) => `${machineType}|${image || 'boot-script'}`;
const monthOf = (now: number) => new Date(now).toISOString().slice(0, 7);
const imageOn = (spec: DeploymentSpec, machineType: string) => placementsOf(spec).find(p => p.machineType === machineType)?.image ?? spec.image;

function sessionCeiling(spec: DeploymentSpec, machineType = spec.machineType): CapacityEntry['ceiling'] {
  const configured = spec.realtime?.maxSessions ?? (Number(spec.envByMachineType?.[machineType]?.RT_MAX_SESSIONS) || null);
  return { sessions: configured ?? DEFAULT_RT_MAX_SESSIONS, source: configured ? 'configured' : 'default', samples: 0 };
}

export abstract class ScalingControl extends ParkingControl {
  private readonly scalingStates = new WeakMap<Runtime, ScalingState>();

  private scalingState(rt: Runtime): ScalingState {
    let s = this.scalingStates.get(rt);
    if (!s) { s = { trace: [], refusals: { at: 0, n: 0 }, spendSavedAt: 0, warnedMonth: null }; this.scalingStates.set(rt, s); }
    return s;
  }

  protected override noteDemand(rt: Runtime): void {
    super.noteDemand(rt);
    this.traceLoad(rt);
  }

  protected forgetLoad(rt: Runtime): void {
    this.scalingStates.delete(rt);
  }

  protected traceLoad(rt: Runtime): void {
    const { spec } = rt.record;
    if (!spec.scaling) return;
    const s = this.scalingState(rt);
    const seen = s.refusals;
    const fresh = rt.refusedAt.filter(t => t > seen.at).length + Math.max(0, rt.refusedAt.filter(t => t === seen.at).length - seen.n);
    const last = rt.refusedAt.at(-1);
    if (last !== undefined) s.refusals = { at: last, n: rt.refusedAt.filter(t => t === last).length };
    const count = this.opts.sessions?.(spec.name) ?? null;
    const sessions = count === null ? null : count * spec.targetInflightPerReplica / sessionCeiling(spec).sessions;
    noteLoad(s.trace, { at: this.now(), level: Math.max(rt.inflight + rt.waiting, sessions ?? 0), refused: fresh, sessions });
  }

  private billing(rt: Runtime): ReplicaMachine[] {
    return this.runningMachines().filter(m => m.deployment === rt.record.spec.name);
  }

  private priceOf(rt: Runtime): number {
    const { spec } = rt.record;
    return this.machines.find(m => m.deployment === spec.name && m.pricePerHour != null)?.pricePerHour ?? spec.maxEurPerHour;
  }

  private timesOf(rt: Runtime): { boot: number; resume: number; start: number; idle: number } {
    const { spec } = rt.record;
    const measured = rt.record.measured?.[measuredKey(spec.machineType, spec.image)];
    const boot = median(measured?.boot) ?? DEFAULT_BOOT_SECONDS;
    const resume = median(measured?.resume) ?? DEFAULT_RESUME_SECONDS;
    const parked = this.machines.some(m => m.deployment === spec.name && this.parkedNow(m) && !this.isStarting(m));
    return { boot, resume, start: parked ? resume : boot, idle: Math.max(spec.idleAction === 'stop' ? resume : boot, spec.scaleDownDelaySeconds) };
  }

  private monthSpent(rt: Runtime): boolean {
    const budget = rt.record.spec.scaling?.budget?.eurPerMonth;
    const spend = rt.record.spend;
    return budget !== undefined && spend?.month === monthOf(this.now()) && spend.eur >= budget;
  }

  private replicaCap(rt: Runtime): { max: number; note: string } {
    const { spec } = rt.record;
    const budget = spec.scaling?.budget ?? {};
    const price = this.priceOf(rt);
    const limits: Array<[number, string]> = [[spec.maxReplicas, `maxReplicas ${spec.maxReplicas}`]];
    if (budget.maxReplicas !== undefined) limits.push([budget.maxReplicas, `budget.maxReplicas ${budget.maxReplicas}`]);
    if (budget.eurPerHour !== undefined && price > 0) {
      const n = Math.floor(budget.eurPerHour / price + 1e-9);
      limits.push([n, `budget €${budget.eurPerHour}/h pays for ${n} at €${round3(price)}/h`]);
    }
    if (this.monthSpent(rt)) limits.push([0, this.budgetRefusal(rt)!]);
    const [max, note] = limits.reduce((best, l) => (l[0] < best[0] ? l : best));
    return { max, note };
  }

  protected budgetRefusal(rt: Runtime): string | null {
    if (!this.monthSpent(rt)) return null;
    const { spend, spec } = rt.record;
    return `monthly budget spent: €${spend!.eur.toFixed(2)} of €${spec.scaling!.budget!.eurPerMonth} in ${spend!.month}, new load goes to the fallback`;
  }

  private accrueSpend(rt: Runtime): void {
    const budget = rt.record.spec.scaling?.budget?.eurPerMonth;
    if (budget === undefined) return;
    const now = this.now();
    const month = monthOf(now);
    const prev = rt.record.spend;
    let eur = prev?.month === month ? prev.eur : 0;
    for (const m of this.billing(rt)) {
      const since = Math.max(prev?.at ?? now, m.createdAt, this.poweredOnAt.get(m.id) ?? 0);
      eur += (m.pricePerHour ?? 0) * Math.max(0, now - since) / 3_600_000;
    }
    rt.record.spend = { month, eur, at: now };
    const s = this.scalingState(rt);
    if (eur >= budget && s.warnedMonth !== month) {
      s.warnedMonth = month;
      this.log('deployments: monthly budget spent, new load goes to the fallback', { deployment: rt.record.spec.name, month, eur: round3(eur), budget });
    }
    if (now - s.spendSavedAt < SPEND_SAVE_MS) return;
    s.spendSavedAt = now;
    void this.opts.store.saveDeployment(rt.record).catch(() => {});
  }

  protected scalingDecide(rt: Runtime, live: number, active: boolean): PressureDecision {
    this.accrueSpend(rt);
    this.traceLoad(rt);
    const times = this.timesOf(rt);
    const cap = this.replicaCap(rt);
    return scalingDecision({
      spec: rt.record.spec, trace: this.scalingState(rt).trace, refusedHoldMs: REFUSED_HOLD_MS, now: this.now(), live,
      maxReplicas: cap.max, capNote: cap.note, price: this.priceOf(rt), bootSeconds: times.start, idleSeconds: times.idle,
      active, state: rt.pressure,
    });
  }

  protected planSpec(rt: Runtime): DeploymentSpec {
    const { spec } = rt.record;
    if (!spec.scaling) return spec;
    return {
      ...spec, maxReplicas: this.replicaCap(rt).max, idleMinutes: Math.max(spec.idleMinutes, this.timesOf(rt).idle / 60),
      scaleDownDelaySeconds: 0,
    };
  }

  protected planExtras(rt: Runtime): { autoscaleOnly?: boolean; hold?: number } {
    const hold = rt.record.hold;
    return {
      ...(rt.record.spec.scaling ? { autoscaleOnly: true } : {}),
      ...(hold && this.now() < hold.until ? { hold: hold.replicas } : {}),
    };
  }

  protected drainMsOf(rt: Runtime): number {
    const { spec } = rt.record;
    return spec.scaling && spec.autoscale?.drainSeconds === undefined ? SESSION_DRAIN_MS : autoscaleSettings(spec).drainMs;
  }

  protected override async probeOne(m: ReplicaMachine): Promise<void> {
    const wasReady = this.probes.get(m.id)?.everReady === true;
    await super.probeOne(m);
    const rt = this.deployments.get(m.deployment);
    if (wasReady || !rt || !this.probes.get(m.id)?.everReady) return;
    const resumedAt = this.poweredOnAt.get(m.id);
    const from = resumedAt ?? m.createdAt;
    if (from < this.startedAt) return;
    const key = measuredKey(m.machineType, imageOn(rt.record.spec, m.machineType));
    const kind = resumedAt === undefined ? 'boot' : 'resume';
    const entry = rt.record.measured?.[key] ?? { boot: [], resume: [] };
    const samples = [...entry[kind], Math.round((this.now() - from) / 1000)].slice(-MEASURED_KEEP);
    rt.record.measured = { ...rt.record.measured, [key]: { ...entry, [kind]: samples } };
    void this.opts.store.saveDeployment(rt.record).catch(() => {});
  }

  protected expectedReadyAt(rt: Runtime, mine: ReplicaMachine[]): number | null {
    const { spec } = rt.record;
    if (mine.some(m => isParked(m) || this.probes.get(m.id)?.everReady)) return null;
    const samples = rt.record.measured?.[measuredKey(spec.machineType, spec.image)]?.boot;
    if (!samples || samples.length < CONFIDENT_SAMPLES) return null;
    return (mine.length ? Math.min(...mine.map(m => m.createdAt)) : this.now()) + median(samples)! * 1000;
  }

  capacity(name: string): CapacityView | null {
    const rt = this.deployments.get(name);
    if (!rt) return null;
    const { spec, spend, hold, measured } = rt.record;
    const now = this.now();
    const types = machineTypesOf(spec);
    const reservations = [...this.deployments].flatMap(([holder, other]) => {
      const { reserveQuota, machineType } = other.record.spec;
      if (!reserveQuota || !types.has(machineType)) return [];
      const window = other.record.spec.paused ? null : activeWindow(reserveQuota.windows, now);
      return [{ holder, machineType, ...reserveQuota, active: window ? { replicas: window.replicas, until: new Date(window.endsAt).toISOString() } : null }];
    });
    const time = (samples: number[] | undefined, fallback: number): CapacityTime => (
      { seconds: median(samples) ?? fallback, source: samples?.length ? 'measured' : 'default', samples: samples?.length ?? 0 });
    const capacity = [...types].map((machineType): CapacityEntry => {
      const image = imageOn(spec, machineType);
      const seen = measured?.[measuredKey(machineType, image)];
      const ceiling = sessionCeiling(spec, machineType);
      const boot = time(seen?.boot, DEFAULT_BOOT_SECONDS);
      const resume = time(seen?.resume, DEFAULT_RESUME_SECONDS);
      const missing = [
        ...(ceiling.source === 'default' ? ['ceiling'] : []), ...(boot.samples < CONFIDENT_SAMPLES ? ['boot'] : []),
        ...(spec.idleAction === 'stop' && resume.samples < CONFIDENT_SAMPLES ? ['resume'] : []),
      ];
      return { machineType, image, ceiling, boot, resume, confident: missing.length === 0, missing };
    });
    const month = monthOf(now);
    const spentEur = spend?.month === month ? round3(spend.eur) : 0;
    return {
      deployment: name,
      mode: spec.scaling?.mode ?? null,
      target: spec.scaling?.target ?? null,
      budget: spec.scaling?.budget ? { ...spec.scaling.budget, month, spentEur, exhausted: this.monthSpent(rt) } : null,
      hold: hold && now < hold.until ? { replicas: hold.replicas, until: new Date(hold.until).toISOString() } : null,
      capacity,
      reservations,
    };
  }
}
