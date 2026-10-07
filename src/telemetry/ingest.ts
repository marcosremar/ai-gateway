/**
 * Ingest of one telemetry batch, after auth (auth.ts): size limits, per-credential rate limit, per-event schema
 * validation, debug sampling, identity stamping and the privacy scrubber, then the store.
 *
 * A bad event is counted and dropped — never a 500, never the whole batch. Only the batch-level limits refuse the
 * request: > 100 events or > 64 KB → 413, rate exhausted → 429 (Retry-After), body not `{events:[…]}` → 400.
 *
 * Stamping (the credential wins over the body):
 *   session → source `browser`; `sessionId`, `app`, `deployment`, `replicaId` from the token;
 *   edge    → source `edge` (or `model`, which the edge relays); `deployment`, `replicaId`, `app` from the replica;
 *   app key → `app` from the key; source `browser` | `edge` | `model` as sent (`gateway` is reserved to the gateway).
 */

import { TELEMETRY_LIMITS, type StoredTelemetryEvent, type TelemetryEvent, type TelemetrySource } from './contract';
import type { TelemetryPrincipal } from './auth';
import { TelemetryEventSchema } from './schema';
import { scrubAttrs } from './scrub';
import type { NewTelemetryRow, TelemetryStore } from './store';

export interface IngestOptions {
  /** Fraction (0..1) of `debug` events kept, decided per trace (TELEMETRY_DEBUG_SAMPLE, default 0). */
  debugSample?: number;
  /** Events per minute per credential (app / session / replica); TELEMETRY_RATE_PER_MIN, default 1200. */
  ratePerMinute?: number;
  now?: () => number;
}

export interface IngestCounters {
  batches: number;
  accepted: number;
  invalid: number;
  sampledOut: number;
  redactedAttrs: number;
  rateLimited: number;
  tooLarge: number;
  unauthorized: number;
  clockReplaced: number;
}

export type IngestResult =
  | { status: 200; accepted: number; dropped: { invalid: number; sampled: number }; redactedAttrs: number; errors: Array<{ index: number; issue: string }> }
  | { status: 400 | 413 | 429; error: string; retryAfterSec?: number };

/** Clock sanity: a source `ts` further than this from the receive time is replaced by it (and flagged). */
const MAX_CLOCK_GAP_MS = 86_400_000;
const MAX_ERRORS_REPORTED = 10;

const principalKey = (p: TelemetryPrincipal) =>
  p.kind === 'app' ? `app:${p.app}` : p.kind === 'session' ? `session:${p.sessionId}` : `edge:${p.replicaId}`;

/** Deterministic per-trace sampling: a whole trace is kept or dropped together. */
export function traceSampled(traceId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return parseInt(traceId.slice(0, 8), 16) / 0x1_0000_0000 < rate;
}

function sourceFor(p: TelemetryPrincipal, sent: TelemetrySource): TelemetrySource | null {
  if (p.kind === 'session') return 'browser';
  if (p.kind === 'edge') return sent === 'model' ? 'model' : 'edge';
  return sent === 'gateway' ? null : sent;
}

function stamp(p: TelemetryPrincipal, e: TelemetryEvent): Partial<StoredTelemetryEvent> {
  if (p.kind === 'session') return { app: p.app, sessionId: p.sessionId, deployment: p.deployment, replicaId: p.replicaId };
  if (p.kind === 'edge') return { deployment: p.deployment, replicaId: p.replicaId, ...(p.app ? { app: p.app } : { app: undefined }) };
  return { app: p.app, deployment: e.deployment, replicaId: e.replicaId };
}

export class TelemetryIngest {
  readonly counters: IngestCounters = {
    batches: 0, accepted: 0, invalid: 0, sampledOut: 0, redactedAttrs: 0, rateLimited: 0, tooLarge: 0, unauthorized: 0, clockReplaced: 0,
  };
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly now: () => number;
  private readonly debugSample: number;
  private readonly ratePerMinute: number;

  constructor(private readonly store: TelemetryStore, opts: IngestOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.debugSample = Math.min(1, Math.max(0, opts.debugSample ?? 0));
    this.ratePerMinute = Math.max(1, opts.ratePerMinute ?? 1200);
  }

  /** Token bucket per credential, `ratePerMinute` deep, refilled continuously. */
  private take(key: string, n: number): number | null {
    const now = this.now();
    if (this.buckets.size > 10_000) {
      for (const [k, b] of this.buckets) if (now - b.at > 600_000) this.buckets.delete(k);
    }
    const b = this.buckets.get(key) ?? { tokens: this.ratePerMinute, at: now };
    b.tokens = Math.min(this.ratePerMinute, b.tokens + ((now - b.at) / 60_000) * this.ratePerMinute);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens < n) return Math.max(1, Math.ceil(((n - b.tokens) / this.ratePerMinute) * 60));
    b.tokens -= n;
    return null;
  }

  /** Stores the gateway's own events (emit.ts sink): same validation and scrubber, no auth, no rate limit. */
  ingestOwn(event: TelemetryEvent): void {
    const parsed = TelemetryEventSchema.safeParse(event);
    if (!parsed.success) { this.counters.invalid++; return; }
    if (parsed.data.level === 'debug' && !traceSampled(parsed.data.traceId, this.debugSample)) { this.counters.sampledOut++; return; }
    const { attrs, redacted } = scrubAttrs(parsed.data.attrs);
    this.counters.redactedAttrs += redacted;
    this.counters.accepted++;
    this.store.insert([clean({ ...parsed.data, source: 'gateway', rxTs: this.now(), attrs })]);
  }

  ingest(principal: TelemetryPrincipal, body: unknown, bodyBytes: number): IngestResult {
    this.counters.batches++;
    if (bodyBytes > TELEMETRY_LIMITS.maxBatchBytes) {
      this.counters.tooLarge++;
      return { status: 413, error: `Batch larger than ${TELEMETRY_LIMITS.maxBatchBytes} bytes` };
    }
    const events = body && typeof body === 'object' ? (body as { events?: unknown }).events : undefined;
    if (!Array.isArray(events)) return { status: 400, error: 'Body must be {"events":[...]}' };
    if (events.length > TELEMETRY_LIMITS.maxBatchEvents) {
      this.counters.tooLarge++;
      return { status: 413, error: `At most ${TELEMETRY_LIMITS.maxBatchEvents} events per batch` };
    }
    const retryAfterSec = this.take(principalKey(principal), Math.max(1, events.length));
    if (retryAfterSec !== null) {
      this.counters.rateLimited++;
      return { status: 429, error: 'Telemetry rate limit exceeded', retryAfterSec };
    }
    const rxTs = this.now();
    const rows: NewTelemetryRow[] = [];
    const errors: Array<{ index: number; issue: string }> = [];
    let invalid = 0; let sampled = 0; let redactedAttrs = 0;
    events.forEach((raw, index) => {
      const parsed = TelemetryEventSchema.safeParse(raw);
      const source = parsed.success ? sourceFor(principal, parsed.data.source) : null;
      if (!parsed.success || !source) {
        invalid++;
        if (errors.length < MAX_ERRORS_REPORTED) {
          const issue = parsed.success ? 'source "gateway" is reserved' : parsed.error.issues.slice(0, 3)
            .map(i => `${i.path.join('.') || '(event)'}: ${i.message}`).join('; ');
          errors.push({ index, issue: issue.slice(0, 200) });
        }
        return;
      }
      const e = parsed.data;
      if (e.level === 'debug' && !traceSampled(e.traceId, this.debugSample)) { sampled++; return; }
      const { attrs, redacted } = scrubAttrs(e.attrs);
      redactedAttrs += redacted;
      const clockOff = Math.abs(e.ts - rxTs) > MAX_CLOCK_GAP_MS;
      if (clockOff) this.counters.clockReplaced++;
      rows.push(clean({
        ...e, ...stamp(principal, e), source, rxTs,
        ts: clockOff ? rxTs : e.ts,
        attrs: clockOff ? { ...(attrs ?? {}), clockReplaced: true } : attrs,
      }));
    });
    if (rows.length) this.store.insert(rows);
    this.counters.accepted += rows.length;
    this.counters.invalid += invalid;
    this.counters.sampledOut += sampled;
    this.counters.redactedAttrs += redactedAttrs;
    return { status: 200, accepted: rows.length, dropped: { invalid, sampled }, redactedAttrs, errors };
  }
}

/** Drops `undefined` fields so stored rows (and their JSON) only hold what is set. */
function clean(row: NewTelemetryRow): NewTelemetryRow {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (v !== undefined) out[k] = v;
  return out as unknown as NewTelemetryRow;
}
