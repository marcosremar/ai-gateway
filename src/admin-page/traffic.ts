import type { StoredTelemetryEvent } from '../telemetry/contract';
import { percentile } from '../telemetry/query';
import { SLO_TARGETS } from '../alerting/slo-targets';
import type { Level } from './ui';
import { parisDay, parisMidnightAfter } from '../deployments/spend-ledger';

export interface TrafficLine { key: string; served: number; failed: number; fallbacks: number; p50Ms: number | null; p95Ms: number | null }

export interface GatewayActivity { at: string; event: string; level: string; deployment: string | null; replicaId: string | null }

export interface TrafficView {
  hours: Array<{ start: string; served: number; failed: number }>;
  total: TrafficLine;
  stages: TrafficLine[];
  providers: TrafficLine[];
  links: TrafficLine[];
}

export const SLOT_MIN = 5;
export interface DayUse { day: string; slots: number[] }

export interface AdminTraffic extends TrafficView {
  activity: GatewayActivity[];
  apps?: TrafficLine[];
  byApp?: Record<string, TrafficView>;
  daily?: Record<string, DayUse[]>;
  costs?: Record<string, Record<string, number>>;
  estimatedCosts?: Record<string, Record<string, number>>;
}

const HOUR_MS = 3_600_000;
const ACTIVITY_KEPT = 40;
export const ACTIVITY_EVENTS = new Set([
  'replica.creating', 'replica.ready', 'replica.create_failed', 'replica.unhealthy', 'replica.parked', 'replica.power_on',
  'replica.released', 'replica.gone', 'autoscale.warm', 'provider.credit_exhausted', 'provider.credit_back',
  'stage.on_fallback', 'stage.on_primary', 'app.degraded', 'replica.stuck_retry', 'replica.stuck_retried', 'replica.stuck_exhausted',
  'route.reorder', 'route.reorder_reverted',
]);

interface Tally { served: number; failed: number; fallbacks: number; durs: number[] }

const tally = (): Tally => ({ served: 0, failed: 0, fallbacks: 0, durs: [] });

function line(key: string, t: Tally): TrafficLine {
  const sorted = t.durs.sort((a, b) => a - b);
  return { key, served: t.served, failed: t.failed, fallbacks: t.fallbacks, p50Ms: percentile(sorted, 50), p95Ms: percentile(sorted, 95) };
}

const lines = (map: Map<string, Tally>) => [...map].map(([key, t]) => line(key, t)).sort((a, b) => b.served + b.failed - a.served - a.failed);
const of = (map: Map<string, Tally>, key: string) => map.get(key) ?? map.set(key, tally()).get(key)!;

function bucket(firstHour: number) {
  const hours = Array.from({ length: 24 }, (_, i) => ({ start: new Date(firstHour + i * HOUR_MS).toISOString(), served: 0, failed: 0 }));
  const total = tally();
  const stages = new Map<string, Tally>();
  const providers = new Map<string, Tally>();
  const links = new Map<string, Tally>();
  return {
    total,
    add(row: StoredTelemetryEvent): void {
      const hour = hours[Math.floor((row.rxTs - firstHour) / HOUR_MS)];
      const stage = String(row.attrs?.stage ?? '(sem etapa)');
      const provider = String(row.attrs?.provider ?? '(sem provedor)');
      const model = row.attrs?.model;
      const link = `${stage}|${provider.startsWith('deployment:') || typeof model !== 'string' || !model ? provider : `${provider}:${model}`}`;
      if (row.event === 'route.served') {
        for (const t of [total, of(stages, stage), of(providers, provider), of(links, link)]) {
          t.served++;
          if (row.durMs !== undefined) t.durs.push(row.durMs);
        }
        if (hour) hour.served++;
      } else if (row.event === 'route.unavailable') {
        total.failed++;
        of(stages, stage).failed++;
        if (hour) hour.failed++;
      } else {
        total.fallbacks++;
        of(stages, stage).fallbacks++;
        of(providers, provider).fallbacks++;
        of(links, link).fallbacks++;
      }
    },
    view: (): TrafficView => ({ hours, total: line('total', total), stages: lines(stages), providers: lines(providers), links: lines(links) }),
  };
}

const ROUTE_EVENTS = new Set(['route.served', 'route.unavailable', 'route.fallback']);

export function adminTraffic(rows: readonly StoredTelemetryEvent[], now: number): AdminTraffic {
  const firstHour = Math.floor(now / HOUR_MS) * HOUR_MS - 23 * HOUR_MS;
  const all = bucket(firstHour);
  const perApp = new Map<string, ReturnType<typeof bucket>>();
  const activity: GatewayActivity[] = [];
  for (let i = rows.length - 1; i >= 0 && rows[i]!.rxTs >= firstHour; i--) {
    const row = rows[i]!;
    if (ROUTE_EVENTS.has(row.event)) {
      all.add(row);
      if (row.app) (perApp.get(row.app) ?? perApp.set(row.app, bucket(firstHour)).get(row.app)!).add(row);
    } else if (row.source === 'gateway' && ACTIVITY_EVENTS.has(row.event) && activity.length < ACTIVITY_KEPT) {
      activity.push({ at: new Date(row.rxTs).toISOString(), event: row.event, level: row.level, deployment: row.deployment ?? null, replicaId: row.replicaId ?? null });
    }
  }
  return {
    ...all.view(), activity,
    apps: lines(new Map([...perApp].map(([app, b]) => [app, b.total]))),
    byApp: Object.fromEntries([...perApp].map(([app, b]) => [app, b.view()])),
    daily: dailyUse(rows),
    costs: linkCosts(rows, now),
    estimatedCosts: linkCosts(rows, now, true),
  };
}

export const COST_DAYS = 7;

export function linkCosts(rows: readonly StoredTelemetryEvent[], now: number, estimatedOnly = false): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (let i = rows.length - 1; i >= 0 && rows[i]!.rxTs >= now - COST_DAYS * 24 * HOUR_MS; i--) {
    const { event, app, attrs } = rows[i]!;
    const usd = Number(attrs?.costUsd);
    if (event !== 'usage.cost' || !app || !(usd > 0) || (estimatedOnly && attrs?.estimated !== true)) continue;
    const own = (out[app] ??= {});
    const key = `${attrs?.stage}|${attrs?.provider}:${attrs?.model}`;
    own[key] = (own[key] ?? 0) + usd;
  }
  return out;
}

export function dailyUse(rows: readonly StoredTelemetryEvent[]): Record<string, DayUse[]> {
  const out: Record<string, DayUse[]> = {};
  let dayStart = -Infinity;
  let dayEnd = -Infinity;
  let day = '';
  for (const row of rows) {
    if (row.event !== 'route.served' || !row.app) continue;
    if (row.rxTs >= dayEnd || row.rxTs < dayStart) {
      dayEnd = parisMidnightAfter(row.rxTs);
      day = parisDay(row.rxTs);
      dayStart = parisMidnightAfter(dayEnd - 30 * HOUR_MS);
      if (parisDay(dayStart) !== day) dayStart = dayEnd - 24 * HOUR_MS;
    }
    const slot = Math.min(1440 / SLOT_MIN - 1, Math.floor((row.rxTs - dayStart) / 60_000 / SLOT_MIN));
    const days = out[row.app] ??= [];
    let use = days.at(-1);
    if (use?.day !== day) days.push(use = { day, slots: new Array<number>(1440 / SLOT_MIN).fill(0) });
    use!.slots[slot]!++;
  }
  return out;
}

export const answeredShare = (l: Pick<TrafficLine, 'served' | 'failed'>) => (l.served + l.failed ? l.served / (l.served + l.failed) : null);

export const SLO_MIN_CALLS = 20;

export function sloLevel(l: Pick<TrafficLine, 'served' | 'failed'>): Level {
  const share = answeredShare(l);
  if (share === null || share >= SLO_TARGETS.uptimeRatio) return 'ok';
  return l.served + l.failed >= SLO_MIN_CALLS ? 'bad' : 'warn';
}

export function gpuShare(v: TrafficView): number | null {
  const gpu = v.providers.filter(l => l.key.startsWith('deployment:')).reduce((a, l) => a + l.served, 0);
  return v.total.served ? gpu / v.total.served : null;
}
