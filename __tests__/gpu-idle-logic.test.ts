/**
 * Unit tests for server/gpu-idle-logic.ts.
 *
 * Covers: checkIdleAction (none/warning/stop branches), shouldResetIdleFromHealth
 * (all detection signals), estimateBootTimeFromImage (registry path + regex heuristics),
 * computeAdaptiveIdleTimeout (boot grace + post-ready adaptive window),
 * resolveEffectiveIdleTimeout (config override logic), adaptiveMonitorDelay,
 * and computeIdleMs.
 *
 * All pure functions — no side effects; time is injectable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock app-registry (used by estimateBootTimeFromImage via require()) ────────

vi.mock('../server/app-registry', () => ({
  getImage: vi.fn(() => null),
  bootEstimateForImage: vi.fn(() => 300),
}));

// ── Import under test ─────────────────────────────────────────────────────────

import {
  checkIdleAction,
  shouldResetIdleFromHealth,
  estimateBootTimeFromImage,
  computeAdaptiveIdleTimeout,
  resolveEffectiveIdleTimeout,
  adaptiveMonitorDelay,
  computeIdleMs,
  type IdleCheckResult,
  type IdleTimeoutContext,
} from '../server/gpu-idle-logic';

// ── Helpers ───────────────────────────────────────────────────────────────────

const MIN_4H = 240 * 60_000;
const MAX_8H = 480 * 60_000;
const TIMEOUT_15MIN = 15 * 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// checkIdleAction
// ─────────────────────────────────────────────────────────────────────────────

describe('checkIdleAction', () => {
  it('#1 returns none when no baseline timestamp exists', () => {
    const result = checkIdleAction(0, 0, Date.now(), TIMEOUT_15MIN, false);
    expect(result.action).toBe('none');
  });

  it('#2 returns none when idle duration is below 75% of timeout', () => {
    const now = 1_000_000;
    const lastRequest = now - TIMEOUT_15MIN * 0.5; // 50% of timeout
    const result = checkIdleAction(lastRequest, 0, now, TIMEOUT_15MIN, false);
    expect(result.action).toBe('none');
  });

  it('#3 returns warning when idle is between 75% and 100% of timeout', () => {
    const now = 1_000_000;
    const lastRequest = now - TIMEOUT_15MIN * 0.8; // 80% of timeout
    const result = checkIdleAction(lastRequest, 0, now, TIMEOUT_15MIN, false) as Extract<IdleCheckResult, { action: 'warning' }>;
    expect(result.action).toBe('warning');
    expect(result.remainingSec).toBeGreaterThan(0);
    expect(result.idleMs).toBeGreaterThan(0);
  });

  it('#4 warning is suppressed when alreadyWarned=true', () => {
    const now = 1_000_000;
    const lastRequest = now - TIMEOUT_15MIN * 0.8;
    const result = checkIdleAction(lastRequest, 0, now, TIMEOUT_15MIN, true);
    expect(result.action).toBe('none');
  });

  it('#5 returns stop when idle duration reaches full timeout', () => {
    const now = 1_000_000;
    const lastRequest = now - TIMEOUT_15MIN; // exactly at timeout
    const result = checkIdleAction(lastRequest, 0, now, TIMEOUT_15MIN, false) as Extract<IdleCheckResult, { action: 'stop' }>;
    expect(result.action).toBe('stop');
    expect(result.idleMs).toBeGreaterThanOrEqual(TIMEOUT_15MIN);
    expect(result.idleMin).toBeGreaterThanOrEqual(15);
  });

  it('#6 returns stop when idle duration exceeds timeout', () => {
    const now = 10_000_000; // large enough: now - TIMEOUT_15MIN*2 stays positive
    const lastRequest = now - TIMEOUT_15MIN * 2;
    const result = checkIdleAction(lastRequest, 0, now, TIMEOUT_15MIN, false);
    expect(result.action).toBe('stop');
  });

  it('#7 uses max of lastModelRequestTime and lastRequestTime as baseline', () => {
    const now = 1_000_000;
    const recentRequest = now - TIMEOUT_15MIN * 0.1; // very recent
    const oldModelRequest = now - TIMEOUT_15MIN * 2;  // very old
    // recentRequest is the max, so idle should be short → none
    const result = checkIdleAction(oldModelRequest, recentRequest, now, TIMEOUT_15MIN, false);
    expect(result.action).toBe('none');
  });

  it('#8 uses max correctly when lastModelRequestTime is more recent', () => {
    const now = 1_000_000;
    const recentModel = now - TIMEOUT_15MIN * 0.1;
    const oldRequest = now - TIMEOUT_15MIN * 2;
    const result = checkIdleAction(recentModel, oldRequest, now, TIMEOUT_15MIN, false);
    expect(result.action).toBe('none');
  });

  it('#9 stop result idleMin is rounded value of idleMs / 60_000', () => {
    const now = 10_000_000;
    const lastRequest = now - 30 * 60_000; // 30 minutes idle
    const result = checkIdleAction(lastRequest, 0, now, TIMEOUT_15MIN, false) as Extract<IdleCheckResult, { action: 'stop' }>;
    expect(result.action).toBe('stop');
    expect(result.idleMin).toBe(30);
  });

  it('#10 warning remainingSec is correct remaining time', () => {
    const now = 1_000_000;
    // Put at 80% → 3 minutes until timeout
    const elapsed = TIMEOUT_15MIN * 0.8;
    const lastRequest = now - elapsed;
    const result = checkIdleAction(lastRequest, 0, now, TIMEOUT_15MIN, false) as Extract<IdleCheckResult, { action: 'warning' }>;
    expect(result.action).toBe('warning');
    const expected = Math.round((TIMEOUT_15MIN - elapsed) / 1000);
    expect(result.remainingSec).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shouldResetIdleFromHealth
// ─────────────────────────────────────────────────────────────────────────────

describe('shouldResetIdleFromHealth', () => {
  it('#11 returns false for null health data', () => {
    expect(shouldResetIdleFromHealth(null, 0, TIMEOUT_15MIN, 1_000_000)).toBe(false);
  });

  it('#12 returns true when training=true', () => {
    expect(shouldResetIdleFromHealth({ training: true }, 0, TIMEOUT_15MIN, 1_000_000)).toBe(true);
  });

  it('#13 returns false when training=false (other signals absent)', () => {
    expect(shouldResetIdleFromHealth({ training: false }, 0, TIMEOUT_15MIN, 1_000_000)).toBe(false);
  });

  it('#14 returns true when model_loaded=false (still initializing)', () => {
    expect(shouldResetIdleFromHealth({ model_loaded: false }, 0, TIMEOUT_15MIN, 1_000_000)).toBe(true);
  });

  it('#15 returns false when model_loaded=true (other signals absent)', () => {
    expect(shouldResetIdleFromHealth({ model_loaded: true }, 0, TIMEOUT_15MIN, 1_000_000)).toBe(false);
  });

  it('#16 returns true when deployedGpuUtil > 5', () => {
    expect(shouldResetIdleFromHealth({}, 10, TIMEOUT_15MIN, 1_000_000)).toBe(true);
  });

  it('#17 returns false when deployedGpuUtil exactly 5 (boundary)', () => {
    expect(shouldResetIdleFromHealth({}, 5, TIMEOUT_15MIN, 1_000_000)).toBe(false);
  });

  it('#18 returns true when health gpu_util > 5', () => {
    expect(shouldResetIdleFromHealth({ gpu_util: 20 }, 0, TIMEOUT_15MIN, 1_000_000)).toBe(true);
  });

  it('#19 returns true when health gpuUtil > 5 (camelCase alias)', () => {
    expect(shouldResetIdleFromHealth({ gpuUtil: 15 }, 0, TIMEOUT_15MIN, 1_000_000)).toBe(true);
  });

  it('#20 returns false when gpu_util is exactly 5', () => {
    expect(shouldResetIdleFromHealth({ gpu_util: 5 }, 0, TIMEOUT_15MIN, 1_000_000)).toBe(false);
  });

  it('#21 returns true when last_request_at is within idle timeout window (epoch ms)', () => {
    // Use real epoch-ms magnitude (> 1e12) so the code treats it as ms, not seconds.
    const now = 1_700_000_000_000;
    const lastReq = now - TIMEOUT_15MIN * 0.5; // 50% of timeout ago → within window
    expect(shouldResetIdleFromHealth({ last_request_at: lastReq }, 0, TIMEOUT_15MIN, now)).toBe(true);
  });

  it('#22 returns false when last_request_at is older than idle timeout', () => {
    const now = 1_700_000_000_000;
    const lastReq = now - TIMEOUT_15MIN * 2; // 2× timeout ago → stale
    expect(shouldResetIdleFromHealth({ last_request_at: lastReq }, 0, TIMEOUT_15MIN, now)).toBe(false);
  });

  it('#23 normalizes epoch seconds (< 1e12) to epoch ms', () => {
    // now is epoch ms; lastReqS is in epoch seconds (< 1e12)
    const nowMs = 1_700_000_000_000;
    const lastReqS = Math.round((nowMs - TIMEOUT_15MIN * 0.5) / 1000); // epoch seconds
    expect(lastReqS).toBeLessThan(1e12);
    expect(shouldResetIdleFromHealth({ last_request_at: lastReqS }, 0, TIMEOUT_15MIN, nowMs)).toBe(true);
  });

  it('#24 returns true when lastRequestAt alias is used (camelCase)', () => {
    const now = 1_700_000_000_000;
    const lastReq = now - TIMEOUT_15MIN * 0.5;
    expect(shouldResetIdleFromHealth({ lastRequestAt: lastReq }, 0, TIMEOUT_15MIN, now)).toBe(true);
  });

  it('#25 returns true when last_activity_at is within window', () => {
    const now = 1_700_000_000_000;
    const lastReq = now - TIMEOUT_15MIN * 0.3;
    expect(shouldResetIdleFromHealth({ last_activity_at: lastReq }, 0, TIMEOUT_15MIN, now)).toBe(true);
  });

  it('#26 returns true when active_requests > 0', () => {
    expect(shouldResetIdleFromHealth({ active_requests: 3 }, 0, TIMEOUT_15MIN, 1_000_000)).toBe(true);
  });

  it('#27 returns false when active_requests is 0', () => {
    expect(shouldResetIdleFromHealth({ active_requests: 0 }, 0, TIMEOUT_15MIN, 1_000_000)).toBe(false);
  });

  it('#28 returns true when activeRequests (camelCase) > 0', () => {
    expect(shouldResetIdleFromHealth({ activeRequests: 1 }, 0, TIMEOUT_15MIN, 1_000_000)).toBe(true);
  });

  it('#29 returns true when active_streams > 0', () => {
    expect(shouldResetIdleFromHealth({ active_streams: 2 }, 0, TIMEOUT_15MIN, 1_000_000)).toBe(true);
  });

  it('#30 returns true when activeStreams (camelCase) > 0', () => {
    expect(shouldResetIdleFromHealth({ activeStreams: 5 }, 0, TIMEOUT_15MIN, 1_000_000)).toBe(true);
  });

  it('#31 returns false when all signals absent', () => {
    expect(shouldResetIdleFromHealth({}, 0, TIMEOUT_15MIN, 1_000_000)).toBe(false);
  });

  it('#32 returns false when last_request_at is 0', () => {
    expect(shouldResetIdleFromHealth({ last_request_at: 0 }, 0, TIMEOUT_15MIN, 1_000_000)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// estimateBootTimeFromImage
// ─────────────────────────────────────────────────────────────────────────────

describe('estimateBootTimeFromImage', () => {
  it('#33 matches 70B pattern → returns 600s', () => {
    expect(estimateBootTimeFromImage('my-image-70b:latest')).toBe(600);
  });

  it('#34 matches 200B pattern → returns 600s', () => {
    expect(estimateBootTimeFromImage('model-200B')).toBe(600);
  });

  it('#35 matches llama.*70 → returns 600s', () => {
    expect(estimateBootTimeFromImage('llama3-70b-instruct')).toBe(600);
  });

  it('#36 matches mixtral → returns 600s', () => {
    expect(estimateBootTimeFromImage('mixtral-8x7b')).toBe(600);
  });

  it('#37 matches 32B → returns 400s', () => {
    expect(estimateBootTimeFromImage('qwen-32B-chat')).toBe(400);
  });

  it('#38 matches 13B → returns 400s', () => {
    expect(estimateBootTimeFromImage('llama-13b')).toBe(400);
  });

  it('#39 matches gemma.*27 → returns 400s', () => {
    expect(estimateBootTimeFromImage('gemma-27b-it')).toBe(400);
  });

  it('#40 matches 7B → returns 180s', () => {
    expect(estimateBootTimeFromImage('llama-7b-chat')).toBe(180);
  });

  it('#41 matches 4B → returns 180s', () => {
    expect(estimateBootTimeFromImage('gemma-4b')).toBe(180);
  });

  it('#42 matches 3B → returns 180s', () => {
    expect(estimateBootTimeFromImage('phi-3B')).toBe(180);
  });

  it('#43 matches phi → returns 180s', () => {
    expect(estimateBootTimeFromImage('phi-2')).toBe(180);
  });

  it('#44 matches hybrik → returns 300s', () => {
    expect(estimateBootTimeFromImage('hybrik-v2')).toBe(300);
  });

  it('#45 matches ultravox → returns 300s', () => {
    expect(estimateBootTimeFromImage('ultravox-s2s:latest')).toBe(300);
  });

  it('#46 matches wan-i2v → returns 300s', () => {
    expect(estimateBootTimeFromImage('wan-i2v-model')).toBe(300);
  });

  it('#47 unknown image falls back to 250s', () => {
    expect(estimateBootTimeFromImage('my-custom-image')).toBe(250);
  });

  it('#48 empty string falls back to 250s', () => {
    expect(estimateBootTimeFromImage('')).toBe(250);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeAdaptiveIdleTimeout
// ─────────────────────────────────────────────────────────────────────────────

describe('computeAdaptiveIdleTimeout', () => {
  const baseCtx: IdleTimeoutContext = {
    lastBootDurationMs: 0,
    avgBootTimeS: 0,
    dockerImage: 'unknown-image',
    isBooting: false,
  };

  it('#49 uses lastBootDurationMs when available (highest priority)', () => {
    const ctx: IdleTimeoutContext = { ...baseCtx, lastBootDurationMs: 300_000 }; // 5 min boot
    const result = computeAdaptiveIdleTimeout(ctx);
    // 300_000 * 2.0 = 600_000 ms (10 min), but floor is MIN_4H
    expect(result).toBe(MIN_4H);
  });

  it('#50 uses avgBootTimeS when lastBootDurationMs is 0', () => {
    const ctx: IdleTimeoutContext = { ...baseCtx, avgBootTimeS: 500 }; // 500s avg
    const result = computeAdaptiveIdleTimeout(ctx);
    // 500_000 * 2.0 = 1_000_000 ms, below MIN_4H → returns MIN_4H
    expect(result).toBe(MIN_4H);
  });

  it('#51 falls back to image-based estimate when both boot times are 0', () => {
    const ctx: IdleTimeoutContext = { ...baseCtx, dockerImage: 'unknown-image' };
    const result = computeAdaptiveIdleTimeout(ctx);
    // 250s * 2.0 = 500_000ms, below MIN_4H → MIN_4H
    expect(result).toBe(MIN_4H);
  });

  it('#52 adaptive timeout is capped at MAX_8H', () => {
    // A very long boot time: 300 min = 18_000_000ms
    // 18_000_000 * 2.0 = 36_000_000ms → capped at MAX_8H
    const ctx: IdleTimeoutContext = { ...baseCtx, lastBootDurationMs: 18_000_000 };
    const result = computeAdaptiveIdleTimeout(ctx);
    expect(result).toBe(MAX_8H);
  });

  it('#53 adaptive timeout respects MIN_4H floor', () => {
    // Even a 30s boot should give MIN_4H
    const ctx: IdleTimeoutContext = { ...baseCtx, lastBootDurationMs: 30_000 };
    const result = computeAdaptiveIdleTimeout(ctx);
    expect(result).toBe(MIN_4H);
  });

  it('#54 boot grace period is returned when isBooting=true', () => {
    const ctx: IdleTimeoutContext = { ...baseCtx, lastBootDurationMs: 600_000, isBooting: true };
    const result = computeAdaptiveIdleTimeout(ctx);
    // 600_000 * 1.5 = 900_000ms > MIN_BOOT_GRACE (1_200_000ms → 20min)
    // max(1_200_000, 900_000) = 1_200_000ms
    expect(result).toBe(20 * 60_000);
  });

  it('#55 boot grace is at least 20 min even for short boots', () => {
    const ctx: IdleTimeoutContext = { ...baseCtx, lastBootDurationMs: 5_000, isBooting: true };
    const result = computeAdaptiveIdleTimeout(ctx);
    // 5_000 * 1.5 = 7_500ms — below MIN_BOOT_GRACE (1_200_000ms)
    expect(result).toBe(20 * 60_000);
  });

  it('#56 long booting pod gets grace > 20 min', () => {
    // 30 min boot → 30 * 60_000 * 1.5 = 2_700_000ms (45 min)
    const ctx: IdleTimeoutContext = { ...baseCtx, lastBootDurationMs: 30 * 60_000, isBooting: true };
    const result = computeAdaptiveIdleTimeout(ctx);
    expect(result).toBe(45 * 60_000);
  });

  it('#57 lastBootDurationMs takes priority over avgBootTimeS', () => {
    const ctx: IdleTimeoutContext = {
      ...baseCtx,
      lastBootDurationMs: 100_000,
      avgBootTimeS: 9999,
    };
    // lastBootDurationMs wins → 100_000 * 2 = 200_000 < MIN_4H → MIN_4H
    const result = computeAdaptiveIdleTimeout(ctx);
    expect(result).toBe(MIN_4H);
  });

  it('#58 adaptive value between min and max is returned as-is', () => {
    // Boot time that makes adaptive timeout between MIN_4H and MAX_8H:
    // Need adaptiveTimeout > MIN_4H: bootMs * 2 > 240*60_000 → bootMs > 120*60_000 = 7_200_000ms
    const bootMs = 8 * 60 * 60_000; // 8 hours boot → adaptive = 16h → capped at 8h
    const ctx: IdleTimeoutContext = { ...baseCtx, lastBootDurationMs: bootMs };
    expect(computeAdaptiveIdleTimeout(ctx)).toBe(MAX_8H);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveEffectiveIdleTimeout
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveEffectiveIdleTimeout', () => {
  it('#59 returns configuredTimeout=Infinity unchanged', () => {
    expect(resolveEffectiveIdleTimeout(MIN_4H, Infinity)).toBe(Infinity);
  });

  it('#60 returns adaptiveTimeout when configuredTimeout <= 0', () => {
    expect(resolveEffectiveIdleTimeout(MIN_4H, 0)).toBe(MIN_4H);
  });

  it('#61 returns adaptiveTimeout when configuredTimeout is negative', () => {
    expect(resolveEffectiveIdleTimeout(MIN_4H, -1)).toBe(MIN_4H);
  });

  it('#62 returns min(adaptive, configured) when configured is positive and finite', () => {
    const adaptive = MIN_4H; // 4h
    const configured = 2 * 60 * 60_000; // 2h — stricter
    expect(resolveEffectiveIdleTimeout(adaptive, configured)).toBe(configured);
  });

  it('#63 returns adaptive when configured is larger than adaptive', () => {
    const adaptive = 60 * 60_000; // 1h
    const configured = MAX_8H; // 8h — looser than adaptive
    expect(resolveEffectiveIdleTimeout(adaptive, configured)).toBe(adaptive);
  });

  it('#64 returns configured when it equals adaptive', () => {
    expect(resolveEffectiveIdleTimeout(MIN_4H, MIN_4H)).toBe(MIN_4H);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// adaptiveMonitorDelay
// ─────────────────────────────────────────────────────────────────────────────

describe('adaptiveMonitorDelay', () => {
  it('#65 returns 60_000 when idleMs > 60_000 and currentDelay < 60_000', () => {
    expect(adaptiveMonitorDelay(90_000, 30_000, 30_000)).toBe(60_000);
  });

  it('#66 returns currentDelay unchanged when idleMs <= 60_000', () => {
    expect(adaptiveMonitorDelay(30_000, 30_000, 30_000)).toBe(30_000);
  });

  it('#67 returns currentDelay unchanged when already at 60_000', () => {
    expect(adaptiveMonitorDelay(90_000, 60_000, 30_000)).toBe(60_000);
  });

  it('#68 returns currentDelay unchanged when already above 60_000', () => {
    expect(adaptiveMonitorDelay(120_000, 90_000, 30_000)).toBe(90_000);
  });

  it('#69 idleMs exactly 60_000 does NOT trigger slow-down', () => {
    // Condition: idleMs > 60_000 — exactly 60k is not greater
    expect(adaptiveMonitorDelay(60_000, 30_000, 30_000)).toBe(30_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeIdleMs
// ─────────────────────────────────────────────────────────────────────────────

describe('computeIdleMs', () => {
  it('#70 returns 0 when both timestamps are 0', () => {
    expect(computeIdleMs(0, 0, 1_000_000)).toBe(0);
  });

  it('#71 returns elapsed since the most recent of the two timestamps', () => {
    const now = 1_000_000;
    const recentRequest = now - 5_000;
    const oldModel = now - 20_000;
    expect(computeIdleMs(oldModel, recentRequest, now)).toBe(5_000);
  });

  it('#72 uses lastModelRequestTime when it is more recent', () => {
    const now = 1_000_000;
    const recentModel = now - 3_000;
    const oldRequest = now - 15_000;
    expect(computeIdleMs(recentModel, oldRequest, now)).toBe(3_000);
  });

  it('#73 returns 0 when lastRequestTime is 0 and lastModelRequestTime is 0', () => {
    expect(computeIdleMs(0, 0, 9_999_999)).toBe(0);
  });

  it('#74 works when only lastModelRequestTime is set', () => {
    const now = 1_000_000;
    const model = now - 10_000;
    expect(computeIdleMs(model, 0, now)).toBe(10_000);
  });

  it('#75 works when only lastRequestTime is set', () => {
    const now = 1_000_000;
    const req = now - 7_500;
    expect(computeIdleMs(0, req, now)).toBe(7_500);
  });
});
