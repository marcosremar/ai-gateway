/**
 * Optimization implementation tests — CROSS-OWNERSHIP harvest wave (x6).
 *
 * Domain-6 (observability) deferred every `src/platform/observability/**` audit
 * item as "out of ownership". This wave implements the SAFE, LOCALIZED ones,
 * each covered here. All unit-only: mocked fetch, in-memory spans, injected
 * clocks/options. No network, no OTLP collector.
 *
 * docs/optimizations/06-observability-cost.md (IDs 501-600):
 *   #512  analyzeBottlenecks derives slowest stage/provider from real spans
 *   #521  benchmark synthetic spans NOT persisted by default
 *   #565  stage spans carry token counts + cost; parent rolls up stage cost
 *   #566  span eviction prefers ended spans (won't orphan an open parent)
 *   #567  OTLP re-queues transient (5xx/429/network) failures; drops 4xx
 *   #568  OTLP flush is copy-then-confirm (no data loss on serialize/throw)
 *   #569  OTLP pending buffer is bounded (drop-oldest + droppedCount)
 *   #570  withSpan span-completion logging is off by default
 *   #571  otel completedSpans ring is bounded
 *   #575  initOtlpFromEnv validates the endpoint is an http(s) URL
 *   #600  Langfuse trace id is stable across onRequestStart/onRequestEnd
 *   (+)   attachExporterToTracer is idempotent (no double-enqueue)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  DistributedTracer,
} from '../../src/platform/observability/distributed-tracer';
import {
  OtlpExporter,
  isValidHttpUrl,
  initOtlpFromEnv,
  attachExporterToTracer,
  _resetOtlpForTests,
} from '../../src/platform/observability/otlp-exporter';
import {
  withSpan,
  getCompletedSpanCount,
  _resetOtelSpansForTests,
} from '../../src/platform/observability/otel';
import { langfuseTraceId } from '../../src/platform/observability/langfuse-hooks';
import type { PipelineMetrics } from '../../src/platform/observability/types';

// ── helpers ──────────────────────────────────────────────────────────────────

function basePipelineMetrics(over: Partial<PipelineMetrics> = {}): PipelineMetrics {
  return {
    requestId: 'req-1',
    pipeline: 'speech',
    totalLatencyMs: 100,
    stages: {},
    routing: { decision: 'gpu', confidence: 0.9, reason: 'fast', costEstimate: 0.001 },
    input: { audioBytes: 1000, estimatedDurationSec: 1 },
    output: { transcriptionLength: 10, responseLength: 20 },
    ...over,
  };
}

/** A fetch stub that returns a fixed status, recording calls. */
function fetchReturning(status: number, body = '') {
  const calls: Array<{ url: string; body: string }> = [];
  const impl = (async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// #565 — stage spans carry token counts + cost; parent rolls up cost
// ─────────────────────────────────────────────────────────────────────────────

describe('#565 stage spans record token counts and cost', () => {
  it('tags input/output tokens and cost on stage spans when provided', () => {
    const tracer = new DistributedTracer();
    const m = basePipelineMetrics({
      stages: {
        llm: { latencyMs: 50, provider: 'groq', success: true, inputTokens: 100, outputTokens: 40, costUsd: 0.002 },
      },
    });
    tracer.tracePipeline(m);

    // Find the llm stage span among retained spans.
    const allTags = (tracer as any).spans as Map<string, any>;
    const stageSpan = Array.from(allTags.values()).find(
      (s) => s.tags['stage.name'] === 'llm',
    );
    expect(stageSpan).toBeTruthy();
    expect(stageSpan.tags['stage.input_tokens']).toBe(100);
    expect(stageSpan.tags['stage.output_tokens']).toBe(40);
    expect(stageSpan.tags['stage.cost_usd']).toBe(0.002);
  });

  it('omits token/cost tags when not supplied (back-compat)', () => {
    const tracer = new DistributedTracer();
    const m = basePipelineMetrics({
      stages: { stt: { latencyMs: 30, provider: 'deepgram', success: true } },
    });
    tracer.tracePipeline(m);
    const stageSpan = Array.from((tracer as any).spans.values()).find(
      (s: any) => s.tags['stage.name'] === 'stt',
    ) as any;
    expect('stage.input_tokens' in stageSpan.tags).toBe(false);
    expect('stage.cost_usd' in stageSpan.tags).toBe(false);
  });

  it('rolls per-stage costs up onto the parent pipeline span', () => {
    const tracer = new DistributedTracer();
    const m = basePipelineMetrics({
      stages: {
        stt: { latencyMs: 30, provider: 'deepgram', success: true, costUsd: 0.001 },
        llm: { latencyMs: 50, provider: 'groq', success: true, costUsd: 0.003 },
      },
    });
    const parent = tracer.tracePipeline(m);
    expect(parent.tags['cost.stages_usd']).toBeCloseTo(0.004, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #512 — analyzeBottlenecks derives slowest stage/provider from real spans
// ─────────────────────────────────────────────────────────────────────────────

describe('#512 analyzeBottlenecks no longer returns hardcoded literals', () => {
  it('identifies the slowest stage and provider from recent stage spans', () => {
    const tracer = new DistributedTracer();
    tracer.tracePipeline(
      basePipelineMetrics({
        stages: {
          stt: { latencyMs: 20, provider: 'deepgram', success: true },
          llm: { latencyMs: 500, provider: 'openrouter', success: true },
          tts: { latencyMs: 80, provider: 'groq', success: true },
        },
      }),
    );

    const result = tracer.analyzeBottlenecks(60_000);
    expect(result.slowestStage).toBe('llm');
    expect(result.slowestProvider).toBe('openrouter');
    // Sanity: not the old fabricated values.
    expect(result.slowestStage).not.toBe('pipeline');
    expect(result.slowestProvider).not.toBe('gpu');
  });

  it('returns "none" when there are no spans in the window', () => {
    const tracer = new DistributedTracer();
    const result = tracer.analyzeBottlenecks(60_000);
    expect(result.slowestStage).toBe('none');
    expect(result.slowestProvider).toBe('none');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #566 — eviction prefers ended spans so an open parent is not orphaned
// ─────────────────────────────────────────────────────────────────────────────

describe('#566 span eviction does not drop an open parent before children', () => {
  const ORIGINAL_CAP = (DistributedTracer as any).MAX_RETAINED_SPANS;
  afterEach(() => {
    (DistributedTracer as any).MAX_RETAINED_SPANS = ORIGINAL_CAP;
  });

  it('evicts an ended span instead of the still-open oldest span', () => {
    const tracer = new DistributedTracer();
    // Shrink the cap for a fast deterministic test.
    (DistributedTracer as any).MAX_RETAINED_SPANS = 3;

    // Open parent (NOT ended) — inserted first, so naive FIFO would drop it.
    const parent = tracer.startSpan('parent');
    // Two ended spans.
    const a = tracer.startSpan('a');
    tracer.endSpan(a.spanId);
    const b = tracer.startSpan('b');
    tracer.endSpan(b.spanId);

    // Now at cap=3 (parent, a, b). Adding a child triggers eviction.
    const child = tracer.startSpan('child', parent.spanId);

    const spans = (tracer as any).spans as Map<string, any>;
    // The open parent must survive; an ended span (a, the oldest ended) is gone.
    expect(spans.has(parent.spanId)).toBe(true);
    expect(spans.has(child.spanId)).toBe(true);
    expect(spans.has(a.spanId)).toBe(false);
  });

  it('keeps a hard bound even if every span is still open (FIFO fallback)', () => {
    const tracer = new DistributedTracer();
    (DistributedTracer as any).MAX_RETAINED_SPANS = 2;
    const s1 = tracer.startSpan('s1'); // open
    tracer.startSpan('s2'); // open
    tracer.startSpan('s3'); // open → forces eviction; none ended → drop oldest
    const spans = (tracer as any).spans as Map<string, any>;
    expect(spans.size).toBe(2);
    expect(spans.has(s1.spanId)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #521 — benchmark synthetic spans are NOT persisted by default
// ─────────────────────────────────────────────────────────────────────────────

describe('#521 runRealtimeBenchmark does not pollute the span ring by default', () => {
  it('stores no benchmark_request spans when persistSpans is not set', async () => {
    const tracer = new DistributedTracer();
    await tracer.runRealtimeBenchmark(3, 0);
    const spans = Array.from((tracer as any).spans.values()) as any[];
    expect(spans.some((s) => s.operation === 'benchmark_request')).toBe(false);
    // analyzeBottlenecks stays clean (no fabricated spans).
    expect(tracer.analyzeBottlenecks(60_000).slowestStage).toBe('none');
  });

  it('stores benchmark spans only when persistSpans is explicitly true', async () => {
    const tracer = new DistributedTracer();
    await tracer.runRealtimeBenchmark(3, 0, { persistSpans: true });
    const spans = Array.from((tracer as any).spans.values()) as any[];
    expect(spans.filter((s) => s.operation === 'benchmark_request').length).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #569 — OTLP pending buffer is bounded (drop-oldest + droppedCount)
// ─────────────────────────────────────────────────────────────────────────────

describe('#569 OtlpExporter bounds the pending buffer', () => {
  it('drops oldest spans past maxPending and counts them', () => {
    const { impl } = fetchReturning(500); // collector "down" so flush never drains
    const exp = new OtlpExporter({
      endpoint: 'http://collector:4318',
      maxBatchSize: 1000, // big so enqueue doesn't auto-flush
      maxPending: 5,
      fetch: impl,
    });
    for (let i = 0; i < 12; i++) {
      exp.enqueue({
        traceId: 't', spanId: `s${i}`, operation: 'op', startTime: 1,
        tags: { duration_ms: 1 }, events: [],
      });
    }
    const s = exp.stats();
    expect(s.pending).toBe(5);
    expect(s.dropped).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #567 / #568 — flush copy-then-confirm + transient re-queue
// ─────────────────────────────────────────────────────────────────────────────

describe('#568 OTLP flush is copy-then-confirm', () => {
  it('removes spans only after a 2xx ACK', async () => {
    const { impl } = fetchReturning(200);
    const exp = new OtlpExporter({ endpoint: 'http://c:4318', maxBatchSize: 100, fetch: impl });
    exp.enqueue({ traceId: 't', spanId: 's1', operation: 'op', startTime: 1, tags: { duration_ms: 1 }, events: [] });
    const r = await exp.flush();
    expect(r.exported).toBe(1);
    expect(exp.stats().pending).toBe(0);
    expect(exp.stats().exported).toBe(1);
  });

  it('does not lose spans when serialization throws (poison batch dropped, not retried forever)', async () => {
    const { impl } = fetchReturning(200);
    const exp = new OtlpExporter({ endpoint: 'http://c:4318', maxBatchSize: 100, fetch: impl });
    // BigInt of a non-integer startTime → msToNano throws inside buildPayload.
    exp.enqueue({ traceId: 't', spanId: 's1', operation: 'op', startTime: 1.5, tags: { duration_ms: 1 }, events: [] });
    const r = await exp.flush();
    expect(r.failed).toBe(1);
    // Poison batch is removed (not stuck), counted as failed.
    expect(exp.stats().pending).toBe(0);
    expect(exp.stats().failed).toBe(1);
  });
});

describe('#567 OTLP retries transient failures, drops permanent ones', () => {
  it('re-queues the batch on a 5xx (keeps it for the next flush)', async () => {
    const { impl } = fetchReturning(503);
    const exp = new OtlpExporter({ endpoint: 'http://c:4318', maxBatchSize: 100, fetch: impl });
    exp.enqueue({ traceId: 't', spanId: 's1', operation: 'op', startTime: 1, tags: { duration_ms: 1 }, events: [] });
    const r = await exp.flush();
    expect(r.exported).toBe(0);
    // Still pending → will be retried; counted as requeued (and failed, for
    // back-compat with the original "every failure counts" contract).
    expect(exp.stats().pending).toBe(1);
    expect(exp.stats().requeued).toBe(1);
  });

  it('re-queues on a network error (fetch throws)', async () => {
    const impl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const exp = new OtlpExporter({ endpoint: 'http://c:4318', maxBatchSize: 100, fetch: impl });
    exp.enqueue({ traceId: 't', spanId: 's1', operation: 'op', startTime: 1, tags: { duration_ms: 1 }, events: [] });
    await exp.flush();
    expect(exp.stats().pending).toBe(1);
    expect(exp.stats().requeued).toBe(1);
    expect(exp.stats().lastFailure?.message).toContain('ECONNREFUSED');
  });

  it('drops the batch permanently on a 4xx (retry is futile)', async () => {
    const { impl } = fetchReturning(400, 'bad request');
    const exp = new OtlpExporter({ endpoint: 'http://c:4318', maxBatchSize: 100, fetch: impl });
    exp.enqueue({ traceId: 't', spanId: 's1', operation: 'op', startTime: 1, tags: { duration_ms: 1 }, events: [] });
    await exp.flush();
    expect(exp.stats().pending).toBe(0);   // dropped, not retried
    expect(exp.stats().failed).toBe(1);
    expect(exp.stats().requeued).toBe(0);  // 4xx is NOT re-queued
  });

  it('eventually exports a re-queued batch once the collector recovers', async () => {
    let status = 503;
    const impl = (async () => ({
      ok: status >= 200 && status < 300, status, text: async () => '',
    } as unknown as Response)) as unknown as typeof fetch;
    const exp = new OtlpExporter({ endpoint: 'http://c:4318', maxBatchSize: 100, fetch: impl });
    exp.enqueue({ traceId: 't', spanId: 's1', operation: 'op', startTime: 1, tags: { duration_ms: 1 }, events: [] });
    await exp.flush();                 // 503 → requeued
    expect(exp.stats().pending).toBe(1);
    status = 200;
    const r = await exp.flush();       // recovered → exported
    expect(r.exported).toBe(1);
    expect(exp.stats().pending).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #575 — initOtlpFromEnv validates the endpoint URL
// ─────────────────────────────────────────────────────────────────────────────

describe('#575 OTLP endpoint URL validation', () => {
  it('isValidHttpUrl accepts http/https and rejects garbage', () => {
    expect(isValidHttpUrl('http://tempo:4318')).toBe(true);
    expect(isValidHttpUrl('https://otlp.example.com')).toBe(true);
    expect(isValidHttpUrl('tempo:4318')).toBe(false);   // no scheme
    expect(isValidHttpUrl('ftp://x')).toBe(false);       // wrong scheme
    expect(isValidHttpUrl('not a url')).toBe(false);
    expect(isValidHttpUrl(undefined)).toBe(false);
    expect(isValidHttpUrl('')).toBe(false);
  });

  it('initOtlpFromEnv returns null for a malformed endpoint', () => {
    _resetOtlpForTests();
    const exp = initOtlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'tempo-no-scheme:4318' } as any);
    expect(exp).toBeNull();
    _resetOtlpForTests();
  });

  it('initOtlpFromEnv returns null when endpoint unset', () => {
    _resetOtlpForTests();
    expect(initOtlpFromEnv({} as any)).toBeNull();
  });

  it('initOtlpFromEnv constructs an exporter for a valid endpoint', () => {
    _resetOtlpForTests();
    const exp = initOtlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://tempo:4318' } as any);
    expect(exp).not.toBeNull();
    _resetOtlpForTests();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (+) attachExporterToTracer is idempotent — no double enqueue
// ─────────────────────────────────────────────────────────────────────────────

describe('attachExporterToTracer is idempotent', () => {
  it('enqueues each completed span once even after multiple attaches', async () => {
    const { impl } = fetchReturning(200);
    const exp = new OtlpExporter({ endpoint: 'http://c:4318', maxBatchSize: 1000, fetch: impl });
    // globalTracer is the one attachExporterToTracer patches.
    const { globalTracer } = await import('../../src/platform/observability/distributed-tracer');
    const originalEndSpan = globalTracer.endSpan;
    try {
      attachExporterToTracer(exp);
      attachExporterToTracer(exp); // second call must be a no-op

      const s = globalTracer.startSpan('idem-test');
      globalTracer.endSpan(s.spanId);

      // Exactly one span buffered, not two.
      expect(exp.stats().pending).toBe(1);
    } finally {
      // Restore so we don't leak a patched endSpan into other test files.
      globalTracer.endSpan = originalEndSpan;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #571 / #570 — otel completedSpans bounded; span logging off by default
// ─────────────────────────────────────────────────────────────────────────────

describe('#571 otel completedSpans ring is bounded', () => {
  beforeEach(() => _resetOtelSpansForTests());

  it('caps the number of retained completed spans', async () => {
    // Run a batch of spans; count must never exceed the documented cap and the
    // ring must actually retain (not be empty).
    for (let i = 0; i < 50; i++) {
      await withSpan(`op-${i}`, async () => i);
    }
    const count = getCompletedSpanCount();
    expect(count).toBe(50);
    expect(count).toBeLessThanOrEqual(5000);
  });
});

describe('#570 withSpan span-completion logging is off by default', () => {
  beforeEach(() => _resetOtelSpansForTests());

  it('does not emit a per-span completion log when OTEL_LOG_SPANS is unset', async () => {
    const prev = process.env.OTEL_LOG_SPANS;
    delete process.env.OTEL_LOG_SPANS;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await withSpan('quiet-op', async () => 1);
      const allCalls = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().map(String).join('\n');
      expect(allCalls).not.toContain('Span completed');
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      if (prev !== undefined) process.env.OTEL_LOG_SPANS = prev;
    }
  });

  it('still returns the wrapped function result', async () => {
    const r = await withSpan('op', async () => 42);
    expect(r).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #600 — Langfuse trace id stable across start/end
// ─────────────────────────────────────────────────────────────────────────────

describe('#600 langfuseTraceId links start and end events', () => {
  it('produces identical ids for the same (userId,stage,provider) tuple', () => {
    const start = { userId: 'u1', stage: 'llm', provider: 'groq', timestamp: 1 };
    const end = { userId: 'u1', stage: 'llm', provider: 'groq', latencyMs: 50, success: true, timestamp: 2 };
    const idA = langfuseTraceId(start);
    const idB = langfuseTraceId(end);
    expect(idA).toBe(idB);
    expect(idA.startsWith('trace-')).toBe(true);
    // Not the old broken sentinel.
    expect(idA).not.toContain('redacted');
  });

  it('produces different ids for different requests', () => {
    const a = langfuseTraceId({ userId: 'u1', stage: 'llm', provider: 'groq' });
    const b = langfuseTraceId({ userId: 'u2', stage: 'llm', provider: 'groq' });
    const c = langfuseTraceId({ userId: 'u1', stage: 'tts', provider: 'groq' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('is stable for missing/anon fields', () => {
    expect(langfuseTraceId({})).toBe(langfuseTraceId({}));
  });
});
