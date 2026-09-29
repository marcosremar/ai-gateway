/**
 * Unit tests for buildSystemAnalytics (src/gateway/routing/analytics-service.ts).
 *
 * Covers: health score calculation, status thresholds, recommendation triggers,
 * routing passthrough, performance metric flags, and edge cases.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSystemAnalytics,
  DEFAULT_REALTIME_METRICS,
  type RealtimeMetrics,
} from '../src/gateway/routing/analytics-service';
import type { RoutingDecision } from '../src/gateway/routing/hybrid-router';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeRouting(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    provider: 'gpu',
    model: 'llama-3-8b',
    confidence: 0.9,
    estimatedLatencyMs: 200,
    reason: 'GPU hot',
    costEstimate: 0.001,
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<RealtimeMetrics> = {}): RealtimeMetrics {
  return { ...DEFAULT_REALTIME_METRICS, ...overrides };
}

// ── System health score ───────────────────────────────────────────────────────

describe('systemHealthScore — 0-100 scale', () => {
  it('produces score ~87 with default metrics (healthy)', () => {
    // (1-0.05)*0.3 + 85*0.01*0.4 + 80*0.01*0.3 = 0.865 → ×100 → 87
    const result = buildSystemAnalytics({
      requestId: 'r1',
      realtimeMetrics: DEFAULT_REALTIME_METRICS,
      routingAdvice: makeRouting(),
    });
    expect(result.systemHealth.overallScore).toBe(87);
    expect(result.systemHealth.status).toBe('healthy');
  });

  it('produces score 100 with perfect metrics', () => {
    // (1-0)*0.3 + 100*0.01*0.4 + 100*0.01*0.3 = 1.0 → ×100 → 100
    const result = buildSystemAnalytics({
      requestId: 'r2',
      realtimeMetrics: makeMetrics({ coldStartRate: 0, userExperienceScore: 100, audioExperienceScore: 100 }),
      routingAdvice: makeRouting(),
    });
    expect(result.systemHealth.overallScore).toBe(100);
    expect(result.systemHealth.status).toBe('healthy');
  });

  it('produces score 0 with worst-case metrics', () => {
    // (1-1)*0.3 + 0*0.01*0.4 + 0*0.01*0.3 = 0 → 0
    const result = buildSystemAnalytics({
      requestId: 'r3',
      realtimeMetrics: makeMetrics({ coldStartRate: 1, userExperienceScore: 0, audioExperienceScore: 0 }),
      routingAdvice: makeRouting(),
    });
    expect(result.systemHealth.overallScore).toBe(0);
    expect(result.systemHealth.status).toBe('critical');
  });

  it('status is warning when score in (60, 80]', () => {
    // Tune for ~65: coldStart=0.3, ux=60, audio=50
    // (0.7*0.3 + 0.6*0.4 + 0.5*0.3) = 0.21+0.24+0.15 = 0.60 → 60 → still warning?
    // Let's use values that produce ~70: coldStart=0.1, ux=70, audio=60
    // (0.9*0.3 + 0.7*0.4 + 0.6*0.3) = 0.27+0.28+0.18 = 0.73 → 73 → warning
    const result = buildSystemAnalytics({
      requestId: 'r4',
      realtimeMetrics: makeMetrics({ coldStartRate: 0.1, userExperienceScore: 70, audioExperienceScore: 60 }),
      routingAdvice: makeRouting(),
    });
    const score = result.systemHealth.overallScore;
    expect(score).toBeGreaterThan(60);
    expect(score).toBeLessThanOrEqual(80);
    expect(result.systemHealth.status).toBe('warning');
  });

  it('score > 80 gives healthy status', () => {
    const result = buildSystemAnalytics({
      requestId: 'r5',
      realtimeMetrics: makeMetrics({ coldStartRate: 0, userExperienceScore: 100, audioExperienceScore: 90 }),
      routingAdvice: makeRouting(),
    });
    expect(result.systemHealth.overallScore).toBeGreaterThan(80);
    expect(result.systemHealth.status).toBe('healthy');
  });

  it('score ≤ 60 gives critical status', () => {
    // (0.5*0.3 + 0.4*0.4 + 0.3*0.3) = 0.15+0.16+0.09 = 0.40 → 40
    const result = buildSystemAnalytics({
      requestId: 'r6',
      realtimeMetrics: makeMetrics({ coldStartRate: 0.5, userExperienceScore: 40, audioExperienceScore: 30 }),
      routingAdvice: makeRouting(),
    });
    expect(result.systemHealth.overallScore).toBeLessThanOrEqual(60);
    expect(result.systemHealth.status).toBe('critical');
  });
});

// ── Recommendations ───────────────────────────────────────────────────────────

describe('recommendations', () => {
  it('always includes baseline short-term and strategic items', () => {
    const result = buildSystemAnalytics({
      requestId: 'r10',
      realtimeMetrics: DEFAULT_REALTIME_METRICS,
      routingAdvice: makeRouting(),
    });
    expect(result.recommendations.shortTerm).toContain('Monitor TTFA improvements');
    expect(result.recommendations.shortTerm).toContain('Track circuit breaker effectiveness');
    expect(result.recommendations.strategic).toContain('Implement predictive scaling');
    expect(result.recommendations.strategic).toContain('Add A/B testing for optimization');
  });

  it('adds TTFA immediate recommendation when ttfaP95 > 600ms', () => {
    const result = buildSystemAnalytics({
      requestId: 'r11',
      realtimeMetrics: makeMetrics({ ttfaP95: 601 }),
      routingAdvice: makeRouting(),
    });
    expect(result.recommendations.immediate).toContain(
      'TTFA exceeds conversational threshold - optimize TTS streaming',
    );
  });

  it('does NOT add TTFA recommendation when ttfaP95 == 600ms (boundary)', () => {
    const result = buildSystemAnalytics({
      requestId: 'r12',
      realtimeMetrics: makeMetrics({ ttfaP95: 600 }),
      routingAdvice: makeRouting(),
    });
    expect(result.recommendations.immediate).not.toContain(
      'TTFA exceeds conversational threshold - optimize TTS streaming',
    );
  });

  it('adds health recommendation when systemHealthScore < 70', () => {
    // Score ~40: coldStart=0.5, ux=40, audio=30
    const result = buildSystemAnalytics({
      requestId: 'r13',
      realtimeMetrics: makeMetrics({ coldStartRate: 0.5, userExperienceScore: 40, audioExperienceScore: 30 }),
      routingAdvice: makeRouting(),
    });
    expect(result.recommendations.immediate).toContain('System health requires attention');
  });

  it('does NOT add health recommendation when score >= 70', () => {
    // Default score ~87
    const result = buildSystemAnalytics({
      requestId: 'r14',
      realtimeMetrics: DEFAULT_REALTIME_METRICS,
      routingAdvice: makeRouting(),
    });
    expect(result.recommendations.immediate).not.toContain('System health requires attention');
  });

  it('adds cold-start short-term recommendation when coldStartRate > 0.1', () => {
    const result = buildSystemAnalytics({
      requestId: 'r15',
      realtimeMetrics: makeMetrics({ coldStartRate: 0.11 }),
      routingAdvice: makeRouting(),
    });
    expect(result.recommendations.shortTerm).toContain(
      'High cold start rate - improve warmup procedures',
    );
  });

  it('does NOT add cold-start recommendation when coldStartRate == 0.1 (boundary)', () => {
    const result = buildSystemAnalytics({
      requestId: 'r16',
      realtimeMetrics: makeMetrics({ coldStartRate: 0.1 }),
      routingAdvice: makeRouting(),
    });
    expect(result.recommendations.shortTerm).not.toContain(
      'High cold start rate - improve warmup procedures',
    );
  });

  it('can accumulate multiple immediate recommendations simultaneously', () => {
    const result = buildSystemAnalytics({
      requestId: 'r17',
      realtimeMetrics: makeMetrics({ ttfaP95: 700, coldStartRate: 1, userExperienceScore: 0, audioExperienceScore: 0 }),
      routingAdvice: makeRouting(),
    });
    expect(result.recommendations.immediate).toContain(
      'TTFA exceeds conversational threshold - optimize TTS streaming',
    );
    expect(result.recommendations.immediate).toContain('System health requires attention');
  });

  it('no immediate recommendations when metrics are healthy', () => {
    const result = buildSystemAnalytics({
      requestId: 'r18',
      realtimeMetrics: makeMetrics({ ttfaP95: 400, coldStartRate: 0.02, userExperienceScore: 95, audioExperienceScore: 90 }),
      routingAdvice: makeRouting(),
    });
    expect(result.recommendations.immediate).toHaveLength(0);
  });
});

// ── Performance metric passthrough ────────────────────────────────────────────

describe('performance metrics passthrough', () => {
  it('maps TTFC metrics correctly', () => {
    const result = buildSystemAnalytics({
      requestId: 'r20',
      realtimeMetrics: makeMetrics({ ttfcP50: 200, ttfcP95: 350 }),
      routingAdvice: makeRouting(),
    });
    const ttfc = result.performance.ttfcMetrics;
    expect(ttfc.p50Ms).toBe(200);
    expect(ttfc.p95Ms).toBe(350);
  });

  it('ttfcMetrics.conversationalReady is true when ttfcP95 < 300', () => {
    const result = buildSystemAnalytics({
      requestId: 'r21',
      realtimeMetrics: makeMetrics({ ttfcP95: 299 }),
      routingAdvice: makeRouting(),
    });
    expect(result.performance.ttfcMetrics.conversationalReady).toBe(true);
  });

  it('ttfcMetrics.conversationalReady is false when ttfcP95 >= 300', () => {
    const result = buildSystemAnalytics({
      requestId: 'r22',
      realtimeMetrics: makeMetrics({ ttfcP95: 300 }),
      routingAdvice: makeRouting(),
    });
    expect(result.performance.ttfcMetrics.conversationalReady).toBe(false);
  });

  it('ttfcMetrics.remark is "Excellent" when ttfcP50 < 250', () => {
    const result = buildSystemAnalytics({
      requestId: 'r23',
      realtimeMetrics: makeMetrics({ ttfcP50: 249 }),
      routingAdvice: makeRouting(),
    });
    expect(result.performance.ttfcMetrics.remark).toContain('Excellent');
  });

  it('ttfcMetrics.remark is "Good" when ttfcP50 >= 250', () => {
    const result = buildSystemAnalytics({
      requestId: 'r24',
      realtimeMetrics: makeMetrics({ ttfcP50: 250 }),
      routingAdvice: makeRouting(),
    });
    expect(result.performance.ttfcMetrics.remark).toContain('Good');
  });

  it('ttfaMetrics.conversationalReady is true when ttfaP95 < 500', () => {
    const result = buildSystemAnalytics({
      requestId: 'r25',
      realtimeMetrics: makeMetrics({ ttfaP95: 499 }),
      routingAdvice: makeRouting(),
    });
    expect(result.performance.ttfaMetrics.conversationalReady).toBe(true);
  });

  it('ttfaMetrics.conversationalReady is false when ttfaP95 >= 500', () => {
    const result = buildSystemAnalytics({
      requestId: 'r26',
      realtimeMetrics: makeMetrics({ ttfaP95: 500 }),
      routingAdvice: makeRouting(),
    });
    expect(result.performance.ttfaMetrics.conversationalReady).toBe(false);
  });

  it('ttfaMetrics.remark is "Excellent" when ttfaP50 < 500', () => {
    const result = buildSystemAnalytics({
      requestId: 'r27',
      realtimeMetrics: makeMetrics({ ttfaP50: 499 }),
      routingAdvice: makeRouting(),
    });
    expect(result.performance.ttfaMetrics.remark).toContain('Excellent');
  });

  it('ttfaMetrics.remark is "Good" when ttfaP50 >= 500', () => {
    const result = buildSystemAnalytics({
      requestId: 'r28',
      realtimeMetrics: makeMetrics({ ttfaP50: 500 }),
      routingAdvice: makeRouting(),
    });
    expect(result.performance.ttfaMetrics.remark).toContain('Good');
  });

  it('passes cold start rate through to performance', () => {
    const result = buildSystemAnalytics({
      requestId: 'r29',
      realtimeMetrics: makeMetrics({ coldStartRate: 0.15 }),
      routingAdvice: makeRouting(),
    });
    expect(result.performance.coldStartRate).toBe(0.15);
  });
});

// ── Routing passthrough ───────────────────────────────────────────────────────

describe('routing passthrough', () => {
  it('maps routingAdvice fields to routing section', () => {
    const advice = makeRouting({
      provider: 'groq',
      confidence: 0.75,
      reason: 'GPU cold',
      costEstimate: 0.002,
    });
    const result = buildSystemAnalytics({
      requestId: 'r30',
      realtimeMetrics: DEFAULT_REALTIME_METRICS,
      routingAdvice: advice,
    });
    expect(result.routing.currentProviderBias).toBe('groq');
    expect(result.routing.confidence).toBe(0.75);
    expect(result.routing.reasoning).toBe('GPU cold');
    expect(result.routing.costPerRequest).toBe(0.002);
    expect(result.routing.activeStrategy).toBe('hybrid-gpu-first');
  });
});

// ── requestId passthrough ─────────────────────────────────────────────────────

describe('requestId passthrough', () => {
  it('echoes requestId into output', () => {
    const result = buildSystemAnalytics({
      requestId: 'unique-req-xyz',
      realtimeMetrics: DEFAULT_REALTIME_METRICS,
      routingAdvice: makeRouting(),
    });
    expect(result.requestId).toBe('unique-req-xyz');
  });
});

// ── Economics (static) ────────────────────────────────────────────────────────

describe('economics section', () => {
  it('returns static economics data', () => {
    const result = buildSystemAnalytics({
      requestId: 'r40',
      realtimeMetrics: DEFAULT_REALTIME_METRICS,
      routingAdvice: makeRouting(),
    });
    expect(result.economics.gpuCostHour).toBe(0.16);
    expect(result.economics.vsCompetitors.openaiRealtime).toBe(43.0);
    expect(result.economics.vsCompetitors.openaiSavings).toBe(99.6);
    expect(result.economics.aiGatewayEfficiency).toBe(0.95);
  });
});

// ── Output shape ──────────────────────────────────────────────────────────────

describe('output shape', () => {
  it('includes a valid ISO timestamp string', () => {
    const result = buildSystemAnalytics({
      requestId: 'r50',
      realtimeMetrics: DEFAULT_REALTIME_METRICS,
      routingAdvice: makeRouting(),
    });
    expect(() => new Date(result.timestamp).toISOString()).not.toThrow();
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes uptimeSeconds as a positive integer', () => {
    const result = buildSystemAnalytics({
      requestId: 'r51',
      realtimeMetrics: DEFAULT_REALTIME_METRICS,
      routingAdvice: makeRouting(),
    });
    expect(Number.isInteger(result.systemHealth.uptimeSeconds)).toBe(true);
    expect(result.systemHealth.uptimeSeconds).toBeGreaterThan(0);
  });

  it('recommendations object always has all three keys', () => {
    const result = buildSystemAnalytics({
      requestId: 'r52',
      realtimeMetrics: DEFAULT_REALTIME_METRICS,
      routingAdvice: makeRouting(),
    });
    expect(Array.isArray(result.recommendations.immediate)).toBe(true);
    expect(Array.isArray(result.recommendations.shortTerm)).toBe(true);
    expect(Array.isArray(result.recommendations.strategic)).toBe(true);
  });
});
