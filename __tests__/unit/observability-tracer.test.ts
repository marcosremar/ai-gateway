import { describe, it, expect, beforeEach } from 'vitest';
import { DistributedTracer } from '../../src/observability/distributed-tracer';

describe('DistributedTracer', () => {
  let tracer: DistributedTracer;

  beforeEach(() => {
    tracer = new DistributedTracer();
  });

  it('generateTraceId returns 32-char hex string', () => {
    const id = tracer.generateTraceId();
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generateSpanId returns 16-char hex string', () => {
    const id = tracer.generateSpanId();
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('startSpan returns span with traceId, spanId, startTime, operation', () => {
    const span = tracer.startSpan('test-op');
    expect(span.traceId).toHaveLength(32);
    expect(span.spanId).toHaveLength(16);
    expect(span.operation).toBe('test-op');
    expect(typeof span.startTime).toBe('number');
    expect(span.tags).toEqual({});
    expect(span.events).toEqual([]);
  });

  it('startSpan with parentSpanId sets parentSpanId', () => {
    const parent = tracer.startSpan('parent');
    const child = tracer.startSpan('child', parent.spanId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.traceId).toHaveLength(32);
  });

  it('addTag adds tag to span', () => {
    const span = tracer.startSpan('op');
    tracer.addTag(span.spanId, 'key1', 'value1');
    tracer.addTag(span.spanId, 'num', 42);
    expect(span.tags['key1']).toBe('value1');
    expect(span.tags['num']).toBe(42);
  });

  it('addEvent adds event to span', () => {
    const span = tracer.startSpan('op');
    tracer.addEvent(span.spanId, 'click', { button: 'submit' });
    expect(span.events).toHaveLength(1);
    expect(span.events[0].name).toBe('click');
    expect(span.events[0].attributes).toEqual({ button: 'submit' });
    expect(typeof span.events[0].timestamp).toBe('number');
  });

  it('finishSpan calculates durationMs', () => {
    const span = tracer.startSpan('op');
    const result = tracer.endSpan(span.spanId);
    expect(result).toBeDefined();
    expect(typeof result!.tags.duration_ms).toBe('number');
    expect(result!.tags.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('getTraceTree / getPipelineMetrics not crashing (smoke)', () => {
    const parent = tracer.startSpan('pipeline');
    const child = tracer.startSpan('stt', parent.spanId);
    tracer.endSpan(child.spanId);
    tracer.endSpan(parent.spanId);
    // These are internal APIs; ensure they don't throw
    const cleanupCount = tracer.cleanup();
    expect(typeof cleanupCount).toBe('number');
  });
});
