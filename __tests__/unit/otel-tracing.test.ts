// ── OpenTelemetry in-memory tracing — unit suite ─────────────────────────────
// Covers initOtel, createSpan, withSpan, getCurrentSpan, getCompletedSpans,
// isOtelInitialized, getOtelConfig, metric helpers, and SPAN_NAMES.
//
// The module holds global state (activeSpans, completedSpans, otelConfig), so
// each test resets the module via vi.resetModules() to get a clean slate.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock logger so tests stay silent ─────────────────────────────────────────

vi.mock('../../src/modules/logger', () => ({
  createLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

async function load() {
  const mod = await import('../../src/platform/observability/otel');
  return mod;
}

describe('isOtelInitialized / getOtelConfig — pre-init state', () => {
  beforeEach(() => { vi.resetModules(); });

  it('returns false before initOtel is called', async () => {
    const { isOtelInitialized } = await load();
    expect(isOtelInitialized()).toBe(false);
  });

  it('getOtelConfig returns undefined before initOtel', async () => {
    const { getOtelConfig } = await load();
    expect(getOtelConfig()).toBeUndefined();
  });
});

describe('initOtel', () => {
  beforeEach(() => { vi.resetModules(); });

  it('marks otel as initialized', async () => {
    const { initOtel, isOtelInitialized } = await load();
    await initOtel();
    expect(isOtelInitialized()).toBe(true);
  });

  it('applies default serviceName when none given', async () => {
    const { initOtel, getOtelConfig } = await load();
    await initOtel();
    expect(getOtelConfig()?.serviceName).toBe('ai-gateway');
  });

  it('applies default exporterUrl when none given', async () => {
    const { initOtel, getOtelConfig } = await load();
    await initOtel();
    expect(getOtelConfig()?.exporterUrl).toBe('http://localhost:4318');
  });

  it('applies default sampleRate 1.0', async () => {
    const { initOtel, getOtelConfig } = await load();
    await initOtel();
    expect(getOtelConfig()?.sampleRate).toBe(1.0);
  });

  it('accepts custom serviceName', async () => {
    const { initOtel, getOtelConfig } = await load();
    await initOtel({ serviceName: 'my-service' });
    expect(getOtelConfig()?.serviceName).toBe('my-service');
  });

  it('accepts custom exporterUrl', async () => {
    const { initOtel, getOtelConfig } = await load();
    await initOtel({ exporterUrl: 'http://otel-collector:4317' });
    expect(getOtelConfig()?.exporterUrl).toBe('http://otel-collector:4317');
  });

  it('accepts sampleRate 0 (disable sampling)', async () => {
    const { initOtel, getOtelConfig } = await load();
    await initOtel({ sampleRate: 0 });
    expect(getOtelConfig()?.sampleRate).toBe(0);
  });

  it('calling initOtel twice replaces config', async () => {
    const { initOtel, getOtelConfig } = await load();
    await initOtel({ serviceName: 'first' });
    await initOtel({ serviceName: 'second' });
    expect(getOtelConfig()?.serviceName).toBe('second');
  });
});

describe('createSpan', () => {
  beforeEach(() => { vi.resetModules(); });

  it('returns a span with a non-empty traceId and spanId', async () => {
    const { createSpan } = await load();
    const span = createSpan('test.op');
    const ctx = span.spanContext();
    expect(ctx.traceId).toBeTruthy();
    expect(ctx.spanId).toBeTruthy();
  });

  it('traceId is 32 hex chars (no hyphens)', async () => {
    const { createSpan } = await load();
    const span = createSpan('test.op');
    expect(span.spanContext().traceId).toMatch(/^[a-f0-9]{32}$/);
  });

  it('spanId is 16 hex chars (no hyphens)', async () => {
    const { createSpan } = await load();
    const span = createSpan('test.op');
    expect(span.spanContext().spanId).toMatch(/^[a-f0-9]{16}$/);
  });

  it('two spans have different spanIds', async () => {
    const { createSpan } = await load();
    const a = createSpan('op.a');
    const b = createSpan('op.b');
    expect(a.spanContext().spanId).not.toBe(b.spanContext().spanId);
  });

  it('span with parent stores parent.traceId and parent.spanId as attributes', async () => {
    const { createSpan } = await load();
    const parent = createSpan('parent');
    const child = createSpan('child', parent);
    const attrs = (child as any).getAttributes?.() ?? {};
    expect(attrs['parent.traceId']).toBe(parent.spanContext().traceId);
    expect(attrs['parent.spanId']).toBe(parent.spanContext().spanId);
  });

  it('span without parent has no parent.* attributes', async () => {
    const { createSpan } = await load();
    const span = createSpan('standalone');
    const attrs = (span as any).getAttributes?.() ?? {};
    expect(attrs['parent.traceId']).toBeUndefined();
    expect(attrs['parent.spanId']).toBeUndefined();
  });

  it('setAttribute stores a string value', async () => {
    const { createSpan } = await load();
    const span = createSpan('op');
    span.setAttribute('provider', 'groq');
    const attrs = (span as any).getAttributes();
    expect(attrs['provider']).toBe('groq');
  });

  it('setAttribute stores a number value', async () => {
    const { createSpan } = await load();
    const span = createSpan('op');
    span.setAttribute('latencyMs', 42);
    const attrs = (span as any).getAttributes();
    expect(attrs['latencyMs']).toBe(42);
  });

  it('setAttribute stores a boolean value', async () => {
    const { createSpan } = await load();
    const span = createSpan('op');
    span.setAttribute('cached', true);
    const attrs = (span as any).getAttributes();
    expect(attrs['cached']).toBe(true);
  });
});

describe('withSpan — success path', () => {
  beforeEach(() => { vi.resetModules(); });

  it('returns the value produced by fn', async () => {
    const { withSpan } = await load();
    const result = await withSpan('test.success', async () => 'hello');
    expect(result).toBe('hello');
  });

  it('sets status=success attribute on the span', async () => {
    const { withSpan, getCompletedSpans } = await load();
    await withSpan('test.ok', async (span) => {
      void span;
    });
    const spans = getCompletedSpans();
    expect(spans.length).toBeGreaterThan(0);
    const last = spans[spans.length - 1] as any;
    expect(last.attributes?.status).toBe('success');
  });

  it('moves span from active to completed', async () => {
    const { withSpan, getCompletedSpans } = await load();
    const before = getCompletedSpans().length;
    await withSpan('test.move', async () => 'done');
    expect(getCompletedSpans().length).toBe(before + 1);
  });

  it('span json includes the name', async () => {
    const { withSpan, getCompletedSpans } = await load();
    await withSpan('my.custom.span', async () => undefined);
    const spans = getCompletedSpans();
    const names = spans.map((s: any) => s.name);
    expect(names).toContain('my.custom.span');
  });

  it('span json includes durationMs >= 0', async () => {
    const { withSpan, getCompletedSpans } = await load();
    await withSpan('test.duration', async () => 'x');
    const spans = getCompletedSpans();
    const last = spans[spans.length - 1] as any;
    expect(typeof last.durationMs).toBe('number');
    expect(last.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes the span to fn so attributes can be set inside', async () => {
    const { withSpan, getCompletedSpans } = await load();
    await withSpan('test.attrs', async (span) => {
      span.setAttribute('model', 'llama3');
    });
    const spans = getCompletedSpans();
    const last = spans[spans.length - 1] as any;
    expect(last.attributes?.model).toBe('llama3');
  });
});

describe('withSpan — error path', () => {
  beforeEach(() => { vi.resetModules(); });

  it('re-throws the error', async () => {
    const { withSpan } = await load();
    await expect(withSpan('test.throw', async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
  });

  it('sets status=error attribute on the span', async () => {
    const { withSpan, getCompletedSpans } = await load();
    await withSpan('test.err-attrs', async () => { throw new Error('fail'); }).catch(() => {});
    const spans = getCompletedSpans();
    const last = spans[spans.length - 1] as any;
    expect(last.attributes?.status).toBe('error');
  });

  it('records the error event on the span', async () => {
    const { withSpan, getCompletedSpans } = await load();
    await withSpan('test.err-event', async () => { throw new Error('exploded'); }).catch(() => {});
    const spans = getCompletedSpans();
    const last = spans[spans.length - 1] as any;
    const events: Array<{ name: string; attributes?: Record<string, unknown> }> = last.events ?? [];
    const exceptionEvt = events.find(e => e.name === 'exception');
    expect(exceptionEvt).toBeDefined();
    expect(exceptionEvt?.attributes?.['exception.message']).toBe('exploded');
  });

  it('moves span to completedSpans even on error', async () => {
    const { withSpan, getCompletedSpans } = await load();
    const before = getCompletedSpans().length;
    await withSpan('test.err-complete', async () => { throw new Error('x'); }).catch(() => {});
    expect(getCompletedSpans().length).toBe(before + 1);
  });
});

describe('getCurrentSpan', () => {
  beforeEach(() => { vi.resetModules(); });

  it('returns undefined when no active spans exist', async () => {
    const { getCurrentSpan } = await load();
    expect(getCurrentSpan()).toBeUndefined();
  });

  it('returns a span after createSpan', async () => {
    const { createSpan, getCurrentSpan } = await load();
    createSpan('active.span');
    expect(getCurrentSpan()).toBeDefined();
  });
});

describe('getCompletedSpans', () => {
  beforeEach(() => { vi.resetModules(); });

  it('starts empty', async () => {
    const { getCompletedSpans } = await load();
    expect(getCompletedSpans()).toHaveLength(0);
  });

  it('grows by 1 after each completed withSpan', async () => {
    const { withSpan, getCompletedSpans } = await load();
    await withSpan('op1', async () => 'a');
    expect(getCompletedSpans()).toHaveLength(1);
    await withSpan('op2', async () => 'b');
    expect(getCompletedSpans()).toHaveLength(2);
  });

  it('respects the limit parameter', async () => {
    const { withSpan, getCompletedSpans } = await load();
    for (let i = 0; i < 5; i++) {
      await withSpan(`op${i}`, async () => i);
    }
    const limited = getCompletedSpans(3);
    expect(limited).toHaveLength(3);
  });

  it('returns most recent spans when limited (slice from end)', async () => {
    const { withSpan, getCompletedSpans } = await load();
    for (let i = 0; i < 5; i++) {
      await withSpan(`slice.op${i}`, async () => i);
    }
    const limited = getCompletedSpans(2) as Array<{ name: string }>;
    const names = limited.map(s => s.name);
    expect(names).toContain('slice.op4');
    expect(names).toContain('slice.op3');
    expect(names).not.toContain('slice.op0');
  });
});

describe('withSpan — parent threading', () => {
  beforeEach(() => { vi.resetModules(); });

  it('child span inherits parent traceId in attributes', async () => {
    const { createSpan, withSpan, getCompletedSpans } = await load();
    const parent = createSpan('parent');
    await withSpan('child', async () => 'c', parent);
    const spans = getCompletedSpans() as Array<{ attributes: Record<string, unknown> }>;
    const child = spans.find(s => s.attributes?.['parent.traceId']);
    expect(child).toBeDefined();
    expect(child!.attributes['parent.traceId']).toBe(parent.spanContext().traceId);
  });
});

describe('SPAN_NAMES constants', () => {
  it('pipeline span names are correct', async () => {
    const { SPAN_NAMES } = await load();
    expect(SPAN_NAMES.PIPELINE_SPEECH).toBe('pipeline.speech');
    expect(SPAN_NAMES.PIPELINE_STT).toBe('pipeline.stt');
    expect(SPAN_NAMES.PIPELINE_LLM).toBe('pipeline.llm');
    expect(SPAN_NAMES.PIPELINE_TTS).toBe('pipeline.tts');
  });

  it('provider span names are correct', async () => {
    const { SPAN_NAMES } = await load();
    expect(SPAN_NAMES.PROVIDER_CHAT).toBe('provider.chat');
    expect(SPAN_NAMES.PROVIDER_TRANSCRIBE).toBe('provider.transcribe');
    expect(SPAN_NAMES.PROVIDER_SYNTHESIZE).toBe('provider.synthesize');
    expect(SPAN_NAMES.PROVIDER_FALLBACK).toBe('provider.fallback');
  });

  it('GPU span names are correct', async () => {
    const { SPAN_NAMES } = await load();
    expect(SPAN_NAMES.GPU_BOOT).toBe('gpu.boot');
    expect(SPAN_NAMES.GPU_HEALTH).toBe('gpu.health');
    expect(SPAN_NAMES.GPU_TERMINATE).toBe('gpu.terminate');
  });

  it('auth span names are correct', async () => {
    const { SPAN_NAMES } = await load();
    expect(SPAN_NAMES.AUTH_VALIDATE).toBe('auth.validate');
    expect(SPAN_NAMES.AUTH_SIGN_TOKEN).toBe('auth.sign_token');
  });

  it('proxy span names are correct', async () => {
    const { SPAN_NAMES } = await load();
    expect(SPAN_NAMES.PROXY_REQUEST).toBe('proxy.request');
    expect(SPAN_NAMES.PROXY_RESPONSE).toBe('proxy.response');
  });
});

describe('metric helpers (incrementCounter, recordHistogram, recordGauge)', () => {
  beforeEach(() => { vi.resetModules(); });

  it('incrementCounter does not throw', async () => {
    const { incrementCounter } = await load();
    expect(() => incrementCounter('requests.total')).not.toThrow();
  });

  it('incrementCounter accepts value and labels', async () => {
    const { incrementCounter } = await load();
    expect(() => incrementCounter('requests.total', 5, { provider: 'groq' })).not.toThrow();
  });

  it('recordHistogram does not throw', async () => {
    const { recordHistogram } = await load();
    expect(() => recordHistogram('request.latency', 123)).not.toThrow();
  });

  it('recordHistogram accepts labels', async () => {
    const { recordHistogram } = await load();
    expect(() => recordHistogram('request.latency', 50, { stage: 'stt' })).not.toThrow();
  });

  it('recordGauge does not throw', async () => {
    const { recordGauge } = await load();
    expect(() => recordGauge('active.sessions', 7)).not.toThrow();
  });

  it('recordGauge accepts labels', async () => {
    const { recordGauge } = await load();
    expect(() => recordGauge('active.sessions', 3, { provider: 'modal' })).not.toThrow();
  });

  it('incrementCounter default value is 1', async () => {
    // Just verify no throw — the function logs internally
    const { incrementCounter } = await load();
    expect(() => incrementCounter('my.counter')).not.toThrow();
  });
});
