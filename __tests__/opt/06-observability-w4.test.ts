/**
 * Optimization implementation tests — Observability, Metrics & Cost Tracking
 * WAVE 4 (audit IDs 501-600, docs/optimizations/06-observability-cost.md).
 *
 * Covers a DISTINCT batch from waves 1-3:
 *   #504 GPU-only latency ring → GPU-scoped metric names (+ corrected HELP)
 *   #529 per-unit (char/minute) pricing for TTS/STT that don't bill per token
 *   #531 amortize hourly GPU rental over per-request wall-clock latency
 *   #548 CostWatcher.reportFrom(getSpend) — wire the live spend counter in
 *   #553 BudgetGuard uses the O(1) daily-total hash, not the list scan
 *   #554 SpendTracker.checkBudgetFast — authoritative untruncated daily hash
 *   #588 metrics-collector dropped the pointless per-sample ring (counter only)
 *   #591 real cumulative gateway_gpu_latency_ms histogram for histogram_quantile
 *
 * Unit-only. No network. Pure logic + in-memory adapters + injected fakes.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// #529 — per-unit pricing (characters / audio-minutes), not tokens
// ─────────────────────────────────────────────────────────────────────────────

import {
  estimateUnitCost,
  lookupUnitPricing,
  estimateRequestCost,
  DEFAULT_UNIT_PRICING,
} from '../../src/tracking/pricing';

describe('#529 per-unit pricing for audio models that do not bill per token', () => {
  it('prices OpenAI TTS by character, not token', () => {
    const p = lookupUnitPricing('openai', 'tts-1');
    expect(p).not.toBeNull();
    expect(p!.unit).toBe('character');
    // 1000 chars at $15 / 1M chars = $0.015.
    const cost = estimateUnitCost('openai', 'tts-1', 1000);
    expect(cost).toBeCloseTo(0.015, 6);
  });

  it('prices Whisper STT per audio-minute', () => {
    const p = lookupUnitPricing('openai', 'whisper-large-v3-turbo');
    expect(p!.unit).toBe('minute');
    // 5 minutes * $0.006/min = $0.03.
    expect(estimateUnitCost('openai', 'whisper-large-v3-turbo', 5)).toBeCloseTo(0.03, 6);
  });

  it('returns null for models with no per-unit rate (caller falls back to tokens)', () => {
    expect(estimateUnitCost('groq', 'llama-3.1-8b-instant', 1000)).toBeNull();
    expect(lookupUnitPricing('groq', 'llama-3.1-8b-instant')).toBeNull();
  });

  it('clamps invalid / negative unit counts to 0 cost', () => {
    expect(estimateUnitCost('openai', 'tts-1', -5)).toBe(0);
    expect(estimateUnitCost('openai', 'tts-1', NaN)).toBe(0);
  });

  it('does not disturb the existing token-based estimator', () => {
    // gpt-4o-mini: $0.15/1M in, $0.60/1M out.
    const cost = estimateRequestCost('openai', 'gpt-4o-mini', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.75, 6);
  });

  it('exposes a non-empty unit-pricing table for audio providers', () => {
    expect(Object.keys(DEFAULT_UNIT_PRICING).length).toBeGreaterThan(0);
    expect(DEFAULT_UNIT_PRICING['openai/tts-1-hd'].unit).toBe('character');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #531 — amortize hourly GPU rental over per-request latency
// ─────────────────────────────────────────────────────────────────────────────

import { amortizeHourlyCost } from '../../src/tracking/pricing';

describe('#531 amortize hourly GPU cost over a single request', () => {
  it('charges costPerHr * (latencyMs / 3,600,000)', () => {
    // $3.60/hr for a 1000ms request = $0.001.
    expect(amortizeHourlyCost(3.6, 1000)).toBeCloseTo(0.001, 9);
    // A full hour of requests sums to the hourly rate.
    expect(amortizeHourlyCost(2.0, 3_600_000)).toBeCloseTo(2.0, 9);
  });

  it('returns 0 for non-positive / invalid inputs', () => {
    expect(amortizeHourlyCost(0, 1000)).toBe(0);
    expect(amortizeHourlyCost(-1, 1000)).toBe(0);
    expect(amortizeHourlyCost(2, -5)).toBe(0);
    expect(amortizeHourlyCost(NaN, 1000)).toBe(0);
  });

  it('scales linearly with latency (longer request = more cost)', () => {
    const short = amortizeHourlyCost(5, 100);
    const long = amortizeHourlyCost(5, 1000);
    expect(long).toBeCloseTo(short * 10, 9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #554 / #553 — SpendTracker & BudgetGuard read the atomic daily hash, not
// the (truncatable, O(n)) per-record list.
// ─────────────────────────────────────────────────────────────────────────────

import { SpendTracker } from '../../src/tracking/spend-tracker';
import type { SpendRecord } from '../../src/tracking/spend-tracker';
import { BudgetGuard } from '../../src/tracking/budget-guard';
import type { StateStore } from '../../src/deps';

/** Minimal in-memory StateStore with a list, hash, and atomic hincrby. */
function makeStore(): StateStore & { _hashes: Map<string, Record<string, string>>; _lists: Map<string, string[]> } {
  const lists = new Map<string, string[]>();
  const hashes = new Map<string, Record<string, string>>();
  const store: any = {
    _hashes: hashes,
    _lists: lists,
    async get() { return null; },
    async set() {},
    async del() {},
    async rpush(key: string, v: string) {
      const arr = lists.get(key) ?? [];
      arr.push(v);
      lists.set(key, arr);
      return arr.length;
    },
    async lrange(key: string, start: number, stop: number) {
      const arr = lists.get(key) ?? [];
      const s = start < 0 ? arr.length + start : start;
      const e = stop < 0 ? arr.length + stop : stop;
      return arr.slice(s, e + 1);
    },
    async ltrim(key: string, start: number, stop: number) {
      const arr = lists.get(key) ?? [];
      const s = start < 0 ? Math.max(0, arr.length + start) : start;
      const e = stop < 0 ? arr.length + stop : stop;
      lists.set(key, arr.slice(s, e + 1));
    },
    async hgetall(key: string) { return hashes.get(key) ?? {}; },
    async hset(key: string, field: string, value: string) {
      const h = hashes.get(key) ?? {};
      h[field] = value;
      hashes.set(key, h);
    },
    async hincrby(key: string, field: string, by: number) {
      const h = hashes.get(key) ?? {};
      const cur = parseInt(h[field] ?? '0', 10) || 0;
      h[field] = String(cur + by);
      hashes.set(key, h);
      return cur + by;
    },
  };
  return store;
}

const TODAY = new Date().toISOString().slice(0, 10);

function rec(over: Partial<SpendRecord> = {}): SpendRecord {
  return {
    userId: 'u1',
    provider: 'openai',
    model: 'gpt-4o',
    stage: 'llm',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0.10,
    timestamp: Date.parse(`${TODAY}T12:00:00Z`),
    ...over,
  };
}

describe('#554 checkBudgetFast reads the untruncated atomic daily hash', () => {
  let store: ReturnType<typeof makeStore>;
  let tracker: SpendTracker;

  beforeEach(() => {
    store = makeStore();
    tracker = new SpendTracker(store);
  });

  it('sums the daily hash (not the capped list) for the budget total', async () => {
    await tracker.record(rec({ costUsd: 0.40 }));
    await tracker.record(rec({ costUsd: 0.30 }));
    const status = await tracker.checkBudgetFast('u1', { dailyLimitUsd: 1.0 });
    expect(status.currentUsd).toBeCloseTo(0.70, 6);
    expect(status.over).toBe(false);
    expect(status.pct).toBeCloseTo(0.70, 6);
  });

  it('marks over-budget when the hash total crosses the limit', async () => {
    await tracker.record(rec({ costUsd: 0.60 }));
    await tracker.record(rec({ costUsd: 0.50 }));
    const status = await tracker.checkBudgetFast('u1', { dailyLimitUsd: 1.0 });
    expect(status.currentUsd).toBeCloseTo(1.10, 6);
    expect(status.over).toBe(true);
  });

  it('reports the true total even when the record LIST is truncated', async () => {
    // The list (used by the slow getDailySummary path) is capped, but the hash
    // is incremented atomically and never trimmed — so it stays authoritative.
    for (let i = 0; i < 30; i++) await tracker.record(rec({ costUsd: 0.01 }));
    const fast = await tracker.getDailyTotalFast('u1');
    expect(fast.totalCostUsd).toBeCloseTo(0.30, 6);
    expect(fast.requestCount).toBe(30);
  });

  it('treats a zero/absent limit as not-over', async () => {
    await tracker.record(rec({ costUsd: 5.0 }));
    const status = await tracker.checkBudgetFast('u1', { dailyLimitUsd: 0 });
    expect(status.over).toBe(false);
    expect(status.pct).toBe(0);
  });
});

describe('#553 BudgetGuard decides from the fast daily-total hash', () => {
  let store: ReturnType<typeof makeStore>;
  let tracker: SpendTracker;
  let guard: BudgetGuard;

  beforeEach(() => {
    store = makeStore();
    tracker = new SpendTracker(store);
    guard = new BudgetGuard(tracker, { degradeThreshold: 0.8, blockThreshold: 1.0 });
  });

  const chain = [{ provider: 'openai', model: 'gpt-4o' }];

  it('passes through under the degrade threshold without scanning the list', async () => {
    await tracker.record(rec({ costUsd: 0.10 })); // 10% of $1
    const res = await guard.checkAndDowngrade('u1', chain, 'llm', 1.0);
    expect(res.downgraded).toBe(false);
    expect(res.chain).toEqual(chain);
  });

  it('downgrades expensive models in the 80-100% band', async () => {
    await tracker.record(rec({ costUsd: 0.85 })); // 85%
    const res = await guard.checkAndDowngrade('u1', chain, 'llm', 1.0);
    expect(res.downgraded).toBe(true);
    expect(res.chain[0].model).toBe('gpt-4o-mini');
  });

  it('hard-blocks at or above the block threshold', async () => {
    await tracker.record(rec({ costUsd: 1.0 })); // 100%
    await expect(guard.checkAndDowngrade('u1', chain, 'llm', 1.0)).rejects.toThrow(/budget exceeded/i);
  });

  it('falls back gracefully for a tracker without getDailyTotalFast', async () => {
    // Back-compat: a custom tracker shape that only implements getDailySummary.
    const legacy: any = {
      async getDailySummary() { return { date: TODAY, totalCostUsd: 0.5, requestCount: 1, byProvider: {}, byStage: {} }; },
    };
    const legacyGuard = new BudgetGuard(legacy, { degradeThreshold: 0.8, blockThreshold: 1.0 });
    const res = await legacyGuard.checkAndDowngrade('u1', chain, 'llm', 1.0);
    expect(res.downgraded).toBe(false); // 50% < 80%
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #548 — CostWatcher.reportFrom(getSpend) pulls the live counter
// ─────────────────────────────────────────────────────────────────────────────

import { CostWatcher } from '../../src/alerting/cost-watcher';

/** Fake AlertRouter capturing routed alerts. */
function makeRouter() {
  const routed: any[] = [];
  return {
    routed,
    route: async (a: any) => { routed.push(a); },
  } as any;
}

describe('#548 CostWatcher.reportFrom wires the live spend counter', () => {
  it('reads the getter and fires thresholds like report()', () => {
    const router = makeRouter();
    let spend = 0;
    const w = new CostWatcher({ router, cap: 100, now: () => Date.parse('2026-06-14T00:00:00Z') });

    expect(w.reportFrom(() => spend)).toEqual([]); // 0%
    spend = 55; // 55% → crosses 0.5
    expect(w.reportFrom(() => spend)).toEqual([0.5]);
    spend = 85; // 85% → crosses 0.8
    expect(w.reportFrom(() => spend)).toEqual([0.8]);
    expect(router.routed.length).toBe(2);
    expect(router.routed[1].severity).toBe('critical');
  });

  it('is sticky — the same threshold does not re-fire on the same day', () => {
    const router = makeRouter();
    const w = new CostWatcher({ router, cap: 100, now: () => Date.parse('2026-06-14T06:00:00Z') });
    expect(w.reportFrom(() => 60)).toEqual([0.5]);
    expect(w.reportFrom(() => 70)).toEqual([]); // still in 0.5 band, already fired
  });

  it('never throws when the spend getter throws or returns garbage', () => {
    const router = makeRouter();
    const w = new CostWatcher({ router, cap: 100 });
    expect(w.reportFrom(() => { throw new Error('counter unavailable'); })).toEqual([]);
    expect(w.reportFrom(() => NaN)).toEqual([]);
    expect(w.reportFrom(() => -10)).toEqual([]);
    expect(router.routed.length).toBe(0);
  });

  it('disabled (cap<=0) reports nothing', () => {
    const router = makeRouter();
    const w = new CostWatcher({ router, cap: 0 });
    expect(w.reportFrom(() => 9999)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #588 — metrics-collector dropped the pointless per-sample ring
// ─────────────────────────────────────────────────────────────────────────────

import { metrics } from '../../src/metrics-collector';

describe('#588 metrics-collector keeps a sample COUNT, not a sample array', () => {
  beforeEach(() => metrics.reset());

  it('recentSamples is a monotonic counter across record types', () => {
    metrics.increment('opt588.req', { a: '1' });
    metrics.gauge('opt588.mem', 42, { a: '1' });
    metrics.histogram('opt588.dur', 100, { a: '1' });
    const snap = metrics.getSnapshot();
    expect(snap.recentSamples).toBe(3);
  });

  it('does not expose a per-sample object array (no MetricSample retention)', () => {
    metrics.increment('opt588.x');
    const snap = metrics.getSnapshot();
    // recentSamples is a plain number, never an array of {timestamp,...} objects.
    expect(typeof snap.recentSamples).toBe('number');
    expect(Array.isArray((snap as any).samples)).toBe(false);
    expect((metrics as any).samples).toBeUndefined();
  });

  it('reset() zeroes the counter', () => {
    metrics.increment('opt588.y');
    metrics.reset();
    expect(metrics.getSnapshot().recentSamples).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #591 — real cumulative GPU latency histogram
// #504 — GPU-scoped latency metric names + corrected HELP
// ─────────────────────────────────────────────────────────────────────────────

import {
  computeLatencyHistogram,
  LATENCY_BUCKETS_MS,
  renderPrometheusMetrics,
  getMetricsSnapshot,
} from '../../server/metrics';

describe('#591 computeLatencyHistogram produces cumulative le-buckets', () => {
  it('counts samples ≤ each bound (cumulative, Prometheus le semantics)', () => {
    // buckets: 10,25,50,100,250,500,1000,2500,5000,10000
    const h = computeLatencyHistogram([5, 30, 30, 700]);
    expect(h.count).toBe(4);
    expect(h.sum).toBe(765);
    // le=10 → {5}=1 ; le=25 → still 1 ; le=50 → {5,30,30}=3 ; le=100 → 3 ;
    // le=1000 → all 4.
    expect(h.bucketCounts[0]).toBe(1);   // le=10
    expect(h.bucketCounts[1]).toBe(1);   // le=25
    expect(h.bucketCounts[2]).toBe(3);   // le=50
    expect(h.bucketCounts[3]).toBe(3);   // le=100
    expect(h.bucketCounts[6]).toBe(4);   // le=1000
  });

  it('is non-decreasing across buckets and tops out at count', () => {
    const h = computeLatencyHistogram([12, 80, 300, 9000]);
    for (let i = 1; i < h.bucketCounts.length; i++) {
      expect(h.bucketCounts[i]).toBeGreaterThanOrEqual(h.bucketCounts[i - 1]);
    }
    expect(h.bucketCounts[h.bucketCounts.length - 1]).toBeLessThanOrEqual(h.count);
  });

  it('handles an empty ring (all-zero buckets, count 0)', () => {
    const h = computeLatencyHistogram([]);
    expect(h.count).toBe(0);
    expect(h.sum).toBe(0);
    expect(h.bucketCounts.every((c) => c === 0)).toBe(true);
    expect(h.bucketCounts.length).toBe(LATENCY_BUCKETS_MS.length);
  });

  it('snapshot exposes a gpuLatencyHistogram object', () => {
    const snap = getMetricsSnapshot();
    expect(snap.gpuLatencyHistogram).toBeDefined();
    expect(Array.isArray((snap.gpuLatencyHistogram as any).bucketCounts)).toBe(true);
  });
});

describe('#591/#504 Prometheus output emits histogram + GPU-scoped gauges', () => {
  it('renders a gateway_gpu_latency_ms histogram with le buckets, +Inf, sum, count', () => {
    const out = renderPrometheusMetrics();
    expect(out).toContain('# TYPE gateway_gpu_latency_ms histogram');
    expect(out).toMatch(/gateway_gpu_latency_ms_bucket\{le="10"\} \d+/);
    expect(out).toContain('gateway_gpu_latency_ms_bucket{le="+Inf"}');
    expect(out).toMatch(/gateway_gpu_latency_ms_sum \d+/);
    expect(out).toMatch(/gateway_gpu_latency_ms_count \d+/);
  });

  it('emits GPU-scoped percentile gauges (#504)', () => {
    const out = renderPrometheusMetrics();
    expect(out).toContain('gateway_gpu_latency_p50_ms');
    expect(out).toContain('gateway_gpu_latency_p95_ms');
    expect(out).toContain('gateway_gpu_latency_p99_ms');
  });

  it('keeps the legacy gauge names for back-compat but corrects the HELP (#504)', () => {
    const out = renderPrometheusMetrics();
    expect(out).toContain('gateway_latency_p95_ms');
    // HELP no longer falsely claims "across all stages"; it's GPU-only.
    expect(out).toMatch(/# HELP gateway_latency_p95_ms .*GPU-only/);
    expect(out).not.toMatch(/# HELP gateway_latency_p95_ms p95 latency across all stages/);
  });
});
