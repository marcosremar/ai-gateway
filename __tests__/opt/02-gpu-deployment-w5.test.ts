// ── Unit tests for GPU deployment optimizations — WAVE 5 (IDs 101-200) ──────
// Pure-helper / localized-behavior tests only — no network, no provider/GPU
// calls, no real FS. Distinct from wave-1..4
// (02-gpu-deployment{,-w2,-w3,-w4}.test.ts). See
// docs/optimizations/implemented/02-gpu-deployment-w5.md for the ID mapping.

import { describe, it, expect, afterEach } from 'vitest';

import {
  cleanupCredentials,
} from '../../server/gpu-deploy-loop';
import {
  estimateRaceCostPerInstance,
  racePreflightImageError,
  computeRaceBudget,
  RACE_EST_PER_INSTANCE_HR,
} from '../../server/gpu-deploy-race';
import {
  tryAcquireDeployLock,
} from '../../server/gpu-handlers';
import { stopCanary } from '../../server/gpu-deploy-canary';
import {
  deployState, setDeployState, deployLock, setDeployLock,
} from '../../server/state';

// ── #148: cleanup deletes must preserve TensorDock authId ────────────────────
// The bug: in-loop cleanup deletes passed `{ apiKey }` only, dropping `authId`,
// so a TensorDock delete failed and left a billable instance. cleanupCredentials
// is the helper now used at every previously-broken site.
describe('#148 cleanupCredentials preserves authId', () => {
  it('keeps authId when present (TensorDock)', () => {
    const out = cleanupCredentials({ apiKey: 'k', authId: 'auth-123' });
    expect(out).toEqual({ apiKey: 'k', authId: 'auth-123' });
  });

  it('omits authId when absent (non-TensorDock — unchanged shape)', () => {
    const out = cleanupCredentials({ apiKey: 'k' });
    expect(out).toEqual({ apiKey: 'k' });
    expect('authId' in out).toBe(false);
  });

  it('drops an empty-string authId (falsy → treated as absent)', () => {
    const out = cleanupCredentials({ apiKey: 'k', authId: '' });
    expect(out).toEqual({ apiKey: 'k' });
  });

  it('does not mutate the input object', () => {
    const input = { apiKey: 'k', authId: 'a' };
    const out = cleanupCredentials(input);
    expect(out).not.toBe(input);
    expect(input).toEqual({ apiKey: 'k', authId: 'a' });
  });
});

// ── #151: race budget sizes per-instance cost from the real offer price ──────
describe('#151 estimateRaceCostPerInstance', () => {
  it('uses the cheapest live offer price when known', () => {
    expect(estimateRaceCostPerInstance(0.34)).toBeCloseTo(0.34, 5);
  });

  it('falls back to the flat $2 prior when no price is known', () => {
    expect(estimateRaceCostPerInstance(undefined)).toBe(RACE_EST_PER_INSTANCE_HR);
    expect(estimateRaceCostPerInstance(0)).toBe(RACE_EST_PER_INSTANCE_HR);
    expect(estimateRaceCostPerInstance(-1)).toBe(RACE_EST_PER_INSTANCE_HR);
  });

  it('feeds computeRaceBudget so a cheap 4090 race is no longer over-rejected', () => {
    // 4 × $0.40 = $1.60 ≤ $2 cap → all 4 slots allowed (the flat $2 prior would
    // have rejected at >1 instance under a $2 cap).
    const per = estimateRaceCostPerInstance(0.4);
    const plan = computeRaceBudget(4, per, 2);
    expect(plan.rejected).toBe(false);
    expect(plan.allowedRaceN).toBe(4);
  });

  it('feeds computeRaceBudget so an expensive A100 race is under-protected no more', () => {
    // 1 × $3.50 > $2 cap → reject (the flat $2 prior would have wrongly allowed it).
    const per = estimateRaceCostPerInstance(3.5);
    const plan = computeRaceBudget(2, per, 2);
    expect(plan.rejected).toBe(true);
  });
});

// ── #154: race path fails fast once on a bad image (was: fail N slots) ───────
describe('#154 racePreflightImageError', () => {
  it('returns null for a valid Docker image reference', () => {
    expect(racePreflightImageError('marcosremar/babelcast-subtitle:latest', ['vast', 'runpod'])).toBeNull();
    expect(racePreflightImageError('ghcr.io/owner/img:tag', ['vast'])).toBeNull();
  });

  it('returns an error string for a malformed image (whitespace / shell metachars)', () => {
    const e1 = racePreflightImageError('bad image with spaces', ['vast']);
    expect(typeof e1).toBe('string');
    expect(e1).toMatch(/Invalid dockerImage/);

    const e2 = racePreflightImageError('owner/img;rm -rf', ['runpod']);
    expect(typeof e2).toBe('string');
  });

  it('rejects a Modal deploy-script (.py) when modal is NOT a participating tier', () => {
    const e = racePreflightImageError('babelcast.py', ['vast', 'runpod']);
    expect(typeof e).toBe('string');
    expect(e).toMatch(/Invalid dockerImage/);
  });

  it('allows a Modal deploy-script (.py) when modal IS a participating tier', () => {
    expect(racePreflightImageError('babelcast.py', ['modal'])).toBeNull();
    expect(racePreflightImageError('trellis2.py', ['vast', 'modal'])).toBeNull();
  });
});

// ── #160: stop/terminate clear the canary eval interval ──────────────────────
// stopCanary() clears the 60s promote/rollback timer. It is now called in both
// handleGpuStop and handleGpuTerminate so the interval can't keep firing against
// a dead/paused endpoint.
describe('#160 stopCanary clears the eval interval', () => {
  afterEach(() => {
    // Defensive: ensure we never leak a timer into other suites.
    if (deployState.canaryEvalTimer) {
      try { clearInterval(deployState.canaryEvalTimer as ReturnType<typeof setInterval>); } catch { /* no-op */ }
      setDeployState({ canaryEvalTimer: null });
    }
  });

  it('clears an active canary timer and nulls the state field', () => {
    const timer = setInterval(() => { /* never runs in the test window */ }, 1_000_000);
    setDeployState({ canaryEvalTimer: timer });
    expect(deployState.canaryEvalTimer).toBeTruthy();

    stopCanary();
    expect(deployState.canaryEvalTimer).toBeNull();
  });

  it('is a safe no-op when no canary timer is set (idempotent)', () => {
    setDeployState({ canaryEvalTimer: null });
    expect(() => stopCanary()).not.toThrow();
    expect(deployState.canaryEvalTimer).toBeNull();
    // Second call still safe.
    expect(() => stopCanary()).not.toThrow();
  });
});

// ── #130: atomic deploy-lock acquisition helper ──────────────────────────────
// tryAcquireDeployLock() encapsulates the check-then-set so no future `await`
// can split the two and let a concurrent deploy race in.
describe('#130 tryAcquireDeployLock', () => {
  afterEach(() => {
    setDeployLock(false); // never leak a held lock into other suites
  });

  it('acquires the lock when free and returns true', () => {
    setDeployLock(false);
    expect(tryAcquireDeployLock()).toBe(true);
    expect(deployLock).toBe(true);
  });

  it('returns false without re-setting when the lock is already held', () => {
    setDeployLock(false);
    expect(tryAcquireDeployLock()).toBe(true);  // first caller wins
    expect(tryAcquireDeployLock()).toBe(false); // second caller rejected
    expect(deployLock).toBe(true);              // still held by the first
  });

  it('a release lets the next caller re-acquire', () => {
    setDeployLock(false);
    expect(tryAcquireDeployLock()).toBe(true);
    setDeployLock(false); // owner releases
    expect(tryAcquireDeployLock()).toBe(true); // re-acquirable
  });
});
