import { readStateFile, writeStateFile } from './state-file';
import type { DeploymentView } from './types';

export const SPEND_LEDGER_TICK_MS = 60_000;
export const SPEND_DAYS_KEPT = 90;
export const DISMISS_MS = 7 * 86_400_000;
export const NO_APP = '(sem app)';

export interface StageCloud { usd?: number; estimatedUsd?: number; unknown?: number }
export interface SpendDay { gpuEur: number; requests: number; tokens: number; cloudUsd?: number; stages?: Record<string, StageCloud> }

export interface SpendLedgerView {
  since: string | null;
  days: Array<{ day: string; apps: Record<string, SpendDay> }>;
}

interface LedgerState {
  since: string | null;
  lastTickAt: number | null;
  days: Record<string, Record<string, SpendDay>>;
  dismissed: Record<string, number>;
}

const PARIS_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
export const parisDay = (ms: number) => PARIS_DAY.format(ms);

export function parisMidnightAfter(ms: number): number {
  const day = parisDay(ms);
  const next = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
  for (const offsetH of [2, 1, 0]) {
    const at = next - offsetH * 3_600_000;
    if (at > ms && parisDay(at) !== day && parisDay(at - 1) === day) return at;
  }
  return next;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const live = (d: DeploymentView) => d.replicas.filter(r => r.phase !== 'halted');

export class SpendLedger {
  private state: LedgerState = { since: null, lastTickAt: null, days: {}, dismissed: {} };
  private timer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly opts: {
    path?: string; now?: () => number; ownerOf: (deployment: DeploymentView) => string | null;
    deployments: () => DeploymentView[]; log?: (msg: string, data?: Record<string, unknown>) => void;
  }) {
    this.now = opts.now ?? Date.now;
  }

  async load(): Promise<void> {
    if (!this.opts.path) return;
    const read = await readStateFile<LedgerState>(this.opts.path);
    if (read.data) this.state = { since: read.data.since ?? null, lastTickAt: read.data.lastTickAt ?? null, days: read.data.days ?? {}, dismissed: read.data.dismissed ?? {} };
  }

  private entry(day: string, app: string): SpendDay {
    const apps = this.state.days[day] ??= {};
    return apps[app] ??= { gpuEur: 0, requests: 0, tokens: 0 };
  }

  request(app: string, tokens = 0): void {
    const e = this.entry(parisDay(this.now()), app);
    e.requests++;
    e.tokens += Math.max(0, Math.round(tokens));
  }

  cloud(app: string, usd: number | null, stage = 'chat', estimated = false): void {
    if (usd !== null && (!Number.isFinite(usd) || usd <= 0)) return;
    const e = this.entry(parisDay(this.now()), app);
    const s = ((e.stages ??= {})[stage] ??= {});
    if (usd === null) {
      s.unknown = (s.unknown ?? 0) + 1;
      return;
    }
    const field = estimated ? 'estimatedUsd' : 'usd';
    s[field] = round((s[field] ?? 0) + usd);
    e.cloudUsd = round((e.cloudUsd ?? 0) + usd);
  }

  private addGpu(app: string, eurPerHour: number, from: number, to: number): void {
    for (let start = from; start < to;) {
      const end = Math.min(to, parisMidnightAfter(start));
      const e = this.entry(parisDay(start), app);
      e.gpuEur = round(e.gpuEur + (eurPerHour * (end - start)) / 3_600_000);
      start = end;
    }
  }

  accrue(): void {
    const now = this.now();
    const firstTick = this.state.lastTickAt === null;
    const todayStart = parisMidnightAfter(now) - 86_400_000;
    const last = this.state.lastTickAt ?? todayStart;
    this.state.since ??= parisDay(now);
    for (const d of this.opts.deployments()) {
      const app = this.opts.ownerOf(d) ?? NO_APP;
      for (const r of live(d)) {
        if (!r.pricePerHour) continue;
        const startedAt = now - r.ageSeconds * 1000;
        const from = Math.max(last, startedAt, firstTick ? todayStart : -Infinity);
        if (from < now) this.addGpu(app, r.pricePerHour, from, now);
      }
    }
    this.state.lastTickAt = now;
    this.trim(now);
  }

  private trim(now: number): void {
    const oldest = parisDay(now - (SPEND_DAYS_KEPT - 1) * 86_400_000);
    for (const day of Object.keys(this.state.days)) if (day < oldest) delete this.state.days[day];
    for (const [id, until] of Object.entries(this.state.dismissed)) if (until <= now) delete this.state.dismissed[id];
  }

  dismiss(id: string): Promise<void> {
    this.state.dismissed[id] = this.now() + DISMISS_MS;
    return this.flush();
  }

  dismissed(): Record<string, number> {
    const now = this.now();
    return Object.fromEntries(Object.entries(this.state.dismissed).filter(([, until]) => until > now));
  }

  view(): SpendLedgerView {
    const days = Object.keys(this.state.days).sort().map(day => ({
      day, apps: Object.fromEntries(Object.entries(this.state.days[day]!).map(([app, e]) => [app, {
        ...e, gpuEur: Math.round(e.gpuEur * 10_000) / 10_000, ...(e.cloudUsd ? { cloudUsd: Math.round(e.cloudUsd * 10_000) / 10_000 } : {}),
      }])),
    }));
    return { since: this.state.since, days };
  }

  flush(): Promise<void> {
    const path = this.opts.path;
    if (!path) return Promise.resolve();
    this.chain = this.chain.then(() => writeStateFile(path, JSON.stringify(this.state)))
      .catch(err => this.opts.log?.('spend-ledger: write failed', { error: String(err) }));
    return this.chain;
  }

  tick(): Promise<void> {
    this.accrue();
    return this.flush();
  }

  start(intervalMs = SPEND_LEDGER_TICK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.tick();
  }
}
