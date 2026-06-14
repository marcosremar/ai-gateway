/**
 * Optimization tests — pure idle-decision helpers (server/gpu-idle-logic.ts).
 *
 * These are pure functions (no state, no IO), so they're exercised directly.
 * Focus: the operator-configured idle timeout acting as an explicit
 * cost-control cap over the adaptive window (#201 mitigation — the 4h adaptive
 * floor must never silently widen an operator's cap), plus the core idle
 * action / monitor-delay helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveEffectiveIdleTimeout,
  computeAdaptiveIdleTimeout,
  checkIdleAction,
  computeIdleMs,
  adaptiveMonitorDelay,
} from '../../server/gpu-idle-logic';

describe('resolveEffectiveIdleTimeout — configured cap caps the adaptive floor', () => {
  const FOUR_H = 240 * 60_000;

  it('a configured 5-min timeout caps the 4h adaptive floor (cost control wins)', () => {
    expect(resolveEffectiveIdleTimeout(FOUR_H, 5 * 60_000)).toBe(5 * 60_000);
  });

  it('keeps the adaptive value when it is lower than the configured cap', () => {
    expect(resolveEffectiveIdleTimeout(20 * 60_000, 60 * 60_000)).toBe(20 * 60_000);
  });

  it('Infinity configured timeout disables idle shutdown entirely', () => {
    expect(resolveEffectiveIdleTimeout(FOUR_H, Infinity)).toBe(Infinity);
  });

  it('configured <= 0 falls back to the adaptive timeout', () => {
    expect(resolveEffectiveIdleTimeout(FOUR_H, 0)).toBe(FOUR_H);
    expect(resolveEffectiveIdleTimeout(FOUR_H, -1)).toBe(FOUR_H);
  });
});

describe('computeAdaptiveIdleTimeout — proportional to boot cost', () => {
  it('scales with the actual boot duration once it exceeds the floor (2x multiplier)', () => {
    // 3h30m boot → 2x = 7h (above the 4h floor, below the 8h ceiling).
    const t = computeAdaptiveIdleTimeout({
      lastBootDurationMs: 210 * 60_000,
      avgBootTimeS: 0,
      dockerImage: '',
      isBooting: false,
    });
    expect(t).toBe(420 * 60_000);
  });

  it('caps at the 8h ceiling for very long boots', () => {
    const t = computeAdaptiveIdleTimeout({
      lastBootDurationMs: 600 * 60_000, // 10h → 2x = 20h
      avgBootTimeS: 0,
      dockerImage: '',
      isBooting: false,
    });
    expect(t).toBe(480 * 60_000);
  });

  it('during boot returns a grace window of at least 20 min', () => {
    const t = computeAdaptiveIdleTimeout({
      lastBootDurationMs: 30_000, // 30s boot
      avgBootTimeS: 0,
      dockerImage: '',
      isBooting: true,
    });
    expect(t).toBeGreaterThanOrEqual(20 * 60_000);
  });
});

describe('checkIdleAction', () => {
  const TIMEOUT = 5 * 60_000;
  const now = 1_000_000_000_000;

  it('returns none when no baseline timestamp exists', () => {
    expect(checkIdleAction(0, 0, now, TIMEOUT, false)).toEqual({ action: 'none' });
  });

  it('returns stop once idle duration meets the timeout', () => {
    const last = now - TIMEOUT - 1;
    const r = checkIdleAction(last, 0, now, TIMEOUT, false);
    expect(r.action).toBe('stop');
  });

  it('warns at 75% of the timeout, exactly once (not when already warned)', () => {
    const last = now - Math.ceil(TIMEOUT * 0.8);
    expect(checkIdleAction(last, 0, now, TIMEOUT, false).action).toBe('warning');
    expect(checkIdleAction(last, 0, now, TIMEOUT, true).action).toBe('none');
  });

  it('uses the most recent of model/any request timestamps as the baseline', () => {
    const recent = now - 1_000;
    const old = now - TIMEOUT - 1;
    // Recent generic request keeps it active even though the model request is old.
    expect(checkIdleAction(old, recent, now, TIMEOUT, false)).toEqual({ action: 'none' });
  });
});

describe('computeIdleMs & adaptiveMonitorDelay', () => {
  it('computeIdleMs returns 0 with no baseline, else now - lastActivity', () => {
    expect(computeIdleMs(0, 0, 5_000)).toBe(0);
    expect(computeIdleMs(2_000, 1_000, 5_000)).toBe(3_000);
  });

  it('adaptiveMonitorDelay slows to 60s when idle > 1 min', () => {
    expect(adaptiveMonitorDelay(120_000, 30_000, 30_000)).toBe(60_000);
  });

  it('adaptiveMonitorDelay keeps the current delay when not idle long enough', () => {
    expect(adaptiveMonitorDelay(30_000, 30_000, 30_000)).toBe(30_000);
  });
});
