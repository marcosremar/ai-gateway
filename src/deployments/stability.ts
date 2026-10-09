/**
 * Client instability reports — `POST/GET /v1/apps/:app/stability-report` (wired in http.ts).
 *
 * A server-side SDK client (sdk/node `GatewayClient`) buffers what it saw while the gateway was unreachable or slow
 * — route switches to the direct fallback, failures, recoveries — and posts the batch here once the gateway answers
 * again. Reports go to a small in-memory ring (for `GET`) and, best-effort, one JSONL line per report in
 * `<DEPLOYMENTS_STATE_DIR>/client-stability.jsonl`, rotated to `.1` past `maxFileBytes` (default 5 MB). Each app may
 * post `MAX_REPORTS_PER_MINUTE` reports a minute (then `append` returns null: 429). A filesystem that rejects the write
 * never fails the request; it is logged.
 */

import { appendFile, mkdir, rename, stat } from 'fs/promises';
import { dirname } from 'path';

/** One observation a client recorded (mirror of sdk/node `InstabilityEvent`). */
export interface ClientInstabilityEvent {
  at: number;
  kind: string;
  path?: string;
  code?: string;
  route?: string;
  latencyMs?: number;
  detail?: string;
}

export interface ClientStabilityBatch {
  app: string;
  client: string;
  receivedAt: number;
  events: ClientInstabilityEvent[];
}

const MAX_EVENTS_PER_REPORT = 200;
const MAX_BATCHES_KEPT = 200;
const MAX_FIELD = { kind: 40, path: 120, code: 60, route: 20, detail: 300 };
const SKEW_MS = 5 * 60_000;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_REPORTS_PER_MINUTE = 20;

const cleanString = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

/** One event, sanitized: bad rows are dropped, fields are capped. Returns null when unusable. */
export function cleanEvent(raw: unknown, now: number): ClientInstabilityEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  const kind = cleanString(e.kind, MAX_FIELD.kind);
  if (typeof e.at !== 'number' || !Number.isFinite(e.at) || e.at < 0 || !kind) return null;
  const out: ClientInstabilityEvent = { at: Math.min(e.at, now + SKEW_MS), kind };
  const path = cleanString(e.path, MAX_FIELD.path); if (path) out.path = path;
  const code = cleanString(e.code, MAX_FIELD.code); if (code) out.code = code;
  const route = cleanString(e.route, MAX_FIELD.route); if (route) out.route = route;
  const detail = cleanString(e.detail, MAX_FIELD.detail); if (detail) out.detail = detail;
  if (typeof e.latencyMs === 'number' && Number.isFinite(e.latencyMs) && e.latencyMs >= 0) out.latencyMs = Math.round(e.latencyMs);
  return out;
}

// ── What goes to disk ───────────────────────────────────────────────────────
// The file gets a rebuilt copy, not the request's strings (CodeQL js/http-to-file-access, PR #45): numbers as numbers,
// `kind`/`route` only from the SDK's own vocabulary, and every free-text field re-spelled character by character from
// a fixed alphabet (anything else, newlines included, becomes `_`), bounded in length. One report stays one line.

const EVENT_KINDS = ['unreachable', 'slow', 'direct', 'direct_failed', 'recovered', 'breaker_open'] as const;
const ROUTES = ['gateway', 'direct'] as const;
const SAFE_CHARS = new Map<string, string>(
  [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.:/@()[],;=+#%?&\'éèêàçãõáíóúâôü'].map(c => [c, c]),
);

/** Free text for the file: only `SAFE_CHARS` (each taken from the table, not from the input), at most `max` chars. */
export function fileText(v: string | undefined, max: number): string | undefined {
  if (v === undefined) return undefined;
  let out = '';
  for (const c of v.slice(0, max)) out += SAFE_CHARS.get(c) ?? '_';
  return out;
}

const pick = <T extends string>(allowed: readonly T[], v: string | undefined): T | 'other' | undefined =>
  v === undefined ? undefined : allowed.find(a => a === v) ?? 'other';

const finite = (n: number | undefined): number | undefined => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : undefined);

/** The JSONL record of one batch: whitelisted fields and types only. */
export function fileRecord(batch: ClientStabilityBatch): Record<string, unknown> {
  return {
    app: fileText(batch.app, 40),
    client: fileText(batch.client, 80),
    receivedAt: finite(batch.receivedAt),
    receivedAtIso: new Date(finite(batch.receivedAt) ?? 0).toISOString(),
    events: batch.events.slice(0, MAX_EVENTS_PER_REPORT).map(e => ({
      at: finite(e.at),
      kind: pick(EVENT_KINDS, e.kind),
      ...(e.path !== undefined ? { path: fileText(e.path, MAX_FIELD.path) } : {}),
      ...(e.code !== undefined ? { code: fileText(e.code, MAX_FIELD.code) } : {}),
      ...(e.route !== undefined ? { route: pick(ROUTES, e.route) } : {}),
      ...(e.latencyMs !== undefined ? { latencyMs: finite(e.latencyMs) } : {}),
      ...(e.detail !== undefined ? { detail: fileText(e.detail, MAX_FIELD.detail) } : {}),
    })),
  };
}

export interface ClientStabilityOptions {
  /** JSONL file to append reports to (e.g. `<DEPLOYMENTS_STATE_DIR>/client-stability.jsonl`); absent = memory only. */
  file?: string;
  maxFileBytes?: number;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export class ClientStabilityLog {
  private readonly ring: ClientStabilityBatch[] = [];
  private readonly recentPosts = new Map<string, number[]>();
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly log: (msg: string, data?: Record<string, unknown>) => void;

  constructor(private readonly opts: ClientStabilityOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** Stores one report; returns how many events were accepted, or null when the app posts too often. Never throws on a bad body shape. */
  append(app: string, body: Record<string, unknown>): number | null {
    const now = this.now();
    const posts = (this.recentPosts.get(app) ?? []).filter(at => now - at < 60_000);
    if (posts.length >= MAX_REPORTS_PER_MINUTE) return null;
    this.recentPosts.set(app, [...posts, now]);
    const rawEvents = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS_PER_REPORT) : [];
    const events = rawEvents.map(e => cleanEvent(e, now)).filter((e): e is ClientInstabilityEvent => e !== null);
    const client = cleanString(body.client, 80) ?? 'unknown';
    if (!events.length) return 0;
    const batch: ClientStabilityBatch = { app, client, receivedAt: now, events };
    this.ring.push(batch);
    if (this.ring.length > MAX_BATCHES_KEPT) this.ring.splice(0, this.ring.length - MAX_BATCHES_KEPT);
    this.log('client stability report', { app, client, events: events.length });
    this.persist(batch);
    return events.length;
  }

  flush(): Promise<void> {
    return this.chain;
  }

  /** Most recent batches for one app (`app` null = all), newest last. */
  recent(app: string | null, limit = 50): ClientStabilityBatch[] {
    const all = app === null ? this.ring : this.ring.filter(b => b.app === app);
    return all.slice(Math.max(0, all.length - Math.min(Math.max(limit, 1), MAX_BATCHES_KEPT)));
  }

  /** Serialized, best-effort JSONL append. */
  private persist(batch: ClientStabilityBatch): void {
    const file = this.opts.file;
    if (!file) return;
    this.chain = this.chain.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true });
        const size = await stat(file).then(st => st.size, () => 0);
        if (size >= (this.opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)) await rename(file, `${file}.1`);
        await appendFile(file, `${JSON.stringify(fileRecord(batch))}\n`, 'utf8');
      } catch (err) {
        this.log('client stability report: could not persist', { error: String((err as Error).message ?? err).slice(0, 120) });
      }
    });
  }
}
