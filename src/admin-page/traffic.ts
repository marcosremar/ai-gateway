import type { StoredTelemetryEvent } from '../telemetry/contract';
import { percentile } from '../telemetry/query';

export interface TrafficLine { key: string; served: number; failed: number; fallbacks: number; p50Ms: number | null; p95Ms: number | null }

export interface GatewayActivity { at: string; event: string; level: string; deployment: string | null; replicaId: string | null }

export interface AdminTraffic {
  hours: Array<{ start: string; served: number; failed: number }>;
  total: TrafficLine;
  stages: TrafficLine[];
  providers: TrafficLine[];
  activity: GatewayActivity[];
}

const HOUR_MS = 3_600_000;
const ACTIVITY_KEPT = 40;
export const ACTIVITY_EVENTS = new Set([
  'replica.creating', 'replica.ready', 'replica.create_failed', 'replica.unhealthy', 'replica.parked', 'replica.power_on',
  'replica.released', 'replica.gone', 'autoscale.warm', 'provider.credit_exhausted', 'provider.credit_back',
  'stage.on_fallback', 'stage.on_primary', 'app.degraded',
]);

interface Tally { served: number; failed: number; fallbacks: number; durs: number[] }

const tally = (): Tally => ({ served: 0, failed: 0, fallbacks: 0, durs: [] });

function line(key: string, t: Tally): TrafficLine {
  const sorted = t.durs.sort((a, b) => a - b);
  return { key, served: t.served, failed: t.failed, fallbacks: t.fallbacks, p50Ms: percentile(sorted, 50), p95Ms: percentile(sorted, 95) };
}

export function adminTraffic(rows: readonly StoredTelemetryEvent[], now: number): AdminTraffic {
  const firstHour = Math.floor(now / HOUR_MS) * HOUR_MS - 23 * HOUR_MS;
  const hours = Array.from({ length: 24 }, (_, i) => ({ start: new Date(firstHour + i * HOUR_MS).toISOString(), served: 0, failed: 0 }));
  const total = tally();
  const stages = new Map<string, Tally>();
  const providers = new Map<string, Tally>();
  const of = (map: Map<string, Tally>, key: string) => map.get(key) ?? map.set(key, tally()).get(key)!;
  const activity: GatewayActivity[] = [];
  for (let i = rows.length - 1; i >= 0 && rows[i]!.rxTs >= firstHour; i--) {
    const row = rows[i]!;
    const hour = hours[Math.floor((row.rxTs - firstHour) / HOUR_MS)];
    const stage = String(row.attrs?.stage ?? '(sem etapa)');
    if (row.event === 'route.served') {
      const provider = String(row.attrs?.provider ?? '(sem provedor)');
      for (const t of [total, of(stages, stage), of(providers, provider)]) {
        t.served++;
        if (row.durMs !== undefined) t.durs.push(row.durMs);
      }
      if (hour) hour.served++;
    } else if (row.event === 'route.unavailable') {
      total.failed++;
      of(stages, stage).failed++;
      if (hour) hour.failed++;
    } else if (row.event === 'route.fallback') {
      total.fallbacks++;
      of(stages, stage).fallbacks++;
      of(providers, String(row.attrs?.provider ?? '(sem provedor)')).fallbacks++;
    } else if (row.source === 'gateway' && ACTIVITY_EVENTS.has(row.event) && activity.length < ACTIVITY_KEPT) {
      activity.push({ at: new Date(row.rxTs).toISOString(), event: row.event, level: row.level, deployment: row.deployment ?? null, replicaId: row.replicaId ?? null });
    }
  }
  const lines = (map: Map<string, Tally>) => [...map].map(([key, t]) => line(key, t)).sort((a, b) => b.served + b.failed - a.served - a.failed);
  return { hours, total: line('total', total), stages: lines(stages), providers: lines(providers), activity };
}
