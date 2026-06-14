/**
 * Optimization implementation tests — Observability, Metrics & Cost Tracking
 * WAVE 3 (audit IDs 501-600, docs/optimizations/06-observability-cost.md).
 *
 * Covers a DISTINCT batch from waves 1 & 2:
 *   #501 cached sorted latency ring on scrape
 *   #502 diagnostics sorts ring once + shared percentile
 *   #527 inference-cost cumulative load/persist getter
 *   #530 pricing table asOf stamp + staleness check
 *   #532 blended cost-per-GPU-request relabel
 *   #533 cloudRequests = total − gpu
 *   #534 RunPod volume rate configurable + estimator
 *   #557 per-user baseline (z-score) spend anomaly
 *   #563 cost-per-successful-request metric
 *   #578 EventBus per-type history ring
 *   #587 error-summary true error-RATE alert
 *   #592 provider label allow-list (bucket "other")
 *   #593 bounded GPU-status enum gauge
 *   #594 monotonic gateway_inference_spend_usd_total counter
 *   #598 SLO evaluator over a metrics snapshot
 *
 * Unit-only. No network. Pure logic + in-memory adapters + mocked deps.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// #530 — pricing table is dated + flags staleness
// ─────────────────────────────────────────────────────────────────────────────

import { PRICING_TABLE_AS_OF, isPricingStale } from '../../src/tracking/pricing';

describe('#530 pricing table carries a revision date and flags staleness', () => {
  it('exposes a parseable YYYY-MM-DD asOf stamp', () => {
    expect(PRICING_TABLE_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(new Date(`${PRICING_TABLE_AS_OF}T00:00:00Z`).getTime())).toBe(false);
  });

  it('is fresh just after the stamp and stale long after it', () => {
    const asOf = new Date(`${PRICING_TABLE_AS_OF}T00:00:00Z`);
    const oneMonthLater = new Date(asOf.getTime() + 30 * 24 * 3600_000);
    const eightMonthsLater = new Date(asOf.getTime() + 8 * 30 * 24 * 3600_000);
    expect(isPricingStale(6, oneMonthLater)).toBe(false);
    expect(isPricingStale(6, eightMonthsLater)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #598 — SLO evaluator compares a metrics snapshot against the targets
// ─────────────────────────────────────────────────────────────────────────────

import {
  evaluateSlos,
  breachAction,
  SLO_TARGETS,
  SLO_BREACH_POLICY,
} from '../../src/alerting/slo-targets';

describe('#598 SLO evaluator detects breaches from a metrics snapshot', () => {
  it('flags latency/spend ceilings exceeded and uptime floor missed', () => {
    const breaches = evaluateSlos(
      {
        chatP95Ms: SLO_TARGETS.chatP95Ms + 1, // over
        sttP95Ms: SLO_TARGETS.sttP95Ms - 1,    // under (ok)
        uptimeRatio: SLO_TARGETS.uptimeRatio - 0.01, // below floor → breach
        dailySpendUsd: 999,
      },
      { DAILY_BUDGET_USD: '50' } as any,
    );
    const byMetric = Object.fromEntries(breaches.map((b) => [b.metric, b]));
    expect(byMetric.chatP95Ms.direction).toBe('over');
    expect(byMetric.uptimeRatio.direction).toBe('under');
    expect(byMetric.dailySpendUsd.observed).toBe(999);
    expect(byMetric.sttP95Ms).toBeUndefined(); // within target, not a breach
  });

  it('daily-spend SLO derives from the live budget env (#599 linkage)', () => {
    // With a raised cap, $120 spend is NOT a breach.
    expect(evaluateSlos({ dailySpendUsd: 120 }, { DAILY_BUDGET_USD: '200' } as any)
      .some((b) => b.metric === 'dailySpendUsd')).toBe(false);
    // With the default cap it IS.
    expect(evaluateSlos({ dailySpendUsd: 120 }, {} as any)
      .some((b) => b.metric === 'dailySpendUsd')).toBe(true);
  });

  it('skips SLOs whose metric is absent from the snapshot', () => {
    expect(evaluateSlos({})).toEqual([]);
  });

  it('breachAction escalates per SLO_BREACH_POLICY', () => {
    expect(breachAction(0)).toBe('none');
    expect(breachAction(SLO_BREACH_POLICY.warningThreshold)).toBe('warn');
    expect(breachAction(SLO_BREACH_POLICY.pageThreshold)).toBe('page');
    expect(breachAction(SLO_BREACH_POLICY.failoverThreshold)).toBe('failover');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #578 — EventBus per-type history ring (no full-ring scan on filtered query)
// ─────────────────────────────────────────────────────────────────────────────

import { eventBus } from '../../src/event-bus';

describe('#578 EventBus getHistory(type) reads a per-type ring', () => {
  beforeEach(() => {
    eventBus.offAll();
    eventBus.clearHistory();
  });

  it('returns only the requested type, in chronological order', async () => {
    await eventBus.emit('a.evt', { i: 0 }, 't');
    await eventBus.emit('b.evt', { j: 0 }, 't');
    await eventBus.emit('a.evt', { i: 1 }, 't');

    const a = eventBus.getHistory('a.evt');
    expect(a.map((e) => (e.data as { i: number }).i)).toEqual([0, 1]);
    expect(eventBus.getHistory('b.evt')).toHaveLength(1);
    // unknown type → empty, not a throw
    expect(eventBus.getHistory('nope.evt')).toEqual([]);
    // unfiltered still returns everything chronologically
    expect(eventBus.getHistory().map((e) => e.type)).toEqual(['a.evt', 'b.evt', 'a.evt']);
  });

  it('clearHistory() also clears the per-type rings', async () => {
    await eventBus.emit('a.evt', {}, 't');
    eventBus.clearHistory();
    expect(eventBus.getHistory('a.evt')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #557 — per-user baseline (z-score) spend anomaly
// ─────────────────────────────────────────────────────────────────────────────

import {
  createCostAnomalyDetector,
  spendZScore,
  type UserSpendBaseline,
} from '../../src/tracking/cost-anomaly-detector';
import type { UsageLogStore } from '../../src/deps';

function fakeUsageStore(over: Partial<UsageLogStore> = {}): UsageLogStore {
  return {
    async groupByUser() { return []; },
    async countByContext() { return 0; },
    async countInRange() { return 0; },
    async groupByModelAndRoute() { return []; },
    async countByStage() { return 0; },
    ...over,
  };
}

describe('#557 cost-anomaly-detector flags spend spikes relative to a user baseline', () => {
  it('spendZScore guards a near-zero stddev', () => {
    expect(spendZScore(10, 2, 4)).toBe(2);
    expect(spendZScore(1, 1, 0)).toBe(0);          // equal to mean, no variance
    expect(spendZScore(5, 1, 0)).toBe(Infinity);   // above mean, zero variance
  });

  it('flags a normally-cheap user whose spend jumps many sigma above their mean', async () => {
    const baselines: UserSpendBaseline[] = [
      // power user: high spend but in-line with their own history → NOT flagged
      { userId: 'power', todayUsd: 12, meanUsd: 11, stdDevUsd: 2 },
      // cheap user spiking from a $0.01 norm → flagged even though it's < $1
      { userId: 'cheap', todayUsd: 0.5, meanUsd: 0.01, stdDevUsd: 0.02 },
    ];
    const detector = createCostAnomalyDetector(
      fakeUsageStore(),
      { baselineSpikeZScore: 3, baselineSpikeMinUsd: 0.1 },
      { getUserSpendBaselines: () => baselines },
    );
    const spikes = (await detector.detectAnomalies()).filter((a) => a.type === 'baseline_spend_spike');
    expect(spikes).toHaveLength(1);
    expect(spikes[0].data!.userId).toBe('cheap');
    expect(spikes[0].severity).toBe('critical'); // >= 2x the z threshold
  });

  it('does not run the baseline check when no baseline provider is supplied', async () => {
    const detector = createCostAnomalyDetector(fakeUsageStore());
    const out = await detector.detectAnomalies();
    expect(out.some((a) => a.type === 'baseline_spend_spike')).toBe(false);
  });

  it('ignores spikes below the absolute floor (avoids near-zero noise)', async () => {
    const baselines: UserSpendBaseline[] = [
      { userId: 'tiny', todayUsd: 0.02, meanUsd: 0.001, stdDevUsd: 0.001 },
    ];
    const detector = createCostAnomalyDetector(
      fakeUsageStore(),
      { baselineSpikeMinUsd: 0.1 },
      { getUserSpendBaselines: () => baselines },
    );
    expect((await detector.detectAnomalies()).some((a) => a.type === 'baseline_spend_spike')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #587 — error-summary true error-RATE alert when total ops are tracked
// ─────────────────────────────────────────────────────────────────────────────

import { errorSummary } from '../../src/error-summary';
import { DeployError } from '../../src/errors/deploy-errors';

describe('#587 error-summary computes a true error rate when operations are recorded', () => {
  beforeEach(() => {
    errorSummary.clear();
    errorSummary.clearAlerts();
  });

  it('50 errors out of 60 ops trips the rate alert (catastrophic)', () => {
    for (let i = 0; i < 60; i++) errorSummary.recordOperation();
    for (let i = 0; i < 50; i++) errorSummary.record(new DeployError('NETWORK', 'NET_TIMEOUT', {}));
    errorSummary._forceAlertCheck();
    const alerts = errorSummary.getAlerts();
    const rate = alerts.find((a) => a.type === 'high_error_rate');
    expect(rate).toBeDefined();
    // currentValue is the fractional rate (≈0.83), not a raw count
    expect(rate!.currentValue).toBeGreaterThan(0.5);
    expect(rate!.currentValue).toBeLessThanOrEqual(1);
  });

  it('50 errors out of 50,000 ops does NOT trip the rate alert (noise)', () => {
    for (let i = 0; i < 5000; i++) errorSummary.recordOperation(); // ring caps at 5000
    for (let i = 0; i < 50; i++) errorSummary.record(new DeployError('NETWORK', 'NET_TIMEOUT', {}));
    errorSummary._forceAlertCheck();
    // 50 / 5000 = 1% < 10% threshold → no rate alert
    expect(errorSummary.getAlerts().some((a) => a.type === 'high_error_rate')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #534 — RunPod volume cost rate is configurable + estimator exported
// ─────────────────────────────────────────────────────────────────────────────

import { estRunpodVolumeMonthlyUsd } from '../../server/gpu-cost-audit';

describe('#534 RunPod volume monthly-cost estimate', () => {
  it('uses the default ~$0.10/GB/mo rate when env unset', () => {
    expect(estRunpodVolumeMonthlyUsd(100)).toBeCloseTo(10.0, 5);
    expect(estRunpodVolumeMonthlyUsd(0)).toBe(0);
    expect(estRunpodVolumeMonthlyUsd(NaN)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #527 / #563 / #594 — cost-tracker cumulative total + per-success + load
// ─────────────────────────────────────────────────────────────────────────────

import {
  recordInferenceCost,
  getInferenceCostStats,
  getCumulativeInferenceCostUsd,
  loadInferenceCostTotal,
  resetDailyInferenceCost,
} from '../../server/cost-tracker';
import * as gwState from '../../server/state';

describe('#594 cost-tracker keeps a monotonic cumulative total across daily resets', () => {
  beforeEach(() => {
    resetDailyInferenceCost();
    gwState.setDailyGpuSpendUsd(0);
  });

  it('cumulative survives resetDailyInferenceCost while the daily total zeroes', () => {
    recordInferenceCost('openai', 'tts'); // mapped, non-zero
    const before = getInferenceCostStats();
    expect(before.totalUsd).toBeGreaterThan(0);
    expect(before.cumulativeUsd).toBeCloseTo(before.totalUsd, 6);

    resetDailyInferenceCost();
    const after = getInferenceCostStats();
    expect(after.totalUsd).toBe(0);                       // daily reset
    expect(after.cumulativeUsd).toBeCloseTo(before.totalUsd, 6); // cumulative kept
  });

  it('#527 loadInferenceCostTotal seeds the cumulative counter (monotonic only)', () => {
    loadInferenceCostTotal(5.0);
    expect(getCumulativeInferenceCostUsd()).toBeCloseTo(5.0, 6);
    loadInferenceCostTotal(3.0); // lower value ignored — never goes backwards
    expect(getCumulativeInferenceCostUsd()).toBeCloseTo(5.0, 6);
    recordInferenceCost('openai', 'tts');
    expect(getCumulativeInferenceCostUsd()).toBeGreaterThan(5.0);
  });
});

describe('#563 cost-tracker exposes cost per SUCCESSFUL request per provider', () => {
  beforeEach(() => {
    resetDailyInferenceCost();
    gwState.setDailyGpuSpendUsd(0);
  });

  it('divides provider cost by successes only (errors inflate the ratio)', () => {
    // two openai:tts requests, one failed → cost counted for both, success=1
    recordInferenceCost('openai', 'tts', undefined, true);
    recordInferenceCost('openai', 'tts', undefined, false);
    const stats = getInferenceCostStats();
    const totalCost = stats.byProvider.openai;
    expect(totalCost).toBeGreaterThan(0);
    // cost-per-success = totalCost / 1 success (not / 2 requests)
    expect(stats.costPerSuccessByProvider.openai).toBeCloseTo(totalCost, 6);
  });

  it('omits providers with $0 cost (no signal)', () => {
    recordInferenceCost('ollama', 'llm'); // mapped at $0
    const stats = getInferenceCostStats();
    expect(stats.byProvider.ollama).toBe(0);
    expect(stats.costPerSuccessByProvider.ollama).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #501 / #532 / #533 / #592 / #593 / #594 — metrics snapshot + Prometheus render
// ─────────────────────────────────────────────────────────────────────────────

import {
  getMetricsSnapshot,
  renderPrometheusMetrics,
  isKnownProvider,
  getSortedLatencies,
  computePercentile,
} from '../../server/metrics';
import { latencyRing, metricsCounters, recordGpuLatency, deployState } from '../../server/state';

function clearLatencyRing(): void {
  latencyRing.length = 0;
  // bump generation so the cache invalidates
  recordGpuLatency(1);
  latencyRing.length = 0;
}

function resetCounters(): void {
  metricsCounters.requestsTotal = 0;
  metricsCounters.errorsTotal = 0;
  for (const k of Object.keys(metricsCounters.byProvider)) delete metricsCounters.byProvider[k];
  for (const k of Object.keys(metricsCounters.byStage)) delete metricsCounters.byStage[k];
}

describe('#501 sorted latency ring is cached per generation', () => {
  beforeEach(() => clearLatencyRing());

  it('returns the same sorted array reference until a new sample arrives', () => {
    recordGpuLatency(30);
    recordGpuLatency(10);
    recordGpuLatency(20);
    const a = getSortedLatencies();
    const b = getSortedLatencies();
    expect(a).toBe(b);                       // cache hit → identical reference
    expect(a).toEqual([10, 20, 30]);         // and correctly sorted
    expect(computePercentile(a, 50)).toBe(20);

    recordGpuLatency(5);                      // new sample bumps generation
    const c = getSortedLatencies();
    expect(c).not.toBe(a);                    // cache refreshed
    expect(c).toEqual([5, 10, 20, 30]);
  });
});

describe('#533 / #532 cost rollups in the metrics snapshot', () => {
  beforeEach(() => {
    resetCounters();
    resetDailyInferenceCost();
  });

  it('cloudRequests = total − gpu (not an allow-list sum)', () => {
    metricsCounters.requestsTotal = 10;
    metricsCounters.byProvider['gpu'] = 4;
    metricsCounters.byProvider['fireworks'] = 3; // omitted by the old allow-list sum
    metricsCounters.byProvider['deepgram'] = 3;
    const snap = getMetricsSnapshot();
    const cost = snap.cost as { gpuRequests: number; cloudRequests: number };
    expect(cost.gpuRequests).toBe(4);
    expect(cost.cloudRequests).toBe(6); // 10 − 4, captures fireworks + deepgram
  });

  it('#532 blended cost-per-GPU-request key is honestly named', () => {
    metricsCounters.byProvider['gpu'] = 5;
    deployState.costPerHr = 2;
    gwState.setDailyGpuSpendUsd(10);
    const cost = getMetricsSnapshot().cost as Record<string, unknown>;
    expect('blendedCostPerGpuRequestUsd' in cost).toBe(true);
    expect('costPerGpuRequest' in cost).toBe(false); // old misleading name gone
    expect(cost.blendedCostPerGpuRequestUsd).toBeCloseTo(2, 5); // 10 / 5
  });
});

describe('#592 / #593 / #594 Prometheus exposition', () => {
  beforeEach(() => {
    resetCounters();
    resetDailyInferenceCost();
  });

  it('isKnownProvider gates the allow-list', () => {
    expect(isKnownProvider('groq')).toBe(true);
    expect(isKnownProvider('deepgram')).toBe(true);
    expect(isKnownProvider('some-random-provider')).toBe(false);
  });

  it('#592 unknown providers collapse into a single "other" series', () => {
    metricsCounters.requestsTotal = 3;
    metricsCounters.byProvider['groq'] = 1;
    metricsCounters.byProvider['mystery-x'] = 1;
    metricsCounters.byProvider['mystery-y'] = 1;
    const text = renderPrometheusMetrics();
    expect(text).toContain('gateway_requests_by_provider{provider="groq"} 1');
    expect(text).toContain('gateway_requests_by_provider{provider="other"} 2'); // x + y merged
    expect(text).not.toContain('mystery-x');
    expect(text).not.toContain('mystery-y');
  });

  it('#593 GPU status is a bounded enum gauge (exactly one is 1)', () => {
    deployState.status = 'booting';
    const text = renderPrometheusMetrics();
    expect(text).toContain('gateway_gpu_status{status="booting"} 1');
    expect(text).toContain('gateway_gpu_status{status="ready"} 0');
    // an out-of-enum status maps to "other", never a free-form label series
    deployState.status = 'some-weird-status' as any;
    const text2 = renderPrometheusMetrics();
    expect(text2).toContain('gateway_gpu_status{status="other"} 1');
    expect(text2).not.toContain('some-weird-status');
  });

  it('#594 monotonic cumulative inference spend is exported as a counter', () => {
    recordInferenceCost('openai', 'tts'); // non-zero cloud cost
    const text = renderPrometheusMetrics();
    expect(text).toContain('# TYPE gateway_inference_spend_usd_total counter');
    const m = text.match(/gateway_inference_spend_usd_total (\d+(?:\.\d+)?)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
  });
});

// keep deployState from leaking a weird status into other suites
afterEach(() => {
  if (deployState) deployState.status = 'idle' as any;
});
