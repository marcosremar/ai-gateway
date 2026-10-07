/**
 * Telemetry HTTP surface (docs/api/telemetry.md):
 *
 *   POST /v1/telemetry/events      ingest — self-authenticated (auth.ts): app key, realtime session token, edge HMAC
 *   GET  /v1/telemetry/timeline    ?traceId=… | ?sessionId=…   merged events of every source, ordered by ts (admin)
 *   GET  /v1/telemetry/summary     ?since=1h&groupBy=event|source|deployment|replicaId|app (+ filters)       (admin)
 *   GET  /v1/telemetry/events      filters + `cursor` paging (newest first; `order=asc`)                      (admin)
 *   GET  /v1/telemetry/stats       ingest counters and store size                                             (admin)
 *
 * `telemetryFromEnv` builds the whole service: TELEMETRY=0 turns it off; TELEMETRY_RETENTION_DAYS (14),
 * TELEMETRY_MAX_ROWS (200 000), TELEMETRY_MAX_DISK_MB (256), TELEMETRY_DEBUG_SAMPLE (0), TELEMETRY_RATE_PER_MIN
 * (1200), TELEMETRY_DIR (default `<DEPLOYMENTS_STATE_DIR or ~/.ai-gateway>/telemetry`). When the repo's OTLP exporter
 * is configured (OTEL_EXPORTER_OTLP_ENDPOINT) every stored event is also forwarded to it as a span.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { homedir } from 'os';
import { join } from 'path';
import type { CustomRoute } from '../gateway/proxy/types';
import { initOtlpFromEnv } from '../platform/observability/otlp-exporter';
import { TELEMETRY_INGEST_PATH, TELEMETRY_LIMITS, TELEMETRY_LEVELS, TELEMETRY_REPLICA_HEADER, TELEMETRY_SOURCES } from './contract';
import type { StoredTelemetryEvent, TelemetryLevel, TelemetrySource } from './contract';
import { authenticateTelemetry, isAuthFailure, type TelemetryAuthDeps } from './auth';
import { TelemetryIngest } from './ingest';
import { queryEvents, SUMMARY_GROUPS, summarize, timeline, type EventFilter, type SummaryGroup } from './query';
import { TelemetryStore } from './store';
import { newSpanId } from './trace-context';

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

/** Reads the body up to `limit` bytes; `null` = larger than the limit (the rest is discarded). */
export function readLimited(req: IncomingMessage, limit: number): Promise<{ text: string; bytes: number } | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) { over = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? null : { text: Buffer.concat(chunks).toString('utf8'), bytes }));
    req.on('error', reject);
  });
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

const DURATION = /^(\d+)(s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `since`/`until`: ms epoch, ISO date, or a relative `15m` / `1h` / `7d` back from now. */
export function parseTime(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const rel = DURATION.exec(value.trim());
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2]!]!;
  if (/^\d{10,}$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function filterFromQuery(q: URLSearchParams, now: number): EventFilter {
  const f: EventFilter = {};
  for (const k of ['traceId', 'sessionId', 'turnId', 'replicaId', 'deployment', 'app', 'event'] as const) {
    const v = q.get(k);
    if (v) f[k] = v.slice(0, TELEMETRY_LIMITS.maxId);
  }
  const source = q.get('source');
  if (source && (TELEMETRY_SOURCES as readonly string[]).includes(source)) f.source = source as TelemetrySource;
  const level = q.get('level');
  if (level && (TELEMETRY_LEVELS as readonly string[]).includes(level)) f.level = level as TelemetryLevel;
  const since = parseTime(q.get('since'), now);
  const until = parseTime(q.get('until'), now);
  if (since !== undefined) f.since = since;
  if (until !== undefined) f.until = until;
  return f;
}

export interface TelemetryRoutesOptions {
  store: TelemetryStore;
  ingest: TelemetryIngest;
  auth: TelemetryAuthDeps;
  /** Admin check for the read routes (same admins as deployments: DEPLOYMENTS_ADMIN_USERS). */
  isAdminToken: (token: string) => boolean;
  now?: () => number;
}

export function createTelemetryRoutes(opts: TelemetryRoutesOptions): { publicRoutes: CustomRoute[]; adminRoutes: CustomRoute[] } {
  const now = opts.now ?? Date.now;

  const ingestRoute: CustomRoute = {
    method: 'POST',
    path: TELEMETRY_INGEST_PATH,
    handler: async (req, res) => {
      const body = await readLimited(req, TELEMETRY_LIMITS.maxBatchBytes);
      if (!body) {
        opts.ingest.counters.tooLarge++;
        return send(res, 413, { error: `Batch larger than ${TELEMETRY_LIMITS.maxBatchBytes} bytes` });
      }
      let parsed: unknown;
      try { parsed = body.text ? JSON.parse(body.text) : null; } catch { return send(res, 400, { error: 'Body is not JSON' }); }
      const bodyToken = parsed && typeof parsed === 'object' && typeof (parsed as { token?: unknown }).token === 'string'
        ? (parsed as { token: string }).token : undefined;
      const principal = authenticateTelemetry({
        authorization: header(req, 'authorization'),
        replica: header(req, TELEMETRY_REPLICA_HEADER),
        origin: header(req, 'origin'),
        secFetchSite: header(req, 'sec-fetch-site'),
        bodyToken,
      }, opts.auth);
      if (isAuthFailure(principal)) {
        opts.ingest.counters.unauthorized++;
        return send(res, principal.status, { error: principal.error, code: principal.code });
      }
      const result = opts.ingest.ingest(principal, parsed, body.bytes);
      if (result.status !== 200) {
        return send(res, result.status, { error: result.error },
          result.retryAfterSec ? { 'Retry-After': String(result.retryAfterSec) } : {});
      }
      const { status, ...out } = result;
      return send(res, status, out);
    },
  };

  const admin = (handler: (q: URLSearchParams, res: ServerResponse) => void) => async (req: IncomingMessage, res: ServerResponse) => {
    const token = (header(req, 'authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!token || !opts.isAdminToken(token)) return send(res, 403, { error: 'Telemetry queries need an admin API key' });
    handler(new URL(req.url ?? '/', 'http://gateway').searchParams, res);
  };

  const rows = (): readonly StoredTelemetryEvent[] => opts.store.rows();
  const adminRoutes: CustomRoute[] = [
    {
      method: 'GET', path: '/v1/telemetry/timeline', handler: admin((q, res) => {
        const traceId = q.get('traceId') ?? undefined;
        const sessionId = q.get('sessionId') ?? undefined;
        if (!traceId && !sessionId) return send(res, 400, { error: 'Pass traceId or sessionId' });
        send(res, 200, timeline(rows(), { traceId, sessionId }));
      }),
    },
    {
      method: 'GET', path: '/v1/telemetry/summary', handler: admin((q, res) => {
        const groupBy = (q.get('groupBy') ?? 'event') as SummaryGroup;
        if (!SUMMARY_GROUPS.includes(groupBy)) return send(res, 400, { error: `groupBy must be one of ${SUMMARY_GROUPS.join(', ')}` });
        const filter = filterFromQuery(q, now());
        if (filter.since === undefined) filter.since = now() - 3_600_000;
        send(res, 200, { since: filter.since, ...summarize(rows(), groupBy, filter) });
      }),
    },
    {
      method: 'GET', path: '/v1/telemetry/events', handler: admin((q, res) => {
        const cursor = q.get('cursor');
        const limit = Number(q.get('limit') ?? 100);
        send(res, 200, queryEvents(rows(), filterFromQuery(q, now()), {
          limit: Number.isFinite(limit) ? limit : 100,
          ...(cursor && /^\d+$/.test(cursor) ? { cursor: Number(cursor) } : {}),
          order: q.get('order') === 'asc' ? 'asc' : 'desc',
        }));
      }),
    },
    {
      method: 'GET', path: '/v1/telemetry/stats', handler: admin((_q, res) => {
        send(res, 200, {
          rows: opts.store.size, maxRows: opts.store.maxRows, evictedByCap: opts.store.evictedByCap,
          retentionDays: opts.store.retentionMs / 86_400_000, counters: opts.ingest.counters,
        });
      }),
    },
  ];
  return { publicRoutes: [ingestRoute], adminRoutes };
}

/** OTLP forward of one stored event (a zero-or-`durMs`-long span tagged with the event's fields). */
export function eventToSpan(row: StoredTelemetryEvent) {
  const durMs = row.durMs ?? 0;
  return {
    traceId: row.traceId,
    spanId: newSpanId(),
    operation: row.event,
    startTime: Math.round(row.ts - durMs),
    tags: {
      duration_ms: Math.round(durMs), 'telemetry.source': row.source, 'telemetry.level': row.level,
      ...(row.sessionId ? { 'session.id': row.sessionId } : {}), ...(row.turnId ? { 'turn.id': row.turnId } : {}),
      ...(row.replicaId ? { 'replica.id': row.replicaId } : {}), ...(row.deployment ? { deployment: row.deployment } : {}),
      ...(row.app ? { app: row.app } : {}), ...(row.attrs ?? {}),
    },
    events: row.level === 'error' ? [{ timestamp: row.ts, name: 'exception', attributes: {} }] : [],
  };
}

export interface TelemetryService {
  store: TelemetryStore;
  ingest: TelemetryIngest;
  publicRoutes: CustomRoute[];
  adminRoutes: CustomRoute[];
  start(): Promise<void>;
  stop(): void;
}

const envNumber = (v: string | undefined, fallback: number) => (v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);

export function telemetryFromEnv(
  env: Record<string, string | undefined>,
  deps: { auth: TelemetryAuthDeps; isAdminToken: (token: string) => boolean; log?: (msg: string, data?: Record<string, unknown>) => void },
): TelemetryService | null {
  if (env.TELEMETRY === '0') return null;
  const dir = env.TELEMETRY_DIR || join(env.DEPLOYMENTS_STATE_DIR || join(homedir(), '.ai-gateway'), 'telemetry');
  const exporter = env.OTEL_EXPORTER_OTLP_ENDPOINT ? initOtlpFromEnv(env as NodeJS.ProcessEnv) : null;
  const store = new TelemetryStore({
    dir,
    retentionDays: envNumber(env.TELEMETRY_RETENTION_DAYS, 14),
    maxRows: envNumber(env.TELEMETRY_MAX_ROWS, 200_000),
    maxDiskBytes: envNumber(env.TELEMETRY_MAX_DISK_MB, 256) * 1024 * 1024,
    ...(deps.log ? { log: deps.log } : {}),
    ...(exporter ? { onStored: (row: StoredTelemetryEvent) => exporter.enqueue(eventToSpan(row)) } : {}),
  });
  const ingest = new TelemetryIngest(store, {
    debugSample: envNumber(env.TELEMETRY_DEBUG_SAMPLE, 0),
    ratePerMinute: envNumber(env.TELEMETRY_RATE_PER_MIN, 1200),
  });
  const routes = createTelemetryRoutes({ store, ingest, auth: deps.auth, isAdminToken: deps.isAdminToken });
  return {
    store, ingest, ...routes,
    start: async () => { await store.init(); await store.cleanup(); store.start(); },
    stop: () => store.stop(),
  };
}
