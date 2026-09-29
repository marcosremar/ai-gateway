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
}): SystemAnalyticsPayload {
  const { requestId, realtimeMetrics, routingAdvice } = opts;

  // System Health Calculation — produces a 0-100 score.
  // Weights (30% cold-start health, 40% UX score, 30% audio score) are
  // normalised to [0,1] then scaled to [0,100] so the status thresholds
  // (>80 healthy, >60 warning) are meaningful.
  const systemHealthScore = Math.round(
    ((1 - realtimeMetrics.coldStartRate) * 0.3 +
    realtimeMetrics.userExperienceScore * 0.01 * 0.4 +
    realtimeMetrics.audioExperienceScore * 0.01 * 0.3) * 100,
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
    economics: {
      gpuCostHour: 0.16,
      vsCompetitors: {
        openaiRealtime: 43.0,
        openaiSavings: 99.6,
      },
      optimizationStatus: 'TTFA streaming optimizations active',
      aiGatewayEfficiency: 0.95,
    },
    recommendations,
  };
}
