/**
 * Read side of telemetry (admin only, wired in http.ts): filtered event pages, the merged timeline of one session or
 * trace across every source, and fleet-wide summaries. Pure functions over the store's rows (oldest first).
 */

import type { StoredTelemetryEvent, TelemetryLevel, TelemetrySource } from './contract';
import { TELEMETRY_LEVELS } from './contract';

export interface EventFilter {
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  replicaId?: string;
  deployment?: string;
  app?: string;
  source?: TelemetrySource;
  /** Minimum level (`warn` = warn + error). */
  level?: TelemetryLevel;
  /** Exact name, or a prefix ending in `*` (`rt.ladder.*`). */
  event?: string;
  /** Receive-time window (ms). */
  since?: number;
  until?: number;
}

const levelRank = (l: TelemetryLevel) => TELEMETRY_LEVELS.indexOf(l);

export function matches(row: StoredTelemetryEvent, f: EventFilter): boolean {
  if (f.traceId && row.traceId !== f.traceId) return false;
  if (f.sessionId && row.sessionId !== f.sessionId) return false;
  if (f.turnId && row.turnId !== f.turnId) return false;
  if (f.replicaId && row.replicaId !== f.replicaId) return false;
  if (f.deployment && row.deployment !== f.deployment) return false;
  if (f.app && row.app !== f.app) return false;
  if (f.source && row.source !== f.source) return false;
  if (f.level && levelRank(row.level) < levelRank(f.level)) return false;
  if (f.event) {
    if (f.event.endsWith('*') ? !row.event.startsWith(f.event.slice(0, -1)) : row.event !== f.event) return false;
  }
  if (f.since !== undefined && row.rxTs < f.since) return false;
  if (f.until !== undefined && row.rxTs > f.until) return false;
  return true;
}

export interface EventPage {
  events: StoredTelemetryEvent[];
  /** Pass back as `cursor` for the next page; null = no more. */
  nextCursor: number | null;
}

/** One page, newest first by default (`order: 'asc'` = oldest first). `cursor` = the last `seq` of the previous page. */
export function queryEvents(
  rows: readonly StoredTelemetryEvent[], filter: EventFilter, opts: { limit?: number; cursor?: number; order?: 'asc' | 'desc' } = {},
): EventPage {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const asc = opts.order === 'asc';
  const out: StoredTelemetryEvent[] = [];
  let more = false;
  if (asc) {
    for (const row of rows) {
      if (opts.cursor !== undefined && row.seq <= opts.cursor) continue;
      if (!matches(row, filter)) continue;
      if (out.length === limit) { more = true; break; }
      out.push(row);
    }
  } else {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      if (opts.cursor !== undefined && row.seq >= opts.cursor) continue;
      if (!matches(row, filter)) continue;
      if (out.length === limit) { more = true; break; }
      out.push(row);
    }
  }
  return { events: out, nextCursor: more && out.length ? out[out.length - 1]!.seq : null };
}

export interface SourceClock {
  count: number;
  /** `rxTs - ts` (ms): transit + client batching + clock skew. ~0 for the gateway; < 0 = that clock runs ahead. */
  lagMsMedian: number;
  lagMsMin: number;
  lagMsMax: number;
}

export interface Timeline {
  traceIds: string[];
  sessionIds: string[];
  events: StoredTelemetryEvent[];
  truncated: boolean;
  clocks: Partial<Record<TelemetrySource, SourceClock>>;
  note: string;
}

export const TIMELINE_NOTE = 'events are ordered by their source timestamp `ts`; `rxTs` is the gateway receive time. '
  + 'Per source, clocks.lagMs = rxTs - ts (transit + client batching + clock skew): when a source\'s median lag is '
  + 'far from its transit time, read its events against `rxTs` instead.';

/**
 * Everything about one session or one trace, from every source, ordered by `ts` (ties: arrival order). One hop of
 * expansion: a session pulls in every event of the traces it used (gateway routing events carry the trace id, not
 * the session), and a trace pulls in every event of the sessions seen in it.
 */
export function timeline(
  rows: readonly StoredTelemetryEvent[], key: { traceId?: string; sessionId?: string }, maxEvents = 5000,
): Timeline {
  const traceIds = new Set<string>(key.traceId ? [key.traceId] : []);
  const sessionIds = new Set<string>(key.sessionId ? [key.sessionId] : []);
  for (const row of rows) {
    if (key.sessionId && row.sessionId === key.sessionId) traceIds.add(row.traceId);
    if (key.traceId && row.traceId === key.traceId && row.sessionId) sessionIds.add(row.sessionId);
  }
  const picked: StoredTelemetryEvent[] = [];
  let truncated = false;
  for (const row of rows) {
    if (!traceIds.has(row.traceId) && !(row.sessionId && sessionIds.has(row.sessionId))) continue;
    if (picked.length === maxEvents) { truncated = true; break; }
    picked.push(row);
  }
  picked.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  const lags = new Map<TelemetrySource, number[]>();
  for (const row of picked) {
    const list = lags.get(row.source) ?? [];
    list.push(row.rxTs - row.ts);
    lags.set(row.source, list);
  }
  const clocks: Timeline['clocks'] = {};
  for (const [source, list] of lags) {
    const sorted = [...list].sort((a, b) => a - b);
    clocks[source] = { count: sorted.length, lagMsMedian: percentile(sorted, 50)!, lagMsMin: sorted[0]!, lagMsMax: sorted[sorted.length - 1]! };
  }
  return { traceIds: [...traceIds], sessionIds: [...sessionIds], events: picked, truncated, clocks, note: TIMELINE_NOTE };
}

/** Nearest-rank percentile of an ascending list; null when empty. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export const TURN_LATENCY_EVENTS: readonly string[] = ['edge.stt.done', 'edge.llm.first_token', 'edge.tts.first_audio', 'turn.first_audio', 's2s.first_audio'];

export interface LatencyStat { count: number; p50Ms: number | null; p95Ms: number | null }

export interface LatencyReport {
  windowSeconds: number;
  stages: Record<string, LatencyStat & { providers: Record<string, LatencyStat> }>;
  events: Record<string, LatencyStat>;
}

function latencyStat(durs: number[]): LatencyStat {
  const sorted = [...durs].sort((a, b) => a - b);
  return { count: sorted.length, p50Ms: percentile(sorted, 50), p95Ms: percentile(sorted, 95) };
}

export function latencyReport(rows: readonly StoredTelemetryEvent[], now: number, windowMs = 15 * 60_000): LatencyReport {
  const stages = new Map<string, Map<string, number[]>>();
  const events = new Map<string, number[]>();
  const push = <K>(map: Map<K, number[]>, key: K, ms: number) => { map.set(key, [...(map.get(key) ?? []), ms]); };
  for (let i = rows.length - 1; i >= 0 && rows[i]!.rxTs >= now - windowMs; i--) {
    const row = rows[i]!;
    if (row.durMs === undefined) continue;
    if (row.event === 'route.served') {
      const stage = String(row.attrs?.stage ?? '(none)');
      if (!stages.has(stage)) stages.set(stage, new Map());
      push(stages.get(stage)!, String(row.attrs?.provider ?? '(none)'), row.durMs);
    } else if (TURN_LATENCY_EVENTS.includes(row.event)) push(events, row.event, row.durMs);
  }
  return {
    windowSeconds: windowMs / 1000,
    stages: Object.fromEntries([...stages].map(([stage, providers]) => [stage, {
      ...latencyStat([...providers.values()].flat()),
      providers: Object.fromEntries([...providers].map(([provider, durs]) => [provider, latencyStat(durs)])),
    }])),
    events: Object.fromEntries([...events].map(([event, durs]) => [event, latencyStat(durs)])),
  };
}

export const SUMMARY_GROUPS = ['event', 'source', 'deployment', 'replicaId', 'app'] as const;
export type SummaryGroup = typeof SUMMARY_GROUPS[number];

export interface SummaryRow {
  key: string;
  count: number;
  levels: Record<TelemetryLevel, number>;
  durMs: { count: number; p50: number | null; p95: number | null };
}

/** Counts by level and p50/p95 of `durMs`, per group, largest groups first. Rows without the group field → `(none)`. */
export function summarize(
  rows: readonly StoredTelemetryEvent[], groupBy: SummaryGroup, filter: EventFilter = {}, maxGroups = 500,
): { groupBy: SummaryGroup; total: number; groups: SummaryRow[]; truncated: boolean } {
  const groups = new Map<string, { count: number; levels: Record<TelemetryLevel, number>; durs: number[] }>();
  let total = 0;
  for (const row of rows) {
    if (!matches(row, filter)) continue;
    total++;
    const key = String(row[groupBy] ?? '(none)');
    let g = groups.get(key);
    if (!g) {
      g = { count: 0, levels: { debug: 0, info: 0, warn: 0, error: 0 }, durs: [] };
      groups.set(key, g);
    }
    g.count++;
    g.levels[row.level]++;
    if (row.durMs !== undefined) g.durs.push(row.durMs);
  }
  const all = [...groups.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  return {
    groupBy,
    total,
    truncated: all.length > maxGroups,
    groups: all.slice(0, maxGroups).map(([key, g]) => {
      const sorted = g.durs.sort((a, b) => a - b);
      return { key, count: g.count, levels: g.levels, durMs: { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95) } };
    }),
  };
}
