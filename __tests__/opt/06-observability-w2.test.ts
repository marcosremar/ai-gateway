/**
 * Optimization implementation tests — Observability, Metrics & Cost Tracking
 * WAVE 2 (audit IDs 501-600, docs/optimizations/06-observability-cost.md).
 *
 * Covers a DIFFERENT batch than __tests__/opt/06-observability.test.ts (wave 1,
 * which covered #513/#590/#514/#515/#552/#525/#526/#528/#580/#582/#595/#596/#558).
 *
 * Unit-only. No network. Pure logic + in-memory adapters + mocked deps.
 */

// NOTE: must be set BEFORE importing the metrics-collector — the cardinality cap
// is read once at module load. A small cap makes #589 cheap to exercise.
process.env.METRICS_MAX_SERIES_PER_METRIC = '3';

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// #577 — src EventBus history is a ring buffer (O(1) emit, no Array.shift())
// ─────────────────────────────────────────────────────────────────────────────

import { eventBus } from '../../src/event-bus';

describe('#577 EventBus history ring buffer keeps emit O(1) and order correct', () => {
  beforeEach(() => {
    eventBus.offAll();
    eventBus.clearHistory();
  });

  it('retains chronological order and bounds size; getHistory filters by type', async () => {
    for (let i = 0; i < 5; i++) await eventBus.emit('t.evt', { i }, 'test');
    await eventBus.emit('other.evt', { x: 1 }, 'test');

    const all = eventBus.getHistory();
    // Oldest first, newest last.
    expect(all[0].type).toBe('t.evt');
    expect((all[0].data as { i: number }).i).toBe(0);
    expect(all[all.length - 1].type).toBe('other.evt');

    const filtered = eventBus.getHistory('t.evt');
    expect(filtered).toHaveLength(5);
    expect(filtered.map((e) => (e.data as { i: number }).i)).toEqual([0, 1, 2, 3, 4]);

    expect(eventBus.getStats().historySize).toBe(6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #579 / #581 — server event-bus bounded history + skip stringify when quiet
// ─────────────────────────────────────────────────────────────────────────────

import {
  emitGatewayEvent,
  getEventHistory,
  clearEventHistory,
} from '../../server/event-bus';

describe('#579 server event-bus keeps a bounded, queryable history', () => {
  beforeEach(() => clearEventHistory());

  it('records emitted events chronologically and filters by name', () => {
    emitGatewayEvent('gpu.deployed', { podId: 'p1' });
    emitGatewayEvent('budget.warning', { pct: 0.5 });
    emitGatewayEvent('gpu.deployed', { podId: 'p2' });

    const all = getEventHistory();
    expect(all).toHaveLength(3);
    expect(all[0].event).toBe('gpu.deployed');
    expect(all[2].event).toBe('gpu.deployed');

    const gpu = getEventHistory('gpu.deployed');
    expect(gpu).toHaveLength(2);
    expect(gpu.map((e) => (e.data as { podId: string }).podId)).toEqual(['p1', 'p2']);
    // payload carries injected timestamp + event name
    expect(typeof gpu[0].data.timestamp).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #584 / #585 — request-logger id index (O(1) logResponse) + cached RPM epoch
// ─────────────────────────────────────────────────────────────────────────────

import { requestLogger } from '../../src/request-logger';

describe('#584 request-logger logResponse/getById use an id index', () => {
  beforeEach(() => requestLogger.clear());

  it('updates the matching entry by id and evicts the index on overflow', () => {
    requestLogger.log({ requestId: 'r1', method: 'POST', path: '/v1/chat' });
    requestLogger.log({ requestId: 'r2', method: 'POST', path: '/v1/chat' });
    requestLogger.logResponse({ requestId: 'r2', statusCode: 503, durationMs: 12, error: 'boom' });

    const r2 = requestLogger.getById('r2');
    expect(r2?.statusCode).toBe(503);
    expect(r2?.error).toBe('boom');
    // untouched request keeps no status
    expect(requestLogger.getById('r1')?.statusCode).toBeUndefined();
    // unknown id is a no-op, not a throw
    expect(() => requestLogger.logResponse({ requestId: 'nope', statusCode: 200, durationMs: 1 })).not.toThrow();
  });

  it('#585 getStats RPM counts recent entries via cached epoch (tsMs)', () => {
    requestLogger.log({ requestId: 'a', method: 'GET', path: '/health' });
    requestLogger.log({ requestId: 'b', method: 'GET', path: '/health' });
    const stats = requestLogger.getStats();
    expect(stats.total).toBe(2);
    expect(stats.requestsPerMinute).toBe(2);
    // entries carry a numeric epoch cache
    expect(typeof requestLogger.getById('a')?.tsMs).toBe('number');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #586 — error-summary caches epoch ms (tsMs) and filters with it
// ─────────────────────────────────────────────────────────────────────────────

import { errorSummary } from '../../src/error-summary';
import { DeployError } from '../../src/errors/deploy-errors';

describe('#586 error-summary stores epoch ms alongside the ISO timestamp', () => {
  beforeEach(() => {
    errorSummary.clear();
    errorSummary.clearAlerts();
  });

  it('records errors and returns them in the recent-summary window', () => {
    const err = new DeployError('NETWORK', 'NET_TIMEOUT', { detail: 'x' });
    const recorded = errorSummary.record(err, 'deploy-1');
    expect(recorded).toBe(err);
    expect(errorSummary.count).toBe(1);
    const summary = errorSummary.getSummary(24);
    expect(summary.totalErrors).toBeGreaterThanOrEqual(1);
    // non-DeployError is ignored (returns null)
    expect(errorSummary.record({ not: 'an error' })).toBeNull();
    expect(errorSummary.count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #589 — metrics-collector cardinality guard (cap distinct label-sets/metric)
// ─────────────────────────────────────────────────────────────────────────────

import { metrics } from '../../src/metrics-collector';

describe('#589 metrics-collector caps series per metric to avoid cardinality blowup', () => {
  beforeEach(() => {
    metrics.reset();
    metrics.setMaxSeriesPerMetric(3); // small cap for a cheap, deterministic test
  });

  it('drops new label-sets past the cap but keeps updating existing ones', () => {
    // cap is 3 (env override above). 4 distinct userIds → 1 dropped.
    for (let i = 0; i < 4; i++) metrics.increment('req.total', { userId: `u${i}` });
    expect(metrics.getCounter('req.total', { userId: 'u0' })).toBe(1);
    expect(metrics.getCounter('req.total', { userId: 'u1' })).toBe(1);
    expect(metrics.getCounter('req.total', { userId: 'u2' })).toBe(1);
    // u3 was over the cap → not stored.
    expect(metrics.getCounter('req.total', { userId: 'u3' })).toBe(0);
    expect(metrics.getDroppedCardinalityCount()).toBe(1);

    // Existing keys still increment freely (not a new series).
    metrics.increment('req.total', { userId: 'u0' });
    expect(metrics.getCounter('req.total', { userId: 'u0' })).toBe(2);
    expect(metrics.getDroppedCardinalityCount()).toBe(1);
  });

  it('cap is per-metric-name, not global; gauges/histograms share the gate', () => {
    for (let i = 0; i < 5; i++) metrics.gauge('mem.bytes', i, { host: `h${i}` });
    // 3 kept, 2 dropped for this metric.
    expect(metrics.getGauge('mem.bytes', { host: 'h0' })).toBe(0);
    expect(metrics.getGauge('mem.bytes', { host: 'h4' })).toBeUndefined();
    expect(metrics.getDroppedCardinalityCount()).toBe(2);

    // A different metric name gets its own fresh budget.
    metrics.histogram('lat.ms', 1, { p: 'a' });
    metrics.histogram('lat.ms', 2, { p: 'a' });
    expect(metrics.getHistogramStats('lat.ms', { p: 'a' })!.count).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #597 — AlertRouter dedupe expires lazily on lookup (no per-route full scan)
// ─────────────────────────────────────────────────────────────────────────────

import { AlertRouter } from '../../src/alerting/alert-router';
import type { AlertChannel, AlertPayload } from '../../src/alerting/types';

function payload(over: Partial<AlertPayload> = {}): AlertPayload {
  return { severity: 'warning', title: over.title ?? 'T', message: over.message ?? 'M', timestamp: new Date(), ...over };
}

describe('#597 AlertRouter dedupe re-fires after the window via lazy expiry', () => {
  it('dedupes within window, then allows the same alert once expired', async () => {
    const sent: string[] = [];
    const ch: AlertChannel = { name: 'c', async send(p) { sent.push(p.title); } };
    const router = new AlertRouter([ch], { dedupeWindowMs: 1000, retryDelayMs: 0 });

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(10_000);
    await router.route(payload({ title: 'dup' })); // delivered
    await router.route(payload({ title: 'dup' })); // within window → deduped
    expect(sent).toEqual(['dup']);

    nowSpy.mockReturnValue(12_000); // 2s later, past the 1s window
    await router.route(payload({ title: 'dup' })); // re-fires
    expect(sent).toEqual(['dup', 'dup']);
    nowSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #559 / #560 / #561 / #562 — cost-anomaly-detector alerting + new anomaly types
// ─────────────────────────────────────────────────────────────────────────────

import {
  createCostAnomalyDetector,
  type IdleGpuSnapshot,
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

describe('#562 cost-anomaly-detector flags idle billing GPU waste', () => {
  it('flags a GPU that has not served a request past the idle threshold', async () => {
    const T0 = 1_000_000_000_000;
    const snap: IdleGpuSnapshot = { active: true, costPerHr: 2.0, lastRequestMs: T0 - 45 * 60_000 };
    const detector = createCostAnomalyDetector(
      fakeUsageStore(),
      { idleGpuMinutes: 30 },
      { getIdleGpuSnapshot: () => snap, now: () => T0 },
    );
    const anomalies = await detector.detectAnomalies();
    const idle = anomalies.find((a) => a.type === 'idle_gpu_waste');
    expect(idle).toBeDefined();
    expect(idle!.data!.idleMinutes).toBe(45);
    expect(idle!.data!.wastedUsd as number).toBeCloseTo(1.5, 4); // 45min @ $2/hr
  });

  it('does not flag a GPU within the idle window or one not billing', async () => {
    const T0 = 1_000_000_000_000;
    const recent = createCostAnomalyDetector(
      fakeUsageStore(),
      { idleGpuMinutes: 30 },
      { getIdleGpuSnapshot: () => ({ active: true, costPerHr: 2, lastRequestMs: T0 - 5 * 60_000 }), now: () => T0 },
    );
    expect((await recent.detectAnomalies()).find((a) => a.type === 'idle_gpu_waste')).toBeUndefined();

    const free = createCostAnomalyDetector(
      fakeUsageStore(),
      {},
      { getIdleGpuSnapshot: () => ({ active: true, costPerHr: 0, lastRequestMs: 0 }), now: () => T0 },
    );
    expect((await free.detectAnomalies()).find((a) => a.type === 'idle_gpu_waste')).toBeUndefined();
  });
});

describe('#561 cost-anomaly-detector estimates realtime cost from duration', () => {
  it('uses sumRealtimeDurationMinutes when available to estimate $', async () => {
    const store = fakeUsageStore({
      async countByStage() { return 2; }, // 2 realtime sessions
    });
    // augment with the optional duration query the detector probes for
    (store as unknown as { sumRealtimeDurationMinutes: () => Promise<number> })
      .sumRealtimeDurationMinutes = async () => 10; // 10 audio-minutes today

    const detector = createCostAnomalyDetector(store, { realtimeUsdPerMinute: 0.06 });
    const anomalies = await detector.detectAnomalies();
    const rt = anomalies.find((a) => a.type === 'untracked_realtime');
    expect(rt).toBeDefined();
    expect(rt!.data!.estimated).toBe(true);
    expect(rt!.data!.estUsd as number).toBeCloseTo(0.6, 4); // 10 * 0.06
  });

  it('falls back to count-only when no duration query is available', async () => {
    const store = fakeUsageStore({ async countByStage() { return 3; } });
    const detector = createCostAnomalyDetector(store);
    const rt = (await detector.detectAnomalies()).find((a) => a.type === 'untracked_realtime');
    expect(rt).toBeDefined();
    expect(rt!.data!.estimated).toBeUndefined();
    expect(rt!.data!.count).toBe(3);
  });
});

describe('#559/#560 detectAndAlert routes warning/critical anomalies to the sink', () => {
  it('routes non-info anomalies and skips info ones', async () => {
    const routed: Array<{ severity: string; title: string }> = [];
    const sink = { route: (p: { severity: string; title: string }) => { routed.push(p); } };
    const store = fakeUsageStore({
      // a critical high-spend user (warning/critical) ...
      async groupByUser() { return [{ userId: 'u9', costUsd: 9 }]; },
      // ... plus an info-level realtime anomaly that must NOT be routed
      async countByStage() { return 1; },
    });
    const detector = createCostAnomalyDetector(store, {}, { alertSink: sink as any });

    const anomalies = await detector.detectAndAlert();
    expect(anomalies.some((a) => a.type === 'high_spend_user')).toBe(true);
    expect(anomalies.some((a) => a.type === 'untracked_realtime')).toBe(true);
    // only the high-spend (critical) one was routed; the info realtime one was not
    expect(routed).toHaveLength(1);
    expect(routed[0].severity).toBe('critical');
    expect(routed[0].title).toContain('high_spend_user');
  });

  it('a throwing sink never breaks detection', async () => {
    const sink = { route: () => { throw new Error('sink down'); } };
    const store = fakeUsageStore({ async groupByUser() { return [{ userId: 'u', costUsd: 2 }]; } });
    const detector = createCostAnomalyDetector(store, {}, { alertSink: sink as any });
    await expect(detector.detectAndAlert()).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #524 — cost-tracker now maps deepgram / fireworks:tts / elevenlabs / ollama
// ─────────────────────────────────────────────────────────────────────────────

import {
  recordInferenceCost,
  getInferenceCostStats,
  resetDailyInferenceCost,
} from '../../server/cost-tracker';
import * as gwState from '../../server/state';

describe('#524 cost-tracker maps previously-missing provider:stage pairs (no silent $0 gap)', () => {
  beforeEach(() => {
    resetDailyInferenceCost();
    gwState.setDailyGpuSpendUsd(0);
  });

  it('fireworks:tts now records non-zero and is not unmapped (was a silent $0 gap)', () => {
    recordInferenceCost('fireworks', 'tts');
    const s = getInferenceCostStats();
    expect(s.unmappedRequests).toBe(0);
    expect(s.byProvider.fireworks).toBeGreaterThan(0);
    expect(s.totalUsd).toBeGreaterThan(0);
    // folded into the budget counter (cloud, non-GPU)
    expect(gwState.dailyGpuSpendUsd).toBeGreaterThan(0);
  });

  it('ollama (self-hosted) is mapped at $0 but COUNTED, not unmapped', () => {
    recordInferenceCost('ollama', 'llm');
    recordInferenceCost('ollama', 'stt');
    recordInferenceCost('ollama', 'tts');
    const s = getInferenceCostStats();
    expect(s.requests).toBe(3);
    expect(s.unmappedRequests).toBe(0);
    expect(s.byProvider.ollama).toBe(0);
    // $0 mapped pairs do not move the budget counter
    expect(gwState.dailyGpuSpendUsd).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #537 — gpu-cost-audit estimates stopped-pod monthly storage cost
// ─────────────────────────────────────────────────────────────────────────────

import { estStoppedPodMonthlyUsd } from '../../server/gpu-cost-audit';

describe('#537 stopped-pod audit attaches a monthly storage cost estimate', () => {
  it('estimates from disk size, defaulting when unknown', () => {
    // default rate 0.10/GB/mo, default disk 30GB → $3.00
    expect(estStoppedPodMonthlyUsd(undefined)).toBeCloseTo(3.0, 5);
    expect(estStoppedPodMonthlyUsd(0)).toBeCloseTo(3.0, 5); // 0 falls back to default
    expect(estStoppedPodMonthlyUsd(100)).toBeCloseTo(10.0, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #556 — SpendTracker counts invalid (negative/non-finite) cost records
// ─────────────────────────────────────────────────────────────────────────────

import { SpendTracker, type SpendRecord } from '../../src/tracking/spend-tracker';
import { InMemoryStateAdapter } from '../../src/adapters/in-memory-state';

function mkRecord(costUsd: number): SpendRecord {
  return {
    userId: 'u1', provider: 'openai', model: 'gpt-4o', stage: 'llm',
    inputTokens: 100, outputTokens: 50, costUsd, timestamp: Date.parse('2026-06-14T12:00:00Z'),
  };
}

describe('#556 SpendTracker exposes an invalid-record counter', () => {
  it('counts negative and non-finite costs and excludes them from the total', async () => {
    const tracker = new SpendTracker(new InMemoryStateAdapter());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await tracker.record(mkRecord(0.5));   // valid
    await tracker.record(mkRecord(-1));    // invalid
    await tracker.record(mkRecord(NaN));   // invalid
    await tracker.record(mkRecord(Infinity)); // invalid
    warn.mockRestore();

    expect(tracker.getInvalidCount()).toBe(3);
    const fast = await tracker.getDailyTotalFast('u1', '2026-06-14');
    expect(fast.requestCount).toBe(1);
    expect(fast.totalCostUsd).toBeCloseTo(0.5, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #555 — budget-guard default downgrades have no self-mapping no-ops
// ─────────────────────────────────────────────────────────────────────────────

import { BudgetGuard } from '../../src/tracking/budget-guard';

describe('#555 budget-guard default downgrades only list real cheaper tiers', () => {
  it('downgrades gpt-4o but never emits a self-mapping for already-cheapest models', async () => {
    // Stub spend tracker reporting 90% spend → degrade band (>= 0.8, < 1.0).
    const spend = { async getDailySummary() { return { totalCostUsd: 9, date: '', requestCount: 0, byProvider: {}, byStage: {} }; } };
    const guard = new BudgetGuard(spend as any);

    const res = await guard.checkAndDowngrade(
      'u1',
      [
        { provider: 'openai', model: 'gpt-4o' },
        { provider: 'openai', model: 'gpt-4o-mini-tts' }, // already cheapest — must pass through unchanged
      ],
      'llm',
      10,
    );
    expect(res.downgraded).toBe(true);
    const models = res.chain.map((e) => e.model);
    expect(models[0]).toBe('gpt-4o-mini'); // real downgrade
    expect(models[1]).toBe('gpt-4o-mini-tts'); // unchanged (no self-map drift)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #599 — SLO daily-spend target derives from DAILY_BUDGET_USD env
// ─────────────────────────────────────────────────────────────────────────────

import { resolveDailySpendSlo, SLO_TARGETS } from '../../src/alerting/slo-targets';

describe('#599 daily-spend SLO is derived from the live budget env', () => {
  it('uses DAILY_BUDGET_USD when set to a positive number', () => {
    expect(resolveDailySpendSlo({ DAILY_BUDGET_USD: '120' } as any)).toBe(120);
  });

  it('falls back to the documented default when unset/zero/invalid', () => {
    expect(resolveDailySpendSlo({} as any)).toBe(SLO_TARGETS.dailySpendUsd);
    expect(resolveDailySpendSlo({ DAILY_BUDGET_USD: '0' } as any)).toBe(SLO_TARGETS.dailySpendUsd);
    expect(resolveDailySpendSlo({ DAILY_BUDGET_USD: 'abc' } as any)).toBe(SLO_TARGETS.dailySpendUsd);
    expect(resolveDailySpendSlo({ DAILY_BUDGET_USD: '-5' } as any)).toBe(SLO_TARGETS.dailySpendUsd);
  });
});
