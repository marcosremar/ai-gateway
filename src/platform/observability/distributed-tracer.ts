/**
 * Distributed Tracing for AI Gateway pipelines.
 *
 * Tracks pipeline stages, latencies, and provider decisions
 * with OpenTelemetry-style spans and metrics.
 * Automatically redacts sensitive fields in logs and traces.
 */

import { randomBytes, createHash } from 'crypto';
import type { TraceContext, PipelineMetrics } from './types';
import { defaultLogger as log } from '../logger';

const SENSITIVE_KEYS = new Set([
  'apiKey', 'secret', 'token', 'password', 'credential',
  'authorization', 'bearer', 'accessToken', 'refreshToken',
  'privateKey', 'hfToken', 'authId',
]);

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.has(lower) || lower.includes('secret') || lower.includes('key');
}

function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === 'string') return '[redacted]';
  
  const result: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      result[key] = '[redacted]';
    } else if (typeof v === 'object' && v !== null) {
      result[key] = redactValue(v);
    } else {
      result[key] = v;
    }
  }
  return result;
}

export class DistributedTracer {
  /** Bounded ring of spans to prevent unbounded memory growth on long-running
   * processes that emit thousands of pipeline traces. */
  private static readonly MAX_RETAINED_SPANS = 5_000;
  private spans = new Map<string, TraceContext>();

  generateTraceId(): string {
    return randomBytes(16).toString('hex');
  }

  generateSpanId(): string {
    return randomBytes(8).toString('hex');
  }

  startSpan(operation: string, parentSpanId?: string): TraceContext {
    // Child spans MUST share the parent's traceId so logs/queries that group
    // by traceId reconstruct the full pipeline. Generating a fresh traceId
    // for every stage made every span look like its own root trace.
    const parent = parentSpanId ? this.spans.get(parentSpanId) : undefined;
    const span: TraceContext = {
      traceId: parent?.traceId ?? this.generateTraceId(),
      spanId: this.generateSpanId(),
      parentSpanId,
      operation,
      startTime: Date.now(),
      tags: {},
      events: []
    };

    this.spans.set(span.spanId, span);
    // Cap the retained span count once we exceed the limit.
    //
    // #566: a naive oldest-first (FIFO) eviction can drop a long-running PARENT
    // span (inserted first) while its child stage spans are still arriving,
    // orphaning the children. Prefer evicting the oldest *ended* span (one with
    // `duration_ms` set, i.e. endSpan() was called); only if every retained
    // span is still open do we fall back to plain FIFO to keep the bound hard.
    if (this.spans.size > DistributedTracer.MAX_RETAINED_SPANS) {
      let victim: string | undefined;
      for (const [id, s] of this.spans) {
        if (s.spanId === span.spanId) continue; // never evict the one we just added
        if (s.tags.duration_ms !== undefined) { victim = id; break; }
      }
      if (victim === undefined) {
        const oldest = this.spans.keys().next();
        if (!oldest.done) victim = oldest.value;
      }
      if (victim !== undefined) this.spans.delete(victim);
    }
    return span;
  }

  addTag(spanId: string, key: string, value: unknown): void {
    const span = this.spans.get(spanId);
    if (span) {
      span.tags[key] = isSensitiveKey(key) ? '[redacted]' : value;
    }
  }

  addEvent(spanId: string, name: string, attributes: Record<string, unknown> = {}): void {
    const span = this.spans.get(spanId);
    if (span) {
      const safeAttrs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(attributes)) {
        safeAttrs[k] = isSensitiveKey(k) ? '[redacted]' : v;
      }
      span.events.push({
        timestamp: Date.now(),
        name,
        attributes: safeAttrs
      });
    }
  }

  endSpan(spanId: string): TraceContext | null {
    const span = this.spans.get(spanId);
    if (!span) return null;

    span.tags.duration_ms = Date.now() - span.startTime;
    return span;
  }

  // Pipeline-specific tracing
  tracePipeline(metrics: PipelineMetrics): TraceContext {
    const span = this.startSpan(`${metrics.pipeline}_pipeline`);
    if (metrics.ttfcMs !== undefined) {
      span.ttfcMs = metrics.ttfcMs;
    }

    this.addTag(span.spanId, 'pipeline.type', metrics.pipeline);
    this.addTag(span.spanId, 'request.id', metrics.requestId);
    this.addTag(span.spanId, 'total.latency_ms', metrics.totalLatencyMs);
    this.addTag(span.spanId, 'ttfc_ms', metrics.ttfcMs || null);
    this.addTag(span.spanId, 'routing.decision', metrics.routing.decision);
    this.addTag(span.spanId, 'routing.confidence', metrics.routing.confidence);
    this.addTag(span.spanId, 'routing.cost_estimate', metrics.routing.costEstimate);
    this.addTag(span.spanId, 'input.audio_bytes', metrics.input.audioBytes);
    this.addTag(span.spanId, 'input.duration_sec', metrics.input.estimatedDurationSec);
    this.addTag(span.spanId, 'output.transcription_length', metrics.output.transcriptionLength);
    this.addTag(span.spanId, 'output.response_length', metrics.output.responseLength);
    if (metrics.output.audioBytes) {
      this.addTag(span.spanId, 'output.audio_bytes', metrics.output.audioBytes);
    }

    // Stage tracing
    for (const [stageName, stageData] of Object.entries(metrics.stages)) {
      if (stageData) {
        const stageSpan = this.startSpan(`${stageName}_stage`, span.spanId);
        this.addTag(stageSpan.spanId, 'stage.name', stageName);
        this.addTag(stageSpan.spanId, 'stage.latency_ms', stageData.latencyMs);
        this.addTag(stageSpan.spanId, 'stage.provider', stageData.provider);
        this.addTag(stageSpan.spanId, 'stage.success', stageData.success);

        // #565: per-trace cost attribution — stamp token counts and cost on the
        // stage span when the caller supplied them so Tempo/Jaeger can break
        // cost down by stage/provider. Skipped when undefined (back-compat).
        if (stageData.inputTokens !== undefined) {
          this.addTag(stageSpan.spanId, 'stage.input_tokens', stageData.inputTokens);
        }
        if (stageData.outputTokens !== undefined) {
          this.addTag(stageSpan.spanId, 'stage.output_tokens', stageData.outputTokens);
        }
        if (stageData.costUsd !== undefined) {
          this.addTag(stageSpan.spanId, 'stage.cost_usd', stageData.costUsd);
        }

        if (!stageData.success) {
          this.addEvent(stageSpan.spanId, 'stage_failure', {
            stage: stageName,
            provider: stageData.provider,
            latency_ms: stageData.latencyMs
          });
        }

        this.endSpan(stageSpan.spanId);
      }
    }

    // #565: roll the per-stage costs up onto the parent so the whole-pipeline
    // cost is queryable on the root span (not only the routing estimate).
    const stageCosts = Object.values(metrics.stages)
      .filter((s): s is NonNullable<typeof s> => !!s && typeof s.costUsd === 'number')
      .map((s) => s.costUsd as number);
    if (stageCosts.length > 0) {
      this.addTag(span.spanId, 'cost.stages_usd', stageCosts.reduce((a, b) => a + b, 0));
    }

    // Routing decision event
    this.addEvent(span.spanId, 'routing_decision', {
      decision: metrics.routing.decision,
      confidence: metrics.routing.confidence,
      reason: metrics.routing.reason,
      cost_estimate: metrics.routing.costEstimate
    });

    this.endSpan(span.spanId);
    return span;
  }

  // Performance analytics
  analyzeBottlenecks(sinceMs: number): {
    slowestStage: string;
    slowestProvider: string;
    averageLatencyMs: number;
    p95LatencyMs: number;
    failureRate: number;
  } {
    // An *ended* span has a defined `duration_ms` (endSpan sets it) — including
    // a legitimate 0 for fast/synchronous spans. The previous truthy check
    // (`span.tags.duration_ms`) dropped every 0ms span, which on a fast pipeline
    // is most of them, so `analyzeBottlenecks` returned 'none' even with data.
    const recentSpans = Array.from(this.spans.values())
      .filter(span => span.tags.duration_ms !== undefined && (Date.now() - span.startTime) < sinceMs);

    if (recentSpans.length === 0) {
      return {
        slowestStage: 'none',
        slowestProvider: 'none',
        averageLatencyMs: 0,
        p95LatencyMs: 0,
        failureRate: 0
      };
    }

    const latencies = recentSpans.map(span => span.tags.duration_ms as number);
    latencies.sort((a, b) => a - b);

    // P95 = the value at rank ceil(N*0.95)-1 (0-indexed). Using Math.floor
    // collapses to the max for small N (e.g. floor(20*0.95)=19 → last element).
    const p95Index = Math.max(0, Math.ceil(latencies.length * 0.95) - 1);
    const p95Latency = latencies[p95Index] || latencies[latencies.length - 1];

    const totalRequests = recentSpans.length;
    const failedRequests = recentSpans.filter(span =>
      span.events.some(event => event.name === 'stage_failure')
    ).length;

    // #512: derive the slowest stage/provider from the recent stage spans
    // instead of returning hardcoded 'pipeline'/'gpu' literals. We average the
    // observed stage latency per `stage.name` and per `stage.provider` tag and
    // pick the max; callers can finally trust these fields.
    const stageLatencies = new Map<string, { sum: number; n: number }>();
    const providerLatencies = new Map<string, { sum: number; n: number }>();
    for (const sp of recentSpans) {
      const stageName = sp.tags['stage.name'];
      const stageLatency = sp.tags['stage.latency_ms'];
      const provider = sp.tags['stage.provider'];
      if (typeof stageName === 'string' && typeof stageLatency === 'number') {
        const e = stageLatencies.get(stageName) ?? { sum: 0, n: 0 };
        e.sum += stageLatency; e.n += 1;
        stageLatencies.set(stageName, e);
      }
      if (typeof provider === 'string' && typeof stageLatency === 'number') {
        const e = providerLatencies.get(provider) ?? { sum: 0, n: 0 };
        e.sum += stageLatency; e.n += 1;
        providerLatencies.set(provider, e);
      }
    }
    const pickSlowest = (m: Map<string, { sum: number; n: number }>): string => {
      let best = 'none';
      let bestAvg = -1;
      for (const [k, { sum, n }] of m) {
        const avg = sum / n;
        if (avg > bestAvg) { bestAvg = avg; best = k; }
      }
      return best;
    };
    const slowestStage = pickSlowest(stageLatencies);
    const slowestProvider = pickSlowest(providerLatencies);

    return {
      slowestStage,
      slowestProvider,
      averageLatencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      p95LatencyMs: p95Latency,
      failureRate: failedRequests / totalRequests
    };
  }

  // Realtime audio experience analysis
  getRealtimeMetrics(windowMs: number = 300_000 /* 5 min */): {
    ttfcP50: number;
    ttfcP95: number;
    ttfaP50: number;
    ttfaP95: number;
    coldStartRate: number;
    userExperienceScore: number; // 0-100, lower is better
    audioExperienceScore: number; // 0-100 for TTFA experience
  } {
    const cutoff = Date.now() - windowMs;
    const recentSpans = Array.from(this.spans.values())
      .filter(span => span.startTime > cutoff && (span.ttfcMs !== undefined || span.ttfaMs !== undefined));

    if (recentSpans.length < 3) {
      return {
        ttfcP50: 0,
        ttfcP95: 0,
        ttfaP50: 0,
        ttfaP95: 0,
        coldStartRate: 0,
        userExperienceScore: 100,
        audioExperienceScore: 100
      };
    }

    // TTFC calculations (Time To First Content)
    const ttfcValues = recentSpans.map(span => span.ttfcMs).filter((val): val is number => val !== undefined).sort((a, b) => a - b);
    const p50Ttfc = ttfcValues.length > 0 ? ttfcValues[Math.max(0, Math.ceil(ttfcValues.length * 0.5) - 1)] : 0;
    const p95Ttfc = ttfcValues.length > 0 ? ttfcValues[Math.max(0, Math.ceil(ttfcValues.length * 0.95) - 1)] : 0;

    // TTFA calculations (Time To First Audio)
    const ttfaValues = recentSpans.map(span => span.ttfaMs).filter((val): val is number => val !== undefined).sort((a, b) => a - b);
    const p50Ttfa = ttfaValues.length > 0 ? ttfaValues[Math.max(0, Math.ceil(ttfaValues.length * 0.5) - 1)] : 0;
    const p95Ttfa = ttfaValues.length > 0 ? ttfaValues[Math.max(0, Math.ceil(ttfaValues.length * 0.95) - 1)] : 0;

    // Cold start rate: TTFC > 500ms OR no TTFA
    const coldStarts = (ttfcValues.filter(ttfc => ttfc > 500).length +
                       recentSpans.filter(span => !span.ttfaMs).length);
    const coldStartRate = coldStarts / recentSpans.length;

    // User experience score: based on TTFA P95 (target <500ms = 100pts, >2000ms = 0pts)
    const idealTtfa = 500; // ms for first audio
    const acceptableTtfa = 2000; // ms
    let audioScore = 100;
    if (p95Ttfa > idealTtfa) {
      audioScore = Math.max(0, 100 - ((p95Ttfa - idealTtfa) / (acceptableTtfa - idealTtfa)) * 100);
    }

    // TTFC experience score (text feedback)
    const idealTtfc = 300; // ms for first text
    const acceptableTtfcText = 1000; // ms
    let textScore = 100;
    if (p95Ttfc > idealTtfc) {
      textScore = Math.max(0, 100 - ((p95Ttfc - idealTtfc) / (acceptableTtfcText - idealTtfc)) * 100);
    }

    const userExperienceScore = Math.min(audioScore, textScore);

    return {
      ttfcP50: p50Ttfc,
      ttfcP95: p95Ttfc,
      ttfaP50: p50Ttfa,
      ttfaP95: p95Ttfa,
      coldStartRate,
      userExperienceScore: Math.round(userExperienceScore * 100) / 100,
      audioExperienceScore: Math.round(audioScore * 100) / 100
    };
  }

  // Benchmark automation
  //
  // #521: the benchmark uses `simulateRequestLatency()` (random numbers). By
  // default these synthetic samples are NOT persisted as `benchmark_request`
  // spans, because doing so polluted `analyzeBottlenecks`/`getRealtimeMetrics`
  // (which read the same ring) with fabricated data. Pass
  // `{ persistSpans: true }` only for explicit benchmarking sessions.
  async runRealtimeBenchmark(
    requestCount: number = 10,
    intervalMs: number = 2000,
    opts: { persistSpans?: boolean } = {},
  ): Promise<{
    ttfcStats: { min: number, max: number, avg: number, p95: number };
    reliability: number; // success rate 0-1
    throughput: number;   // req/sec
    analysis: string;
  }> {
    const results: number[] = [];
    const startTime = Date.now();
    let successCount = 0;

    log.log(`[tracer] Starting realtime benchmark: ${requestCount} requests, ${intervalMs}ms intervals`);

    for (let i = 0; i < requestCount; i++) {
      try {
        // Wait for warmup between requests
        if (i > 0) await new Promise(resolve => setTimeout(resolve, intervalMs));

        const benchmarkStart = Date.now();

        // Trigger a synthetic request (would need real endpoint in implementation)
        // For now, simulate with random TTFC values based on current system state
        const simulatedTtfc = this.simulateRequestLatency();

        results.push(simulatedTtfc);
        successCount++;

        const ttfc = Date.now() - benchmarkStart;
        log.log(`[tracer] Request ${i+1}/${requestCount}: TTFC=${ttfc}ms`);

        // #521: only store synthetic spans in the production ring when the
        // caller explicitly opts in, so default benchmark runs can't skew the
        // real-traffic metrics that share `this.spans`.
        if (opts.persistSpans) {
          const span = this.startSpan('benchmark_request');
          span.ttfcMs = ttfc;
          this.endSpan(span.spanId);
        }

      } catch (error) {
        const safeError = error instanceof Error 
          ? { message: error.message, name: error.name }
          : error;
        log.error(`[tracer] Request ${i+1} failed:`, safeError);
      }
    }

    const totalTime = Date.now() - startTime;
    const reliability = successCount / requestCount;
    const throughput = (successCount / totalTime) * 1000;

    if (results.length === 0) {
      return {
        ttfcStats: { min: 0, max: 0, avg: 0, p95: 0 },
        reliability,
        throughput,
        analysis: 'No successful requests'
      };
    }

    const sorted = results.sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const avg = results.reduce((a, b) => a + b) / results.length;
    const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];

    // Generate analysis
    const analysisParts: string[] = [];
    if (avg < 300) analysisParts.push('EXCELLENT responsive (<300ms avg)');
    else if (avg < 600) analysisParts.push('GOOD responsive (<600ms avg)');
    else if (avg < 1000) analysisParts.push('FAIR responsive (600-1000ms avg)');
    else analysisParts.push('SLOW response (>1000ms avg)');

    if (reliability > 0.95) analysisParts.push(`${Math.round(reliability*100)}% reliable`);
    else analysisParts.push(`Only ${Math.round(reliability*100)}% reliability`);

    if (throughput > 0.5) analysisParts.push(`${throughput.toFixed(1)} req/sec sustained`);
    else analysisParts.push(`${throughput.toFixed(1)} req/sec (may need vertical scaling)`);

    return {
      ttfcStats: { min, max, avg, p95 },
      reliability,
      throughput,
      analysis: analysisParts.join(', ')
    };
  }

  // Simulate request latency based on current system state
  private simulateRequestLatency(): number {
    const baseLatency = 200; // STT baseline
    const variance = Math.random() * 200 - 100; // ±100ms variance
    const systemLoad = Math.random() * 0.3; // 0-30% system impact

    return Math.max(50, Math.round(baseLatency * (1 + variance/100) * (1 + systemLoad)));
  }

  // Cleanup old traces
  cleanup(olderThanMs: number = 60 * 60 * 1000): number { // Default: older than 1 hour
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;

    for (const [spanId, span] of this.spans.entries()) {
      if (span.startTime < cutoff) {
        this.spans.delete(spanId);
        removed++;
      }
    }

    return removed;
  }
}

// Global tracer instance
export const globalTracer = new DistributedTracer();

// Auto-cleanup every 5 minutes. Skipped in vitest/test environments —
// a module-level setInterval that logs through the shared logger would
// otherwise fire during worker teardown and surface as
// `EnvironmentTeardownError: Closing rpc while onUserConsoleLog was pending`,
// turning a benign housekeeping tick into a failed test run. Production
// servers keep the cleanup; tests don't need it.
if (!(typeof process !== 'undefined' && (process.env.VITEST || process.env.NODE_ENV === 'test'))) {
  const _tracerCleanup = setInterval(() => {
    const removed = globalTracer.cleanup();
    if (removed > 0) {
      log.log(`[tracer] Cleaned up ${removed} old traces`);
    }
  }, 5 * 60 * 1000);
  if (_tracerCleanup.unref) _tracerCleanup.unref();
}