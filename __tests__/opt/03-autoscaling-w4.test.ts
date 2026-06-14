/**
 * Optimization implementation tests — Autoscaling, Reliability & Resilience
 * WAVE 4 (docs/optimizations/03-autoscaling-reliability.md, IDs 201-300).
 *
 * Unit-only: no network, no GPU, no real filesystem writes, no live timers.
 * Pure exported helpers are exercised behaviourally; a couple of wirings are
 * verified with an in-memory KV double. Waves 1-3 files are untouched — this
 * file covers the NEXT batch of fixes (IDs: 202, 209, 212, 213, 219, 220, 241,
 * 246, 274, 277, 280, 281, 291, 298).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── #202 — IDLE_TIMEOUT_MS seeded from documented env vars ───────────────────
describe('idle timeout env seeding (#202)', () => {
  let ml: typeof import('../../server/gpu-monitor-loop');
  beforeEach(async () => {
    ml = await import('../../server/gpu-monitor-loop');
  });

  it('prefers IDLE_TIMEOUT_MIN (minutes → ms)', () => {
    expect(ml.resolveIdleTimeoutFromEnv({ IDLE_TIMEOUT_MIN: '20' })).toBe(20 * 60_000);
  });

  it('falls back to IDLE_TIMEOUT_MS when minutes unset', () => {
    expect(ml.resolveIdleTimeoutFromEnv({ IDLE_TIMEOUT_MS: '90000' })).toBe(90_000);
  });

  it('returns the default for missing/garbage/non-positive values', () => {
    expect(ml.resolveIdleTimeoutFromEnv({}, 5 * 60_000)).toBe(5 * 60_000);
    expect(ml.resolveIdleTimeoutFromEnv({ IDLE_TIMEOUT_MIN: 'abc' }, 1234)).toBe(1234);
    expect(ml.resolveIdleTimeoutFromEnv({ IDLE_TIMEOUT_MIN: '0' }, 1234)).toBe(1234);
    expect(ml.resolveIdleTimeoutFromEnv({ IDLE_TIMEOUT_MS: '-5' }, 1234)).toBe(1234);
  });

  it('minutes win over ms when both set', () => {
    expect(ml.resolveIdleTimeoutFromEnv({ IDLE_TIMEOUT_MIN: '10', IDLE_TIMEOUT_MS: '999' })).toBe(10 * 60_000);
  });
});

// ── #246 — P95 demotion under active load ────────────────────────────────────
describe('P95 demotion under active load (#246)', () => {
  let ml: typeof import('../../server/gpu-monitor-loop');
  beforeEach(async () => { ml = await import('../../server/gpu-monitor-loop'); });

  it('demotes when idle and P95 over target*multiplier', () => {
    expect(ml.shouldDemoteOnP95(2_500, 1_000, 2, /*active*/ false)).toBe(true);
  });

  it('uses a HIGHER threshold while active (2× idle → 3× active)', () => {
    // 2500 > 1000*2 (idle) but NOT > 1000*3 (active boost 1.5 → 3×)
    expect(ml.shouldDemoteOnP95(2_500, 1_000, 2, /*active*/ false)).toBe(true);
    expect(ml.shouldDemoteOnP95(2_500, 1_000, 2, /*active*/ true)).toBe(false);
    // A truly-degraded active pod still demotes.
    expect(ml.shouldDemoteOnP95(3_500, 1_000, 2, /*active*/ true)).toBe(true);
  });

  it('returns false for null/invalid P95 or target', () => {
    expect(ml.shouldDemoteOnP95(null, 1_000, 2, false)).toBe(false);
    expect(ml.shouldDemoteOnP95(0, 1_000, 2, false)).toBe(false);
    expect(ml.shouldDemoteOnP95(2_000, 0, 2, false)).toBe(false);
  });
});

// ── #298 — graded budget action (drain-then-stop, not hard-kill at 100%) ──────
describe('budget action grading (#298)', () => {
  let ml: typeof import('../../server/gpu-monitor-loop');
  beforeEach(async () => { ml = await import('../../server/gpu-monitor-loop'); });

  it('none below soft limit', () => {
    expect(ml.budgetActionForSpend(5, 10)).toBe('none');
  });

  it('warn at the soft limit', () => {
    expect(ml.budgetActionForSpend(8, 10)).toBe('warn');
  });

  it('drain-stop (resumable) at exactly 100%, not terminate', () => {
    expect(ml.budgetActionForSpend(10, 10)).toBe('drain-stop');
    expect(ml.budgetActionForSpend(11, 10)).toBe('drain-stop');
  });

  it('terminate only once well past budget (>=1.25×)', () => {
    expect(ml.budgetActionForSpend(12.5, 10)).toBe('terminate');
  });

  it('none when budget is zero/disabled', () => {
    expect(ml.budgetActionForSpend(100, 0)).toBe('none');
  });
});

// ── #213 — resume health-poll exponential backoff ────────────────────────────
describe('resume poll interval backoff (#213)', () => {
  let rm: typeof import('../../server/gpu-resume-manager');
  beforeEach(async () => { rm = await import('../../server/gpu-resume-manager'); });

  it('keeps the tight base interval during the fast phase', () => {
    expect(rm.resumePollIntervalMs(0)).toBe(3_000);
    expect(rm.resumePollIntervalMs(30_000)).toBe(3_000);
    expect(rm.resumePollIntervalMs(59_999)).toBe(3_000);
  });

  it('backs off exponentially after the fast phase, capped at max', () => {
    const a = rm.resumePollIntervalMs(60_000);   // first step
    const b = rm.resumePollIntervalMs(120_000);  // later step
    expect(a).toBeGreaterThan(3_000);
    expect(b).toBeGreaterThanOrEqual(a);
    // Never exceeds the cap.
    expect(rm.resumePollIntervalMs(600_000)).toBeLessThanOrEqual(15_000);
    expect(rm.resumePollIntervalMs(600_000)).toBe(15_000);
  });

  it('is monotonic non-decreasing across elapsed time', () => {
    let prev = 0;
    for (const t of [0, 30_000, 60_000, 90_000, 120_000, 300_000, 600_000]) {
      const v = rm.resumePollIntervalMs(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('canFreshDeployReplaceResumable gates on tier availability (#214 guard intact)', () => {
    expect(rm.canFreshDeployReplaceResumable(0)).toBe(false);
    expect(rm.canFreshDeployReplaceResumable(1)).toBe(true);
  });
});

// ── #274 — Modal branch present in standby handover terminate-old-pod ─────────
describe('standby Modal handover termination branch (#274)', () => {
  it('terminateOldPod source covers the modal provider', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(
      path.resolve(__dirname, '../../server/gpu-standby.ts'),
      'utf-8',
    );
    // The provider switch must now include a modal branch that deletes the app.
    expect(src).toMatch(/provider === 'modal'[\s\S]*?modal\.deleteInstance/);
    // Importing the module proves the modal branch references a real import.
    const gs = await import('../../server/gpu-standby');
    expect(typeof gs.initiateHandover).toBe('function');
  });

  it('standbyP95Multiplier clamp still intact (wave-3 #285 untouched)', async () => {
    const gs = await import('../../server/gpu-standby');
    expect(gs.standbyP95Multiplier(undefined, 2)).toBe(2);
    expect(gs.standbyP95Multiplier('100')).toBe(10);   // clamped high
    expect(gs.standbyP95Multiplier('0.1')).toBe(1.2);  // clamped low
  });
});

// ── #281 / #282 — standby pool dollar cap + shorter health timeout ───────────
describe('standby pool cost budget + health timeout (#281/#282)', () => {
  let ad: typeof import('../../server/standby-pool-adapter');
  beforeEach(async () => { ad = await import('../../server/standby-pool-adapter'); });

  it('cap disabled (<=0) always admits', () => {
    expect(ad.withinPoolCostBudget(100, 50, 0)).toBe(true);
    expect(ad.withinPoolCostBudget(100, 50, -1)).toBe(true);
  });

  it('admits when adding the pod stays within budget', () => {
    expect(ad.withinPoolCostBudget(2, 1.5, 5)).toBe(true);
    expect(ad.withinPoolCostBudget(0, 5, 5)).toBe(true); // exactly at cap
  });

  it('refuses when adding the pod would exceed budget', () => {
    expect(ad.withinPoolCostBudget(4, 2, 5)).toBe(false);
  });

  it('fails closed for a missing/non-finite pod cost', () => {
    expect(ad.withinPoolCostBudget(0, Number.NaN, 5)).toBe(false);
    expect(ad.withinPoolCostBudget(0, -1, 5)).toBe(false);
  });

  it('#282 default health timeout shortened from 20min to 8min', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(
      path.resolve(__dirname, '../../server/standby-pool-adapter.ts'),
      'utf-8',
    );
    expect(src).toMatch(/DEFAULT_POOL_HEALTH_TIMEOUT_MS\s*=\s*8\s*\*\s*60_000/);
    expect(src).not.toMatch(/DEFAULT_POOL_HEALTH_TIMEOUT_MS\s*=\s*20\s*\*\s*60_000/);
  });
});

// ── #280 — asymmetric predictive safety margin ───────────────────────────────
describe('adaptive predictive safety margin (#280)', () => {
  let pw: typeof import('../../src/gateway/autoscaler/predictive-warmer');
  beforeEach(async () => { pw = await import('../../src/gateway/autoscaler/predictive-warmer'); });

  it('neutral inputs return the base margin', () => {
    expect(pw.adaptiveSafetyMargin(0, 0)).toBeCloseTo(1.2, 5);
  });

  it('expensive GPU lowers the margin (less over-provisioning)', () => {
    expect(pw.adaptiveSafetyMargin(1, 0)).toBeLessThan(1.2);
    expect(pw.adaptiveSafetyMargin(1, 0)).toBeGreaterThanOrEqual(1.0);
  });

  it('catastrophic cold-start raises the margin', () => {
    expect(pw.adaptiveSafetyMargin(0, 1)).toBeGreaterThan(1.2);
    expect(pw.adaptiveSafetyMargin(0, 1)).toBeLessThanOrEqual(1.5);
  });

  it('clamps to [minMargin, maxMargin] and tolerates NaN', () => {
    expect(pw.adaptiveSafetyMargin(Number.NaN, Number.NaN)).toBeCloseTo(1.2, 5);
    expect(pw.adaptiveSafetyMargin(5, -5)).toBeGreaterThanOrEqual(1.0);
    expect(pw.adaptiveSafetyMargin(-5, 5)).toBeLessThanOrEqual(1.5);
  });
});

// ── #277 — predictive warmup ROI gate ────────────────────────────────────────
describe('predictive warmup ROI gate (#277)', () => {
  let pwu: typeof import('../../src/gateway/autoscaler/predictive-warmup');
  beforeEach(async () => { pwu = await import('../../src/gateway/autoscaler/predictive-warmup'); });

  it('explores (allows warm) with insufficient history', () => {
    expect(pwu.shouldWarmGivenRoi(0, 0)).toBe(true);
    expect(pwu.shouldWarmGivenRoi(3, 0)).toBe(true); // below minSamples (4)
  });

  it('skips warm for a bucket with poor realized-demand hit rate', () => {
    // 10 warms, 1 hit → 10% < 30% min → skip
    expect(pwu.shouldWarmGivenRoi(10, 1)).toBe(false);
  });

  it('keeps warming a bucket whose demand reliably materialises', () => {
    // 10 warms, 5 hits → 50% ≥ 30% → warm
    expect(pwu.shouldWarmGivenRoi(10, 5)).toBe(true);
  });

  it('respects custom thresholds', () => {
    expect(pwu.shouldWarmGivenRoi(10, 6, { minHitRate: 0.7 })).toBe(false);
    expect(pwu.shouldWarmGivenRoi(2, 0, { minSamples: 2, minHitRate: 0.5 })).toBe(false);
  });

  it('warmCountForForecast (wave-3 #278) still intact', () => {
    expect(pwu.warmCountForForecast(0, 3)).toBe(1);
    expect(pwu.warmCountForForecast(12, 3)).toBe(3);
  });
});

// ── #291 — queue-depth running-total cache ───────────────────────────────────
describe('queue-depth total cache (#291)', () => {
  let qd: typeof import('../../src/gateway/autoscaler/queue-depth-tracker');

  // Minimal KvStore double with a SCAN counter.
  function makeKv() {
    const data = new Map<string, string>();
    let scanCalls = 0;
    return {
      data,
      get scanCalls() { return scanCalls; },
      get: async (k: string) => data.get(k) ?? null,
      set: async (k: string, v: string) => { data.set(k, v); },
      del: async (k: string) => { data.delete(k); },
      scan: async (_p: string, cb?: (keys: string[]) => void) => {
        scanCalls++;
        const keys = [...data.keys()].filter((k) => k.startsWith('queue-depth:'));
        cb?.(keys);
        return keys.length;
      },
    };
  }

  beforeEach(async () => { qd = await import('../../src/gateway/autoscaler/queue-depth-tracker'); });

  it('isTotalCacheFresh respects null + ttl bounds', () => {
    expect(qd.isTotalCacheFresh(null, 1000, 1000)).toBe(false);
    expect(qd.isTotalCacheFresh(1000, 1500, 1000)).toBe(true);  // 500ms < 1000ms
    expect(qd.isTotalCacheFresh(1000, 2500, 1000)).toBe(false); // 1500ms ≥ 1000ms
    expect(qd.isTotalCacheFresh(1000, 1000, 0)).toBe(false);    // ttl disabled
  });

  it('collapses a burst of reads into a single SCAN within the TTL', async () => {
    const kv = makeKv();
    const t = new qd.QueueDepthTracker(kv as any, { totalCacheTtlMs: 10_000 });
    await t.increment(0);
    await t.increment(1);
    const before = kv.scanCalls;
    const a = await t.getTotalDepth(); // 1 scan
    const b = await t.getTotalDepth(); // cached
    const c = await t.getTotalDepth(); // cached
    expect(a).toBe(2);
    expect(b).toBe(2);
    expect(c).toBe(2);
    expect(kv.scanCalls - before).toBe(1);
  });

  it('a write invalidates the cache so the next total reflects the change', async () => {
    const kv = makeKv();
    const t = new qd.QueueDepthTracker(kv as any, { totalCacheTtlMs: 10_000 });
    await t.increment(0);
    expect(await t.getTotalDepth()).toBe(1); // populates cache
    await t.increment(0);                    // invalidates cache
    expect(await t.getTotalDepth()).toBe(2); // re-scans, reflects write
  });

  it('zero TTL disables caching (scans every call)', async () => {
    const kv = makeKv();
    const t = new qd.QueueDepthTracker(kv as any, { totalCacheTtlMs: 0 });
    await t.increment(0);
    const before = kv.scanCalls;
    await t.getTotalDepth();
    await t.getTotalDepth();
    expect(kv.scanCalls - before).toBe(2);
  });
});

// ── #241 — auto-recovery deprioritizes the crashed provider ──────────────────
describe('auto-recovery deprioritize crashed provider (#241)', () => {
  let ar: typeof import('../../server/gpu-auto-recovery');
  beforeEach(async () => { ar = await import('../../server/gpu-auto-recovery'); });

  it('moves the crashed provider to the end, preserving the rest order', () => {
    const tiers = [{ name: 'runpod' }, { name: 'vast' }, { name: 'tensordock' }];
    const out = ar.deprioritizeProvider(tiers, 'runpod');
    expect(out.map((t) => t.name)).toEqual(['vast', 'tensordock', 'runpod']);
  });

  it('keeps the crashed provider as a last-resort fallback (not dropped)', () => {
    const tiers = [{ name: 'runpod' }];
    const out = ar.deprioritizeProvider(tiers, 'runpod');
    expect(out.map((t) => t.name)).toEqual(['runpod']);
  });

  it('null/empty crashed provider returns an unchanged copy', () => {
    const tiers = [{ name: 'runpod' }, { name: 'vast' }];
    expect(ar.deprioritizeProvider(tiers, null).map((t) => t.name)).toEqual(['runpod', 'vast']);
    expect(ar.deprioritizeProvider(tiers, '').map((t) => t.name)).toEqual(['runpod', 'vast']);
    // Returns a copy, not the same reference.
    expect(ar.deprioritizeProvider(tiers, null)).not.toBe(tiers);
  });

  it('handles multiple tiers on the crashed provider', () => {
    const tiers = [{ name: 'vast' }, { name: 'runpod' }, { name: 'vast' }];
    const out = ar.deprioritizeProvider(tiers, 'vast');
    expect(out.map((t) => t.name)).toEqual(['runpod', 'vast', 'vast']);
  });
});

// ── #219 / #220 — boot timeout cap (per-provider multiplier + unknown default) ─
describe('boot timeout cap resolution (#219/#220)', () => {
  let bt: typeof import('../../src/gateway/autoscaler/boot-timeout');
  beforeEach(async () => { bt = await import('../../src/gateway/autoscaler/boot-timeout'); });

  it('known provider: bootTimeSecs × multiplier', () => {
    expect(bt.resolveBootTimeoutCap({ bootTimeSecs: 120, multiplier: 2 })).toBe(240_000);
    expect(bt.resolveBootTimeoutCap({ bootTimeSecs: 120, multiplier: 3 })).toBe(360_000);
  });

  it('#220 unknown provider uses a 300s assumption (not 120s)', () => {
    // unknown → 300 * 2 = 600s = 600_000ms, far above the old 120*2=240s cap.
    expect(bt.resolveBootTimeoutCap({ multiplier: 2 })).toBe(600_000);
    expect(bt.resolveBootTimeoutCap({ bootTimeSecs: 0, multiplier: 2 })).toBe(600_000);
  });

  it('caps at the absolute maximum', () => {
    expect(bt.resolveBootTimeoutCap({ bootTimeSecs: 9999, multiplier: 3, absoluteMaxMs: 30 * 60_000 }))
      .toBe(30 * 60_000);
  });

  it('multiplier floored at 1', () => {
    expect(bt.resolveBootTimeoutCap({ bootTimeSecs: 100, multiplier: 0 })).toBe(100_000);
  });

  it('handleBootTimeout (wave context) still produces an idle state', () => {
    const res = bt.handleBootTimeout(
      0,
      { state: 'booting', tierIndex: 0, bootTriggeredAt: 0, prevBootFailCount: 0, trigger: 'demand' } as any,
      { provider: 'runpod' } as any,
      240_000,
      300_000,
      'watchdog',
    );
    expect(res.newState.state).toBe('idle');
    expect(res.logEntry.eventType).toBe('boot_timeout');
  });
});

// ── #212 — Modal idle grace scaled by cold-start ─────────────────────────────
describe('modal idle grace scaling (#212)', () => {
  let oc: typeof import('../../server/gpu-orphan-cleanup');
  beforeEach(async () => { oc = await import('../../server/gpu-orphan-cleanup'); });

  it('falls back to base grace with no observed cold-start', () => {
    expect(oc.modalIdleGraceMs(5 * 60_000, undefined)).toBe(5 * 60_000);
    expect(oc.modalIdleGraceMs(5 * 60_000, 0)).toBe(5 * 60_000);
  });

  it('scales grace up for an expensive cold-start', () => {
    // coldStart 4min × 2 = 8min > 5min base → 8min
    expect(oc.modalIdleGraceMs(5 * 60_000, 4 * 60_000)).toBe(8 * 60_000);
  });

  it('never goes below base even for a cheap cold-start', () => {
    expect(oc.modalIdleGraceMs(5 * 60_000, 30_000)).toBe(5 * 60_000);
  });

  it('caps grace at the configured maximum', () => {
    expect(oc.modalIdleGraceMs(5 * 60_000, 60 * 60_000, { maxGraceMs: 30 * 60_000 }))
      .toBe(30 * 60_000);
  });
});

// ── #209 — sustained zero-util feeds idle-stop decision ──────────────────────
describe('zero-util idle-stop signal (#209)', () => {
  let hm: typeof import('../../server/gpu-health-metrics');
  beforeEach(async () => { hm = await import('../../server/gpu-health-metrics'); });

  it('does not stop before the stop threshold (longer than the warn window)', () => {
    expect(hm.shouldStopForZeroUtil(10)).toBe(false); // warn fires at 10, stop later
    expect(hm.shouldStopForZeroUtil(19)).toBe(false);
  });

  it('signals stop once sustained 0% util crosses the threshold', () => {
    expect(hm.shouldStopForZeroUtil(20)).toBe(true);
    expect(hm.shouldStopForZeroUtil(25)).toBe(true); // >= so a jump still fires
  });

  it('honours a custom threshold', () => {
    expect(hm.shouldStopForZeroUtil(5, 5)).toBe(true);
    expect(hm.shouldStopForZeroUtil(4, 5)).toBe(false);
  });

  it('adaptiveProbeInterval (wave-3 #247) still intact', () => {
    expect(hm.adaptiveProbeInterval(30_000, 0, true)).toBeLessThan(30_000);
    expect(hm.adaptiveProbeInterval(30_000, 10 * 60_000, false)).toBe(120_000);
  });
});
