/**
 * Optimization implementation tests — Autoscaling, Reliability & Resilience
 * (docs/optimizations/03-autoscaling-reliability.md, IDs 201-300).
 *
 * Unit-only: no network, no GPU, no real filesystem writes. Pure helpers are
 * exercised behaviourally; `.unref()` additions and the monitor-loop threshold
 * conversions are verified via source-text assertions (the surrounding logic
 * needs a live monitor loop + provider clients to exercise directly), matching
 * the repo's existing structural-test convention.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const repoRoot = resolve(__dirname, '..', '..');
const readSrc = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf-8');

// ── #239 / #240 — crash-recovery thresholds use `>=` + one-shot flags ────────
describe('gpu-monitor-loop crash/recovery thresholds (#239/#240)', () => {
  const src = readSrc('server/gpu-monitor-loop.ts');

  it('SSH app-level recovery uses `>= 3` with a one-shot guard (was `=== 3`)', () => {
    expect(src).toContain('monitorConsecFails >= 3');
    expect(src).toContain('!sshRecoveryAttemptedForCurrentDeploy');
    expect(src).not.toContain('monitorConsecFails === 3');
  });

  it('crash-recovery redeploy uses `>= 10` with a one-shot guard (was `=== 10`)', () => {
    expect(src).toContain('monitorConsecFails >= 10');
    expect(src).toContain('!crashRedeployTriggeredForCurrentDeploy');
    expect(src).not.toContain('monitorConsecFails === 10');
  });

  it('one-shot recovery flags are reset on a fresh deploy in startGpuMonitoring', () => {
    const start = src.indexOf('export function startGpuMonitoring');
    const body = src.slice(start, src.indexOf('}', start) + 1);
    expect(body).toContain('sshRecoveryAttemptedForCurrentDeploy = false');
    expect(body).toContain('crashRedeployTriggeredForCurrentDeploy = false');
    expect(body).toContain('crashRecordedForCurrentDeploy = false');
  });

  it('#243 resetIdleState still leaves monitorCrashRecoveryAttempts untouched', () => {
    const resetFn = src.slice(src.indexOf('export function resetIdleState'));
    const resetBody = resetFn.slice(0, resetFn.indexOf('}') + 1);
    expect(resetBody).not.toContain('monitorCrashRecoveryAttempts');
    // The new one-shot flags must NOT be reset on every request either —
    // resetting them would let a crash→request→reset loop bypass the guard.
    expect(resetBody).not.toContain('crashRedeployTriggeredForCurrentDeploy');
    expect(resetBody).not.toContain('sshRecoveryAttemptedForCurrentDeploy');
  });
});

// ── #205/#261/#262/#263/#264/#265 — background timers unref'd ─────────────────
describe('background timers are unref\'d so they never pin the event loop', () => {
  it('#261 orphan-sweep periodic + initial timers unref (server/gpu-orphan-cleanup.ts)', () => {
    const src = readSrc('server/gpu-orphan-cleanup.ts');
    expect(src).toContain('orphanSweepTimer.unref');
    expect(src).toContain('orphanSweepInitialTimer.unref');
  });

  it('#262 standby-pool tick timer unref (server/standby-pool.ts)', () => {
    const src = readSrc('server/standby-pool.ts');
    const start = src.indexOf('export function startStandbyPoolMonitor');
    const body = src.slice(start, src.indexOf('}', src.indexOf('installPoolEventHook', start)) + 1);
    expect(body).toContain('tickTimer.unref');
  });

  it('#263 standby (handover) monitor timer unref + error-reset timer cleared', () => {
    const src = readSrc('server/gpu-standby.ts');
    expect(src).toContain('standbyMonitorTimer.unref');
    const stop = src.indexOf('export function stopStandbyMonitor');
    const stopBody = src.slice(stop, stop + 400);
    expect(stopBody).toContain('_standbyErrorResetTimer');
    expect(stopBody).toContain('clearTimeout(_standbyErrorResetTimer)');
  });

  it('#264 latency-scheduler startup + interval timers unref (server/latency-scheduler.ts)', () => {
    const src = readSrc('server/latency-scheduler.ts');
    expect(src).toContain('startupTimer.unref');
    expect(src).toContain('_timer.unref');
  });

  it('#205 destroy timer unref on both schedule + recovery paths', () => {
    const src = readSrc('server/gpu-destroy-timer.ts');
    // Two unref call-sites: scheduleAutoDestroy and recoverPersistedDestroyTimer.
    const matches = src.match(/destroyTimer as unknown as \{ unref\?: \(\) => void \}\)\.unref\?\.\(\)/g) ?? [];
    expect(matches.length).toBe(2);
  });
});

// ── #265 — predictive-warmer ticker unref (behavioural + structural) ─────────
describe('predictive-warmer (#265, #280 helpers)', () => {
  let warmer: typeof import('../../src/gateway/autoscaler/predictive-warmer');

  beforeEach(async () => {
    warmer = await import('../../src/gateway/autoscaler/predictive-warmer');
    warmer._resetPredictiveWarmerForTests();
  });

  afterEach(() => {
    warmer._resetPredictiveWarmerForTests();
  });

  it('#265 startPredictiveWarmer source unrefs the tick timer', () => {
    const src = readSrc('src/gateway/autoscaler/predictive-warmer.ts');
    const start = src.indexOf('export function startPredictiveWarmer');
    const body = src.slice(start, src.indexOf('export function stopPredictiveWarmer'));
    expect(body).toContain('tickTimer.unref');
  });

  it('startPredictiveWarmer calls unref() on the interval (no event-loop pin)', () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(globalThis, 'setInterval');
      let unrefCalled = false;
      // Make the next setInterval return a handle whose unref we can observe.
      spy.mockImplementationOnce(((fn: any, ms?: any) => {
        const handle: any = { unref: () => { unrefCalled = true; return handle; }, ref: () => handle };
        return handle;
      }) as any);
      warmer.startPredictiveWarmer(() => 0, async () => {}, { tickMs: 1000 });
      expect(unrefCalled).toBe(true);
      spy.mockRestore();
    } finally {
      warmer.stopPredictiveWarmer();
      vi.useRealTimers();
    }
  });

  it('EWMA forecast reflects recorded request volume', () => {
    const base = 10_000 * 60_000; // arbitrary fixed minute boundary
    // Fill the last 10 whole minutes each with 4 requests.
    for (let m = 1; m <= 10; m++) {
      const ts = base - m * 60_000 + 1;
      for (let r = 0; r < 4; r++) warmer.recordRequest(ts);
    }
    const ewma = warmer.currentEwma(base);
    expect(ewma).toBeCloseTo(4, 5);
    // forecastNext = ewma * forecastWindowMin(5) * safetyMargin(1.2) = 24
    warmer.startPredictiveWarmer(() => 0, async () => {});
    expect(warmer.forecastNext(base)).toBeCloseTo(24, 4);
    warmer.stopPredictiveWarmer();
  });
});

// ── #266 / #267 — memory-watcher restores global.setTimeout + wires idle GC ──
describe('memory-watcher global.setTimeout patch (#266/#267)', () => {
  let mw: typeof import('../../src/memory-watcher');

  beforeEach(async () => {
    mw = await import('../../src/memory-watcher');
  });

  it('#266 stop() restores the original global.setTimeout', () => {
    const original = global.setTimeout;
    const watcher = mw.startMemoryWatcher({ checkIntervalMs: 60_000 });
    // While running, the patch is installed (a different function reference).
    expect(global.setTimeout).not.toBe(original);
    watcher.stop();
    // After stop, the original must be restored — no permanent global leak.
    expect(global.setTimeout).toBe(original);
  });

  it('#266 stop() does NOT clobber a newer patch installed on top', () => {
    const original = global.setTimeout;
    const watcher = mw.startMemoryWatcher({ checkIntervalMs: 60_000 });
    const newer = ((fn: any, ms?: any, ...a: any[]) => original(fn, ms, ...a)) as typeof global.setTimeout;
    global.setTimeout = newer; // someone else re-patches after us
    watcher.stop();
    expect(global.setTimeout).toBe(newer); // ours must not stomp the newer one
    global.setTimeout = original; // cleanup
  });

  it('#267 idle GC reads the activity timestamp updated by the patch', () => {
    const src = readSrc('src/memory-watcher/index.ts');
    // The GC-on-idle check must read `lastActivity` (the patched var), not the
    // dead `lastRequestTime` that nothing updated.
    expect(src).toContain('Date.now() - lastActivity');
    expect(src).not.toContain('Date.now() - lastRequestTime');
  });
});

// ── #209 — zero-util GPU warning fires reliably once (>= + one-shot flag) ─────
describe('gpu-health-metrics zero-util warning (#209)', () => {
  const src = readSrc('server/gpu-health-metrics.ts');

  it('uses `>=` threshold with a one-shot `zeroUtilWarned` guard (was exact `===`)', () => {
    expect(src).toContain('consecutiveZeroUtilProbes >= ZERO_UTIL_WARNING_THRESHOLD');
    expect(src).toContain('zeroUtilWarned');
    expect(src).not.toContain('consecutiveZeroUtilProbes === ZERO_UTIL_WARNING_THRESHOLD');
  });

  it('warning resets when utilization resumes (so a later idle window re-warns)', () => {
    // Both the counter and the one-shot flag reset on util > 0.
    const elseBranch = src.slice(src.indexOf('else if (util > 0)'));
    expect(elseBranch).toContain('consecutiveZeroUtilProbes = 0');
    expect(elseBranch).toContain('zeroUtilWarned = false');
  });
});
