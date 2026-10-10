// ── AI Gateway — Desktop-app field telemetry (docs/app-telemetry.md) ───────────────────────────────────────────────
// Opt-in usage/performance events from the ucast.me desktop app, so field problems (slow stages, crashes, error codes,
// versions in use) are visible. Separate from the unified telemetry in src/telemetry (whose `POST /v1/telemetry/events`
// takes trace-correlated browser/edge events with a different shape and limits).
//
//   POST /v1/telemetry/app/events    gateway key (proxy customRoute: the proxy's key auth runs first)
//   GET  /v1/telemetry/app/summary   ?days=7                                  (admin key)
//   GET  /v1/telemetry/app/events    ?installId=&kind=&since=&until=&limit=   (admin key)
//
// Env: APP_TELEMETRY=0 turns it off; APP_TELEMETRY_RETENTION_DAYS, else TELEMETRY_RETENTION_DAYS, else 365;
// APP_TELEMETRY_DIR (default `<DEPLOYMENTS_STATE_DIR | RAILWAY_VOLUME_MOUNT_PATH | ~/.ai-gateway>/app-telemetry`);
// APP_TELEMETRY_MAX_DAY_MB (512); APP_TELEMETRY_BATCHES_PER_MIN per install (30).

import type { IncomingMessage, ServerResponse } from 'http';
import { homedir } from 'os';
import { join } from 'path';
import { AppTelemetryStore, AppTelemetryStoreFull } from './store';
import { summarize } from './summary';
import {
  APP_TELEMETRY_KINDS, APP_TELEMETRY_LIMITS, AppTelemetryError, parseBatch, type StoredAppEvent,
} from './validate';

export { AppTelemetryStore, dayOf } from './store';
export { summarize, percentile, type AppTelemetrySummary } from './summary';
export {
  APP_TELEMETRY_KINDS, APP_TELEMETRY_LIMITS, APP_TELEMETRY_TEXT_KEY, AppTelemetryError, parseBatch, sanitizeFields,
  type AppTelemetryBatch, type AppTelemetryEvent, type AppTelemetryKind, type StoredAppEvent,
} from './validate';

export const APP_TELEMETRY_PATHS = {
  events: '/v1/telemetry/app/events',
  summary: '/v1/telemetry/app/summary',
} as const;

const DAY_MS = 86_400_000;
const MAX_SUMMARY_DAYS = 366;
const MAX_LIST = 1000;

interface Route { method: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }

export interface CreateAppTelemetryOptions {
  env?: Record<string, string | undefined>;
  /** Overrides the env-derived store (tests). */
  store?: AppTelemetryStore;
  /** Gateway user of a request that passed the proxy's key auth. */
  userOf: (req: IncomingMessage) => string;
  isAdminToken: (token: string) => boolean;
  now?: () => number;
  /** Retention sweep period; 0 = no timer (tests call `sweep()`). */
  sweepIntervalMs?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

/** Body up to `limit` bytes; null = larger (the rest is drained and discarded). */
function readLimited(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      bytes += c.length;
      if (bytes > limit) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};

/** ms epoch, ISO date, or relative `15m` / `2h` / `7d`. */
export function parseSince(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const rel = /^(\d+)(m|h|d)$/.exec(value.trim());
  if (rel) return now - Number(rel[1]) * ({ m: 60_000, h: 3_600_000, d: DAY_MS } as Record<string, number>)[rel[2]!]!;
  if (/^\d{10,}$/.test(value)) return Number(value);
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

export function storeFromEnv(env: Record<string, string | undefined>, log?: CreateAppTelemetryOptions['log']): AppTelemetryStore {
  const stateDir = env.DEPLOYMENTS_STATE_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || join(homedir(), '.ai-gateway');
  return new AppTelemetryStore({
    dir: env.APP_TELEMETRY_DIR?.trim() || join(stateDir, 'app-telemetry'),
    retentionDays: positive(env.APP_TELEMETRY_RETENTION_DAYS, positive(env.TELEMETRY_RETENTION_DAYS, 365)),
    maxDayBytes: positive(env.APP_TELEMETRY_MAX_DAY_MB, 512) * 1024 * 1024,
    ...(log ? { log } : {}),
  });
}

export function createAppTelemetry(opts: CreateAppTelemetryOptions) {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const store = opts.store ?? storeFromEnv(env, opts.log);
  const batchesPerMin = positive(env.APP_TELEMETRY_BATCHES_PER_MIN, 30);
  const windows = new Map<string, { since: number; count: number }>();
  const counters = { batches: 0, events: 0, rejected: 0, tooLarge: 0, throttled: 0 };

  const throttled = (installId: string): boolean => {
    const t = now();
    const w = windows.get(installId);
    if (!w || t - w.since >= 60_000) {
      if (windows.size > 50_000) windows.clear();
      windows.set(installId, { since: t, count: 1 });
      return false;
    }
    w.count++;
    return w.count > batchesPerMin;
  };

  const ingest: Route = {
    method: 'POST', path: APP_TELEMETRY_PATHS.events, handler: async (req, res) => {
      const text = await readLimited(req, APP_TELEMETRY_LIMITS.maxBatchBytes);
      if (text === null) { counters.tooLarge++; return send(res, 413, { error: `Batch larger than ${APP_TELEMETRY_LIMITS.maxBatchBytes} bytes` }); }
      let body: unknown;
      try { body = JSON.parse(text); } catch { counters.rejected++; return send(res, 400, { error: 'Body is not JSON' }); }
      const rxTs = now();
      let batch;
      try { batch = parseBatch(body, rxTs); } catch (err) {
        if (!(err instanceof AppTelemetryError)) throw err;
        counters.rejected++;
        return send(res, err.status, { error: err.message });
      }
      if (throttled(batch.installId)) {
        counters.throttled++;
        return send(res, 429, { error: 'Too many telemetry batches from this install' }, { 'Retry-After': '60' });
      }
      const app = opts.userOf(req);
      const rows: StoredAppEvent[] = batch.events.map(e => ({
        rxTs, installId: batch.installId, appVersion: batch.appVersion, os: batch.os, app, ts: e.ts, kind: e.kind, fields: e.fields,
      }));
      try { await store.append(rows); } catch (err) {
        if (err instanceof AppTelemetryStoreFull) return send(res, 507, { error: 'Telemetry storage is full for today' }, { 'Retry-After': '3600' });
        opts.log?.('app telemetry: append failed', { error: err instanceof Error ? err.message : String(err) });
        return send(res, 503, { error: 'Telemetry storage unavailable' }, { 'Retry-After': '60' });
      }
      counters.batches++;
      counters.events += rows.length;
      send(res, 200, { accepted: rows.length });
    },
  };

  const admin = (handler: (q: URLSearchParams, res: ServerResponse) => Promise<void>) => async (req: IncomingMessage, res: ServerResponse) => {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token || !opts.isAdminToken(token)) return send(res, 403, { error: 'App telemetry queries need an admin API key' });
    await handler(new URL(req.url ?? '/', 'http://gateway').searchParams, res);
  };

  const summary: Route = {
    method: 'GET', path: APP_TELEMETRY_PATHS.summary, handler: admin(async (q, res) => {
      const days = Math.min(MAX_SUMMARY_DAYS, Math.max(1, Math.floor(Number(q.get('days') ?? 7) || 7)));
      const until = now();
      const since = until - days * DAY_MS;
      send(res, 200, { days, ...summarize(await store.read(since, until), since, until) });
    }),
  };

  const list: Route = {
    method: 'GET', path: APP_TELEMETRY_PATHS.events, handler: admin(async (q, res) => {
      const t = now();
      const kind = q.get('kind');
      if (kind && !(APP_TELEMETRY_KINDS as readonly string[]).includes(kind)) return send(res, 400, { error: `kind must be one of ${APP_TELEMETRY_KINDS.join(', ')}` });
      const installId = q.get('installId')?.toLowerCase();
      const since = parseSince(q.get('since'), t) ?? t - DAY_MS;
      const until = parseSince(q.get('until'), t) ?? t;
      const limit = Math.min(MAX_LIST, Math.max(1, Math.floor(Number(q.get('limit') ?? 200) || 200)));
      const rows = (await store.read(since, until))
        .filter(r => (!installId || r.installId === installId) && (!kind || r.kind === kind))
        .sort((a, b) => b.rxTs - a.rxTs || b.ts - a.ts);
      send(res, 200, { since, until, total: rows.length, events: rows.slice(0, limit) });
    }),
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  const sweep = async (): Promise<number> => {
    const removed = await store.sweep(now());
    if (removed) opts.log?.('app telemetry: retention sweep', { removed, retentionDays: store.retentionDays });
    return removed;
  };
  const interval = opts.sweepIntervalMs ?? 6 * 3_600_000;

  return {
    store,
    counters,
    /** Behind the proxy's key auth (customRoutes); the reads check for an admin key themselves. */
    routes: [ingest, summary, list] as Route[],
    sweep,
    start: async (): Promise<void> => {
      await sweep().catch(() => 0);
      if (interval > 0 && !timer) { timer = setInterval(() => { void sweep().catch(() => 0); }, interval); timer.unref?.(); }
    },
    stop: (): void => { if (timer) clearInterval(timer); timer = null; },
  };
}

export type AppTelemetry = ReturnType<typeof createAppTelemetry>;

/** `null` when APP_TELEMETRY=0. */
export function appTelemetryFromEnv(env: Record<string, string | undefined>, opts: Omit<CreateAppTelemetryOptions, 'env'>): AppTelemetry | null {
  if (env.APP_TELEMETRY === '0') return null;
  return createAppTelemetry({ ...opts, env });
}
