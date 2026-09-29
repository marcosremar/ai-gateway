/**
 * gpu-idle-logic unit tests
 *
 * All functions under test are pure (no side effects, no mutable state imports),
 * so these tests are fast and deterministic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkIdleAction,
  shouldResetIdleFromHealth,
  computeAdaptiveIdleTimeout,
  resolveEffectiveIdleTimeout,
  adaptiveMonitorDelay,
  computeIdleMs,
  estimateBootTimeFromImage,
  type IdleCheckResult,
  type IdleTimeoutContext,
} from '../../server/gpu-idle-logic';

// ── checkIdleAction ─────────────────────────────────────────────────────────

describe('checkIdleAction', () => {
  const TIMEOUT_MS = 15 * 60_000; // 15 min
  const BASE_TIME = 1_000_000_000;

  it('returns none when no baseline time exists (both zeros)', () => {
    const result = checkIdleAction(0, 0, BASE_TIME, TIMEOUT_MS, false);
    expect(result.action).toBe('none');
  });

  it('returns none when idle duration is below 75% threshold', () => {
    const now = BASE_TIME + TIMEOUT_MS * 0.5; // 50% idle
    const result = checkIdleAction(BASE_TIME, 0, now, TIMEOUT_MS, false);
    expect(result.action).toBe('none');
  });

  it('returns warning when idle is between 75% and 100% of timeout (not yet warned)', () => {
    const now = BASE_TIME + TIMEOUT_MS * 0.8; // 80% idle
    const result = checkIdleAction(BASE_TIME, 0, now, TIMEOUT_MS, false) as Extract<IdleCheckResult, { action: 'warning' }>;
    expect(result.action).toBe('warning');
    expect(result.idleMs).toBeCloseTo(TIMEOUT_MS * 0.8, -2);
    expect(result.remainingSec).toBeGreaterThan(0);
    expect(result.remainingSec).toBeLessThan(TIMEOUT_MS / 1000);
  });

  it('skips warning when alreadyWarned=true even if in warning band', () => {
    const now = BASE_TIME + TIMEOUT_MS * 0.8;
    const result = checkIdleAction(BASE_TIME, 0, now, TIMEOUT_MS, true);
    expect(result.action).toBe('none');
  });

  it('returns stop when idle exceeds timeout', () => {
    const now = BASE_TIME + TIMEOUT_MS + 1000; // just over threshold
    const result = checkIdleAction(BASE_TIME, 0, now, TIMEOUT_MS, false) as Extract<IdleCheckResult, { action: 'stop' }>;
    expect(result.action).toBe('stop');
    expect(result.idleMs).toBeGreaterThanOrEqual(TIMEOUT_MS);
    expect(result.idleMin).toBe(Math.round(result.idleMs / 60_000));
  });

  it('uses lastRequestTime when it is more recent than lastModelRequestTime', () => {
    const lastModel = BASE_TIME;
    const lastReq = BASE_TIME + 5000; // 5 s later
    const now = lastReq + TIMEOUT_MS + 1000;
    const result = checkIdleAction(lastModel, lastReq, now, TIMEOUT_MS, false);
    expect(result.action).toBe('stop');
  });

  it('uses lastModelRequestTime when it is more recent than lastRequestTime', () => {
    const lastReq = BASE_TIME;
    const lastModel = BASE_TIME + 5000;
    const now = lastModel + TIMEOUT_MS * 0.5;
    const result = checkIdleAction(lastModel, lastReq, now, TIMEOUT_MS, false);
    expect(result.action).toBe('none');
  });

  it('returns stop=true when exactly at timeout boundary', () => {
    const now = BASE_TIME + TIMEOUT_MS;
    const result = checkIdleAction(BASE_TIME, 0, now, TIMEOUT_MS, false);
    expect(result.action).toBe('stop');
  });
});

// ── shouldResetIdleFromHealth ────────────────────────────────────────────────

describe('shouldResetIdleFromHealth', () => {
  const TIMEOUT_MS = 15 * 60_000;
  // Must be > 1e12 so the function does NOT treat it as epoch-seconds
  const NOW = 1_700_000_000_000; // ~Nov 2023 in ms

  it('returns false for null healthData', () => {
    expect(shouldResetIdleFromHealth(null, 0, TIMEOUT_MS, NOW)).toBe(false);
  });

  it('returns true when training=true', () => {
    expect(shouldResetIdleFromHealth({ training: true }, 0, TIMEOUT_MS, NOW)).toBe(true);
  });

  it('returns true when model_loaded=false (still initializing)', () => {
    expect(shouldResetIdleFromHealth({ model_loaded: false }, 0, TIMEOUT_MS, NOW)).toBe(true);
  });

  it('returns true when deployedGpuUtil > 5', () => {
    expect(shouldResetIdleFromHealth({}, 50, TIMEOUT_MS, NOW)).toBe(true);
  });

  it('returns false when deployedGpuUtil <= 5 and no other signals', () => {
    expect(shouldResetIdleFromHealth({}, 5, TIMEOUT_MS, NOW)).toBe(false);
  });

  it('returns true when health body reports gpu_util > 5', () => {
    expect(shouldResetIdleFromHealth({ gpu_util: 80 }, 0, TIMEOUT_MS, NOW)).toBe(true);
  });

  it('returns true when health body reports gpuUtil > 5 (camelCase alias)', () => {
    expect(shouldResetIdleFromHealth({ gpuUtil: 30 }, 0, TIMEOUT_MS, NOW)).toBe(true);
  });

  it('returns false when gpu_util <= 5', () => {
    expect(shouldResetIdleFromHealth({ gpu_util: 3 }, 0, TIMEOUT_MS, NOW)).toBe(false);
  });

  it('returns true for recent last_request_at (epoch ms)', () => {
    const recentMs = NOW - 60_000; // 1 min ago — within timeout
    expect(shouldResetIdleFromHealth({ last_request_at: recentMs }, 0, TIMEOUT_MS, NOW)).toBe(true);
  });

  it('returns true for recent last_request_at (epoch seconds)', () => {
    const recentS = Math.floor((NOW - 60_000) / 1000); // epoch seconds
    expect(shouldResetIdleFromHealth({ last_request_at: recentS }, 0, TIMEOUT_MS, NOW)).toBe(true);
  });

  it('returns false for stale last_request_at older than idle timeout', () => {
    const staleMs = NOW - TIMEOUT_MS - 1000;
    expect(shouldResetIdleFromHealth({ last_request_at: staleMs }, 0, TIMEOUT_MS, NOW)).toBe(false);
  });

  it('returns true for lastRequestAt (camelCase alias)', () => {
    const recentMs = NOW - 30_000;
    expect(shouldResetIdleFromHealth({ lastRequestAt: recentMs }, 0, TIMEOUT_MS, NOW)).toBe(true);
  });

  it('returns true for last_activity_at alias', () => {
    const recentMs = NOW - 30_000;
    expect(shouldResetIdleFromHealth({ last_activity_at: recentMs }, 0, TIMEOUT_MS, NOW)).toBe(true);
  });

  it('returns true when active_requests > 0', () => {
    expect(shouldResetIdleFromHealth({ active_requests: 2 }, 0, TIMEOUT_MS, NOW)).toBe(true);
  });

  it('returns true when activeRequests > 0 (camelCase alias)', () => {
    expect(shouldResetIdleFromHealth({ activeRequests: 1 }, 0, TIMEOUT_MS, NOW)).toBe(true);
  });

  it('returns true when active_streams > 0', () => {
    expect(shouldResetIdleFromHealth({ active_streams: 3 }, 0, TIMEOUT_MS, NOW)).toBe(true);
  });

  it('returns false when active_requests is 0', () => {
    expect(shouldResetIdleFromHealth({ active_requests: 0 }, 0, TIMEOUT_MS, NOW)).toBe(false);
  });

  it('returns false for empty health body with no active signals', () => {
    expect(shouldResetIdleFromHealth({}, 0, TIMEOUT_MS, NOW)).toBe(false);
  });
});

// ── estimateBootTimeFromImage ────────────────────────────────────────────────

describe('estimateBootTimeFromImage', () => {
  it('returns high estimate for 70B model names', () => {
    expect(estimateBootTimeFromImage('llama-70b-q4')).toBeGreaterThanOrEqual(500);
  });

  it('returns high estimate for 200B pattern', () => {
    expect(estimateBootTimeFromImage('my-200b-model')).toBeGreaterThanOrEqual(500);
  });

  it('returns medium estimate for 32B model', () => {
    const t = estimateBootTimeFromImage('qwen-32b');
    expect(t).toBeGreaterThanOrEqual(300);
    expect(t).toBeLessThan(600);
  });

  it('returns medium estimate for 13B model', () => {
    const t = estimateBootTimeFromImage('codellama-13b');
    expect(t).toBeGreaterThanOrEqual(300);
    expect(t).toBeLessThan(600);
  });

  it('returns small estimate for 7B model', () => {
    const t = estimateBootTimeFromImage('mistral-7b-instruct');
    expect(t).toBeGreaterThanOrEqual(100);
    expect(t).toBeLessThan(300);
  });

  it('returns small estimate for 4B model', () => {
    const t = estimateBootTimeFromImage('gemma-4b');
    expect(t).toBeGreaterThanOrEqual(100);
    expect(t).toBeLessThan(300);
  });

  it('returns medium estimate for hybrik pattern', () => {
    const t = estimateBootTimeFromImage('hybrik-pose-v2');
    expect(t).toBeGreaterThanOrEqual(200);
    expect(t).toBeLessThan(500);
  });

  it('returns default estimate for unknown image', () => {
    const t = estimateBootTimeFromImage('my-custom-app:latest');
    expect(t).toBe(250);
  });
});

// ── computeAdaptiveIdleTimeout ───────────────────────────────────────────────

describe('computeAdaptiveIdleTimeout', () => {
  const MIN_IDLE = 240 * 60_000; // 4h
  const MAX_IDLE = 480 * 60_000; // 8h
  const MIN_BOOT_GRACE = 20 * 60_000; // 20 min

  it('uses lastBootDurationMs when provided', () => {
    const bootMs = 10 * 60_000; // 10 min
    const ctx: IdleTimeoutContext = {
      lastBootDurationMs: bootMs,
      avgBootTimeS: 0,
      dockerImage: '',
      isBooting: false,
    };
    const t = computeAdaptiveIdleTimeout(ctx);
    // adaptive = bootMs * 2.0 = 20 min, but floor is MIN_IDLE (4h)
    expect(t).toBe(MIN_IDLE);
  });

  it('respects MAX_IDLE ceiling for very long boot times', () => {
    const bootMs = 600 * 60_000; // 10h boot
    const ctx: IdleTimeoutContext = {
      lastBootDurationMs: bootMs,
      avgBootTimeS: 0,
      dockerImage: '',
      isBooting: false,
    };
    const t = computeAdaptiveIdleTimeout(ctx);
    expect(t).toBe(MAX_IDLE);
  });

  it('uses avgBootTimeS when lastBootDurationMs=0', () => {
    const ctx: IdleTimeoutContext = {
      lastBootDurationMs: 0,
      avgBootTimeS: 300, // 5 min
      dockerImage: '',
      isBooting: false,
    };
    const t = computeAdaptiveIdleTimeout(ctx);
    // boot = 300s*1000 = 300000ms, adaptive = 600000ms, but floor is MIN_IDLE
    expect(t).toBe(MIN_IDLE);
  });

  it('falls back to image-based estimate when both duration fields are 0', () => {
    const ctx: IdleTimeoutContext = {
      lastBootDurationMs: 0,
      avgBootTimeS: 0,
      dockerImage: 'my-custom-app',
      isBooting: false,
    };
    const t = computeAdaptiveIdleTimeout(ctx);
    // estimateBootTimeFromImage → 250s → 250000ms * 2 = 500000ms < MIN_IDLE
    expect(t).toBe(MIN_IDLE);
  });

  it('returns boot grace period when isBooting=true (≥ MIN_BOOT_GRACE)', () => {
    const ctx: IdleTimeoutContext = {
      lastBootDurationMs: 5 * 60_000, // 5 min actual boot so far
      avgBootTimeS: 0,
      dockerImage: '',
      isBooting: true,
    };
    const t = computeAdaptiveIdleTimeout(ctx);
    // 5min * 1.5 = 7.5min < MIN_BOOT_GRACE (20min) → returns MIN_BOOT_GRACE
    expect(t).toBe(MIN_BOOT_GRACE);
  });

  it('returns 1.5x boot estimate as grace when it exceeds MIN_BOOT_GRACE', () => {
    const ctx: IdleTimeoutContext = {
      lastBootDurationMs: 20 * 60_000, // 20 min boot
      avgBootTimeS: 0,
      dockerImage: '',
      isBooting: true,
    };
    const t = computeAdaptiveIdleTimeout(ctx);
    // 20min * 1.5 = 30min > 20min (MIN_BOOT_GRACE)
    expect(t).toBe(30 * 60_000);
  });
});

// ── resolveEffectiveIdleTimeout ──────────────────────────────────────────────

describe('resolveEffectiveIdleTimeout', () => {
  const ADAPTIVE = 4 * 60 * 60_000; // 4h

  it('returns configuredTimeoutMs when it is smaller than adaptive', () => {
    const configured = 30 * 60_000; // 30 min
    expect(resolveEffectiveIdleTimeout(ADAPTIVE, configured)).toBe(configured);
  });

  it('returns adaptiveTimeoutMs when configured is larger', () => {
    const configured = 8 * 60 * 60_000; // 8h > 4h adaptive
    expect(resolveEffectiveIdleTimeout(ADAPTIVE, configured)).toBe(ADAPTIVE);
  });

  it('returns adaptiveTimeoutMs when configured is 0 (disabled)', () => {
    expect(resolveEffectiveIdleTimeout(ADAPTIVE, 0)).toBe(ADAPTIVE);
  });

  it('returns Infinity when configured is Infinity (idle shutdown disabled)', () => {
    expect(resolveEffectiveIdleTimeout(ADAPTIVE, Infinity)).toBe(Infinity);
  });

  it('returns -Infinity passthrough for negative-infinity configured', () => {
    // -Infinity is not finite → returns configuredTimeoutMs
    expect(resolveEffectiveIdleTimeout(ADAPTIVE, -Infinity)).toBe(-Infinity);
  });
});

// ── adaptiveMonitorDelay ─────────────────────────────────────────────────────

describe('adaptiveMonitorDelay', () => {
  const BASE_DELAY = 30_000; // 30s

  it('returns currentDelayMs unchanged when idle < 1 min', () => {
    expect(adaptiveMonitorDelay(30_000, BASE_DELAY, BASE_DELAY)).toBe(BASE_DELAY);
  });

  it('returns 60s when idle > 1 min and current delay < 60s', () => {
    expect(adaptiveMonitorDelay(90_000, BASE_DELAY, BASE_DELAY)).toBe(60_000);
  });

  it('does not reduce delay when already at 60s or above', () => {
    expect(adaptiveMonitorDelay(90_000, 60_000, BASE_DELAY)).toBe(60_000);
    expect(adaptiveMonitorDelay(90_000, 120_000, BASE_DELAY)).toBe(120_000);
  });

  it('returns currentDelayMs unchanged when idle is exactly 60s', () => {
    // 60_000 is not > 60_000
    expect(adaptiveMonitorDelay(60_000, BASE_DELAY, BASE_DELAY)).toBe(BASE_DELAY);
  });
});

// ── computeIdleMs ────────────────────────────────────────────────────────────

describe('computeIdleMs', () => {
  const NOW = 1_000_000_000;

  it('returns 0 when both timestamps are 0', () => {
    expect(computeIdleMs(0, 0, NOW)).toBe(0);
  });

  it('computes idle from the more recent of the two timestamps', () => {
    const older = NOW - 300_000; // 5 min ago
    const newer = NOW - 60_000;  // 1 min ago
    expect(computeIdleMs(older, newer, NOW)).toBe(60_000);
    expect(computeIdleMs(newer, older, NOW)).toBe(60_000);
  });

  it('uses lastModelRequestTime when lastRequestTime is 0', () => {
    const lastModel = NOW - 120_000;
    expect(computeIdleMs(lastModel, 0, NOW)).toBe(120_000);
  });

  it('uses lastRequestTime when lastModelRequestTime is 0', () => {
    const lastReq = NOW - 45_000;
    expect(computeIdleMs(0, lastReq, NOW)).toBe(45_000);
  });

  it('returns 0 when idle base is 0 (both 0)', () => {
    expect(computeIdleMs(0, 0, NOW)).toBe(0);
  });
});
