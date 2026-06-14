/**
 * Optimization implementation tests — Autoscaling, Reliability & Resilience
 * WAVE 3 (docs/optimizations/03-autoscaling-reliability.md, IDs 201-300).
 *
 * Unit-only: no network, no GPU, no real filesystem writes. Pure exported
 * helpers are exercised behaviourally; a couple of wirings are verified with a
 * fake KV store. Wave-1/2 files are untouched — this file covers the NEXT batch
 * of fixes (IDs: 233, 235, 237, 251, 252, 271, 278, 283, 285, 287, 294, 208,
 * 242, 255, 256, 249).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory KvStore double for the circuit-breaker.
function makeKv() {
  const data = new Map<string, string>();
  return {
    data,
    get: vi.fn(async (k: string) => data.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { data.set(k, v); }),
    del: vi.fn(async (k: string) => { data.delete(k); }),
    scan: vi.fn(async (_p: string, cb: (keys: string[]) => void) => { cb([...data.keys()]); return 0; }),
  };
}

// ── #233 / #235 / #237 — circuit-breaker hardening ───────────────────────────
describe('circuit-breaker double-count + half-open gate + forced reset (#233/#235/#237)', () => {
  let cb: typeof import('../../src/gateway/autoscaler/circuit-breaker');

  beforeEach(async () => {
    cb = await import('../../src/gateway/autoscaler/circuit-breaker');
  });

  it('#233 shouldCountFailure dedups by request id, no-ops on a repeat', () => {
    expect(cb.shouldCountFailure('req-1', undefined)).toBe(true);  // first time
    expect(cb.shouldCountFailure('req-1', 'req-1')).toBe(false);   // already counted
    expect(cb.shouldCountFailure('req-2', 'req-1')).toBe(true);    // new id
    expect(cb.shouldCountFailure(undefined, 'req-1')).toBe(true);  // no id → legacy always-count
  });

  it('#233 recordFailure with the same id only increments the counter once', async () => {
    const store = makeKv();
    // High threshold so the basic consecutive-failures path doesn't trip and we
    // can read the raw `failures` count to prove the dedup (recordRequest's
    // advanced success-rate path is exercised separately).
    const breaker = new cb.TierCircuitBreaker(store as any, { failureThreshold: 100 });
    await breaker.recordFailure(0, 'req-A');
    await breaker.recordFailure(0, 'req-A'); // duplicate id → must NOT re-count
    expect(JSON.parse(store.data.get('circuit:0')!).failures).toBe(1);
    // A genuinely different request increments.
    await breaker.recordFailure(0, 'req-B');
    expect(JSON.parse(store.data.get('circuit:0')!).failures).toBe(2);
  });

  it('#233 recordRequest dedups the failure increment by id', async () => {
    const store = makeKv();
    const breaker = new cb.TierCircuitBreaker(store as any, { failureThreshold: 100, adaptiveThresholds: false, predictiveAnalysis: false });
    // recordRequest then recordFailure for the SAME request → one failure only.
    await breaker.recordRequest(0, 10, false, 'boom', 'req-X');
    await breaker.recordFailure(0, 'req-X');
    expect(JSON.parse(store.data.get('circuit:0')!).failures).toBe(1);
  });

  it('#233 legacy behavior preserved when no request id is supplied', async () => {
    const store = makeKv();
    const breaker = new cb.TierCircuitBreaker(store as any, { failureThreshold: 2 });
    await breaker.recordFailure(0); // no id
    await breaker.recordFailure(0); // no id → counts again → trips
    expect(await breaker.getState(0)).toBe('open');
  });

  it('#235 canAdmitHalfOpenProbe enforces the configured concurrency', () => {
    expect(cb.canAdmitHalfOpenProbe(0, 1)).toBe(true);   // first probe ok
    expect(cb.canAdmitHalfOpenProbe(1, 1)).toBe(false);  // second refused (cap 1)
    expect(cb.canAdmitHalfOpenProbe(2, 3)).toBe(true);   // under cap 3
    expect(cb.canAdmitHalfOpenProbe(3, 3)).toBe(false);  // at cap 3
    expect(cb.canAdmitHalfOpenProbe(5, 0)).toBe(false);  // floor cap to 1
  });

  it('#235 canProbe: closed always admits, open never, half-open honors the cap', async () => {
    const store = makeKv();
    const breaker = new cb.TierCircuitBreaker(store as any, {
      failureThreshold: 1, recoveryTimeoutMs: 0, halfOpenMaxConcurrent: 1,
    });
    // closed
    expect(await breaker.canProbe(0, 99)).toBe(true);
    // open → trip it; recoveryTimeoutMs 0 means it immediately reads as half-open.
    await breaker.recordFailure(0);
    // With recoveryTimeoutMs=0 the state transitions to half-open on read.
    expect(await breaker.getState(0)).toBe('half-open');
    expect(await breaker.canProbe(0, 0)).toBe(true);   // one probe allowed
    expect(await breaker.canProbe(0, 1)).toBe(false);  // a concurrent second refused
  });

  it('#237 shouldForceReset trips only after enough recovery windows while open', () => {
    // closed → never
    expect(cb.shouldForceReset('closed', 1000, 1000, 999999)).toBe(false);
    // open, not enough windows elapsed (need 5 * 1000 = 5000)
    expect(cb.shouldForceReset('open', 1000, 1000, 1000 + 4000, 5)).toBe(false);
    // open, exactly enough windows elapsed
    expect(cb.shouldForceReset('open', 1000, 1000, 1000 + 5000, 5)).toBe(true);
    // half-open also eligible
    expect(cb.shouldForceReset('half-open', 0 + 1, 1000, 1 + 5000, 5)).toBe(true);
    // missing openedAt / non-positive recovery → never
    expect(cb.shouldForceReset('open', 0, 1000, 999999)).toBe(false);
    expect(cb.shouldForceReset('open', 1000, 0, 999999)).toBe(false);
  });

  it('#237 a circuit stuck open past maxRecoveryWindows resets to closed on read', async () => {
    const store = makeKv();
    // Seed a state that opened "long ago" with a finite recovery window.
    store.data.set('circuit:3', JSON.stringify({
      failures: 9, state: 'open', openedAt: 1, halfOpenSuccesses: 0,
      totalRequests: 9, successCount: 0, avgLatencyMs: 10, latencyVariance: 0,
      lastSuccessRate: 0, failureReasons: [], adaptiveThreshold: 3, predictiveScore: 0,
    }));
    // recoveryTimeoutMs small, maxRecoveryWindows default 5 → Date.now() >> 5*recovery.
    const breaker = new cb.TierCircuitBreaker(store as any, { recoveryTimeoutMs: 1, maxRecoveryWindows: 5 });
    expect(await breaker.getState(3)).toBe('closed');
  });
});

// ── #251 / #252 — EWMA tail-aware ranking + scaled stale penalty ──────────────
describe('ewma-tracker tail-aware ranking + scaled stale penalty (#251/#252)', () => {
  let mod: typeof import('../../src/gateway/routing/ewma-tracker');

  beforeEach(async () => {
    mod = await import('../../src/gateway/routing/ewma-tracker');
  });

  it('#252 stalePenaltyFactor scales with staleness and is capped', () => {
    // Below threshold → no penalty.
    expect(mod.stalePenaltyFactor(30_000, 60_000)).toBe(1);
    // At the threshold → ~no penalty (one window).
    expect(mod.stalePenaltyFactor(60_000, 60_000)).toBeCloseTo(1, 5);
    // Two windows (120s) → 1 + (2-1)*0.1 = 1.1.
    expect(mod.stalePenaltyFactor(120_000, 60_000, 0.1)).toBeCloseTo(1.1, 5);
    // Eleven windows → would be 2.0; capped at maxFactor.
    expect(mod.stalePenaltyFactor(11 * 60_000, 60_000, 0.1, 2.0)).toBe(2.0);
    // Longer stale gets a strictly larger penalty than just-stale (the #252 point).
    expect(mod.stalePenaltyFactor(60 * 60_000, 60_000)).toBeGreaterThan(mod.stalePenaltyFactor(61_000, 60_000));
  });

  it('#251 effectiveScore folds the peak in; peakWeight=0 reproduces ewma-only', () => {
    // peakWeight 0 → exactly the ewma.
    expect(mod.effectiveScore(100, 500, 0)).toBe(100);
    // peakWeight 0.3, peak 500 > ewma 100 → 100*0.7 + 500*0.3 = 220.
    expect(mod.effectiveScore(100, 500, 0.3)).toBeCloseTo(220, 5);
    // peak below ewma never improves the score (max(ewma,peak)).
    expect(mod.effectiveScore(100, 50, 0.3)).toBe(100);
  });

  it('#251 effectiveScore reorders a spiky-tail provider behind a steady one', () => {
    // Two providers with the SAME average (100ms) but the spiky one has a much
    // worse tail (peak 1000 vs 120). Tail-aware scoring must rank steady first.
    const steadyScore = mod.effectiveScore(100, 120, 0.3); // ~106
    const spikyScore = mod.effectiveScore(100, 1000, 0.3); // 100*0.7 + 1000*0.3 = 370
    expect(spikyScore).toBeGreaterThan(steadyScore);
  });

  it('#251 rankingByScore returns a sorted score field and never undershoots ewma', () => {
    const t = new mod.EWMATracker(0.3);
    for (let i = 0; i < 5; i++) t.record('a', 100);
    for (let i = 0; i < 5; i++) t.record('b', 300);
    const scored = t.rankingByScore(0.3);
    // scoreMs present, and >= ewmaMs (peak is never below ewma in the tracker).
    for (const e of scored) {
      expect(typeof e.scoreMs).toBe('number');
      expect(e.scoreMs).toBeGreaterThanOrEqual(e.ewmaMs);
    }
    // Ascending order by scoreMs; faster provider 'a' ranks first.
    expect(scored[0].provider).toBe('a');
    expect(scored[0].scoreMs).toBeLessThanOrEqual(scored[1].scoreMs);
    // Legacy ranking() shape is unchanged (no scoreMs field).
    expect((t.ranking()[0] as any).scoreMs).toBeUndefined();
  });

  it('legacy ranking()/getLatency() still apply the flat penalty (back-compat untouched)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const t = new mod.EWMATracker(0.3);
      t.record('p', 200);
      vi.setSystemTime(1000 + 61_000); // just stale
      expect(t.getLatency('p')).toBeCloseTo(220, 5); // 200 * 1.1 flat
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── #271 — RequestBatcher first-item wait floor ──────────────────────────────
describe('request-batcher computeBatchWaitMs first-item floor (#271)', () => {
  let rb: typeof import('../../src/gateway/autoscaler/request-batcher');

  beforeEach(async () => {
    rb = await import('../../src/gateway/autoscaler/request-batcher');
  });

  it('legacy proportional behavior when no floor is given (minFirstWaitMs=0)', () => {
    // 1 of 8 @ 50ms → 6.25ms (the tiny window the old code produced).
    expect(rb.computeBatchWaitMs(1, 8, 50, true, 0)).toBeCloseTo(6.25, 5);
    // non-adaptive → always maxWaitMs.
    expect(rb.computeBatchWaitMs(1, 8, 50, false, 0)).toBe(50);
  });

  it('floors the first-item wait but never exceeds maxWaitMs', () => {
    // floor 13 raises the 6.25ms first-item window to 13ms.
    expect(rb.computeBatchWaitMs(1, 8, 50, true, 13)).toBe(13);
    // a floor larger than maxWaitMs is clamped to maxWaitMs.
    expect(rb.computeBatchWaitMs(1, 8, 50, true, 999)).toBe(50);
    // when proportional already exceeds the floor, proportional wins (capped).
    expect(rb.computeBatchWaitMs(8, 8, 50, true, 13)).toBe(50);
  });

  it('a configured minFirstWaitMs actually delays the single-item flush', async () => {
    vi.useFakeTimers();
    try {
      const flushFn = vi.fn(async (b: number[]) => b);
      const batcher = new rb.RequestBatcher<number>(
        { maxBatchSize: 8, maxWaitMs: 50, adaptiveWindow: true, minFirstWaitMs: 25 },
        flushFn,
      );
      const p = batcher.submit(1);
      // Old proportional window (~6ms) would have fired by now; the floor holds.
      vi.advanceTimersByTime(10);
      expect(flushFn).not.toHaveBeenCalled();
      // A second item joins the batch within the floored window.
      const p2 = batcher.submit(2);
      vi.advanceTimersByTime(25);
      await Promise.all([p, p2]);
      expect(flushFn).toHaveBeenCalledTimes(1);
      expect(flushFn.mock.calls[0][0]).toEqual([1, 2]); // both batched together
      batcher.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── #278 — predictive warmup multi-tier warm count ───────────────────────────
describe('predictive-warmup warmCountForForecast (#278)', () => {
  let pw: typeof import('../../src/gateway/autoscaler/predictive-warmup');

  beforeEach(async () => {
    pw = await import('../../src/gateway/autoscaler/predictive-warmup');
  });

  it('sizes warm count to the forecast, clamped to [1, maxTiers]', () => {
    // 12 predicted / 5 per tier = ceil(2.4) = 3, but maxTiers caps at 2.
    expect(pw.warmCountForForecast(12, 2)).toBe(2);
    // 12 / 5 = 3 with room.
    expect(pw.warmCountForForecast(12, 4)).toBe(3);
    // Low forecast still warms at least one tier (when a warm is warranted).
    expect(pw.warmCountForForecast(1, 4)).toBe(1);
    expect(pw.warmCountForForecast(0, 4)).toBe(1);
    // No tiers → warm nothing.
    expect(pw.warmCountForForecast(50, 0)).toBe(0);
    // Custom reqsPerTier.
    expect(pw.warmCountForForecast(10, 5, 2)).toBe(5); // ceil(10/2)=5
  });
});

// ── #283 — standby pool exact refill cap ─────────────────────────────────────
describe('standby-pool canRefillPool exact cap (#283)', () => {
  let sp: typeof import('../../server/standby-pool');

  beforeEach(async () => {
    sp = await import('../../server/standby-pool');
  });

  it('refills only while below the floor and below the (exact) max', () => {
    // below floor + room → refill.
    expect(sp.canRefillPool(0, 0, 1, 2)).toBe(true);
    // at/above the floor → no refill regardless of room.
    expect(sp.canRefillPool(0, 1, 1, 2)).toBe(false);
    // below floor but pool already at max (exact cap, slack 0) → no overshoot.
    expect(sp.canRefillPool(2, 0, 1, 2, 0)).toBe(false);
    // the old +1 slack is opt-in: slack 1 permits one overshoot.
    expect(sp.canRefillPool(2, 0, 1, 2, 1)).toBe(true);
    expect(sp.canRefillPool(3, 0, 1, 2, 1)).toBe(false);
  });
});

// ── #285 / #287 — standby latency trigger + event-driven drain ───────────────
describe('gpu-standby latency trigger + drain completion (#285/#287)', () => {
  let gs: typeof import('../../server/gpu-standby');

  beforeEach(async () => {
    gs = await import('../../server/gpu-standby');
  });

  it('#285 standbyP95Multiplier parses env, falls back, and clamps to [1.2, 10]', () => {
    expect(gs.standbyP95Multiplier(undefined, 2)).toBe(2);   // fallback
    expect(gs.standbyP95Multiplier('3')).toBe(3);            // parsed
    expect(gs.standbyP95Multiplier('0.5')).toBe(1.2);        // clamped up (and 0.5<=0? no → clamp band)
    expect(gs.standbyP95Multiplier('100')).toBe(10);         // clamped down
    expect(gs.standbyP95Multiplier('not-a-number', 2)).toBe(2); // invalid → fallback
    expect(gs.standbyP95Multiplier('-4', 2)).toBe(2);        // non-positive → fallback
  });

  it('#285 shouldTriggerStandbyOnLatency only fires above target*multiplier', () => {
    expect(gs.shouldTriggerStandbyOnLatency(2100, 1000, 2)).toBe(true);  // > 2000
    expect(gs.shouldTriggerStandbyOnLatency(2000, 1000, 2)).toBe(false); // not strictly greater
    expect(gs.shouldTriggerStandbyOnLatency(1500, 1000, 2)).toBe(false);
    expect(gs.shouldTriggerStandbyOnLatency(null, 1000, 2)).toBe(false); // no data
    expect(gs.shouldTriggerStandbyOnLatency(5000, 0, 2)).toBe(false);    // invalid target
    // A tunable multiplier of 3 raises the bar.
    expect(gs.shouldTriggerStandbyOnLatency(2500, 1000, 3)).toBe(false);
    expect(gs.shouldTriggerStandbyOnLatency(3500, 1000, 3)).toBe(true);
  });

  it('#287 isDrainComplete exits the instant activeRequests hits 0 (or on timeout)', () => {
    expect(gs.isDrainComplete(0, 100, 30_000)).toBe(true);    // drained early
    expect(gs.isDrainComplete(3, 100, 30_000)).toBe(false);   // still draining
    expect(gs.isDrainComplete(3, 30_000, 30_000)).toBe(true); // timed out
    expect(gs.isDrainComplete(3, 40_000, 30_000)).toBe(true); // past timeout
  });
});

// ── #294 — token-bucket single-op consume+balance ────────────────────────────
describe('load-balancer tryConsumeWithBalance (#294)', () => {
  let lbMod: typeof import('../../src/gateway/autoscaler/load-balancer');

  // Minimal in-memory StateStore for the token bucket (get/set/del only used here).
  function makeStore() {
    const data = new Map<string, string>();
    return {
      data,
      get: vi.fn(async (k: string) => data.get(k) ?? null),
      set: vi.fn(async (k: string, v: string, _ttl?: number) => { data.set(k, v); }),
      del: vi.fn(async (k: string) => { data.delete(k); }),
    } as any;
  }

  beforeEach(async () => {
    lbMod = await import('../../src/gateway/autoscaler/load-balancer');
  });

  it('returns the post-consume balance and allows until exhausted in ONE op each', async () => {
    const store = makeStore();
    const lb = new lbMod.LoadBalancer(store, { capacity: 3, refillRate: 0, initialTokens: 3 });

    const r1 = await lb.tryConsumeWithBalance('c', 1);
    expect(r1).toEqual({ allowed: true, remaining: 2 });
    const r2 = await lb.tryConsumeWithBalance('c', 2);
    expect(r2).toEqual({ allowed: true, remaining: 0 });
    const r3 = await lb.tryConsumeWithBalance('c', 1);
    expect(r3).toEqual({ allowed: false, remaining: 0 }); // refused, balance unchanged
  });

  it('checkRateLimit uses the single-op path and preserves its contract', async () => {
    const store = makeStore();
    const lb = new lbMod.LoadBalancer(store, { capacity: 3, refillRate: 1, initialTokens: 3 });
    // Exhaust (normal priority consumes 3 tokens).
    const ok = await lb.checkRateLimit('c2', 'normal');
    expect(ok.allowed).toBe(true);
    expect(ok.remainingTokens).toBeGreaterThanOrEqual(0);
    // Now empty → rejected with a positive retryAfterMs.
    const denied = await lb.checkRateLimit('c2', 'normal');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('fails closed on a store error', async () => {
    const store = {
      get: vi.fn(async () => { throw new Error('kv down'); }),
      set: vi.fn(async () => {}),
      del: vi.fn(async () => {}),
    } as any;
    const lb = new lbMod.LoadBalancer(store, { capacity: 3, refillRate: 1, initialTokens: 3 });
    expect(await lb.tryConsumeWithBalance('c', 1)).toEqual({ allowed: false, remaining: 0 });
  });
});

// ── #208 / #242 / #255 — gpu-monitor-loop pure decision helpers ───────────────
describe('gpu-monitor-loop idle warn / crash decay / latency trend (#208/#242/#255)', () => {
  let ml: typeof import('../../server/gpu-monitor-loop');

  beforeEach(async () => {
    ml = await import('../../server/gpu-monitor-loop');
  });

  it('#208 computeIdleWarnLevel escalates none → warn → imminent', () => {
    const timeout = 100_000;
    expect(ml.computeIdleWarnLevel(0, timeout)).toBe('none');
    expect(ml.computeIdleWarnLevel(50_000, timeout)).toBe('none');   // 50%
    expect(ml.computeIdleWarnLevel(75_000, timeout)).toBe('warn');   // 75%
    expect(ml.computeIdleWarnLevel(89_000, timeout)).toBe('warn');   // 89%
    expect(ml.computeIdleWarnLevel(90_000, timeout)).toBe('imminent'); // 90% → re-warn
    expect(ml.computeIdleWarnLevel(120_000, timeout)).toBe('imminent');
    // Disabled / invalid timeout → never warn.
    expect(ml.computeIdleWarnLevel(10_000, 0)).toBe('none');
  });

  it('#242 decayCrashCounter restores budget only after a sustained healthy window', () => {
    // Healthy long enough → decrement by one.
    expect(ml.decayCrashCounter(2, 60 * 60_000, 60 * 60_000)).toBe(1);
    // Not healthy long enough → unchanged.
    expect(ml.decayCrashCounter(2, 30 * 60_000, 60 * 60_000)).toBe(2);
    // Never goes below zero.
    expect(ml.decayCrashCounter(0, 99 * 60_000, 60 * 60_000)).toBe(0);
  });

  it('#255 latencyTrendAction maps slope to an early action', () => {
    expect(ml.latencyTrendAction(0.0)).toBe('none');
    expect(ml.latencyTrendAction(-0.3)).toBe('none');   // improving
    expect(ml.latencyTrendAction(0.25)).toBe('warm');   // +25% → pre-warm
    expect(ml.latencyTrendAction(0.6)).toBe('rebenchmark'); // +60% → re-benchmark
    // Boundary at warmSlope.
    expect(ml.latencyTrendAction(0.2)).toBe('warm');
    expect(ml.latencyTrendAction(0.19)).toBe('none');
  });
});

// ── #256 — warmth-monitor staged escalation ──────────────────────────────────
describe('gpu-warmth-monitor warmthFailureAction (#256)', () => {
  let wm: typeof import('../../server/gpu-warmth-monitor');

  beforeEach(async () => {
    wm = await import('../../server/gpu-warmth-monitor');
  });

  it('stages none → mark-unhealthy → escalate (using >= so a skipped count still fires)', () => {
    expect(wm.warmthFailureAction(0)).toBe('none');
    expect(wm.warmthFailureAction(9)).toBe('none');
    expect(wm.warmthFailureAction(10)).toBe('mark-unhealthy');
    expect(wm.warmthFailureAction(15)).toBe('mark-unhealthy');
    expect(wm.warmthFailureAction(20)).toBe('escalate');
    expect(wm.warmthFailureAction(25)).toBe('escalate'); // counter jumped past 20
    // Custom thresholds.
    expect(wm.warmthFailureAction(5, 5, 8)).toBe('mark-unhealthy');
    expect(wm.warmthFailureAction(8, 5, 8)).toBe('escalate');
  });
});

// ── #249 — health status tri-state classification ────────────────────────────
describe('health classifyHealthStatus distinct degraded (#249)', () => {
  let h: typeof import('../../src/gateway/autoscaler/health');

  beforeEach(async () => {
    h = await import('../../src/gateway/autoscaler/health');
  });

  it('separates degraded from healthy (so routing can downgrade per-stage)', () => {
    expect(h.classifyHealthStatus('healthy')).toBe('healthy');
    expect(h.classifyHealthStatus('ok')).toBe('healthy');
    expect(h.classifyHealthStatus('ready')).toBe('healthy');
    expect(h.classifyHealthStatus('READY')).toBe('healthy'); // case-insensitive
    expect(h.classifyHealthStatus('degraded')).toBe('degraded'); // NOT lumped with healthy
    expect(h.classifyHealthStatus('error')).toBe('unhealthy');
    expect(h.classifyHealthStatus(undefined)).toBe('unhealthy');
    expect(h.classifyHealthStatus(null)).toBe('unhealthy');
    expect(h.classifyHealthStatus(42)).toBe('unhealthy');
  });
});
