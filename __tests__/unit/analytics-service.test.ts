import { describe, it, expect } from 'vitest';
import {
  buildSystemAnalytics,
  DEFAULT_REALTIME_METRICS,
} from '../../src/gateway/routing/analytics-service';
import type { RealtimeMetrics, SystemAnalyticsPayload } from '../../src/gateway/routing/analytics-service';
import type { RoutingDecision } from '../../src/gateway/routing/hybrid-router';

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_ROUTING: RoutingDecision = {
  provider: 'groq',
  model: 'llama-3.1-8b',
  confidence: 0.85,
  estimatedLatencyMs: 250,
  reason: 'GPU not available',
  costEstimate: 0.0005,
};

function buildDefault(overrides?: Partial<RealtimeMetrics>): SystemAnalyticsPayload {
  return buildSystemAnalytics({
    requestId: 'req-001',
    realtimeMetrics: { ...DEFAULT_REALTIME_METRICS, ...overrides },
    routingAdvice: DEFAULT_ROUTING,
  });
}

// ── Structure / schema ────────────────────────────────────────────────────────

describe('buildSystemAnalytics — structure', () => {
  it('returns all top-level fields', () => {
    const result = buildDefault();

    expect(result).toHaveProperty('timestamp');
    expect(result).toHaveProperty('requestId');
    expect(result).toHaveProperty('systemHealth');
    expect(result).toHaveProperty('performance');
    expect(result).toHaveProperty('routing');
    expect(result).toHaveProperty('economics');
    expect(result).toHaveProperty('recommendations');
  });

  it('preserves requestId', () => {
    const result = buildSystemAnalytics({
      requestId: 'my-custom-id-123',
      realtimeMetrics: DEFAULT_REALTIME_METRICS,
      routingAdvice: DEFAULT_ROUTING,
    });
    expect(result.requestId).toBe('my-custom-id-123');
  });

  it('timestamp is an ISO 8601 string', () => {
    const result = buildDefault();
    expect(typeof result.timestamp).toBe('string');
    expect(() => new Date(result.timestamp)).not.toThrow();
    const d = new Date(result.timestamp);
    expect(isNaN(d.getTime())).toBe(false);
  });
});

// ── systemHealth ──────────────────────────────────────────────────────────────

describe('buildSystemAnalytics — systemHealth', () => {
  it('overallScore is a number in [0, 100]', () => {
    const result = buildDefault();
    expect(result.systemHealth.overallScore).toBeGreaterThanOrEqual(0);
    expect(result.systemHealth.overallScore).toBeLessThanOrEqual(100);
  });

  it('status is "healthy" when score > 80', () => {
    // Use ideal metrics to push score high
    const result = buildDefault({
      coldStartRate: 0.0,
      userExperienceScore: 100,
      audioExperienceScore: 100,
    });
    expect(result.systemHealth.overallScore).toBeGreaterThan(80);
    expect(result.systemHealth.status).toBe('healthy');
  });

  it('status is "warning" when score is between 60 and 80', () => {
    // coldStartRate=0.5 reduces score: (0.5*0.3 + UX*0.4 + Audio*0.3) * 100
    // With UX=70, audio=70: (0.5*0.3 + 0.7*0.4 + 0.7*0.3)*100 = (0.15+0.28+0.21)*100 = 64
    const result = buildDefault({
      coldStartRate: 0.5,
      userExperienceScore: 70,
      audioExperienceScore: 70,
    });
    expect(result.systemHealth.overallScore).toBeGreaterThan(60);
    expect(result.systemHealth.overallScore).toBeLessThanOrEqual(80);
    expect(result.systemHealth.status).toBe('warning');
  });

  it('status is "critical" when score ≤ 60', () => {
    const result = buildDefault({
      coldStartRate: 1.0,
      userExperienceScore: 10,
      audioExperienceScore: 10,
    });
    // (0*0.3 + 0.1*0.4 + 0.1*0.3)*100 = (0+0.04+0.03)*100 = 7
    expect(result.systemHealth.overallScore).toBeLessThanOrEqual(60);
    expect(result.systemHealth.status).toBe('critical');
  });

  it('overallScore is rounded to integer', () => {
    const result = buildDefault();
    expect(result.systemHealth.overallScore).toBe(Math.round(result.systemHealth.overallScore));
  });

  it('uptimeSeconds is a positive integer', () => {
    const result = buildDefault();
    expect(typeof result.systemHealth.uptimeSeconds).toBe('number');
    expect(result.systemHealth.uptimeSeconds).toBeGreaterThan(0);
    expect(Number.isInteger(result.systemHealth.uptimeSeconds)).toBe(true);
  });

  it('version is a non-empty string', () => {
    const result = buildDefault();
    expect(typeof result.systemHealth.version).toBe('string');
    expect(result.systemHealth.version.length).toBeGreaterThan(0);
  });
});

// ── performance ───────────────────────────────────────────────────────────────

describe('buildSystemAnalytics — performance', () => {
  it('ttfcMetrics.p50Ms reflects input ttfcP50', () => {
    const result = buildDefault({ ttfcP50: 199, ttfcP95: 350 });
    expect(result.performance.ttfcMetrics.p50Ms).toBe(199);
    expect(result.performance.ttfcMetrics.p95Ms).toBe(350);
  });

  it('ttfaMetrics.p50Ms reflects input ttfaP50', () => {
    const result = buildDefault({ ttfaP50: 420, ttfaP95: 750 });
    expect(result.performance.ttfaMetrics.p50Ms).toBe(420);
    expect(result.performance.ttfaMetrics.p95Ms).toBe(750);
  });

  it('ttfcMetrics.conversationalReady is true when ttfcP95 < 300', () => {
    const result = buildDefault({ ttfcP95: 299 });
    expect(result.performance.ttfcMetrics.conversationalReady).toBe(true);
  });

  it('ttfcMetrics.conversationalReady is false when ttfcP95 ≥ 300', () => {
    const result = buildDefault({ ttfcP95: 300 });
    expect(result.performance.ttfcMetrics.conversationalReady).toBe(false);
  });

  it('ttfaMetrics.conversationalReady is true when ttfaP95 < 500', () => {
    const result = buildDefault({ ttfaP95: 499 });
    expect(result.performance.ttfaMetrics.conversationalReady).toBe(true);
  });

  it('ttfaMetrics.conversationalReady is false when ttfaP95 ≥ 500', () => {
    const result = buildDefault({ ttfaP95: 500 });
    expect(result.performance.ttfaMetrics.conversationalReady).toBe(false);
  });

  it('ttfcMetrics.remark is excellent when ttfcP50 < 250', () => {
    const result = buildDefault({ ttfcP50: 200 });
    expect(result.performance.ttfcMetrics.remark).toContain('Excellent');
  });

  it('ttfcMetrics.remark is good when ttfcP50 ≥ 250', () => {
    const result = buildDefault({ ttfcP50: 250 });
    expect(result.performance.ttfcMetrics.remark).toContain('Good');
  });

  it('ttfaMetrics.remark is excellent when ttfaP50 < 500', () => {
    const result = buildDefault({ ttfaP50: 400 });
    expect(result.performance.ttfaMetrics.remark).toContain('Excellent');
  });

  it('ttfaMetrics.remark is good when ttfaP50 ≥ 500', () => {
    const result = buildDefault({ ttfaP50: 500 });
    expect(result.performance.ttfaMetrics.remark).toContain('Good');
  });

  it('coldStartRate reflects input', () => {
    const result = buildDefault({ coldStartRate: 0.12 });
    expect(result.performance.coldStartRate).toBeCloseTo(0.12);
  });

  it('userExperienceScore reflects input', () => {
    const result = buildDefault({ userExperienceScore: 72 });
    expect(result.performance.userExperienceScore).toBe(72);
  });

  it('audioExperienceScore reflects input', () => {
    const result = buildDefault({ audioExperienceScore: 65 });
    expect(result.performance.audioExperienceScore).toBe(65);
  });
});

// ── routing ───────────────────────────────────────────────────────────────────

describe('buildSystemAnalytics — routing', () => {
  it('currentProviderBias reflects routingAdvice.provider', () => {
    const result = buildSystemAnalytics({
      requestId: 'r1',
      realtimeMetrics: DEFAULT_REALTIME_METRICS,
      routingAdvice: { ...DEFAULT_ROUTING, provider: 'gpu' },
    });
    expect(result.routing.currentProviderBias).toBe('gpu');
  });

  it('confidence reflects routingAdvice.confidence', () => {
    const result = buildSystemAnalytics({
      requestId: 'r1',
      realtimeMetrics: DEFAULT_REALTIME_METRICS,
      routingAdvice: { ...DEFAULT_ROUTING, confidence: 0.42 },
    });
    expect(result.routing.confidence).toBeCloseTo(0.42);
  });

  it('reasoning reflects routingAdvice.reason', () => {
    const result = buildSystemAnalytics({
      requestId: 'r1',
      realtimeMetrics: DEFAULT_REALTIME_METRICS,
      routingAdvice: { ...DEFAULT_ROUTING, reason: 'custom reason' },
    });
    expect(result.routing.reasoning).toBe('custom reason');
  });

  it('costPerRequest reflects routingAdvice.costEstimate', () => {
    const result = buildSystemAnalytics({
      requestId: 'r1',
      realtimeMetrics: DEFAULT_REALTIME_METRICS,
      routingAdvice: { ...DEFAULT_ROUTING, costEstimate: 0.0012 },
    });
    expect(result.routing.costPerRequest).toBeCloseTo(0.0012);
  });

  it('activeStrategy is non-empty string', () => {
    const result = buildDefault();
    expect(typeof result.routing.activeStrategy).toBe('string');
    expect(result.routing.activeStrategy.length).toBeGreaterThan(0);
  });
});

// ── economics ─────────────────────────────────────────────────────────────────

describe('buildSystemAnalytics — economics', () => {
  it('gpuCostHour is a positive number', () => {
    const result = buildDefault();
    expect(typeof result.economics.gpuCostHour).toBe('number');
    expect(result.economics.gpuCostHour).toBeGreaterThan(0);
  });

  it('vsCompetitors.openaiRealtime is a positive number', () => {
    const result = buildDefault();
    expect(result.economics.vsCompetitors.openaiRealtime).toBeGreaterThan(0);
  });

  it('vsCompetitors.openaiSavings is a percentage in (0, 100]', () => {
    const result = buildDefault();
    expect(result.economics.vsCompetitors.openaiSavings).toBeGreaterThan(0);
    expect(result.economics.vsCompetitors.openaiSavings).toBeLessThanOrEqual(100);
  });

  it('aiGatewayEfficiency is in (0, 1]', () => {
    const result = buildDefault();
    expect(result.economics.aiGatewayEfficiency).toBeGreaterThan(0);
    expect(result.economics.aiGatewayEfficiency).toBeLessThanOrEqual(1);
  });

  it('optimizationStatus is non-empty string', () => {
    const result = buildDefault();
    expect(typeof result.economics.optimizationStatus).toBe('string');
    expect(result.economics.optimizationStatus.length).toBeGreaterThan(0);
  });
});

// ── recommendations ───────────────────────────────────────────────────────────

describe('buildSystemAnalytics — recommendations', () => {
  it('has immediate, shortTerm, strategic arrays', () => {
    const result = buildDefault();
    expect(Array.isArray(result.recommendations.immediate)).toBe(true);
    expect(Array.isArray(result.recommendations.shortTerm)).toBe(true);
    expect(Array.isArray(result.recommendations.strategic)).toBe(true);
  });

  it('adds immediate rec when ttfaP95 > 600', () => {
    const result = buildDefault({ ttfaP95: 601 });
    const hasRec = result.recommendations.immediate.some(r => r.toLowerCase().includes('ttfa'));
    expect(hasRec).toBe(true);
  });

  it('does not add TTFA rec when ttfaP95 ≤ 600', () => {
    const result = buildDefault({ ttfaP95: 600 });
    const hasRec = result.recommendations.immediate.some(r => r.toLowerCase().includes('ttfa'));
    expect(hasRec).toBe(false);
  });

  it('adds health rec when systemHealthScore < 70', () => {
    const result = buildDefault({
      coldStartRate: 1.0,
      userExperienceScore: 10,
      audioExperienceScore: 10,
    });
    const hasRec = result.recommendations.immediate.some(r => r.toLowerCase().includes('health'));
    expect(hasRec).toBe(true);
  });

  it('adds cold start rec to shortTerm when coldStartRate > 0.1', () => {
    const result = buildDefault({ coldStartRate: 0.15 });
    const hasRec = result.recommendations.shortTerm.some(r => r.toLowerCase().includes('cold start'));
    expect(hasRec).toBe(true);
  });

  it('does not add cold start rec when coldStartRate ≤ 0.1', () => {
    const result = buildDefault({ coldStartRate: 0.05 });
    const hasColdStartRec = result.recommendations.shortTerm.some(
      r => r.toLowerCase().includes('cold start'),
    );
    expect(hasColdStartRec).toBe(false);
  });

  it('shortTerm always has monitoring and circuit breaker recs', () => {
    const result = buildDefault();
    expect(result.recommendations.shortTerm.some(r => r.toLowerCase().includes('ttfa'))).toBe(true);
    expect(result.recommendations.shortTerm.some(r => r.toLowerCase().includes('circuit breaker'))).toBe(true);
  });

  it('strategic always has predictive scaling and A/B testing recs', () => {
    const result = buildDefault();
    expect(result.recommendations.strategic.some(r => r.toLowerCase().includes('predictive'))).toBe(true);
    expect(result.recommendations.strategic.some(r => r.toLowerCase().includes('a/b'))).toBe(true);
  });
});

// ── DEFAULT_REALTIME_METRICS export ──────────────────────────────────────────

describe('DEFAULT_REALTIME_METRICS', () => {
  it('is exported and has all required fields', () => {
    expect(DEFAULT_REALTIME_METRICS).toHaveProperty('ttfcP50');
    expect(DEFAULT_REALTIME_METRICS).toHaveProperty('ttfcP95');
    expect(DEFAULT_REALTIME_METRICS).toHaveProperty('ttfaP50');
    expect(DEFAULT_REALTIME_METRICS).toHaveProperty('ttfaP95');
    expect(DEFAULT_REALTIME_METRICS).toHaveProperty('coldStartRate');
    expect(DEFAULT_REALTIME_METRICS).toHaveProperty('userExperienceScore');
    expect(DEFAULT_REALTIME_METRICS).toHaveProperty('audioExperienceScore');
  });

  it('produces healthy status with default metrics', () => {
    const result = buildDefault();
    // Default metrics: coldStartRate=0.05, UX=85, audio=80
    // score = ((1-0.05)*0.3 + 0.85*0.4 + 0.8*0.3)*100 = (0.285+0.34+0.24)*100 = 86.5 → 87
    expect(result.systemHealth.overallScore).toBeGreaterThan(80);
    expect(result.systemHealth.status).toBe('healthy');
  });
});

// ── Health score formula ──────────────────────────────────────────────────────

describe('buildSystemAnalytics — health score formula', () => {
  it('score = round((1-coldStartRate)*0.3 + UX*0.01*0.4 + audio*0.01*0.3) * 100', () => {
    const metrics: RealtimeMetrics = {
      ttfcP50: 250, ttfcP95: 400,
      ttfaP50: 500, ttfaP95: 800,
      coldStartRate: 0.2,
      userExperienceScore: 60,
      audioExperienceScore: 50,
    };
    // (0.8*0.3 + 0.6*0.4 + 0.5*0.3)*100 = (0.24+0.24+0.15)*100 = 63 → warning
    const result = buildSystemAnalytics({
      requestId: 'x', realtimeMetrics: metrics, routingAdvice: DEFAULT_ROUTING,
    });
    expect(result.systemHealth.overallScore).toBe(63);
    expect(result.systemHealth.status).toBe('warning');
  });

  it('score = 100 when coldStartRate=0, UX=100, audio=100', () => {
    const result = buildDefault({ coldStartRate: 0, userExperienceScore: 100, audioExperienceScore: 100 });
    expect(result.systemHealth.overallScore).toBe(100);
  });

  it('score = 0 when coldStartRate=1, UX=0, audio=0', () => {
    const result = buildDefault({ coldStartRate: 1, userExperienceScore: 0, audioExperienceScore: 0 });
    expect(result.systemHealth.overallScore).toBe(0);
  });
});
