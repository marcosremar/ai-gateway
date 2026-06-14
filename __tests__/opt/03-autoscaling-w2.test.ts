/**
 * Optimization implementation tests — Autoscaling, Reliability & Resilience
 * WAVE 2 (docs/optimizations/03-autoscaling-reliability.md, IDs 201-300).
 *
 * Unit-only: no network, no GPU, no real filesystem writes. Pure helpers are
 * exercised behaviourally; a couple of additions are verified with fake timers
 * + spies. Wave-1 files (03-autoscaling.test.ts / 03-idle-logic.test.ts) are
 * untouched — this file covers the NEXT batch of fixes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── #234 / #238 / #232 — circuit-breaker pure helpers + failureReasons ───────
describe('circuit-breaker adaptive threshold + predictive gate (#234/#238)', () => {
  let cb: typeof import('../../src/gateway/autoscaler/circuit-breaker');

  beforeEach(async () => {
    cb = await import('../../src/gateway/autoscaler/circuit-breaker');
  });

  it('#234 returns the configured threshold until there is enough history', () => {
    // 10 samples < minSamples(30) → use base threshold unchanged.
    expect(cb.computeAdaptiveThreshold(0.5, 3, 0.95, 10, 30)).toBe(3);
  });

  it('#234 a reliable tier gets a more tolerant threshold (>= 5)', () => {
    const t = cb.computeAdaptiveThreshold(0.99, 3, 0.95, 100, 30);
    expect(t).toBeGreaterThanOrEqual(5);
  });

  it('#234 an unreliable tier never trips at a single failure (floor is 2, not 1)', () => {
    // base 3 → *0.5 = 1.5 → old code Math.max(1.5,1)=1.5 (trips at 2 rounded?),
    // new helper floors at 2 so a tier at 1 failure can't instantly open.
    const t = cb.computeAdaptiveThreshold(0.2, 3, 0.95, 100, 30);
    expect(t).toBeGreaterThanOrEqual(2);
  });

  it('#238 predictive open requires both a high score AND enough samples', () => {
    // High score but too few samples → no open.
    expect(cb.shouldPredictiveOpen(0.9, 5, { minSamples: 20 })).toBe(false);
    // Enough samples + high score → open.
    expect(cb.shouldPredictiveOpen(0.9, 25, { minSamples: 20 })).toBe(true);
    // Enough samples but score below threshold → no open.
    expect(cb.shouldPredictiveOpen(0.5, 25, { minSamples: 20, riskThreshold: 0.7 })).toBe(false);
    // Disabled → never open.
    expect(cb.shouldPredictiveOpen(0.99, 1000, { enabled: false })).toBe(false);
  });

  it('#232 getTierAnalytics surfaces recorded failure reasons (was the unused `failureMadre`)', async () => {
    const data = new Map<string, string>();
    const store = {
      get: vi.fn(async (k: string) => data.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => { data.set(k, v); }),
      del: vi.fn(async (k: string) => { data.delete(k); }),
      scan: vi.fn(async () => 0),
    };
    const breaker = new cb.TierCircuitBreaker(store as any);
    // Need >= 10 history entries for getTierAnalytics to return non-null.
    for (let i = 0; i < 12; i++) {
      await breaker.recordRequest(0, 100, i % 4 !== 0, i % 4 === 0 ? `boom-${i}` : undefined);
    }
    const analytics = await breaker.getTierAnalytics(0);
    expect(analytics).not.toBeNull();
    expect(Array.isArray(analytics!.failureReasons)).toBe(true);
    expect(analytics!.failureReasons.length).toBeGreaterThan(0);
    expect(analytics!.failureReasons.some((r) => r.startsWith('boom-'))).toBe(true);
  });

  it('#232 back-compat: legacy persisted `failureMadre` is read as failureReasons', async () => {
    const data = new Map<string, string>();
    // Simulate state written by an older build.
    data.set('circuit:7', JSON.stringify({
      failures: 1, state: 'closed', openedAt: 0, halfOpenSuccesses: 0,
      totalRequests: 1, successCount: 0, avgLatencyMs: 10, latencyVariance: 0,
      lastSuccessRate: 0, failureMadre: ['legacy-reason'], adaptiveThreshold: 3, predictiveScore: 0,
    }));
    const store = {
      get: vi.fn(async (k: string) => data.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => { data.set(k, v); }),
      del: vi.fn(async () => {}),
      scan: vi.fn(async () => 0),
    };
    const breaker = new cb.TierCircuitBreaker(store as any);
    // Record one more failure with a reason; the legacy reason must be preserved.
    await breaker.recordRequest(7, 10, false, 'new-reason');
    const raw = JSON.parse(data.get('circuit:7')!);
    expect(raw.failureReasons).toContain('legacy-reason');
    expect(raw.failureReasons).toContain('new-reason');
    expect(raw.failureMadre).toBeUndefined();
  });
});

// ── #244 / #245 — retry-policy maxTries alias + jitter strategies ─────────────
describe('retry-policy maxTries alias + decorrelated jitter (#244/#245)', () => {
  let rp: typeof import('../../src/retry-policy');

  beforeEach(async () => {
    rp = await import('../../src/retry-policy');
  });

  it('#244 resolveMaxAttempts prefers maxTries, falls back to maxAttempts then 3', () => {
    expect(rp.resolveMaxAttempts({})).toBe(3);
    expect(rp.resolveMaxAttempts({ maxAttempts: 5 })).toBe(5);
    expect(rp.resolveMaxAttempts({ maxTries: 4 })).toBe(4);
    expect(rp.resolveMaxAttempts({ maxAttempts: 5, maxTries: 2 })).toBe(2); // maxTries wins
    expect(rp.resolveMaxAttempts({ maxAttempts: 0 })).toBe(1); // floor at 1
  });

  it('#244 maxTries controls the number of fn invocations', async () => {
    const fn = vi.fn(async () => { throw new Error('always'); });
    const policy = new rp.RetryPolicy({ maxTries: 2, baseDelayMs: 0, backoff: 'fixed' });
    await expect(policy.execute(fn)).rejects.toThrow('always');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('#245 decorrelated jitter stays within [base, prev*3] and respects the cap', () => {
    const orig = Math.random;
    try {
      Math.random = () => 1; // push to the high end of the range
      const d = rp.calculateDelay(0, 'decorrelated', 100, 10_000, 0.5, 200);
      // hi = max(100, 200*3) = 600, lo=100 → at random=1 → 600
      expect(d).toBe(600);
      Math.random = () => 0; // low end → base
      expect(rp.calculateDelay(0, 'decorrelated', 100, 10_000, 0.5, 200)).toBe(100);
      // Cap applied
      Math.random = () => 1;
      expect(rp.calculateDelay(0, 'decorrelated', 100, 500, 0.5, 1_000)).toBe(500);
    } finally {
      Math.random = orig;
    }
  });

  it('#245 existing strategies unchanged (exponential is deterministic)', () => {
    expect(rp.calculateDelay(0, 'exponential', 100, 10_000, 0.5)).toBe(100);
    expect(rp.calculateDelay(1, 'exponential', 100, 10_000, 0.5)).toBe(200);
    expect(rp.calculateDelay(2, 'exponential', 100, 10_000, 0.5)).toBe(400);
    expect(rp.calculateDelay(0, 'fixed', 250, 10_000, 0.5)).toBe(250);
    expect(rp.calculateDelay(3, 'linear', 100, 10_000, 0.5)).toBe(400);
  });
});

// ── #253 / #254 — latency-tracker time-window P95 + sustained breach ─────────
describe('latency-tracker windowed P95 + sustained breach (#253/#254)', () => {
  let lt: typeof import('../../src/gateway/autoscaler/latency-tracker');

  beforeEach(async () => {
    lt = await import('../../src/gateway/autoscaler/latency-tracker');
  });

  it('#253 computeP95TimeWindow only considers samples inside the window', () => {
    const now = 1_000_000;
    const samples = [
      { value: 100, ts: now - 10_000 },   // in window
      { value: 9000, ts: now - 120_000 }, // outside 60s window — should be ignored
      { value: 200, ts: now - 5_000 },    // in window
      { value: 300, ts: now - 1_000 },    // in window
    ];
    const p95 = lt.computeP95TimeWindow(samples, 60_000, now);
    // window has [100,200,300] → ceil(3*0.95)-1 = 2 → 300
    expect(p95).toBe(300);
  });

  it('#253 returns null when no sample falls in the window', () => {
    const now = 1_000_000;
    expect(lt.computeP95TimeWindow([{ value: 5, ts: now - 999_999 }], 1_000, now)).toBeNull();
  });

  it('#254 isSustainedBreach trips on a ratio over a longer tail (2 of last 4 > 50%)', () => {
    // countRecentBreaches (last 3, all must breach) would NOT trip here.
    const samples = [100, 100, 5000, 100, 5000, 100, 5000];
    // last 4 → [100, 5000, 100, 5000] → 2/4 = 0.5 ≥ 0.5 → true
    expect(lt.isSustainedBreach(samples, 1000, { window: 4, minRatio: 0.5 })).toBe(true);
    // The legacy last-3 all-breach check does not trip on the same data.
    expect(lt.countRecentBreaches(samples, 1000)).toBeLessThan(lt.LATENCY_BREACH_COUNT);
  });

  it('#254 isSustainedBreach false when below the ratio / empty', () => {
    expect(lt.isSustainedBreach([100, 100, 100, 5000], 1000, { window: 4, minRatio: 0.5 })).toBe(false);
    expect(lt.isSustainedBreach([], 1000)).toBe(false);
  });
});

// ── #260 — health-check clears the race timeout on the happy path ────────────
describe('health-check race timeout cleared on success (#260)', () => {
  let hc: typeof import('../../src/health-check');

  beforeEach(async () => {
    vi.resetModules();
    hc = await import('../../src/health-check');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears the timeout when the check resolves first (no lingering timer)', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    hc.registerCheck('fast', async () => ({ healthy: true }), { timeoutMs: 30_000 });
    const result = await hc.healthChecker.runOne('fast');
    expect(result.healthy).toBe(true);
    // The timeout for the losing race branch must have been cleared.
    expect(clearSpy).toHaveBeenCalled();
    // And no pending timers remain (the timeout was cleared, not left to fire).
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still reports a timeout error when the check is slow', async () => {
    vi.useFakeTimers();
    hc.registerCheck('slow', () => new Promise((res) => setTimeout(() => res({ healthy: true }), 60_000)), { timeoutMs: 1_000 });
    const p = hc.healthChecker.runOne('slow');
    await vi.advanceTimersByTimeAsync(1_500);
    const result = await p;
    expect(result.healthy).toBe(false);
    expect(result.message).toMatch(/timed out/);
  });
});

// ── #268 / #269 — TimerManager O(n) cleanup + self-sweep ─────────────────────
describe('TimerManager key-tracked cleanup + leak sweep (#268/#269)', () => {
  let tm: typeof import('../../src/timer-manager');

  beforeEach(async () => {
    tm = await import('../../src/timer-manager');
  });

  it('#269 TimerInfo carries its map key', () => {
    const mgr = new tm.TimerManager();
    const key = mgr.setTimeout('x', () => {}, 100_000);
    const info = mgr.getActiveTimers()[0];
    expect(info.key).toBe(key);
    mgr.clearAll();
  });

  it('#269 cleanupLeakedTimers removes only aged timers (key-based)', () => {
    const mgr = new tm.TimerManager();
    mgr.setTimeout('young', () => {}, 100_000);
    mgr.setTimeout('old', () => {}, 10);
    const timers = mgr.getActiveTimers();
    // Age the 'old' one well past 2× its maxDuration.
    const old = timers.find((t) => t.name === 'old')!;
    old.createdAt = Date.now() - 1_000_000;
    const cleaned = mgr.cleanupLeakedTimers(50);
    expect(cleaned).toBe(1);
    expect(mgr.getStats().active).toBe(1);
    expect(mgr.getActiveTimers()[0].name).toBe('young');
    mgr.clearAll();
  });

  it('#268 startLeakSweep schedules an unref\'d self-sweep that reaps leaks', () => {
    vi.useFakeTimers();
    try {
      const mgr = new tm.TimerManager();
      mgr.setTimeout('leaky', () => {}, 10);
      const t = mgr.getActiveTimers().find((x) => x.name === 'leaky')!;
      t.createdAt = Date.now() - 1_000_000; // make it look leaked

      const sweepKey = mgr.startLeakSweep(5_000, 50);
      expect(sweepKey).toContain('leak-sweep');
      // Active timers: leaky + the sweep interval.
      expect(mgr.getStats().active).toBe(2);

      vi.advanceTimersByTime(5_000); // fire one sweep
      // leaky reaped; only the sweep interval remains.
      const names = mgr.getActiveTimers().map((x) => x.name);
      expect(names).not.toContain('leaky');
      expect(names).toContain('timer-manager:leak-sweep');

      mgr.stopLeakSweep();
      expect(mgr.getStats().active).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── #270 — RequestBatcher survives a synchronously-throwing flushFn ──────────
describe('RequestBatcher sync-throw safety (#270)', () => {
  let rb: typeof import('../../src/gateway/autoscaler/request-batcher');

  beforeEach(async () => {
    rb = await import('../../src/gateway/autoscaler/request-batcher');
  });

  it('rejects ALL pending items when flushFn throws synchronously', async () => {
    const flushFn = (() => { throw new Error('sync boom'); }) as unknown as (b: number[]) => Promise<unknown[]>;
    const batcher = new rb.RequestBatcher<number>({ maxBatchSize: 3, maxWaitMs: 5_000 }, flushFn);
    const p1 = batcher.submit(1);
    const p2 = batcher.submit(2);
    const p3 = batcher.submit(3); // triggers flush → flushFn throws synchronously

    await expect(p1).rejects.toThrow('sync boom');
    await expect(p2).rejects.toThrow('sync boom');
    await expect(p3).rejects.toThrow('sync boom');
    batcher.destroy();
  });

  it('async-rejecting flushFn still rejects the batch (unchanged behavior)', async () => {
    const flushFn = vi.fn(async () => { throw new Error('async boom'); });
    const batcher = new rb.RequestBatcher<number>({ maxBatchSize: 2, maxWaitMs: 5_000 }, flushFn);
    const p1 = batcher.submit(1);
    const p2 = batcher.submit(2);
    await expect(p1).rejects.toThrow('async boom');
    await expect(p2).rejects.toThrow('async boom');
    batcher.destroy();
  });
});

// ── #289 — degradation-manager booting-tier awareness ────────────────────────
describe('degradation-manager bootingTiers (#289)', () => {
  let dm: typeof import('../../src/gateway/autoscaler/degradation-manager');

  beforeEach(async () => {
    dm = await import('../../src/gateway/autoscaler/degradation-manager');
  });

  function sig(overrides: Partial<import('../../src/gateway/autoscaler/degradation-manager').DegradationSignals> = {}) {
    return {
      queueDepth: 0,
      p95LatencyMs: null,
      circuitStates: new Map(),
      readyTiers: 0,
      activeSessions: 0,
      ...overrides,
    };
  }

  it('reports `cloud` (not `minimal`) when a tier is booting and none are ready (no circuits)', () => {
    expect(dm.determineDegradation(sig({ readyTiers: 0, bootingTiers: 1 }))).toBe('cloud');
  });

  it('reports `cloud` when all circuits open but a tier is booting', () => {
    const circuits = new Map<number, import('../../src/gateway/autoscaler/circuit-breaker').CircuitState>([[0, 'open']]);
    expect(dm.determineDegradation(sig({ readyTiers: 0, circuitStates: circuits, bootingTiers: 2 }))).toBe('cloud');
  });

  it('stays `minimal` when nothing is ready AND nothing is booting (back-compat)', () => {
    expect(dm.determineDegradation(sig({ readyTiers: 0 }))).toBe('minimal');
    const circuits = new Map<number, import('../../src/gateway/autoscaler/circuit-breaker').CircuitState>([[0, 'open']]);
    expect(dm.determineDegradation(sig({ readyTiers: 0, circuitStates: circuits }))).toBe('minimal');
  });
});

// ── #296 — runaway-detector serialize/restore across restart ─────────────────
describe('runaway-detector persistence (#296)', () => {
  let mod: typeof import('../../src/gateway/autoscaler/runaway-detector');

  beforeEach(async () => {
    mod = await import('../../src/gateway/autoscaler/runaway-detector');
  });

  it('serialize captures the window + sticky pause; restore re-arms a still-active pause', () => {
    let nowMs = 1_000_000;
    const det = new mod.RunawayDetector({ maxStarts: 3, windowMs: 60_000, pauseMs: 600_000, now: () => nowMs });
    // Trip the detector (3 starts in window).
    det.recordDeployStart('runpod');
    det.recordDeployStart('runpod');
    expect(det.recordDeployStart('runpod')).toBe(false); // 3rd trips
    expect(det.isPaused('runpod')).toBe(true);

    const snap = det.serialize();
    expect(snap.runpod.pausedUntilMs).toBeGreaterThan(nowMs);

    // Simulate a restart: fresh detector, restore the snapshot.
    const restored = new mod.RunawayDetector({ maxStarts: 3, windowMs: 60_000, pauseMs: 600_000, now: () => nowMs });
    restored.restore(snap);
    // The provider must still be paused immediately after restart (the $130
    // incident scenario: a restart used to clear the guard).
    expect(restored.isPaused('runpod')).toBe(true);
    expect(restored.recordDeployStart('runpod')).toBe(false);
  });

  it('restore drops an already-expired pause and stale window entries', () => {
    let nowMs = 1_000_000;
    const det = new mod.RunawayDetector({ maxStarts: 3, windowMs: 60_000, pauseMs: 5_000, now: () => nowMs });
    det.recordDeployStart('vast');
    det.recordDeployStart('vast');
    det.recordDeployStart('vast'); // trips, paused until now+5s
    const snap = det.serialize();

    // Advance well past the pause + window expiry.
    nowMs += 10 * 60_000;
    const restored = new mod.RunawayDetector({ maxStarts: 3, windowMs: 60_000, pauseMs: 5_000, now: () => nowMs });
    restored.restore(snap);
    expect(restored.isPaused('vast')).toBe(false);
    // Stale starts aged out → next start is allowed.
    expect(restored.recordDeployStart('vast')).toBe(true);
  });

  it('restore tolerates null/empty snapshots', () => {
    const det = new mod.RunawayDetector();
    expect(() => det.restore(null)).not.toThrow();
    expect(() => det.restore(undefined)).not.toThrow();
    expect(() => det.restore({})).not.toThrow();
  });
});

// ── #279 — predictive-warmer bidirectional capacity recommendation ───────────
describe('predictive-warmer forecastVsCapacity (#279)', () => {
  let pw: typeof import('../../src/gateway/autoscaler/predictive-warmer');

  beforeEach(async () => {
    pw = await import('../../src/gateway/autoscaler/predictive-warmer');
  });

  it('recommends `up` when forecast target exceeds capacity', () => {
    expect(pw.forecastVsCapacity(5, 2)).toBe('up');
  });

  it('recommends `down` when forecast falls well below capacity', () => {
    // capacity 4, target 1 → 1 <= floor(4*0.5)=2 → down
    expect(pw.forecastVsCapacity(1, 4)).toBe('down');
  });

  it('recommends `hold` around the boundary (no flapping)', () => {
    // capacity 4, target 3 → not > 4 (up), not <= 2 (down) → hold
    expect(pw.forecastVsCapacity(3, 4)).toBe('hold');
    // capacity 0 never recommends scale-down.
    expect(pw.forecastVsCapacity(0, 0)).toBe('hold');
  });
});

// ── #288 — temperature-router learned wake estimate (EWMA blend) ─────────────
describe('temperature-router blendWakeEstimate (#288)', () => {
  let tr: typeof import('../../src/gateway/autoscaler/temperature-router');

  beforeEach(async () => {
    tr = await import('../../src/gateway/autoscaler/temperature-router');
  });

  it('returns the static prior when there is no observation', () => {
    const prior = tr.defaultWakeEstimateFor('T2_stopped');
    expect(prior).toBe(65_000);
    expect(tr.blendWakeEstimate(prior, null)).toBe(prior);
    expect(tr.blendWakeEstimate(prior, undefined)).toBe(prior);
    expect(tr.blendWakeEstimate(prior, -5)).toBe(prior); // invalid observation ignored
  });

  it('folds an observation toward the prior via one EWMA step', () => {
    // prior 65s, observed 25s, alpha 0.3 → 0.3*25000 + 0.7*65000 = 53000
    expect(tr.blendWakeEstimate(65_000, 25_000, 0.3)).toBeCloseTo(53_000, 3);
  });

  it('converges toward repeated observations across successive blends', () => {
    let est = tr.defaultWakeEstimateFor('T4_cold'); // 205_000
    for (let i = 0; i < 20; i++) est = tr.blendWakeEstimate(est, 30_000, 0.3);
    // After many samples of 30s, the estimate should be close to 30s.
    expect(est).toBeLessThan(40_000);
    expect(est).toBeGreaterThan(30_000 - 1);
  });

  it('does not change the static pickHottestSlot behavior', () => {
    const slots = [
      { vmId: 'a', endpoint: '', tier: 'T2_stopped' as const, lastRequestAt: 0 },
    ];
    expect(tr.pickHottestSlot(slots).estimatedWakeMs).toBe(65_000);
  });
});

// ── #299 / #210 / #248 / #247 — server-side pure cost/probe helpers ──────────
describe('gpu-monitor-loop pure helpers (#299/#210/#248)', () => {
  let ml: typeof import('../../server/gpu-monitor-loop');

  beforeEach(async () => {
    ml = await import('../../server/gpu-monitor-loop');
  });

  it('#299 computeBudgetForecast projects with minute precision (single formula)', () => {
    // 12:30 UTC → 11.5 hours remaining. spend 5 + 2/hr*11.5 = 28
    const at1230 = new Date('2026-06-14T12:30:00Z');
    expect(ml.computeBudgetForecast(5, 2, at1230)).toBeCloseTo(28, 5);
    // 23:00 UTC → exactly 1 hour remaining. spend 10 + 100*1 = 110.
    const at2300 = new Date('2026-06-14T23:00:00Z');
    expect(ml.computeBudgetForecast(10, 100, at2300)).toBeCloseTo(110, 5);
    // The two old formulas (whole hours vs hours+minutes) now agree because a
    // single helper is used: at 12:30 the minute term (0.5h) is included.
    const wholeHourOnly = 5 + 2 * (24 - at1230.getUTCHours()); // old #299 `forecast` formula = 5 + 2*12 = 29
    expect(ml.computeBudgetForecast(5, 2, at1230)).not.toBe(wholeHourOnly);
  });

  it('#210 sessionCostAlertThresholdMs derives from the effective idle timeout', () => {
    // 5-min timeout → 80% = 4 min, capped by default 5-min ceil → 4 min.
    expect(ml.sessionCostAlertThresholdMs(5 * 60_000)).toBe(4 * 60_000);
    // A lowered 2-min timeout → 80% = 96s (still fires before the 2-min stop).
    expect(ml.sessionCostAlertThresholdMs(2 * 60_000)).toBe(96_000);
    // Disabled / non-finite → default.
    expect(ml.sessionCostAlertThresholdMs(Infinity)).toBe(5 * 60_000);
    expect(ml.sessionCostAlertThresholdMs(0)).toBe(5 * 60_000);
    // Never exceeds the timeout itself.
    expect(ml.sessionCostAlertThresholdMs(10_000)).toBeLessThanOrEqual(10_000);
  });

  it('#248 shouldGiveUpProbing only true once stuck at max backoff long enough', () => {
    expect(ml.shouldGiveUpProbing(120_000, 120_000, 11 * 60_000, 10 * 60_000)).toBe(true);
    // Not yet long enough at max backoff.
    expect(ml.shouldGiveUpProbing(120_000, 120_000, 5 * 60_000, 10 * 60_000)).toBe(false);
    // Not at max backoff yet.
    expect(ml.shouldGiveUpProbing(60_000, 120_000, 60 * 60_000, 10 * 60_000)).toBe(false);
  });
});

describe('gpu-health-metrics adaptiveProbeInterval (#247)', () => {
  let hm: typeof import('../../server/gpu-health-metrics');

  beforeEach(async () => {
    hm = await import('../../server/gpu-health-metrics');
  });

  it('speeds up while booting, slows when idle, both bounded', () => {
    const base = hm.GPU_MONITOR_INTERVAL_MS; // 30s
    // Booting → faster (base/2), floored at min.
    expect(hm.adaptiveProbeInterval(base, 0, true)).toBe(15_000);
    expect(hm.adaptiveProbeInterval(20_000, 0, true, 12_000)).toBe(12_000); // min floor
    // Active (not idle) → base.
    expect(hm.adaptiveProbeInterval(base, 0, false)).toBe(base);
    // Mildly idle → 2× base, capped.
    expect(hm.adaptiveProbeInterval(base, 2 * 60_000, false)).toBe(60_000);
    // Long idle → coast at the cap.
    expect(hm.adaptiveProbeInterval(base, 60 * 60_000, false, 10_000, 120_000)).toBe(120_000);
  });
});

// ── #207 — gpu-idle-manager prefer-stop-over-terminate decision helper ───────
describe('gpu-idle-manager shouldTerminateOnMissingClient (#207)', () => {
  let im: typeof import('../../server/gpu-idle-manager');

  beforeEach(async () => {
    im = await import('../../server/gpu-idle-manager');
  });

  it('leaves the pod stopped when creds are only transiently unavailable', () => {
    expect(im.shouldTerminateOnMissingClient({ hasClient: false, credsTransientlyUnavailable: true }))
      .toEqual({ action: 'leave-stopped' });
  });

  it('terminates when creds are permanently gone', () => {
    expect(im.shouldTerminateOnMissingClient({ hasClient: false, credsTransientlyUnavailable: false }))
      .toEqual({ action: 'terminate' });
    expect(im.shouldTerminateOnMissingClient({ hasClient: false }))
      .toEqual({ action: 'terminate' });
  });
});

// ── #214 — gpu-resume-manager capacity guard before destroying resumable ─────
describe('gpu-resume-manager canFreshDeployReplaceResumable (#214)', () => {
  let rm: typeof import('../../server/gpu-resume-manager');

  beforeEach(async () => {
    rm = await import('../../server/gpu-resume-manager');
  });

  it('only allows destroying the resumable pod when a deploy tier exists', () => {
    expect(rm.canFreshDeployReplaceResumable(0)).toBe(false);
    expect(rm.canFreshDeployReplaceResumable(1)).toBe(true);
    expect(rm.canFreshDeployReplaceResumable(3)).toBe(true);
  });
});

// ── #217 — watchdog idleGraceMinutes default unified to 15 (structural) ──────
describe('watchdog idleGrace default (#217)', () => {
  it('uses a 15-min default fallback (matches config-loader + CLAUDE.md)', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve(__dirname, '..', '..', 'src/gateway/autoscaler/watchdog.ts'), 'utf-8');
    expect(src).toContain('config.idleGraceMinutes ?? 15');
    expect(src).not.toContain('config.idleGraceMinutes ?? 8');
  });
});

// ── #258 — cost-monitor staleGraceMinutes default aligned to 20 (structural) ─
describe('cost-monitor staleGrace default (#258)', () => {
  it('defaults staleGraceMinutes to 20 (matches JSDoc)', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve(__dirname, '..', '..', 'src/gateway/autoscaler/cost-monitor.ts'), 'utf-8');
    expect(src).toContain('staleGraceMinutes = 20');
    expect(src).not.toContain('staleGraceMinutes = 10');
  });
});
