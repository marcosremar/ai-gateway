/**
 * Optimization implementation tests — Observability, Metrics & Cost Tracking
 * (audit IDs 501-600, docs/optimizations/06-observability-cost.md).
 *
 * Unit-only. No network. Pure logic + in-memory adapters + mocked state.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// #513 / #590 — metrics-collector: percentile math + Prometheus export
// ─────────────────────────────────────────────────────────────────────────────

import { metrics, percentileIndex } from '../../src/metrics-collector';

describe('#513 metrics-collector percentiles (nearest-rank, no Math.floor collapse)', () => {
  beforeEach(() => metrics.reset());

  it('percentileIndex is nearest-rank and ordered for tiny samples', () => {
    // n=3: ceil(3*0.5)-1 = 1 -> value 20 ; ceil(3*0.95)-1 = 2 -> value 30.
    expect(percentileIndex([10, 20, 30], 0.5)).toBe(20);
    expect(percentileIndex([10, 20, 30], 0.95)).toBe(30);
    // empty -> 0
    expect(percentileIndex([], 0.95)).toBe(0);
  });

  it('histogram p50 <= p95 <= p99 for a small sample (no floor overshoot)', () => {
    metrics.histogram('h.small', 10);
    metrics.histogram('h.small', 20);
    metrics.histogram('h.small', 30);
    const s = metrics.getHistogramStats('h.small')!;
    expect(s.p50).toBeLessThanOrEqual(s.p95);
    expect(s.p95).toBeLessThanOrEqual(s.p99);
    // p99 must NOT be forced to the max for a 3-sample series via floor(N*0.99)
    // (it legitimately equals max here only because nearest-rank index = 2).
    expect(s.p99).toBe(30);
    expect(s.max).toBe(30);
  });

  it('histogram percentiles match expected ranks for 1..100', () => {
    for (let i = 1; i <= 100; i++) metrics.histogram('h.big', i);
    const s = metrics.getHistogramStats('h.big')!;
    expect(s.p50).toBe(50); // ceil(100*0.5)-1 = 49 -> value 50
    expect(s.p95).toBe(95);
    expect(s.p99).toBe(99);
  });
});

describe('#590 metrics-collector exportPrometheus emits summary quantiles, not fake buckets', () => {
  beforeEach(() => metrics.reset());

  it('uses {quantile="..."} and _sum/_count, never _bucket{le="0.5"}', () => {
    metrics.histogram('lat.ms', 100, { provider: 'groq' });
    metrics.histogram('lat.ms', 200, { provider: 'groq' });
    const out = metrics.exportPrometheus();

    // The invalid histogram-bucket abuse must be gone.
    expect(out).not.toContain('_bucket{le="0.5"}');
    // No Prometheus histogram buckets at all (the `quantile="0.95"` summary
    // line legitimately contains the substring `le="0.95"`, so assert on the
    // bucket marker itself rather than that ambiguous fragment).
    expect(out).not.toContain('_bucket');

    // Proper summary representation: quantile label injected alongside existing labels.
    expect(out).toContain('quantile="0.5"');
    expect(out).toContain('quantile="0.95"');
    expect(out).toContain('quantile="0.99"');
    expect(out).toContain('provider="groq"');
    expect(out).toContain('lat.ms_sum');
    expect(out).toContain('lat.ms_count');
    // existing labels preserved in the quantile lines
    expect(out).toMatch(/lat\.ms\{provider="groq",quantile="0\.5"\} 100/);
  });

  it('label-less histogram still produces valid summary lines', () => {
    metrics.histogram('plain', 5);
    const out = metrics.exportPrometheus();
    expect(out).toMatch(/plain\{quantile="0\.5"\} 5/);
    expect(out).toContain('plain_count 1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #514 — performance-profiler percentiles
// ─────────────────────────────────────────────────────────────────────────────

import { recordOperationTiming, getOperationStats } from '../../src/performance-profiler';

describe('#514 performance-profiler getOperationStats nearest-rank', () => {
  it('p50 <= p95 <= max for a 2-sample op (no floor overshoot)', () => {
    recordOperationTiming('op.tiny', 10);
    recordOperationTiming('op.tiny', 100);
    const stats = getOperationStats()['op.tiny'];
    expect(stats.count).toBe(2);
    expect(stats.p50).toBeLessThanOrEqual(stats.p95);
    expect(stats.p95).toBeLessThanOrEqual(stats.max);
    // ceil(2*0.5)-1 = 0 -> 10 ; ceil(2*0.95)-1 = 1 -> 100
    expect(stats.p50).toBe(10);
    expect(stats.p95).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #515 — benchmark-tracker computeStats p50 <= p95
// ─────────────────────────────────────────────────────────────────────────────

import { BenchmarkTracker } from '../../src/tracking/benchmark-tracker';
import { InMemoryStateAdapter } from '../../src/adapters/in-memory-state';

describe('#515 benchmark-tracker stats keep p50 <= p95 invariant', () => {
  it('computeStats via daily summary is ordered for small samples', async () => {
    const store = new InMemoryStateAdapter();
    const tracker = new BenchmarkTracker(store);
    const ts = Date.parse('2026-06-14T00:00:00Z');
    for (const d of [10, 20, 30]) {
      await tracker.recordBoot({
        userId: 'u1', provider: 'runpod', tierIndex: 0,
        durationMs: d, wasDiscovered: false, timestamp: ts,
      });
    }
    const summary = await tracker.getDailySummary('u1', '2026-06-14');
    expect(summary.boot).not.toBeNull();
    expect(summary.boot!.p50).toBeLessThanOrEqual(summary.boot!.p95);
    expect(summary.boot!.p95).toBeLessThanOrEqual(summary.boot!.max);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #552 — SpendTracker.record atomic increment (no lost updates under concurrency)
// ─────────────────────────────────────────────────────────────────────────────

import { SpendTracker, type SpendRecord } from '../../src/tracking/spend-tracker';

function mkRecord(costUsd: number): SpendRecord {
  return {
    userId: 'user-1',
    provider: 'openai',
    model: 'gpt-4o',
    stage: 'llm',
    inputTokens: 100,
    outputTokens: 50,
    costUsd,
    timestamp: Date.parse('2026-06-14T12:00:00Z'),
  };
}

describe('#552 SpendTracker.record is atomic (concurrent increments not lost)', () => {
  it('100 concurrent records accumulate exactly via atomic hincrby', async () => {
    const store = new InMemoryStateAdapter();
    const tracker = new SpendTracker(store);

    // Fire all records concurrently — the old read-modify-write would clobber
    // increments because each read sees the same starting value.
    await Promise.all(Array.from({ length: 100 }, () => tracker.record(mkRecord(0.01))));

    const fast = await tracker.getDailyTotalFast('user-1', '2026-06-14');
    expect(fast.requestCount).toBe(100);
    // 100 * $0.01 = $1.00 (micro-dollar integer accumulation, no float drift)
    expect(fast.totalCostUsd).toBeCloseTo(1.0, 6);
  });

  it('getDailyTotalFast reads the precomputed hash, not the records list', async () => {
    const store = new InMemoryStateAdapter();
    const tracker = new SpendTracker(store);
    await tracker.record(mkRecord(0.25));
    await tracker.record(mkRecord(0.75));
    const fast = await tracker.getDailyTotalFast('user-1', '2026-06-14');
    expect(fast.requestCount).toBe(2);
    expect(fast.totalCostUsd).toBeCloseTo(1.0, 6);
  });

  it('negative cost is still rejected (no corruption)', async () => {
    const store = new InMemoryStateAdapter();
    const tracker = new SpendTracker(store);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await tracker.record(mkRecord(-5));
    warn.mockRestore();
    const fast = await tracker.getDailyTotalFast('user-1', '2026-06-14');
    expect(fast.requestCount).toBe(0);
    expect(fast.totalCostUsd).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #525 / #526 / #528 — cost-tracker unmapped + per-provider + budget folding
//   server/state is mocked so we can assert cloud spend folds into the budget
//   counter WITHOUT loading the heavy real state module.
// ─────────────────────────────────────────────────────────────────────────────

// Exercise the REAL state module. cost-tracker lazily `require('./state')`,
// which vi.mock cannot reliably intercept; server/state re-exports the
// cost-state daily-spend counter + setter (`export * from cost-state`), so we
// drive and read the genuine budget counter — a true integration check of #528.
import * as gwState from '../../server/state';

import {
  recordInferenceCost,
  getInferenceCostStats,
  resetDailyInferenceCost,
} from '../../server/cost-tracker';

describe('#525/#526 cost-tracker surfaces unmapped pairs and per-provider breakdown', () => {
  beforeEach(() => {
    resetDailyInferenceCost();
    gwState.setDailyGpuSpendUsd(0);
  });

  it('mapped + GPU behavior preserved (backward compatible)', () => {
    recordInferenceCost('groq', 'stt');
    recordInferenceCost('gpu', 'llm');
    const s = getInferenceCostStats();
    expect(s.requests).toBe(2);
    expect(s.totalUsd).toBeGreaterThan(0);
    expect(s.byProvider.gpu).toBe(0); // GPU is $0 here (hourly rental)
    expect(s.unmappedRequests).toBe(0);
  });

  it('unknown provider:stage records $0 but is COUNTED (#525)', () => {
    recordInferenceCost('deepgram', 'stt'); // not in COST_PER_REQUEST
    recordInferenceCost('elevenlabs', 'tts');
    const s = getInferenceCostStats();
    expect(s.requests).toBe(2);
    expect(s.totalUsd).toBe(0);
    expect(s.unmappedRequests).toBe(2);
  });

  it('per-provider cost breakdown is tracked (#526)', () => {
    recordInferenceCost('openai', 'llm', 2000); // 0.003 * 2 = 0.006
    recordInferenceCost('groq', 'stt');         // 0.001
    const s = getInferenceCostStats();
    expect(s.byProvider.openai).toBeCloseTo(0.006, 5);
    expect(s.byProvider.groq).toBeCloseTo(0.001, 5);
  });
});

describe('#528 cloud inference cost folds into the daily budget counter', () => {
  beforeEach(() => {
    resetDailyInferenceCost();
    gwState.setDailyGpuSpendUsd(0);
  });

  it('cloud (non-GPU) spend is added to dailyGpuSpendUsd via setter', () => {
    recordInferenceCost('openai', 'llm', 1000); // 0.003
    expect(gwState.dailyGpuSpendUsd).toBeCloseTo(0.003, 6);
    recordInferenceCost('groq', 'stt');          // +0.001
    expect(gwState.dailyGpuSpendUsd).toBeCloseTo(0.004, 6);
  });

  it('GPU stages do NOT touch the budget counter (their cost is hourly rental)', () => {
    recordInferenceCost('gpu', 'stt');
    recordInferenceCost('gpu', 'llm');
    expect(gwState.dailyGpuSpendUsd).toBe(0);
  });

  it('unmapped $0 pairs do not move the budget counter', () => {
    recordInferenceCost('deepgram', 'stt');
    expect(gwState.dailyGpuSpendUsd).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #580 — server event-bus handler error counter
// ─────────────────────────────────────────────────────────────────────────────

import {
  onGatewayEvent,
  emitGatewayEvent,
  handlerErrorCount,
} from '../../server/event-bus';

describe('#580 server event-bus counts handler exceptions', () => {
  it('throwing handler increments the per-event error counter but does not throw', () => {
    const before = handlerErrorCount('test.evt');
    const off = onGatewayEvent((evt) => {
      if (evt === 'test.evt') throw new Error('boom');
    });
    expect(() => emitGatewayEvent('test.evt', { x: 1 })).not.toThrow();
    expect(() => emitGatewayEvent('test.evt', { x: 2 })).not.toThrow();
    off();
    expect(handlerErrorCount('test.evt')).toBe(before + 2);
    expect(handlerErrorCount()).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #582 — emitHook failure counter
// ─────────────────────────────────────────────────────────────────────────────

import { emitHook, getHookErrorCount, resetHookErrorCounts } from '../../src/events/hooks';

describe('#582 emitHook counts hook callback failures', () => {
  beforeEach(() => resetHookErrorCounts());

  it('counts synchronous throws per hook', () => {
    const hooks = {
      onError: () => { throw new Error('sync fail'); },
    };
    emitHook(hooks, 'onError', {
      source: 'request', operation: 'test', message: 'm', retryable: false, timestamp: Date.now(),
    });
    expect(getHookErrorCount('onError')).toBe(1);
    expect(getHookErrorCount()).toBe(1);
  });

  it('counts rejected promises per hook', async () => {
    const hooks = {
      onRequestEnd: async () => { throw new Error('async fail'); },
    };
    emitHook(hooks, 'onRequestEnd', {
      userId: 'u', stage: 'llm', provider: 'groq', latencyMs: 1, success: true, timestamp: Date.now(),
    });
    // allow the rejected microtask to settle
    await new Promise((r) => setTimeout(r, 0));
    expect(getHookErrorCount('onRequestEnd')).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #595 / #596 — AlertRouter retry + always-deliver-critical + suppressed count
// ─────────────────────────────────────────────────────────────────────────────

import { AlertRouter } from '../../src/alerting/alert-router';
import type { AlertChannel, AlertPayload } from '../../src/alerting/types';

function payload(over: Partial<AlertPayload> = {}): AlertPayload {
  return {
    severity: 'warning',
    title: over.title ?? 'T',
    message: over.message ?? 'M',
    timestamp: new Date(),
    ...over,
  };
}

describe('#595 AlertRouter retries a failing channel once', () => {
  it('succeeds on the second attempt after a transient failure', async () => {
    let attempts = 0;
    const ch: AlertChannel = {
      name: 'flaky',
      async send() {
        attempts++;
        if (attempts === 1) throw new Error('503');
      },
    };
    const router = new AlertRouter([ch], { retries: 1, retryDelayMs: 0 });
    await router.route(payload());
    expect(attempts).toBe(2);
  });
});

describe('#596 AlertRouter never drops critical alerts and counts suppressed ones', () => {
  it('rate-limits non-critical alerts but counts the drops', async () => {
    const sent: string[] = [];
    const ch: AlertChannel = {
      name: 'cap',
      async send(p) { sent.push(p.title); },
    };
    const router = new AlertRouter([ch], {
      rateLimit: { max: 2, windowMs: 60_000 },
      dedupeWindowMs: 0,
      retryDelayMs: 0,
    });

    // 4 distinct warnings; only 2 fit under the cap.
    await router.route(payload({ title: 'w1' }));
    await router.route(payload({ title: 'w2' }));
    await router.route(payload({ title: 'w3' }));
    await router.route(payload({ title: 'w4' }));

    expect(sent.length).toBe(2);
    expect(router.getSuppressedCount()).toBe(2);
  });

  it('critical alerts always deliver even over the rate cap', async () => {
    const sent: string[] = [];
    const ch: AlertChannel = {
      name: 'cap',
      async send(p) { sent.push(p.title); },
    };
    const router = new AlertRouter([ch], {
      rateLimit: { max: 1, windowMs: 60_000 },
      dedupeWindowMs: 0,
      retryDelayMs: 0,
    });

    await router.route(payload({ title: 'w1' }));                       // fills cap
    await router.route(payload({ title: 'w2' }));                       // suppressed
    await router.route(payload({ title: 'CRIT', severity: 'critical' })); // must deliver

    expect(sent).toContain('CRIT');
    expect(router.getSuppressedCount()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #558 — cost-anomaly-detector absolute background-spike fallback (no baseline)
// ─────────────────────────────────────────────────────────────────────────────

import { createCostAnomalyDetector } from '../../src/tracking/cost-anomaly-detector';
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

describe('#558 cost-anomaly-detector flags day-one background spike with no baseline', () => {
  it('uses absolute threshold when yesterday has zero data', async () => {
    const store = fakeUsageStore({
      async countByContext() { return 5000; },  // today, high
      async countInRange() { return 0; },        // yesterday, none
    });
    const detector = createCostAnomalyDetector(store, { absoluteBackgroundSpikeCount: 1000 });
    const anomalies = await detector.detectAnomalies();
    const spike = anomalies.find((a) => a.type === 'background_spike');
    expect(spike).toBeDefined();
    expect(spike!.data!.absolute).toBe(true);
  });

  it('does not false-positive below the absolute threshold with no baseline', async () => {
    const store = fakeUsageStore({
      async countByContext() { return 10; },
      async countInRange() { return 0; },
    });
    const detector = createCostAnomalyDetector(store, { absoluteBackgroundSpikeCount: 1000 });
    const anomalies = await detector.detectAnomalies();
    expect(anomalies.find((a) => a.type === 'background_spike')).toBeUndefined();
  });
});
