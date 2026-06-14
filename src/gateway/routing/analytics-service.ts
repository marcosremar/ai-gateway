// ── BabelCast Gateway — System Analytics Builder ─────────────────────────────
// Pure logic that constructs the analytics dashboard payload.
// Runtime signals (realtime metrics, routing advice) are passed in; no server/
// imports.

import type { RoutingDecision } from './hybrid-router';

export interface RealtimeMetrics {
  ttfcP50: number;
  ttfcP95: number;
  ttfaP50: number;
  ttfaP95: number;
  coldStartRate: number;
  userExperienceScore: number;
  audioExperienceScore: number;
}

export const DEFAULT_REALTIME_METRICS: RealtimeMetrics = {
  ttfcP50: 250,
  ttfcP95: 400,
  ttfaP50: 500,
  ttfaP95: 800,
  coldStartRate: 0.05,
  userExperienceScore: 85,
  audioExperienceScore: 80,
};

/**
 * Real spend signals used to compute the economics block instead of hardcoded
 * placeholders (#391). All optional — when omitted, the dashboard falls back to
 * the legacy demo constants so existing callers don't break.
 */
export interface EconomicsInput {
  /** Actual measured GPU cost per hour (USD), e.g. from daily_spend tracking. */
  gpuCostHour?: number;
  /** Reference competitor cost per hour for the same workload (USD). */
  competitorCostHour?: number;
  /** Fraction (0–1) of requests served by the cheaper self-hosted path. */
  selfHostedShare?: number;
}

/**
 * Compute the economics block from real spend figures.
 *
 * `openaiSavings` is the percentage saved vs the competitor cost; efficiency is
 * the share of traffic served by the cheaper path. Returns the legacy demo
 * constants when no real data is supplied. Exported for direct unit testing.
 */
export function computeEconomics(input?: EconomicsInput): SystemAnalyticsPayload['economics'] {
  const gpuCostHour = input?.gpuCostHour;
  const competitorCostHour = input?.competitorCostHour;

  // No real data → preserve the previous (clearly-labeled) demo values.
  if (gpuCostHour === undefined || competitorCostHour === undefined || competitorCostHour <= 0) {
    return {
      gpuCostHour: gpuCostHour ?? 0.16,
      vsCompetitors: { openaiRealtime: competitorCostHour ?? 43.0, openaiSavings: 99.6 },
      optimizationStatus: 'TTFA streaming optimizations active',
      aiGatewayEfficiency: input?.selfHostedShare ?? 0.95,
    };
  }

  const savingsPct = Math.max(0, (1 - gpuCostHour / competitorCostHour) * 100);
  return {
    gpuCostHour: Math.round(gpuCostHour * 1000) / 1000,
    vsCompetitors: {
      openaiRealtime: Math.round(competitorCostHour * 100) / 100,
      openaiSavings: Math.round(savingsPct * 10) / 10,
    },
    optimizationStatus: 'TTFA streaming optimizations active',
    aiGatewayEfficiency:
      input?.selfHostedShare !== undefined
        ? Math.max(0, Math.min(1, input.selfHostedShare))
        : 0.95,
  };
}

export interface SystemAnalyticsPayload {
  timestamp: string;
  requestId: string;
  systemHealth: {
    overallScore: number;
    status: 'healthy' | 'warning' | 'critical';
    uptimeSeconds: number;
    version: string;
  };
  performance: {
    ttfcMetrics: { p50Ms: number; p95Ms: number; conversationalReady: boolean; remark: string };
    ttfaMetrics: { p50Ms: number; p95Ms: number; conversationalReady: boolean; remark: string };
    coldStartRate: number;
    userExperienceScore: number;
    audioExperienceScore: number;
  };
  routing: {
    activeStrategy: string;
    currentProviderBias: string;
    confidence: number;
    reasoning: string;
    costPerRequest: number;
  };
  economics: {
    gpuCostHour: number;
    vsCompetitors: { openaiRealtime: number; openaiSavings: number };
    optimizationStatus: string;
    aiGatewayEfficiency: number;
  };
  recommendations: { immediate: string[]; shortTerm: string[]; strategic: string[] };
}

/**
 * Build the complete /v1/analytics/system response body.
 * Pure transformation — caller provides runtime signals, gets JSON-ready object.
 */
export function buildSystemAnalytics(opts: {
  requestId: string;
  realtimeMetrics: RealtimeMetrics;
  routingAdvice: RoutingDecision;
  /** Real spend signals for the economics block (#391). Optional. */
  economics?: EconomicsInput;
}): SystemAnalyticsPayload {
  const { requestId, realtimeMetrics, routingAdvice } = opts;

  // System Health Calculation
  const systemHealthScore = Math.round(
    (1 - realtimeMetrics.coldStartRate) * 0.3 +
    realtimeMetrics.userExperienceScore * 0.01 * 0.4 +
    realtimeMetrics.audioExperienceScore * 0.01 * 0.3,
  );

  const recommendations = {
    immediate: [] as string[],
    shortTerm: ['Monitor TTFA improvements', 'Track circuit breaker effectiveness'] as string[],
    strategic: ['Implement predictive scaling', 'Add A/B testing for optimization'] as string[],
  };

  if (realtimeMetrics.ttfaP95 > 600) {
    recommendations.immediate.push('TTFA exceeds conversational threshold - optimize TTS streaming');
  }
  if (systemHealthScore < 70) {
    recommendations.immediate.push('System health requires attention');
  }
  if (realtimeMetrics.coldStartRate > 0.1) {
    recommendations.shortTerm.push('High cold start rate - improve warmup procedures');
  }

  return {
    timestamp: new Date().toISOString(),
    requestId,
    systemHealth: {
      overallScore: systemHealthScore,
      status: systemHealthScore > 80 ? 'healthy' : systemHealthScore > 60 ? 'warning' : 'critical',
      uptimeSeconds: Math.floor(Date.now() / 1000),
      version: 'mistral-7b-ttfa-optimized',
    },
    performance: {
      ttfcMetrics: {
        p50Ms: realtimeMetrics.ttfcP50,
        p95Ms: realtimeMetrics.ttfcP95,
        conversationalReady: realtimeMetrics.ttfcP95 < 300,
        remark: realtimeMetrics.ttfcP50 < 250 ? 'Excellent text response speed' : 'Good text response speed',
      },
      ttfaMetrics: {
        p50Ms: realtimeMetrics.ttfaP50,
        p95Ms: realtimeMetrics.ttfaP95,
        conversationalReady: realtimeMetrics.ttfaP95 < 500,
        remark: realtimeMetrics.ttfaP50 < 500 ? 'Excellent audio response speed' : 'Good audio response speed',
      },
      coldStartRate: realtimeMetrics.coldStartRate,
      userExperienceScore: realtimeMetrics.userExperienceScore,
      audioExperienceScore: realtimeMetrics.audioExperienceScore,
    },
    routing: {
      activeStrategy: 'hybrid-gpu-first',
      currentProviderBias: routingAdvice.provider,
      confidence: routingAdvice.confidence,
      reasoning: routingAdvice.reason,
      costPerRequest: routingAdvice.costEstimate,
    },
    economics: computeEconomics(opts.economics),
    recommendations,
  };
}
