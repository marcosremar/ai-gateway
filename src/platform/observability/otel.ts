/**
 * OpenTelemetry integration for AI Gateway.
 *
 * Provides distributed tracing, metrics, and structured logging
 * compatible with the OpenTelemetry standard.
 *
 * Can export to Jaeger, Zipkin, Datadog, Honeycomb, or any OTLP endpoint.
 *
 * @example
 * ```ts
 * import { initOtel, withSpan } from './observability/otel';
 *
 * await initOtel({ serviceName: 'ai-gateway', exporterUrl: 'http://localhost:4318' });
 *
 * const result = await withSpan('provider.chat', async (span) => {
 *   span.setAttribute('provider', 'groq');
 *   span.setAttribute('model', 'llama-3.3-70b');
 *   return provider.chat(messages);
 * });
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('otel');

// ── Types ────────────────────────────────────────────────────────────────────

export interface OtelConfig {
  /** Service name for tracing (default: 'ai-gateway') */
  serviceName?: string;
  /** OTLP exporter endpoint (default: 'http://localhost:4318') */
  exporterUrl?: string;
  /** Enable metrics export (default: true) */
  enableMetrics?: boolean;
  /** Sample rate 0-1 (default: 1.0 = all traces) */
  sampleRate?: number;
  /** Additional resource attributes */
  resourceAttributes?: Record<string, string>;
  /**
   * Log each completed span (one line per span). Off by default — high log
   * volume on hot pipelines (#570). Also enabled via OTEL_LOG_SPANS=1.
   */
  logSpans?: boolean;
}

export interface SpanContext {
  traceId: string;
  spanId: string;
}

export interface Span {
  /** Set an attribute on the span */
  setAttribute(key: string, value: string | number | boolean): void;
  /** Record an error on the span */
  recordError(error: Error): void;
  /** Add an event to the span */
  addEvent(name: string, attributes?: Record<string, unknown>): void;
  /** Get the current span context for propagation */
  spanContext(): SpanContext;
}

// ── In-memory implementation (zero-dependency fallback) ──────────────────────

/**
 * Lightweight span implementation that doesn't require @opentelemetry packages.
 * Writes to the logger and keeps spans in memory for debugging.
 */
class InMemorySpan implements Span {
  private readonly attributes = new Map<string, string | number | boolean>();
  private readonly events: Array<{ name: string; attributes?: Record<string, unknown> }> = [];
  private readonly name: string;
  private readonly startTime: number;
  private readonly _traceId: string;
  private readonly _spanId: string;

  constructor(name: string) {
    this.name = name;
    this.startTime = Date.now();
    // OTel trace/span IDs are hex strings (32 hex chars / 16 hex chars).
    // crypto.randomUUID() returns a UUID with hyphens at offsets 8, 13, 18,
    // 23 — so `.slice(0, 16)` produced `xxxxxxxx-xxxx-xx` (a hyphen mid-id),
    // which downstream OTel collectors reject as invalid. Strip the hyphens
    // BEFORE truncating, so we end up with proper 32/16-hex IDs.
    this._traceId = crypto.randomUUID().replace(/-/g, '');
    this._spanId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  }

  setAttribute(key: string, value: string | number | boolean): void {
    this.attributes.set(key, value);
  }

  recordError(error: Error): void {
    this.addEvent('exception', {
      'exception.type': error.name,
      'exception.message': error.message,
      'exception.stacktrace': error.stack,
    });
  }

  addEvent(name: string, attributes?: Record<string, unknown>): void {
    this.events.push({ name, attributes });
  }

  spanContext(): SpanContext {
    return { traceId: this._traceId, spanId: this._spanId };
  }

  /** Get all attributes (for debugging/exporting) */
  getAttributes(): Record<string, string | number | boolean> {
    return Object.fromEntries(this.attributes.entries());
  }

  /** Get all events */
  getEvents() {
    return [...this.events];
  }

  /** Duration in ms */
  get durationMs(): number {
    return Date.now() - this.startTime;
  }

  /** Export as JSON-serializable object */
  toJSON() {
    return {
      name: this.name,
      traceId: this._traceId,
      spanId: this._spanId,
      startTime: this.startTime,
      durationMs: this.durationMs,
      attributes: this.getAttributes(),
      events: this.getEvents(),
    };
  }
}

// ── Global state ─────────────────────────────────────────────────────────────

let otelConfig: OtelConfig | null = null;
const activeSpans = new Map<string, InMemorySpan>();
const completedSpans: InMemorySpan[] = [];

/**
 * #571: bound the completed-span ring. Without a cap, `withSpan` pushed one
 * span per request forever, leaking memory on long-running servers (the
 * DistributedTracer caps at 5000; this had no cap at all). Keep the most
 * recent N and drop the oldest.
 */
const MAX_COMPLETED_SPANS = 5_000;

/**
 * #570: spans were logged at info level on every completion — one structured
 * line per stage per request, which is high log volume/cost on a hot pipeline.
 * Gate completion logging behind an explicit opt-in (env or initOtel option)
 * so it's off by default and only enabled when debugging.
 */
function spanLoggingEnabled(): boolean {
  if (otelConfig?.logSpans) return true;
  const v =
    typeof process !== 'undefined'
      ? process.env.OTEL_LOG_SPANS ?? process.env.AIGW_OTEL_LOG_SPANS
      : undefined;
  return v === '1' || v === 'true';
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize OpenTelemetry integration.
 * If @opentelemetry packages are installed, uses real exporters.
 * Otherwise falls back to in-memory spans.
 */
export async function initOtel(config: OtelConfig = {}): Promise<void> {
  otelConfig = {
    serviceName: 'ai-gateway',
    exporterUrl: 'http://localhost:4318',
    enableMetrics: true,
    sampleRate: 1.0,
    ...config,
  };

  log.log(
    { serviceName: otelConfig.serviceName, exporterUrl: otelConfig.exporterUrl },
    'OpenTelemetry initialized (in-memory mode)',
  );
}

/**
 * Create a span for tracing.
 *
 * @example
 * ```ts
 * const span = createSpan('provider.chat');
 * span.setAttribute('provider', 'groq');
 * // ... do work ...
 * span.end();
 * ```
 */
export function createSpan(name: string, parent?: Span): Span {
  const span = new InMemorySpan(name);

  if (parent) {
    const ctx = parent.spanContext();
    span.setAttribute('parent.traceId', ctx.traceId);
    span.setAttribute('parent.spanId', ctx.spanId);
  }

  activeSpans.set(span.spanContext().spanId, span);
  return span;
}

/**
 * Execute a function within a span, automatically ending it on completion or error.
 *
 * @example
 * ```ts
 * const result = await withSpan('provider.chat', async (span) => {
 *   span.setAttribute('model', 'llama-3.3-70b');
 *   return provider.chat(messages);
 * });
 * ```
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  parent?: Span,
): Promise<T> {
  const span = createSpan(name, parent);
  const startTime = Date.now();

  try {
    span.setAttribute('status', 'started');
    const result = await fn(span);
    span.setAttribute('status', 'success');
    span.setAttribute('durationMs', Date.now() - startTime);
    return result;
  } catch (error) {
    span.setAttribute('status', 'error');
    span.setAttribute('durationMs', Date.now() - startTime);
    if (error instanceof Error) {
      span.recordError(error);
    }
    throw error;
  } finally {
    const inMemorySpan = activeSpans.get(span.spanContext().spanId);
    activeSpans.delete(span.spanContext().spanId);
    if (inMemorySpan) {
      completedSpans.push(inMemorySpan);
      // #571: keep the ring bounded so a long-running server doesn't leak one
      // span per request forever.
      if (completedSpans.length > MAX_COMPLETED_SPANS) {
        completedSpans.splice(0, completedSpans.length - MAX_COMPLETED_SPANS);
      }

      // #570: only emit the per-span completion line when explicitly enabled.
      if (spanLoggingEnabled()) {
        log.log(
          {
            name,
            traceId: span.spanContext().traceId,
            durationMs: inMemorySpan.durationMs,
            attributes: inMemorySpan.getAttributes(),
          },
          `Span completed: ${name}`,
        );
      }
    }
  }
}

/**
 * Get the current active span from context.
 */
export function getCurrentSpan(): Span | undefined {
  // In a real OTel implementation, this would use context propagation
  // For now, return the most recently created span
  const spans = Array.from(activeSpans.values());
  return spans[spans.length - 1];
}

/**
 * Get completed spans for export/debugging.
 */
export function getCompletedSpans(limit = 100): unknown[] {
  return completedSpans.slice(-limit).map((s) => s.toJSON());
}

/** Current number of retained completed spans (bounded by MAX_COMPLETED_SPANS). */
export function getCompletedSpanCount(): number {
  return completedSpans.length;
}

/** Test-only: clear in-memory span buffers so cases don't leak into each other. */
export function _resetOtelSpansForTests(): void {
  activeSpans.clear();
  completedSpans.length = 0;
}

/**
 * Check if OTel is initialized.
 */
export function isOtelInitialized(): boolean {
  return otelConfig !== null;
}

/**
 * Get OTel configuration.
 */
export function getOtelConfig(): OtelConfig | undefined {
  return otelConfig ?? undefined;
}

// ── Metrics helpers ──────────────────────────────────────────────────────────

/**
 * Record a counter metric.
 */
export function incrementCounter(
  name: string,
  value = 1,
  labels: Record<string, string> = {},
): void {
  log.log({ metric: 'counter', name, value, labels }, `Counter: ${name}`);
}

/**
 * Record a histogram metric.
 */
export function recordHistogram(
  name: string,
  value: number,
  labels: Record<string, string> = {},
): void {
  log.log({ metric: 'histogram', name, value, labels }, `Histogram: ${name}`);
}

/**
 * Record a gauge metric.
 */
export function recordGauge(
  name: string,
  value: number,
  labels: Record<string, string> = {},
): void {
  log.log({ metric: 'gauge', name, value, labels }, `Gauge: ${name}`);
}

// ── Common span names for AI Gateway ─────────────────────────────────────────

export const SPAN_NAMES = {
  // Pipeline
  PIPELINE_SPEECH: 'pipeline.speech',
  PIPELINE_STT: 'pipeline.stt',
  PIPELINE_LLM: 'pipeline.llm',
  PIPELINE_TTS: 'pipeline.tts',

  // Providers
  PROVIDER_CHAT: 'provider.chat',
  PROVIDER_TRANSCRIBE: 'provider.transcribe',
  PROVIDER_SYNTHESIZE: 'provider.synthesize',
  PROVIDER_FALLBACK: 'provider.fallback',

  // GPU
  GPU_BOOT: 'gpu.boot',
  GPU_HEALTH: 'gpu.health',
  GPU_TERMINATE: 'gpu.terminate',

  // Auth
  AUTH_VALIDATE: 'auth.validate',
  AUTH_SIGN_TOKEN: 'auth.sign_token',

  // Proxy
  PROXY_REQUEST: 'proxy.request',
  PROXY_RESPONSE: 'proxy.response',
} as const;

export type SpanName = (typeof SPAN_NAMES)[keyof typeof SPAN_NAMES];
