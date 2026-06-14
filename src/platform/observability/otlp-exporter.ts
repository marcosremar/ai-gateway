/**
 * OTLP HTTP/JSON exporter — batches DistributedTracer spans to an OTLP endpoint
 * (Grafana Tempo, Jaeger, Honeycomb, Datadog, any OTLP-compatible collector).
 *
 * Wire format: OpenTelemetry Protocol (OTLP) HTTP/JSON v1
 * Spec: https://github.com/open-telemetry/opentelemetry-proto
 *
 * Env-driven config:
 *   OTEL_EXPORTER_OTLP_ENDPOINT  base URL (e.g. http://tempo:4318)
 *   OTEL_EXPORTER_OTLP_HEADERS   comma-separated key=value pairs
 *   OTEL_SERVICE_NAME            service.name resource attribute
 *   OTEL_EXPORTER_OTLP_PROTOCOL  http/json (only mode supported)
 *   OTEL_EXPORTER_FLUSH_MS       flush interval (default 5000)
 *   OTEL_EXPORTER_BATCH_MAX      max spans per batch (default 200)
 */

import type { TraceContext } from './types';
import { globalTracer } from './distributed-tracer';
import { defaultLogger as log } from '../logger';

export interface OtlpExporterConfig {
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  /**
   * Hard cap on buffered (not-yet-exported) spans. When the collector is down
   * and flushes keep failing, `pending` would otherwise grow unbounded
   * (#569). Once this cap is exceeded, the oldest spans are dropped and counted
   * in `droppedCount`. Defaults to `maxBatchSize * 50`.
   */
  maxPending?: number;
  fetch?: typeof fetch;
}

interface OtlpKeyValue {
  key: string;
  value: { stringValue?: string; intValue?: string; boolValue?: boolean; doubleValue?: number };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events: Array<{ timeUnixNano: string; name: string; attributes: OtlpKeyValue[] }>;
  status?: { code: number; message?: string };
}

interface OtlpResourceSpans {
  resource: { attributes: OtlpKeyValue[] };
  scopeSpans: Array<{
    scope: { name: string; version?: string };
    spans: OtlpSpan[];
  }>;
}

function toAttr(key: string, value: unknown): OtlpKeyValue {
  if (typeof value === 'string') return { key, value: { stringValue: value } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  if (value === null || value === undefined) return { key, value: { stringValue: '' } };
  return { key, value: { stringValue: String(value) } };
}

function attrsFromObject(obj: Record<string, unknown>): OtlpKeyValue[] {
  return Object.entries(obj).map(([k, v]) => toAttr(k, v));
}

function msToNano(ms: number): string {
  return String(BigInt(ms) * BigInt(1_000_000));
}

export function spanToOtlp(span: TraceContext): OtlpSpan {
  const startNs = msToNano(span.startTime);
  const durationMs =
    typeof span.tags.duration_ms === 'number' ? span.tags.duration_ms : 0;
  const endNs = msToNano(span.startTime + durationMs);

  const hasFailure = span.events.some((e) => e.name === 'stage_failure' || e.name === 'exception');

  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.operation,
    startTimeUnixNano: startNs,
    endTimeUnixNano: endNs,
    attributes: attrsFromObject(span.tags as Record<string, unknown>),
    events: span.events.map((e) => ({
      timeUnixNano: msToNano(e.timestamp),
      name: e.name,
      attributes: attrsFromObject(e.attributes),
    })),
    status: hasFailure ? { code: 2, message: 'failure' } : { code: 1 },
  };
}

export class OtlpExporter {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly serviceName: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxPending: number;
  private readonly fetchImpl: typeof fetch;
  private timer?: ReturnType<typeof setInterval>;
  private pending: TraceContext[] = [];
  private exportedCount = 0;
  private failedCount = 0;
  private droppedCount = 0;
  private requeuedCount = 0;
  private lastFailure?: { ts: number; message: string };

  constructor(config: OtlpExporterConfig) {
    if (!config.endpoint) throw new Error('OtlpExporter: endpoint required');
    this.endpoint = config.endpoint.replace(/\/+$/, '') + '/v1/traces';
    this.headers = config.headers ?? {};
    this.serviceName = config.serviceName ?? 'ai-gateway';
    this.flushIntervalMs = config.flushIntervalMs ?? 5_000;
    this.maxBatchSize = config.maxBatchSize ?? 200;
    this.maxPending = config.maxPending ?? this.maxBatchSize * 50;
    this.fetchImpl = config.fetch ?? fetch;
  }

  /** Buffer a single span. Span must have `tags.duration_ms` set (call after endSpan). */
  enqueue(span: TraceContext): void {
    this.pending.push(span);
    // #569: bound the buffer. If the collector is down, flushes only drain
    // `maxBatchSize` per tick while new spans pile up — without this cap the
    // process would OOM. Drop the oldest excess (closest to retention loss
    // anyway) and count it so the gap is observable in `stats()`.
    this.trimPending();
    if (this.pending.length >= this.maxBatchSize) {
      void this.flush();
    }
  }

  /** Drop oldest spans beyond `maxPending`, counting them in `droppedCount`. */
  private trimPending(): void {
    if (this.pending.length <= this.maxPending) return;
    const overflow = this.pending.length - this.maxPending;
    this.pending.splice(0, overflow);
    this.droppedCount += overflow;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async flush(): Promise<{ exported: number; failed: number }> {
    if (this.pending.length === 0) return { exported: 0, failed: 0 };
    // #568: copy-then-confirm. We must NOT remove spans from `pending` before
    // we know the POST succeeded — if JSON.stringify/fetch throws, splicing
    // first would make the batch unrecoverable. Take a non-destructive view,
    // and only drop the head once the collector ACKs (2xx).
    const batch = this.pending.slice(0, this.maxBatchSize);
    let payload: { resourceSpans: OtlpResourceSpans[] };
    let body: string;
    try {
      payload = this.buildPayload(batch);
      body = JSON.stringify(payload);
    } catch (err) {
      // Serialization itself failed — this batch is poison and will never
      // succeed, so drop it (DLQ) rather than retry-looping forever.
      this.pending.splice(0, batch.length);
      this.failedCount += batch.length;
      this.lastFailure = {
        ts: Date.now(),
        message: `serialize: ${err instanceof Error ? err.message : String(err)}`,
      };
      log.warn({ err: this.lastFailure.message, count: batch.length }, '[otlp] serialize failed');
      return { exported: 0, failed: batch.length };
    }

    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers },
        body,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.lastFailure = { ts: Date.now(), message: `HTTP ${res.status}: ${text.slice(0, 200)}` };
        // #567: 5xx/429 are transient — keep the batch in `pending` for the
        // next flush (bounded re-queue). 4xx means the collector rejected the
        // payload; retrying is futile, so drop it.
        // `failedCount` counts every failed flush span (back-compat);
        // `requeuedCount` additionally tracks the subset kept for retry.
        if (this.isRetryable(res.status)) {
          this.failedCount += batch.length;
          this.requeuedCount += batch.length;
          log.warn({ status: res.status, count: batch.length }, '[otlp] export failed, will retry');
          return { exported: 0, failed: batch.length };
        }
        this.pending.splice(0, batch.length);
        this.failedCount += batch.length;
        log.warn({ status: res.status, count: batch.length }, '[otlp] export rejected, dropped');
        return { exported: 0, failed: batch.length };
      }
      // Success — now (and only now) remove the confirmed spans.
      this.pending.splice(0, batch.length);
      this.exportedCount += batch.length;
      return { exported: batch.length, failed: 0 };
    } catch (err) {
      // Network error — transient. Leave the batch queued for retry; trim in
      // case new spans accrued past the cap while we were awaiting.
      this.failedCount += batch.length;
      this.requeuedCount += batch.length;
      this.lastFailure = {
        ts: Date.now(),
        message: err instanceof Error ? err.message : String(err),
      };
      this.trimPending();
      log.warn({ err: this.lastFailure.message, count: batch.length }, '[otlp] export error, will retry');
      return { exported: 0, failed: batch.length };
    }
  }

  /** 5xx and 429 are transient and worth retrying; other statuses are not. */
  private isRetryable(status: number): boolean {
    return status === 429 || status >= 500;
  }

  buildPayload(spans: TraceContext[]): { resourceSpans: OtlpResourceSpans[] } {
    const resourceSpans: OtlpResourceSpans = {
      resource: {
        attributes: [
          toAttr('service.name', this.serviceName),
          toAttr('telemetry.sdk.name', 'ai-gateway'),
          toAttr('telemetry.sdk.language', 'nodejs'),
        ],
      },
      scopeSpans: [
        {
          scope: { name: 'ai-gateway/distributed-tracer' },
          spans: spans.map(spanToOtlp),
        },
      ],
    };
    return { resourceSpans: [resourceSpans] };
  }

  stats(): {
    pending: number;
    exported: number;
    failed: number;
    dropped: number;
    requeued: number;
    endpoint: string;
    lastFailure?: { ts: number; message: string };
  } {
    return {
      pending: this.pending.length,
      exported: this.exportedCount,
      failed: this.failedCount,
      dropped: this.droppedCount,
      requeued: this.requeuedCount,
      endpoint: this.endpoint,
      lastFailure: this.lastFailure,
    };
  }
}

/**
 * #575: validate that an OTLP endpoint is a well-formed http(s) URL. A typo'd
 * endpoint (missing scheme, bare host) would otherwise start the exporter and
 * make every flush fail forever; reject it loudly at init instead.
 */
export function isValidHttpUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === 'http:' || u.protocol === 'https:';
}

/** Parse comma-separated `k=v,k2=v2` header string from OTEL_EXPORTER_OTLP_HEADERS. */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

let globalExporter: OtlpExporter | null = null;

/** Initialize from env. Returns null if endpoint not set. Idempotent. */
export function initOtlpFromEnv(env: NodeJS.ProcessEnv = process.env): OtlpExporter | null {
  if (globalExporter) return globalExporter;
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return null;
  // #575: a malformed endpoint is worse than none — the exporter would start
  // and silently fail every flush. Refuse to start and log loudly so the
  // misconfiguration is visible at boot.
  if (!isValidHttpUrl(endpoint)) {
    log.warn({ endpoint }, '[otlp] invalid OTEL_EXPORTER_OTLP_ENDPOINT (not an http/https URL); exporter disabled');
    return null;
  }
  const headers = parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);
  const serviceName = env.OTEL_SERVICE_NAME ?? 'ai-gateway';
  const flushIntervalMs = env.OTEL_EXPORTER_FLUSH_MS
    ? Number(env.OTEL_EXPORTER_FLUSH_MS)
    : undefined;
  const maxBatchSize = env.OTEL_EXPORTER_BATCH_MAX
    ? Number(env.OTEL_EXPORTER_BATCH_MAX)
    : undefined;

  globalExporter = new OtlpExporter({
    endpoint,
    headers,
    serviceName,
    flushIntervalMs,
    maxBatchSize,
  });
  globalExporter.start();
  log.log({ endpoint, serviceName }, '[otlp] exporter started');
  return globalExporter;
}

export function getOtlpExporter(): OtlpExporter | null {
  return globalExporter;
}

const ATTACHED_FLAG = '__otlpAttached' as const;

/**
 * Wire DistributedTracer.endSpan to auto-enqueue completed spans.
 *
 * Idempotent: re-wrapping `endSpan` on every call would stack wrappers and
 * enqueue each span N times (memory + duplicate-span bloat at the collector).
 * We tag the patched function and no-op if it's already attached.
 */
export function attachExporterToTracer(exporter: OtlpExporter): void {
  const current = globalTracer.endSpan as typeof globalTracer.endSpan & {
    [ATTACHED_FLAG]?: boolean;
  };
  if (current[ATTACHED_FLAG]) return;
  const original = globalTracer.endSpan.bind(globalTracer);
  const wrapped = ((spanId: string): TraceContext | null => {
    const span = original(spanId);
    if (span) exporter.enqueue(span);
    return span;
  }) as typeof globalTracer.endSpan & { [ATTACHED_FLAG]?: boolean };
  wrapped[ATTACHED_FLAG] = true;
  globalTracer.endSpan = wrapped;
}

export function _resetOtlpForTests(): void {
  if (globalExporter) globalExporter.stop();
  globalExporter = null;
}
