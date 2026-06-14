/**
 * Cross-ownership harvest wave — routing + state cluster.
 *
 * Scope (file cluster): src/gateway/routing/, src/gateway/state/, src/client/.
 * Unit-only: pure helpers and in-memory state. Filesystem-touching code paths
 * (cost-state persist, readiness cold-start profile save) are exercised with a
 * mocked `fs` module so nothing writes to the real `~/.babelcast/`.
 *
 * Covered findings:
 *   provider-racer: #9 (overall race deadline), #10 (otherCancelled reflects
 *     reality), #14 (jitter/backoff retry delay), #87 (wasted-call counter)
 *   ewma-tracker:   #516 (slow-decay/latch peak), #517 (min-sample gate)
 *   readiness-state:#506 (wider per-stage ring), #507 (ring idx reset on wrap),
 *     #508 (init-guard treats 0 as uninitialised), #720 (atomic profile write)
 *   cost-state:     #543 (persist tracked reset date), #545 (deploys_blocked)
 *   metrics-state:  #510 (defensive copy in getLatencyTrend), #511 (olsSlope helper)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  raceProviders,
  computeRetryDelayMs,
  type RaceCandidate,
} from '../../src/gateway/routing/provider-racer';
import {
  EWMATracker,
  updatePeak,
} from '../../src/gateway/routing/ewma-tracker';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// provider-racer #9 — overall race deadline
// ─────────────────────────────────────────────────────────────────────────────
describe('provider-racer #9 — overall deadline', () => {
  it('aborts a hung candidate and surfaces the failure (multi-candidate)', async () => {
    let slowAborted = false;
    const candidates: RaceCandidate<string>[] = [
      {
        name: 'hang-1',
        run: (signal) =>
          new Promise<string>((_, reject) => {
            signal.addEventListener('abort', () => { reject(new Error('aborted-1')); });
          }),
      },
      {
        name: 'hang-2',
        run: (signal) =>
          new Promise<string>((_, reject) => {
            signal.addEventListener('abort', () => {
              slowAborted = true;
              reject(new Error('aborted-2'));
            });
          }),
      },
    ];
    // Neither candidate has its own timeoutMs — without an overall deadline this
    // would hang forever.
    await expect(
      raceProviders(candidates, { overallDeadlineMs: 30 }),
    ).rejects.toBeInstanceOf(Error);
    expect(slowAborted).toBe(true);
  });

  it('single-candidate path respects the overall deadline', async () => {
    const candidate: RaceCandidate<string> = {
      name: 'hang',
      run: (signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    await expect(
      raceProviders([candidate], { overallDeadlineMs: 25 }),
    ).rejects.toThrow('aborted');
  });

  it('does not abort when a winner returns before the deadline', async () => {
    const candidates: RaceCandidate<string>[] = [
      { name: 'fast', run: async () => { await delay(5); return 'fast'; } },
      {
        name: 'slow',
        run: (signal) => new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => resolve('slow'), 1000);
          signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
        }),
      },
    ];
    const r = await raceProviders(candidates, { overallDeadlineMs: 500 });
    expect(r.provider).toBe('fast');
    expect(r.result).toBe('fast');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// provider-racer #10 / #87 — otherCancelled + wastedCalls
// ─────────────────────────────────────────────────────────────────────────────
describe('provider-racer #10/#87 — otherCancelled + wastedCalls', () => {
  it('single candidate reports otherCancelled=false and 0 wasted', async () => {
    const r = await raceProviders([{ name: 'solo', run: async () => 'x' }]);
    expect(r.otherCancelled).toBe(false);
    expect(r.wastedCalls).toBe(0);
  });

  it('multi-candidate win reports otherCancelled=true and counts losers', async () => {
    const candidates: RaceCandidate<string>[] = [
      { name: 'fast', run: async () => { await delay(2); return 'fast'; } },
      {
        name: 'slow',
        run: (signal) => new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => resolve('slow'), 500);
          signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
        }),
      },
    ];
    const r = await raceProviders(candidates);
    expect(r.provider).toBe('fast');
    expect(r.otherCancelled).toBe(true);
    expect(r.wastedCalls).toBe(1);
  });

  it('invokes the onWaste callback with the loser count', async () => {
    const onWaste = vi.fn();
    const candidates: RaceCandidate<string>[] = [
      { name: 'w', run: async () => 'w' },
      { name: 'l1', run: (s) => new Promise<string>((_, rej) => s.addEventListener('abort', () => rej(new Error('a')))) },
      { name: 'l2', run: (s) => new Promise<string>((_, rej) => s.addEventListener('abort', () => rej(new Error('a')))) },
    ];
    await raceProviders(candidates, { onWaste });
    expect(onWaste).toHaveBeenCalledWith(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// provider-racer #14 — jitter/backoff retry delay
// ─────────────────────────────────────────────────────────────────────────────
describe('provider-racer #14 — computeRetryDelayMs', () => {
  it('grows exponentially with attempt (deterministic rand=1)', () => {
    const rand = () => 1; // max jitter -> equals the exp ceiling
    expect(computeRetryDelayMs(0, { baseMs: 100, rand })).toBe(100);
    expect(computeRetryDelayMs(1, { baseMs: 100, rand })).toBe(200);
    expect(computeRetryDelayMs(2, { baseMs: 100, rand })).toBe(400);
  });

  it('caps at maxMs', () => {
    const rand = () => 1;
    expect(computeRetryDelayMs(20, { baseMs: 100, maxMs: 1000, rand })).toBe(1000);
  });

  it('full jitter keeps the delay within [0, ceiling]', () => {
    for (let i = 0; i < 50; i++) {
      const d = computeRetryDelayMs(3, { baseMs: 100, maxMs: 5000 });
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(800); // 100 * 2^3
    }
  });

  it('honors Retry-After as a hard floor', () => {
    // rand=0 -> jitter 0, but retryAfter forces at least 3000
    expect(computeRetryDelayMs(0, { baseMs: 100, retryAfterMs: 3000, rand: () => 0 })).toBe(3000);
    // a larger jitter still wins if above the floor
    expect(computeRetryDelayMs(6, { baseMs: 100, maxMs: 8000, retryAfterMs: 1000, rand: () => 1 })).toBe(6400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ewma-tracker #516 — slow-decay / latch peak
// ─────────────────────────────────────────────────────────────────────────────
describe('ewma-tracker #516 — updatePeak', () => {
  it('latches immediately onto a new high', () => {
    expect(updatePeak(100, 5000, 120)).toBe(5000);
  });

  it('decays only slowly toward the mean after a spike (legacy averaged away fast)', () => {
    // Legacy formula: peak = latency*0.5 + peak*0.5 -> 5000 collapses to ~2500
    // after one normal 200ms sample. The slow-decay keeps it high.
    const afterOne = updatePeak(5000, 200, 200, 0.05);
    expect(afterOne).toBeGreaterThan(4500);
    // Even after several normal samples it remains elevated.
    let p = 5000;
    for (let i = 0; i < 5; i++) p = updatePeak(p, 200, 200, 0.05);
    expect(p).toBeGreaterThan(3500); // legacy would be < 250 by now
  });

  it('never drops below the EWMA (peak >= average by definition)', () => {
    expect(updatePeak(300, 100, 500, 0.05)).toBeGreaterThanOrEqual(500);
  });

  it('decay=0.5 reproduces the legacy mean-reverting behaviour', () => {
    // max(ewma, 5000*0.5 + 200*0.5) = max(200, 2600) = 2600
    expect(updatePeak(5000, 200, 200, 0.5)).toBe(2600);
  });

  it('record() keeps a spike in the tracked peak for several samples', () => {
    const t = new EWMATracker(0.3);
    t.record('p', 5000);          // first sample sets peak=5000
    for (let i = 0; i < 4; i++) t.record('p', 200);
    const score = t.rankingByScore().find((r) => r.provider === 'p');
    expect(score).toBeDefined();
    // peak should still be well above the ~200ms steady-state mean.
    expect(score!.peakMs).toBeGreaterThan(2000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ewma-tracker #517 — min-sample gate in pickBest
// ─────────────────────────────────────────────────────────────────────────────
describe('ewma-tracker #517 — min-sample gate', () => {
  it('default minSamples=1 preserves legacy single-sample trust', () => {
    const t = new EWMATracker(0.3);
    t.record('a', 1000);
    t.record('b', 50); // single fast sample
    expect(t.pickBest(['a', 'b'])).toBe('b');
  });

  it('a provider below minSamples is treated as unknown', () => {
    const t = new EWMATracker(0.3, { minSamples: 3 });
    // a: trusted (3 samples, slow). b: 1 fast fluke -> should NOT win.
    t.record('a', 1000); t.record('a', 1000); t.record('a', 1000);
    t.record('b', 50);
    expect(t.pickBest(['a', 'b'])).toBe('a');
  });

  it('a provider becomes eligible once it reaches minSamples', () => {
    const t = new EWMATracker(0.3, { minSamples: 3 });
    t.record('a', 1000); t.record('a', 1000); t.record('a', 1000);
    t.record('b', 50); t.record('b', 50); t.record('b', 50);
    expect(t.pickBest(['a', 'b'])).toBe('b');
  });

  it('all-cold candidates tie-break by cost even with a min-sample gate', () => {
    const t = new EWMATracker(0.3, { minSamples: 3 });
    const cost: Record<string, number> = { cheap: 0.1, pricey: 9 };
    expect(t.pickBest(['pricey', 'cheap'], (p) => cost[p] ?? null)).toBe('cheap');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readiness-state #506/#507/#508 — per-stage ring buffer
// ─────────────────────────────────────────────────────────────────────────────
describe('readiness-state per-stage ring (#506/#507/#508)', () => {
  beforeEach(() => { vi.resetModules(); });

  it('#506 ring holds ~100 samples so a single spike does not dominate p95', async () => {
    const m = await import('../../src/gateway/state/readiness-state');
    m.resetPerStageLatencyRings();
    for (let i = 0; i < 100; i++) m.recordPerStageLatency('stt', 100);
    // one spike among 100 should NOT push p95 to the spike (index 94 of 100).
    m.recordPerStageLatency('stt', 9999);
    const p95 = m.getPerStageP95('stt');
    expect(p95).toBe(100);
    // With the old 20-sample ring a single 9999 would land at/above index 18.
  });

  it('#507 ring index stays bounded after many wraps', async () => {
    const m = await import('../../src/gateway/state/readiness-state');
    m.resetPerStageLatencyRings();
    // Far exceed the ring size; idx must not grow unbounded but values still cycle.
    for (let i = 0; i < 1000; i++) m.recordPerStageLatency('llm', i);
    // Ring length stays capped.
    expect(m.perStageLatencyRing.llm.length).toBe(100);
    // The most-recent 100 values (900..999) are present, oldest evicted.
    expect(Math.max(...m.perStageLatencyRing.llm)).toBe(999);
    expect(Math.min(...m.perStageLatencyRing.llm)).toBe(900);
  });

  it('#508 a legitimate counter value of 0 is not treated as uninitialised', async () => {
    const m = await import('../../src/gateway/state/readiness-state');
    m.resetPerStageLatencyRings();
    // First record initialises idx to 0 then increments to 1; second record must
    // continue, not reset. Fill exactly to capacity then one more (the wrap) and
    // confirm the oldest sample was overwritten at index 0 (proves idx tracked).
    for (let i = 0; i < 100; i++) m.recordPerStageLatency('tts', i); // 0..99
    m.recordPerStageLatency('tts', 1234); // wraps -> overwrites index 0 (was 0)
    expect(m.perStageLatencyRing.tts[0]).toBe(1234);
    expect(m.perStageLatencyRing.tts.length).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readiness-state #720 — atomic cold-start profile write
// ─────────────────────────────────────────────────────────────────────────────
describe('readiness-state #720 — atomic profile save', () => {
  beforeEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  it('writes to a .tmp file then renames into place', async () => {
    const calls: string[] = [];
    const writes: Array<{ path: string }> = [];
    const renames: Array<{ from: string; to: string }> = [];
    vi.doMock('fs', () => ({
      existsSync: () => false, // no pre-existing profiles file
      mkdirSync: () => undefined,
      readFileSync: () => '[]',
      writeFileSync: (p: string) => { calls.push('write'); writes.push({ path: String(p) }); },
      renameSync: (from: string, to: string) => { calls.push('rename'); renames.push({ from: String(from), to: String(to) }); },
    }));
    const m = await import('../../src/gateway/state/readiness-state');
    m.saveColdStartProfile({
      gpuType: 'RTX 4090', dockerImage: 'img:latest', provider: 'runpod',
      coldTtfbMs: 1000, warmTtfbAvgMs: 200, modelLoadMs: 5000,
      measuredAt: Date.now(), sampleCount: 3,
    });
    // write must happen before rename, and the write target must be the .tmp file.
    expect(calls).toEqual(['write', 'rename']);
    expect(writes[0].path.endsWith('.tmp')).toBe(true);
    expect(renames[0].from.endsWith('.tmp')).toBe(true);
    expect(renames[0].to.endsWith('.tmp')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cost-state #543 — persist the tracked reset date, not "now"
// ─────────────────────────────────────────────────────────────────────────────
describe('cost-state #543 — persist tracked reset date', () => {
  beforeEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  it('persistDailySpend writes dailySpendResetDate, not wall-clock today', async () => {
    let written: any = null;
    vi.doMock('fs', () => ({
      existsSync: () => true,
      mkdirSync: () => undefined,
      readFileSync: () => '{}',
      writeFileSync: (_p: string, data: any) => { written = String(data); },
      // atomicWriteSyncWithFsync uses openSync/fsyncSync/closeSync/renameSync:
      openSync: () => 1,
      fsyncSync: () => undefined,
      closeSync: () => undefined,
      renameSync: () => undefined,
    }));
    const m = await import('../../src/gateway/state/cost-state');
    // Force the tracked reset date to a value distinct from "today".
    m.setDailySpendResetDate('2000-01-01');
    m.flushDailySpend(); // synchronous persist
    expect(written).not.toBeNull();
    const parsed = JSON.parse(written);
    expect(parsed.date).toBe('2000-01-01');
    expect(parsed.date).not.toBe(new Date().toISOString().slice(0, 10));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cost-state #545 — deploys_blocked counter
// ─────────────────────────────────────────────────────────────────────────────
describe('cost-state #545 — deploys_blocked counter', () => {
  beforeEach(() => { vi.resetModules(); });

  it('does not increment when there is no cap', async () => {
    const m = await import('../../src/gateway/state/cost-state');
    m.resetDeploysBlocked();
    // DAILY_BUDGET_USD defaults to 0 (no cap) in the test env.
    m.canAffordDeploy(2);
    expect(m.deploysBlockedTotal.hard_limit_exceeded).toBe(0);
    expect(m.deploysBlockedTotal.soft_limit_exceeded).toBe(0);
  });

  it('counts hard-limit refusals separately from soft-limit refusals', async () => {
    vi.resetModules();
    process.env.DAILY_BUDGET_USD = '100';
    const m = await import('../../src/gateway/state/cost-state');
    m.resetDeploysBlocked();

    // Hard limit: projected (current 0 + 200) > cap 100.
    m.setDailyGpuSpendUsd(0);
    let d = m.canAffordDeploy(200);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('hard_limit_exceeded');
    expect(m.deploysBlockedTotal.hard_limit_exceeded).toBe(1);

    // Soft limit: current 90 is >=80% of cap, small projected stays under cap.
    m.setDailyGpuSpendUsd(90);
    d = m.canAffordDeploy(1);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('soft_limit_exceeded');
    expect(m.deploysBlockedTotal.soft_limit_exceeded).toBe(1);

    delete process.env.DAILY_BUDGET_USD;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// metrics-state #510 / #511 — defensive copy + olsSlope helper
// ─────────────────────────────────────────────────────────────────────────────
describe('metrics-state #510/#511', () => {
  beforeEach(() => { vi.resetModules(); });

  it('#511 olsSlope computes a positive slope for an increasing series', async () => {
    const { olsSlope } = await import('../../src/gateway/state/metrics-state');
    expect(olsSlope([0, 1, 2, 3, 4])).toBeCloseTo(1, 6);
    expect(olsSlope([10, 8, 6, 4])).toBeCloseTo(-2, 6);
  });

  it('#511 olsSlope is safe for degenerate inputs', async () => {
    const { olsSlope } = await import('../../src/gateway/state/metrics-state');
    expect(olsSlope([])).toBe(0);
    expect(olsSlope([5])).toBe(0);
    // identical x-values (timestamps) -> denom 0 -> 0, no NaN.
    expect(olsSlope([1, 2, 3], [7, 7, 7])).toBe(0);
  });

  it('#510 getLatencyTrend does not alias the live ring buffer', async () => {
    const m = await import('../../src/gateway/state/metrics-state');
    // Populate fewer than LATENCY_RING_SIZE so the un-wrapped branch runs.
    for (let i = 0; i < 30; i++) m.recordGpuLatency(100 + i);
    const before = [...m.latencyRing];
    const trend = m.getLatencyTrend();
    expect(trend.samples).toBe(30);
    // The live ring must be unchanged by computing the trend.
    expect(m.latencyRing).toEqual(before);
    expect(typeof trend.slopeMs).toBe('number');
  });
});
