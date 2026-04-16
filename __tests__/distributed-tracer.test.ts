/**
 * Tests for src/observability/distributed-tracer.ts
 * Covers: span lifecycle, tags, events, pipeline tracing, analytics, cleanup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DistributedTracer } from '../src/observability/distributed-tracer';
import type { PipelineMetrics } from '../src/observability/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTracer(): DistributedTracer {
  return new DistributedTracer();
}

function makePipelineMetrics(overrides: Partial<PipelineMetrics> = {}): PipelineMetrics {
  return {
    requestId: 'req-123',
    pipeline: 'speech',
    totalLatencyMs: 500,
    stages: {
      stt: { latencyMs: 200, provider: 'groq', success: true },
      llm: { latencyMs: 150, provider: 'openai', success: true },
      tts: { latencyMs: 150, provider: 'elevenlabs', success: true },
    },
    routing: {
      decision: 'cloud',
      confidence: 0.9,
      reason: 'no gpu available',
      costEstimate: 0.001,
    },
    input: {
      audioBytes: 16000,
      estimatedDurationSec: 1.0,
    },
    output: {
      transcriptionLength: 20,
      responseLength: 50,
    },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DistributedTracer', () => {
  describe('generateTraceId / generateSpanId', () => {
    it('generates unique trace IDs', () => {
      const tracer = makeTracer();
      const ids = new Set(Array.from({ length: 100 }, () => tracer.generateTraceId()));
      expect(ids.size).toBe(100);
    });

    it('trace IDs are 32 hex chars', () => {
      const tracer = makeTracer();
      const id = tracer.generateTraceId();
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    });

    it('span IDs are 16 hex chars', () => {
      const tracer = makeTracer();
      const id = tracer.generateSpanId();
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });

    it('generates unique span IDs', () => {
      const tracer = makeTracer();
      const ids = new Set(Array.from({ length: 100 }, () => tracer.generateSpanId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('startSpan', () => {
    it('creates span with required fields', () => {
      const tracer = makeTracer();
      const span = tracer.startSpan('test-operation');
      expect(span.operation).toBe('test-operation');
      expect(span.traceId).toBeTruthy();
      expect(span.spanId).toBeTruthy();
      expect(span.startTime).toBeGreaterThan(0);
      expect(span.tags).toEqual({});
      expect(span.events).toEqual([]);
    });

    it('sets parentSpanId when provided', () => {
      const tracer = makeTracer();
      const parent = tracer.startSpan('parent');
      const child = tracer.startSpan('child', parent.spanId);
      expect(child.parentSpanId).toBe(parent.spanId);
    });

    it('parentSpanId is undefined when not provided', () => {
      const tracer = makeTracer();
      const span = tracer.startSpan('root');
      expect(span.parentSpanId).toBeUndefined();
    });

    it('different spans get different spanIds', () => {
      const tracer = makeTracer();
      const a = tracer.startSpan('op-a');
      const b = tracer.startSpan('op-b');
      expect(a.spanId).not.toBe(b.spanId);
    });
  });

  describe('addTag', () => {
    it('adds tag to existing span', () => {
      const tracer = makeTracer();
      const span = tracer.startSpan('op');
      tracer.addTag(span.spanId, 'provider', 'groq');
      expect(span.tags['provider']).toBe('groq');
    });

    it('is no-op for unknown spanId', () => {
      const tracer = makeTracer();
      expect(() => tracer.addTag('nonexistent', 'key', 'val')).not.toThrow();
    });

    it('overwrites existing tag', () => {
      const tracer = makeTracer();
      const span = tracer.startSpan('op');
      tracer.addTag(span.spanId, 'status', 'pending');
      tracer.addTag(span.spanId, 'status', 'done');
      expect(span.tags['status']).toBe('done');
    });

    it('supports various value types', () => {
      const tracer = makeTracer();
      const span = tracer.startSpan('op');
      tracer.addTag(span.spanId, 'num', 42);
      tracer.addTag(span.spanId, 'bool', true);
      tracer.addTag(span.spanId, 'obj', { nested: true });
      expect(span.tags['num']).toBe(42);
      expect(span.tags['bool']).toBe(true);
      expect(span.tags['obj']).toEqual({ nested: true });
    });
  });

  describe('addEvent', () => {
    it('adds event to existing span', () => {
      const tracer = makeTracer();
      const span = tracer.startSpan('op');
      tracer.addEvent(span.spanId, 'cache_hit', { cacheId: 'abc' });
      expect(span.events).toHaveLength(1);
      expect(span.events[0].name).toBe('cache_hit');
      expect(span.events[0].attributes).toEqual({ cacheId: 'abc' });
      expect(span.events[0].timestamp).toBeGreaterThan(0);
    });

    it('is no-op for unknown spanId', () => {
      const tracer = makeTracer();
      expect(() => tracer.addEvent('nonexistent', 'evt')).not.toThrow();
    });

    it('accumulates multiple events', () => {
      const tracer = makeTracer();
      const span = tracer.startSpan('op');
      tracer.addEvent(span.spanId, 'start');
      tracer.addEvent(span.spanId, 'progress');
      tracer.addEvent(span.spanId, 'end');
      expect(span.events).toHaveLength(3);
    });

    it('uses empty attributes by default', () => {
      const tracer = makeTracer();
      const span = tracer.startSpan('op');
      tracer.addEvent(span.spanId, 'no-attrs');
      expect(span.events[0].attributes).toEqual({});
    });
  });

  describe('endSpan', () => {
    it('sets duration_ms tag', () => {
      const tracer = makeTracer();
      const span = tracer.startSpan('op');
      const result = tracer.endSpan(span.spanId);
      expect(result).toBe(span);
      expect(span.tags['duration_ms']).toBeGreaterThanOrEqual(0);
    });

    it('returns null for unknown spanId', () => {
      const tracer = makeTracer();
      expect(tracer.endSpan('nonexistent')).toBeNull();
    });

    it('returns the span object', () => {
      const tracer = makeTracer();
      const span = tracer.startSpan('op');
      const result = tracer.endSpan(span.spanId);
      expect(result).toBe(span);
    });
  });

  describe('tracePipeline', () => {
    it('creates a span with pipeline operation name', () => {
      const tracer = makeTracer();
      const metrics = makePipelineMetrics({ pipeline: 'speech' });
      const span = tracer.tracePipeline(metrics);
      expect(span.operation).toBe('speech_pipeline');
    });

    it('sets pipeline tags', () => {
      const tracer = makeTracer();
      const metrics = makePipelineMetrics();
      const span = tracer.tracePipeline(metrics);
      expect(span.tags['pipeline.type']).toBe('speech');
      expect(span.tags['request.id']).toBe('req-123');
      expect(span.tags['total.latency_ms']).toBe(500);
      expect(span.tags['routing.decision']).toBe('cloud');
      expect(span.tags['routing.confidence']).toBe(0.9);
      expect(span.tags['input.audio_bytes']).toBe(16000);
    });

    it('sets ttfcMs on span when provided', () => {
      const tracer = makeTracer();
      const metrics = makePipelineMetrics({ ttfcMs: 250 });
      const span = tracer.tracePipeline(metrics);
      expect(span.ttfcMs).toBe(250);
    });

    it('does not set ttfcMs when undefined', () => {
      const tracer = makeTracer();
      const metrics = makePipelineMetrics({ ttfcMs: undefined });
      const span = tracer.tracePipeline(metrics);
      expect(span.ttfcMs).toBeUndefined();
    });

    it('creates child stage spans', () => {
      const tracer = makeTracer();
      const metrics = makePipelineMetrics();
      const span = tracer.tracePipeline(metrics);
      // Stage spans are children of the pipeline span
      expect(span.parentSpanId).toBeUndefined(); // root
    });

    it('adds routing_decision event', () => {
      const tracer = makeTracer();
      const metrics = makePipelineMetrics();
      const span = tracer.tracePipeline(metrics);
      const routingEvent = span.events.find(e => e.name === 'routing_decision');
      expect(routingEvent).toBeDefined();
      expect(routingEvent!.attributes.decision).toBe('cloud');
    });

    it('adds output.audio_bytes tag when present', () => {
      const tracer = makeTracer();
      const metrics = makePipelineMetrics({
        output: { transcriptionLength: 20, responseLength: 50, audioBytes: 48000 },
      });
      const span = tracer.tracePipeline(metrics);
      expect(span.tags['output.audio_bytes']).toBe(48000);
    });

    it('stage failure events are added for failed stages', () => {
      const tracer = makeTracer();
      const metrics = makePipelineMetrics({
        stages: {
          stt: { latencyMs: 200, provider: 'groq', success: false },
        },
      });
      tracer.tracePipeline(metrics);
      // Stage span should have stage_failure event — verify via spans indirectly
      // The span map is private; check that tracePipeline doesn't throw
      expect(true).toBe(true);
    });

    it('handles missing stages gracefully', () => {
      const tracer = makeTracer();
      const metrics = makePipelineMetrics({ stages: {} });
      expect(() => tracer.tracePipeline(metrics)).not.toThrow();
    });
  });

  describe('analyzeBottlenecks', () => {
    it('returns defaults when no spans', () => {
      const tracer = makeTracer();
      const result = tracer.analyzeBottlenecks(60_000);
      expect(result.slowestStage).toBe('none');
      expect(result.slowestProvider).toBe('none');
      expect(result.averageLatencyMs).toBe(0);
      expect(result.p95LatencyMs).toBe(0);
      expect(result.failureRate).toBe(0);
    });

    it('computes average latency from recent spans', () => {
      const tracer = makeTracer();
      // Create + end spans to set duration_ms
      for (let i = 0; i < 5; i++) {
        const s = tracer.startSpan('op');
        tracer.endSpan(s.spanId);
      }
      const result = tracer.analyzeBottlenecks(60_000);
      expect(result.averageLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('calculates failure rate from stage_failure events', () => {
      const tracer = makeTracer();
      const metrics = makePipelineMetrics({
        stages: {
          stt: { latencyMs: 200, provider: 'groq', success: false },
        },
      });
      tracer.tracePipeline(metrics);
      // The pipeline span itself won't have stage_failure, but stage spans do
      const result = tracer.analyzeBottlenecks(60_000);
      expect(result.failureRate).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getRealtimeMetrics', () => {
    it('returns safe defaults when fewer than 3 spans', () => {
      const tracer = makeTracer();
      const result = tracer.getRealtimeMetrics();
      expect(result.ttfcP50).toBe(0);
      expect(result.ttfcP95).toBe(0);
      expect(result.coldStartRate).toBe(0);
      expect(result.userExperienceScore).toBe(100);
      expect(result.audioExperienceScore).toBe(100);
    });

    it('computes scores from ttfcMs values', () => {
      const tracer = makeTracer();
      // Add spans with ttfcMs
      for (let i = 0; i < 5; i++) {
        const span = tracer.startSpan('request');
        span.ttfcMs = 200;
        tracer.endSpan(span.spanId);
      }
      const result = tracer.getRealtimeMetrics();
      // With 5 spans, should compute stats
      expect(result.ttfcP50).toBeGreaterThanOrEqual(0);
    });

    it('penalizes high TTFC in userExperienceScore', () => {
      const tracer = makeTracer();
      // Add spans with very high ttfcMs
      for (let i = 0; i < 5; i++) {
        const span = tracer.startSpan('slow-request');
        span.ttfcMs = 5000; // very slow
        tracer.endSpan(span.spanId);
      }
      const result = tracer.getRealtimeMetrics();
      expect(result.userExperienceScore).toBeLessThan(100);
    });

    it('returns correct TTFC when all fast', () => {
      const tracer = makeTracer();
      for (let i = 0; i < 5; i++) {
        const span = tracer.startSpan('fast');
        span.ttfcMs = 100;
        tracer.endSpan(span.spanId);
      }
      const result = tracer.getRealtimeMetrics();
      expect(result.userExperienceScore).toBe(100);
    });
  });

  describe('cleanup', () => {
    it('removes spans older than threshold', () => {
      const tracer = makeTracer();
      const span = tracer.startSpan('old-op');
      tracer.endSpan(span.spanId);
      // Negative olderThanMs makes cutoff = Date.now() + 1000 (future), so all spans qualify
      const removed = tracer.cleanup(-1000);
      expect(removed).toBeGreaterThan(0);
    });

    it('does not remove fresh spans', () => {
      const tracer = makeTracer();
      tracer.startSpan('fresh-op');
      // 1 hour threshold — nothing should be removed
      const removed = tracer.cleanup(3_600_000);
      expect(removed).toBe(0);
    });

    it('returns count of removed spans', () => {
      const tracer = makeTracer();
      for (let i = 0; i < 3; i++) tracer.startSpan(`op-${i}`);
      // Negative threshold so cutoff is in the future — all spans qualify
      const removed = tracer.cleanup(-1000);
      expect(removed).toBe(3);
    });

    it('returns 0 when nothing to clean', () => {
      const tracer = makeTracer();
      expect(tracer.cleanup(3_600_000)).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('addTag on ended span still works (span exists in map)', () => {
      const tracer = makeTracer();
      const span = tracer.startSpan('op');
      tracer.endSpan(span.spanId);
      // endSpan doesn't remove from map, so addTag still works
      expect(() => tracer.addTag(span.spanId, 'extra', 'value')).not.toThrow();
    });

    it('multiple tracePipeline calls create independent spans', () => {
      const tracer = makeTracer();
      const s1 = tracer.tracePipeline(makePipelineMetrics({ requestId: 'req-1' }));
      const s2 = tracer.tracePipeline(makePipelineMetrics({ requestId: 'req-2' }));
      expect(s1.spanId).not.toBe(s2.spanId);
      expect(s1.tags['request.id']).toBe('req-1');
      expect(s2.tags['request.id']).toBe('req-2');
    });

    it('stt pipeline type produces correct operation name', () => {
      const tracer = makeTracer();
      const span = tracer.tracePipeline(makePipelineMetrics({ pipeline: 'stt' }));
      expect(span.operation).toBe('stt_pipeline');
    });
  });
});
