/**
 * Telemetry emitter — batches events (docs/api/telemetry.md) to `POST <gateway>/v1/telemetry/events`.
 * Dependency-free, works in the browser and in Node ≥ 18 (sdk/node/telemetry.ts wraps it with an app key).
 *
 *   - flush every `flushIntervalMs` (5 s), or as soon as `maxBatch` (50) events wait;
 *   - on `pagehide` / tab hidden: `navigator.sendBeacon` (the session token rides in the body, a beacon cannot set
 *     headers), falling back to `fetch(..., { keepalive: true })`;
 *   - bounded queue (`maxQueue`, 500): the oldest events are dropped and counted; the count goes out as one
 *     `telemetry.dropped` event with the next batch;
 *   - transient failures (network, 429, 5xx) put the batch back (still bounded); 4xx refusals drop it;
 *   - never throws into the app: every public method swallows its own errors.
 *
 * Privacy: send codes, counts, lengths and durations — never audio, transcripts, LLM text, keys or IPs (the gateway
 * scrubs anyway, and counts what it had to remove).
 */

import {
  TELEMETRY_EVENT_NAME, TELEMETRY_INGEST_PATH, TELEMETRY_LIMITS, TELEMETRY_SENSITIVE_KEY, TELEMETRY_TRACE_ID, type TelemetryAttrs, type TelemetryEvent, type TelemetryLevel, type TelemetrySource,
} from '../../../src/telemetry/contract';

export type { TelemetryEvent, TelemetryLevel, TelemetrySource, TelemetryAttrs } from '../../../src/telemetry/contract';

export interface TelemetryContext {
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  replicaId?: string;
  deployment?: string;
}

export interface TelemetryEmitterOptions extends TelemetryContext {
  /** Gateway base URL (`https://gw.example`) or the full ingest URL; absent = queue until `bind(…, ingestUrl)`. */
  endpoint?: string;
  /** Bearer credential: the realtime session token (browser) or an app key (server). A function is read per flush. */
  token?: string | null | (() => string | null | undefined);
  /** Source stamped on events (the gateway forces `browser` for session tokens). Default `browser`. */
  source?: TelemetrySource;
  flushIntervalMs?: number;
  maxBatch?: number;
  maxQueue?: number;
  /** Capture window `error` / `unhandledrejection` as `browser.error` events (opt-in; no message text is sent). */
  captureErrors?: boolean;
  /** Use `sendBeacon` on pagehide (browser default true). */
  beacon?: boolean;
  fetch?: typeof fetch;
  sendBeacon?: (url: string, data: Blob | string) => boolean;
  now?: () => number;
  /** Event target for pagehide/visibilitychange/error (default `globalThis` when it has addEventListener). */
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
}

export interface EmitFields extends Omit<TelemetryContext, 'traceId'> {
  level?: TelemetryLevel;
  durMs?: number;
  traceId?: string;
  /** Scalars only; anything else, and strings under content-naming keys (text, transcript, token…), is dropped here. */
  attrs?: Record<string, unknown>;
}

export interface TelemetryStats {
  queued: number;
  sent: number;
  dropped: number;
  failed: number;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(buf);
  else for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

/** A fresh W3C trace id (32 hex, never all zeros). */
export function newTraceId(): string {
  let id = randomHex(16);
  while (!TELEMETRY_TRACE_ID.test(id)) id = randomHex(16);
  return id;
}

/** `traceparent` header value for an outgoing call in this trace (new span id each time). */
export function traceparentOf(traceId: string): string {
  let span = randomHex(8);
  while (span === '0000000000000000') span = randomHex(8);
  return `00-${traceId}-${span}-01`;
}

const ingestUrl_ = (endpoint: string) => (endpoint.includes(TELEMETRY_INGEST_PATH) ? endpoint : `${endpoint.replace(/\/+$/, '')}${TELEMETRY_INGEST_PATH}`);

export class TelemetryEmitter {
  private queue: TelemetryEvent[] = [];
  private ctx: TelemetryContext;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private droppedPending = 0;
  private closed = false;
  private url: string | null;
  private boundToken: string | null = null;
  private readonly listeners: Array<[string, (e: Event) => void]> = [];
  readonly stats: TelemetryStats = { queued: 0, sent: 0, dropped: 0, failed: 0 };

  constructor(private readonly opts: TelemetryEmitterOptions) {
    this.url = opts.endpoint ? ingestUrl_(opts.endpoint) : null;
    this.ctx = { traceId: opts.traceId && TELEMETRY_TRACE_ID.test(opts.traceId) ? opts.traceId : newTraceId(),
      sessionId: opts.sessionId, turnId: opts.turnId, replicaId: opts.replicaId, deployment: opts.deployment };
    try {
      this.timer = setInterval(() => { void this.flush(); }, opts.flushIntervalMs ?? 5000);
      (this.timer as { unref?: () => void }).unref?.();
      this.attach();
    } catch { /* no timers / no window: manual flush still works */ }
  }

  /** The trace id every event carries (put it in `traceparent` on the SDK's own HTTP calls: `traceparent()`). */
  get traceId(): string {
    return this.ctx.traceId!;
  }

  /** `traceparent` for the SDK's own gateway calls: this trace, a new span id on each read. */
  get traceparent(): string {
    return traceparentOf(this.traceId);
  }

  /**
   * The realtime session is admitted: events carry `sessionId` from now on (queued ones too) and are sent with the
   * session token to `ingestUrl` (null = keep queuing, send nothing). Same shape as the realtime SDK's
   * `RealtimeTelemetry.bind`, so this emitter can replace its local one.
   */
  bind(sessionId: string, token: string, ingestUrl: string | null): void {
    try {
      this.ctx = { ...this.ctx, sessionId };
      this.boundToken = token;
      this.url = ingestUrl ? ingestUrl_(ingestUrl) : null;
      for (const e of this.queue) if (!e.sessionId) e.sessionId = sessionId;
    } catch { /* never throw */ }
  }

  /** Updates the correlation ids (e.g. `sessionId` once admitted, `turnId` per student turn). */
  setContext(next: TelemetryContext): void {
    try {
      const traceId = next.traceId && TELEMETRY_TRACE_ID.test(next.traceId) ? next.traceId : this.ctx.traceId;
      this.ctx = { ...this.ctx, ...next, traceId };
    } catch { /* never throw */ }
  }

  emit(event: string, fields: EmitFields = {}): void {
    try {
      if (this.closed || !TELEMETRY_EVENT_NAME.test(event) || event.length > TELEMETRY_LIMITS.maxEventName) return;
      const attrs: TelemetryAttrs = {};
      let n = 0;
      for (const [k, v] of Object.entries(fields.attrs ?? {})) {
        if (n >= TELEMETRY_LIMITS.maxAttrs) break;
        if (typeof v === 'string') {
          if (v.length > TELEMETRY_LIMITS.maxAttrString || TELEMETRY_SENSITIVE_KEY.test(k)) continue;
        } else if (typeof v === 'number') {
          if (!Number.isFinite(v)) continue;
        } else if (v !== null && typeof v !== 'boolean') continue;
        attrs[k] = v as TelemetryAttrs[string]; n++;
      }
      const ctx = { ...this.ctx, ...pickIds(fields) };
      const e: TelemetryEvent = {
        ts: (this.opts.now ?? Date.now)(), source: this.opts.source ?? 'browser', level: fields.level ?? 'info', event,
        traceId: fields.traceId && TELEMETRY_TRACE_ID.test(fields.traceId) ? fields.traceId : ctx.traceId!,
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}), ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
        ...(ctx.replicaId ? { replicaId: ctx.replicaId } : {}), ...(ctx.deployment ? { deployment: ctx.deployment } : {}),
        ...(typeof fields.durMs === 'number' && Number.isFinite(fields.durMs) && fields.durMs >= 0 ? { durMs: Math.round(fields.durMs) } : {}),
        ...(n ? { attrs } : {}),
      };
      this.enqueue([e]);
      if (this.queue.length >= this.batchSize()) void this.flush();
    } catch { /* never throw */ }
  }

  /** Sends what is queued now (batches in sequence). Resolves when done; never rejects. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.drain().catch(() => {}).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  /** Last-chance flush (pagehide): beacons, else keepalive fetches; fire-and-forget. */
  flushOnExit(): void {
    try {
      if (!this.url) return;
      this.addDropNotice();
      while (this.queue.length) {
        const batch = this.takeBatch();
        if (!this.beacon(batch)) void this.post(batch, true);
      }
    } catch { /* never throw */ }
  }

  /** Stops the timer and listeners after a final flush. */
  async close(): Promise<void> {
    try {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      const target = this.target();
      for (const [type, fn] of this.listeners) target?.removeEventListener(type, fn);
      this.listeners.length = 0;
      await this.flush();
      this.closed = true;
    } catch { /* never throw */ }
  }

  private batchSize(): number {
    return Math.min(Math.max(this.opts.maxBatch ?? 50, 1), TELEMETRY_LIMITS.maxBatchEvents);
  }

  private enqueue(events: TelemetryEvent[], front = false): void {
    this.queue = front ? [...events, ...this.queue] : [...this.queue, ...events];
    const max = Math.max(this.opts.maxQueue ?? 500, 1);
    if (this.queue.length > max) {
      const extra = this.queue.length - max;
      this.queue.splice(0, extra); // oldest first
      this.stats.dropped += extra;
      this.droppedPending += extra;
    }
    this.stats.queued = this.queue.length;
  }

  private addDropNotice(): void {
    if (!this.droppedPending) return;
    const count = this.droppedPending;
    this.droppedPending = 0;
    this.queue.unshift({
      ts: (this.opts.now ?? Date.now)(), source: this.opts.source ?? 'browser', level: 'warn', event: 'telemetry.dropped',
      traceId: this.traceId, ...(this.ctx.sessionId ? { sessionId: this.ctx.sessionId } : {}), attrs: { count },
    });
  }

  /** Next batch: ≤ maxBatch events and ≤ 60 KB of JSON (room for the envelope and the beacon token). */
  private takeBatch(): TelemetryEvent[] {
    const batch: TelemetryEvent[] = [];
    let bytes = 0;
    while (this.queue.length && batch.length < this.batchSize()) {
      const size = JSON.stringify(this.queue[0]).length + 1;
      if (batch.length && bytes + size > TELEMETRY_LIMITS.maxBatchBytes - 4096) break;
      bytes += size;
      batch.push(this.queue.shift()!);
    }
    this.stats.queued = this.queue.length;
    return batch;
  }

  private async drain(): Promise<void> {
    if (!this.url) return; // not bound yet: keep queuing (bounded)
    this.addDropNotice();
    while (this.queue.length) {
      const batch = this.takeBatch();
      const outcome = await this.post(batch, false);
      if (outcome === 'retry') { this.enqueue(batch, true); return; }
    }
  }

  private token(): string | null {
    if (this.boundToken) return this.boundToken;
    const t = this.opts.token;
    try { return (typeof t === 'function' ? t() : t) ?? null; } catch { return null; }
  }

  private async post(batch: TelemetryEvent[], keepalive: boolean): Promise<'ok' | 'retry' | 'dropped'> {
    const f = this.opts.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f || !batch.length || !this.url) return 'dropped';
    const token = this.token();
    try {
      const res = await f(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', traceparent: this.traceparent, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ events: batch }),
        keepalive,
      });
      if (res.ok) { this.stats.sent += batch.length; return 'ok'; }
      if (res.status === 429 || res.status >= 500) return 'retry';
      this.stats.failed += batch.length;
      return 'dropped';
    } catch {
      return keepalive ? 'dropped' : 'retry';
    }
  }

  private beacon(batch: TelemetryEvent[]): boolean {
    if (this.opts.beacon === false) return false;
    const nav = (globalThis as { navigator?: { sendBeacon?: (u: string, d: Blob | string) => boolean } }).navigator;
    const send = this.opts.sendBeacon ?? (nav?.sendBeacon ? nav.sendBeacon.bind(nav) : null);
    if (!send || !this.url) return false;
    const token = this.token();
    const body = JSON.stringify({ events: batch, ...(token ? { token } : {}) });
    // text/plain: a CORS-safelisted type, so the beacon needs no preflight (the gateway parses the JSON anyway).
    const data = typeof Blob !== 'undefined' ? new Blob([body], { type: 'text/plain;charset=UTF-8' }) : body;
    try {
      const ok = send(this.url, data);
      if (ok) this.stats.sent += batch.length;
      return ok;
    } catch { return false; }
  }

  private target(): Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null {
    if (this.opts.target !== undefined) return this.opts.target;
    const g = globalThis as { addEventListener?: unknown; document?: unknown };
    return typeof g.addEventListener === 'function' && g.document ? (globalThis as unknown as EventTarget) : null;
  }

  private attach(): void {
    const target = this.target();
    if (!target) return;
    const on = (type: string, fn: (e: Event) => void) => { target.addEventListener(type, fn); this.listeners.push([type, fn]); };
    on('pagehide', () => this.flushOnExit());
    on('visibilitychange', () => {
      const doc = (globalThis as { document?: { visibilityState?: string } }).document;
      if (doc?.visibilityState === 'hidden') this.flushOnExit();
    });
    if (!this.opts.captureErrors) return;
    on('error', (e) => {
      const ev = e as Event & { error?: { name?: string }; filename?: string; lineno?: number; colno?: number };
      this.emit('browser.error', { level: 'error', attrs: {
        kind: 'error', name: String(ev.error?.name ?? 'Error').slice(0, 60),
        file: ev.filename ? String(ev.filename).split(/[?#]/)[0]!.split('/').pop()!.slice(0, 80) : null,
        line: ev.lineno ?? null, col: ev.colno ?? null,
      } });
    });
    on('unhandledrejection', (e) => {
      const reason = (e as Event & { reason?: { name?: string } }).reason;
      this.emit('browser.error', { level: 'error', attrs: { kind: 'unhandledrejection', name: String(reason?.name ?? typeof reason).slice(0, 60) } });
    });
  }
}

function pickIds(f: EmitFields): TelemetryContext {
  const out: TelemetryContext = {};
  if (f.sessionId) out.sessionId = f.sessionId;
  if (f.turnId) out.turnId = f.turnId;
  if (f.replicaId) out.replicaId = f.replicaId;
  if (f.deployment) out.deployment = f.deployment;
  return out;
}

/** `const telemetry = createTelemetry({ endpoint, token: () => session.token })` → `telemetry.emit('rt.ice.failed', …)`. */
export function createTelemetry(opts: TelemetryEmitterOptions): TelemetryEmitter {
  return new TelemetryEmitter(opts);
}
