import type { GpuPolicy } from '../config/access-keys';
import { scheduleFloor } from './autoscale';
import { DeploymentError } from './controller';
import { readStateFile, writeStateFile } from './state-file';
import type { DeploymentView } from './types';

export const MAX_START_MINUTES = 240;
export const CLIENT_GPU_TICK_MS = 30_000;

export interface GpuStarter {
  get(name: string): DeploymentView | null;
  list(): DeploymentView[];
  warm(name: string, replicas: number, untilMinutes: number): Promise<DeploymentView>;
  park(name: string): Promise<DeploymentView>;
}

export interface GpuStarterKey { keyId: string; user: string }

interface Start {
  keyId: string;
  user: string;
  deployment: string;
  until: number;
  idleMs: number;
  capEur: number | null;
  sharedWarm: boolean;
  chargedAt: number;
}

interface State { day: string; spent: Record<string, { user: string; eur: number }>; starts: Start[] }

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const cents = (n: number) => Math.round(n * 100) / 100;

export class ClientGpu {
  private state: State;
  private timer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(
    private readonly controller: GpuStarter,
    private readonly opts: { path?: string; now?: () => number; log?: (msg: string, data?: Record<string, unknown>) => void } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.state = { day: dayOf(this.now()), spent: {}, starts: [] };
  }

  async load(): Promise<void> {
    if (!this.opts.path) return;
    const read = await readStateFile<State>(this.opts.path);
    if (read.data) this.state = { day: read.data.day, spent: read.data.spent ?? {}, starts: read.data.starts ?? [] };
  }

  spentToday(keyId: string): number {
    this.rollDay();
    return this.state.spent[keyId]?.eur ?? 0;
  }

  testCopyOf(name: string): DeploymentView | null {
    const app = this.controller.get(name)?.app;
    return this.controller.list().find(d => d.spec.testFor === name && d.app === app) ?? null;
  }

  async start(key: GpuStarterKey, policy: GpuPolicy, requested: string, minutes: unknown, extend = false) {
    const name = policy.gpuDailyEur !== null ? this.testCopyOf(requested)?.name ?? requested : requested;
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_START_MINUTES) {
      throw new DeploymentError(400, `minutes must be an integer 1–${MAX_START_MINUTES}`);
    }
    const view = this.controller.get(name);
    if (!view) throw new DeploymentError(404, `deployment '${name}' not found`);
    const now = this.now();
    const open = this.state.starts.find(s => s.keyId === key.keyId && s.deployment === name);
    if (extend && !open) throw new DeploymentError(404, `this key has no GPU running on '${name}' to extend — POST /v1/deployments/${name}/start first`);
    const until = (open && extend ? Math.max(open.until, now) : now) + minutes * 60_000;
    if (until - now > MAX_START_MINUTES * 60_000) throw new DeploymentError(400, `a GPU is started at most ${MAX_START_MINUTES} min ahead`);
    const asked = view.spec.maxEurPerHour * minutes / 60;
    const spent = this.spentToday(key.keyId);
    if (policy.gpuDailyEur !== null && spent + asked > policy.gpuDailyEur) {
      throw new DeploymentError(402, `daily GPU cap of this key reached: €${cents(spent)} spent today (UTC), €${cents(asked)} more asked, cap €${policy.gpuDailyEur}. `
        + 'Ask for fewer minutes, wait until tomorrow, or ask an admin to raise gpuDailyEur (PUT /v1/admin/access/keys/policy)');
    }
    const other = view.warm && Date.parse(view.warm.until) > now && !open ? view.warm : null;
    const warmUntil = Math.max(until, other ? Date.parse(other.until) : 0);
    await this.controller.warm(name, Math.max(1, other?.replicas ?? 0), (warmUntil - now) / 60_000);
    const entry: Start = open ?? {
      keyId: key.keyId, user: key.user, deployment: name, until, idleMs: 0, capEur: null, sharedWarm: Boolean(other), chargedAt: now,
    };
    Object.assign(entry, { until, idleMs: policy.startIdleMinutes * 60_000, capEur: policy.gpuDailyEur });
    if (!open) this.state.starts.push(entry);
    this.opts.log?.(`client-gpu: ${extend ? 'extended' : 'started'}`, { deployment: name, key: key.keyId, minutes });
    await this.save();
    return {
      deployment: name, until: new Date(until).toISOString(), idleMinutes: policy.startIdleMinutes,
      spentTodayEur: cents(spent), capEur: policy.gpuDailyEur,
    };
  }

  async forget(keyId: string, name: string): Promise<void> {
    this.state.starts = this.state.starts.filter(s => !(s.keyId === keyId && s.deployment === name));
    await this.save();
  }

  async tick(): Promise<void> {
    this.rollDay();
    const now = this.now();
    for (const s of [...this.state.starts]) {
      const view = this.controller.get(s.deployment);
      const running = view?.replicas.filter(r => r.phase !== 'halted') ?? [];
      const rate = running.reduce((sum, r) => sum + (r.pricePerHour ?? view!.spec.maxEurPerHour), 0);
      const spent = this.state.spent[s.keyId] ?? { user: s.user, eur: 0 };
      spent.eur += rate * (now - s.chargedAt) / 3_600_000;
      this.state.spent[s.keyId] = spent;
      s.chargedAt = now;
      const capHit = s.capEur !== null && spent.eur >= s.capEur;
      if (!view || (!running.length && view.status === 'scaled-to-zero' && now >= s.until)) { this.drop(s); continue; }
      if (!capHit && now < s.until) continue;
      const lastUse = view.lastRequestAt ? Date.parse(view.lastRequestAt) : 0;
      if (!capHit && now - lastUse < s.idleMs) continue;
      this.drop(s);
      const keptBy = this.keeper(view, s, now);
      if (keptBy) {
        this.opts.log?.('client-gpu: window over, GPU kept', { deployment: s.deployment, key: s.keyId, keptBy });
        continue;
      }
      await this.controller.park(s.deployment).catch(() => {});
      this.opts.log?.(`client-gpu: ${capHit ? 'daily cap reached' : 'window over and idle'}, GPU parked`, { deployment: s.deployment, key: s.keyId });
    }
    await this.save();
  }

  private keeper(view: DeploymentView, s: Start, now: number): string | null {
    if (scheduleFloor(view.spec.warmSchedule, now) > 0) return 'warm schedule';
    if (s.sharedWarm) return 'another warm window';
    if ((view.realtime?.active ?? 0) > 0 || view.sessions > 0) return 'active session';
    if (this.state.starts.some(o => o.deployment === s.deployment && o.until > now)) return 'another key\'s start';
    return null;
  }

  private drop(s: Start): void {
    this.state.starts = this.state.starts.filter(o => o !== s);
  }

  report(user?: string) {
    this.rollDay();
    const mine = <T extends { user: string }>(x: T) => user === undefined || x.user === user;
    return {
      day: this.state.day,
      spentEur: Object.fromEntries(Object.entries(this.state.spent).filter(([, v]) => mine(v)).map(([k, v]) => [k, cents(v.eur)])),
      running: this.state.starts.filter(mine).map(s => ({ key: s.keyId, deployment: s.deployment, until: new Date(s.until).toISOString(), capEur: s.capEur })),
    };
  }

  private rollDay(): void {
    const day = dayOf(this.now());
    if (day !== this.state.day) this.state = { day, spent: {}, starts: this.state.starts };
  }

  run(intervalMs = CLIENT_GPU_TICK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(err => this.opts.log?.('client-gpu: tick failed', { error: String(err) })); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private save(): Promise<void> {
    const path = this.opts.path;
    if (!path) return Promise.resolve();
    const snapshot = JSON.stringify(this.state, null, 2);
    this.chain = this.chain.catch(() => {}).then(() => writeStateFile(path, snapshot));
    return this.chain;
  }
}
