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
  private readonly fetchImpl: typeof fetch;
  private timer?: ReturnType<typeof setInterval>;
  private pending: TraceContext[] = [];
  private exportedCount = 0;
  private failedCount = 0;
  private lastFailure?: { ts: number; message: string };

  constructor(config: OtlpExporterConfig) {
    if (!config.endpoint) throw new Error('OtlpExporter: endpoint required');
    this.endpoint = config.endpoint.replace(/\/+$/, '') + '/v1/traces';
    this.headers = config.headers ?? {};
    this.serviceName = config.serviceName ?? 'ai-gateway';
    this.flushIntervalMs = config.flushIntervalMs ?? 5_000;
    this.maxBatchSize = config.maxBatchSize ?? 200;
    this.fetchImpl = config.fetch ?? fetch;
  }

  /** Buffer a single span. Span must have `tags.duration_ms` set (call after endSpan). */
  enqueue(span: TraceContext): void {
    this.pending.push(span);
    if (this.pending.length >= this.maxBatchSize) {
      void this.flush();
    }
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
    const batch = this.pending.splice(0, this.maxBatchSize);
    const payload = this.buildPayload(batch);

    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.failedCount += batch.length;
        this.lastFailure = { ts: Date.now(), message: `HTTP ${res.status}: ${body.slice(0, 200)}` };
        log.warn({ status: res.status, count: batch.length }, '[otlp] export failed');
        return { exported: 0, failed: batch.length };
      }
      this.exportedCount += batch.length;
      return { exported: batch.length, failed: 0 };
    } catch (err) {
      this.failedCount += batch.length;
      this.lastFailure = {
        ts: Date.now(),
        message: err instanceof Error ? err.message : String(err),
      };
      log.warn({ err: this.lastFailure.message, count: batch.length }, '[otlp] export error');
      return { exported: 0, failed: batch.length };
    }
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
    endpoint: string;
    lastFailure?: { ts: number; message: string };
  } {
    return {
      pending: this.pending.length,
      exported: this.exportedCount,
      failed: this.failedCount,
      endpoint: this.endpoint,
      lastFailure: this.lastFailure,
    };
  }
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

/** Wire DistributedTracer.endSpan to auto-enqueue completed spans. */
export function attachExporterToTracer(exporter: OtlpExporter): void {
  const original = globalTracer.endSpan.bind(globalTracer);
  globalTracer.endSpan = (spanId: string): TraceContext | null => {
    const span = original(spanId);
    if (span) exporter.enqueue(span);
    return span;
  };
}

export function _resetOtlpForTests(): void {
  if (globalExporter) globalExporter.stop();
  globalExporter = null;
}
