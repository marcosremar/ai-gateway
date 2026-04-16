/**
 * GPU Idle Auto-Stop — Comprehensive Tests
 *
 * Tests the entire idle auto-stop lifecycle:
 * 1. Pure idle decision logic (checkIdleAction, shouldResetIdleFromHealth)
 * 2. Timer reset via touchModelRequest / startGpuMonitoring
 * 3. Auto-stop flow (idle → stop → destroy timer)
 * 4. Auto-resume clears destroy timer
 * 5. The HybrIK scenario: boot 12-13 min, first job OK, second job killed
 * 6. External workload detection (GPU util > 0 resets idle)
 * 7. Race conditions and edge cases
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  checkIdleAction,
  shouldResetIdleFromHealth,
  adaptiveMonitorDelay,
  computeIdleMs,
  computeAdaptiveIdleTimeout,
  estimateBootTimeFromImage,
} from '../server/gpu-idle-logic';

const readSource = (file: string) => readFileSync(join(__dirname, '..', file), 'utf-8');

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Pure Idle Decision Logic
// ═══════════════════════════════════════════════════════════════════════════════

describe('checkIdleAction — pure idle decision', () => {
  const TIMEOUT = 15 * 60_000; // 15 min

  it('returns none when no baseline timestamps exist', () => {
    const result = checkIdleAction(0, 0, Date.now(), TIMEOUT, false);
    expect(result.action).toBe('none');
  });

  it('returns none when idle time is under threshold', () => {
    const now = Date.now();
    const result = checkIdleAction(now - 60_000, 0, now, TIMEOUT, false); // 1 min idle
    expect(result.action).toBe('none');
  });

  it('returns stop when idle time exceeds timeout', () => {
    const now = Date.now();
    const result = checkIdleAction(now - 16 * 60_000, 0, now, TIMEOUT, false); // 16 min idle
    expect(result.action).toBe('stop');
    if (result.action === 'stop') {
      expect(result.idleMin).toBe(16);
      expect(result.idleMs).toBeGreaterThanOrEqual(16 * 60_000);
    }
  });

  it('returns stop when idle time is exactly at timeout', () => {
    const now = Date.now();
    const result = checkIdleAction(now - TIMEOUT, 0, now, TIMEOUT, false);
    expect(result.action).toBe('stop');
  });

  it('returns warning at 75% of timeout (not yet warned)', () => {
    const now = Date.now();
    const idleMs = TIMEOUT * 0.8; // 80% of 15 min = 12 min
    const result = checkIdleAction(now - idleMs, 0, now, TIMEOUT, false);
    expect(result.action).toBe('warning');
    if (result.action === 'warning') {
      expect(result.remainingSec).toBeGreaterThan(0);
      expect(result.remainingSec).toBeLessThanOrEqual(TIMEOUT * 0.25 / 1000);
    }
  });

  it('does not warn again if already warned', () => {
    const now = Date.now();
    const idleMs = TIMEOUT * 0.8;
    const result = checkIdleAction(now - idleMs, 0, now, TIMEOUT, true); // already warned
    expect(result.action).toBe('none');
  });

  it('uses max of lastModelRequestTime and lastRequestTime', () => {
    const now = Date.now();
    // Model request was recent (5 min ago), general request was old (20 min ago)
    const result = checkIdleAction(now - 5 * 60_000, now - 20 * 60_000, now, TIMEOUT, false);
    expect(result.action).toBe('none'); // max(5min, 20min ago) = 5 min ago → not idle
  });

  it('uses max of lastModelRequestTime and lastRequestTime (reversed)', () => {
    const now = Date.now();
    // General request was recent (5 min ago), model request was old (20 min ago)
    const result = checkIdleAction(now - 20 * 60_000, now - 5 * 60_000, now, TIMEOUT, false);
    expect(result.action).toBe('none'); // max = 5 min ago
  });

  it('stops when both timestamps are old', () => {
    const now = Date.now();
    const result = checkIdleAction(now - 20 * 60_000, now - 18 * 60_000, now, TIMEOUT, false);
    expect(result.action).toBe('stop');
  });

  it('respects custom timeout values', () => {
    const now = Date.now();
    const shortTimeout = 5 * 60_000; // 5 min
    const result = checkIdleAction(now - 6 * 60_000, 0, now, shortTimeout, false);
    expect(result.action).toBe('stop');
  });

  it('handles very short timeout (1 min)', () => {
    const now = Date.now();
    const result = checkIdleAction(now - 90_000, 0, now, 60_000, false); // 1.5 min idle, 1 min timeout
    expect(result.action).toBe('stop');
  });

  it('handles very long timeout (60 min)', () => {
    const now = Date.now();
    const longTimeout = 60 * 60_000;
    const result = checkIdleAction(now - 30 * 60_000, 0, now, longTimeout, false); // 30 min idle
    expect(result.action).toBe('none');
  });

  it('warning includes correct remaining seconds', () => {
    const now = Date.now();
    // 12 min idle out of 15 min timeout → 3 min remaining
    const result = checkIdleAction(now - 12 * 60_000, 0, now, TIMEOUT, false);
    expect(result.action).toBe('warning');
    if (result.action === 'warning') {
      expect(result.remainingSec).toBeGreaterThanOrEqual(170); // ~3 min ± rounding
      expect(result.remainingSec).toBeLessThanOrEqual(190);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Health-based Idle Reset
// ═══════════════════════════════════════════════════════════════════════════════

describe('shouldResetIdleFromHealth — external workload detection', () => {
  const TIMEOUT = 15 * 60_000;

  it('returns false for null health data', () => {
    expect(shouldResetIdleFromHealth(null, 0)).toBe(false);
  });

  it('returns false for empty health data with no GPU util', () => {
    expect(shouldResetIdleFromHealth({}, 0)).toBe(false);
    expect(shouldResetIdleFromHealth({}, -1)).toBe(false);
  });

  it('returns true when training=true', () => {
    expect(shouldResetIdleFromHealth({ training: true }, 0)).toBe(true);
  });

  it('returns false when training=false', () => {
    expect(shouldResetIdleFromHealth({ training: false }, 0)).toBe(false);
  });

  it('returns true when model_loaded=false (still initializing)', () => {
    expect(shouldResetIdleFromHealth({ model_loaded: false }, 0)).toBe(true);
  });

  it('returns false when model_loaded=true', () => {
    expect(shouldResetIdleFromHealth({ model_loaded: true }, 0)).toBe(false);
  });

  it('returns true when GPU utilization > 0', () => {
    expect(shouldResetIdleFromHealth({}, 50)).toBe(true);
    expect(shouldResetIdleFromHealth({}, 1)).toBe(true);
  });

  it('returns false when GPU utilization is 0', () => {
    expect(shouldResetIdleFromHealth({}, 0)).toBe(false);
  });

  it('returns false when GPU utilization is -1 (unknown)', () => {
    expect(shouldResetIdleFromHealth({}, -1)).toBe(false);
  });

  it('any single active signal is sufficient', () => {
    // Only training
    expect(shouldResetIdleFromHealth({ training: true, model_loaded: true }, 0)).toBe(true);
    // Only model_loaded=false
    expect(shouldResetIdleFromHealth({ training: false, model_loaded: false }, 0)).toBe(true);
    // Only gpuUtil
    expect(shouldResetIdleFromHealth({ training: false, model_loaded: true }, 25)).toBe(true);
  });

  // ── last_request_at: the probe gap fix ──────────────────────────────────
  describe('last_request_at — probe gap fix', () => {
    it('resets idle when last_request_at is recent (epoch seconds)', () => {
      const fiveMinAgo = Math.floor(Date.now() / 1000) - 5 * 60;
      expect(shouldResetIdleFromHealth({ last_request_at: fiveMinAgo }, 0, TIMEOUT)).toBe(true);
    });

    it('resets idle when last_request_at is recent (epoch ms)', () => {
      const twoMinAgo = Date.now() - 2 * 60_000;
      expect(shouldResetIdleFromHealth({ last_request_at: twoMinAgo }, 0, TIMEOUT)).toBe(true);
    });

    it('does NOT reset when last_request_at is older than idle timeout', () => {
      const twentyMinAgo = Math.floor(Date.now() / 1000) - 20 * 60;
      expect(shouldResetIdleFromHealth({ last_request_at: twentyMinAgo }, 0, TIMEOUT)).toBe(false);
    });

    it('accepts lastRequestAt (camelCase variant)', () => {
      const oneMinAgo = Date.now() - 60_000;
      expect(shouldResetIdleFromHealth({ lastRequestAt: oneMinAgo }, 0, TIMEOUT)).toBe(true);
    });

    it('accepts last_activity_at (alternative name)', () => {
      const threeMinAgo = Date.now() - 3 * 60_000;
      expect(shouldResetIdleFromHealth({ last_activity_at: threeMinAgo }, 0, TIMEOUT)).toBe(true);
    });

    it('ignores last_request_at = 0', () => {
      expect(shouldResetIdleFromHealth({ last_request_at: 0 }, 0, TIMEOUT)).toBe(false);
    });

    it('ignores non-numeric last_request_at', () => {
      expect(shouldResetIdleFromHealth({ last_request_at: 'recently' }, 0, TIMEOUT)).toBe(false);
    });

    it('ignores future timestamps (clock skew)', () => {
      const futureTs = Date.now() + 60_000;
      // Future timestamp means ageMs < 0, which the check rejects
      expect(shouldResetIdleFromHealth({ last_request_at: futureTs }, 0, TIMEOUT)).toBe(false);
    });

    it('uses custom idleTimeoutMs for recency check', () => {
      const shortTimeout = 2 * 60_000; // 2 min
      const threeMinAgo = Date.now() - 3 * 60_000;
      // 3 min ago is outside 2 min timeout → NOT recent
      expect(shouldResetIdleFromHealth({ last_request_at: threeMinAgo }, 0, shortTimeout)).toBe(false);
      // But within the default 15 min timeout → recent
      expect(shouldResetIdleFromHealth({ last_request_at: threeMinAgo }, 0, TIMEOUT)).toBe(true);
    });
  });

  // ── active_requests: in-flight request detection ──────────────────────
  describe('active_requests — in-flight detection', () => {
    it('resets idle when active_requests > 0', () => {
      expect(shouldResetIdleFromHealth({ active_requests: 1 }, 0)).toBe(true);
      expect(shouldResetIdleFromHealth({ active_requests: 5 }, 0)).toBe(true);
    });

    it('does not reset when active_requests = 0', () => {
      expect(shouldResetIdleFromHealth({ active_requests: 0 }, 0)).toBe(false);
    });

    it('accepts activeRequests (camelCase variant)', () => {
      expect(shouldResetIdleFromHealth({ activeRequests: 2 }, 0)).toBe(true);
    });

    it('ignores non-numeric active_requests', () => {
      expect(shouldResetIdleFromHealth({ active_requests: 'yes' }, 0)).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Adaptive Monitor Delay
// ═══════════════════════════════════════════════════════════════════════════════

describe('adaptiveMonitorDelay — polling frequency', () => {
  const BASE = 30_000;

  it('keeps base delay when idle < 1 min', () => {
    expect(adaptiveMonitorDelay(30_000, BASE, BASE)).toBe(BASE);
  });

  it('increases to 60s when idle > 1 min and current delay < 60s', () => {
    expect(adaptiveMonitorDelay(90_000, BASE, BASE)).toBe(60_000);
  });

  it('does not decrease from 60s if already at 60s', () => {
    expect(adaptiveMonitorDelay(90_000, 60_000, BASE)).toBe(60_000);
  });

  it('keeps current delay when already above 60s', () => {
    expect(adaptiveMonitorDelay(90_000, 120_000, BASE)).toBe(120_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. computeIdleMs helper
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeIdleMs', () => {
  it('returns 0 when no timestamps', () => {
    expect(computeIdleMs(0, 0, Date.now())).toBe(0);
  });

  it('computes idle from lastModelRequestTime', () => {
    const now = Date.now();
    expect(computeIdleMs(now - 5000, 0, now)).toBeGreaterThanOrEqual(4999);
    expect(computeIdleMs(now - 5000, 0, now)).toBeLessThanOrEqual(5100);
  });

  it('uses max of both timestamps', () => {
    const now = Date.now();
    const idle = computeIdleMs(now - 10_000, now - 3000, now);
    expect(idle).toBeGreaterThanOrEqual(2900);
    expect(idle).toBeLessThanOrEqual(3200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. HybrIK Scenario — Boot + First Job + Idle Kill
// ═══════════════════════════════════════════════════════════════════════════════

describe('HybrIK scenario — long boot + external workload', () => {
  const TIMEOUT = 15 * 60_000;

  it('machine survives during boot (model_loaded=false resets idle)', () => {
    // T=0: pod becomes ready, startGpuMonitoring sets lastModelRequestTime = T0
    const bootReadyTime = Date.now();
    // T=12min: health probe during boot shows model_loaded=false
    const probeTime = bootReadyTime + 12 * 60_000;

    // Without the health reset, the idle check at T=12min would show 12 min idle
    const idleWithoutReset = checkIdleAction(bootReadyTime, 0, probeTime, TIMEOUT, false);
    expect(idleWithoutReset.action).toBe('warning'); // 80% of 15 min → warning

    // With the health reset (model still loading), idle should be reset
    const shouldReset = shouldResetIdleFromHealth({ model_loaded: false }, 0);
    expect(shouldReset).toBe(true);

    // After reset, lastModelRequestTime = probeTime, so idle = 0
    const idleAfterReset = checkIdleAction(probeTime, 0, probeTime, TIMEOUT, false);
    expect(idleAfterReset.action).toBe('none');
  });

  it('GPU util > 0 during extraction prevents idle timeout', () => {
    const jobStartTime = Date.now();
    // Job is running, GPU at 85% utilization
    const shouldReset = shouldResetIdleFromHealth({ status: 'ok' }, 85);
    expect(shouldReset).toBe(true);
  });

  it('GPU util drops to 0 between jobs → idle timer starts', () => {
    const jobEndTime = Date.now();
    // GPU idle after first job completes
    const shouldReset = shouldResetIdleFromHealth({ status: 'ok' }, 0);
    expect(shouldReset).toBe(false);

    // 15 minutes later → should auto-stop
    const checkTime = jobEndTime + 16 * 60_000;
    const result = checkIdleAction(jobEndTime, 0, checkTime, TIMEOUT, false);
    expect(result.action).toBe('stop');
  });

  it('CRITICAL: external workload with 0% gpu_util gets stopped (the bug)', () => {
    // This is the actual HybrIK bug: the extraction runs on the pod but
    // GPU utilization might show 0% between health probes (30s interval).
    // If the job finishes and GPU goes to 0% before the next probe,
    // the idle timer is NOT reset, and the pod gets stopped.
    const T0 = Date.now();
    const BOOT_TIME = 13 * 60_000; // 13 min boot

    // Pod becomes ready, idle clock = T0
    // First extraction starts immediately and takes 2 min
    const firstJobEnd = T0 + 2 * 60_000;

    // Health probe at T0 + 30s: GPU util = 0% (job hasn't started GPU work yet)
    const probe1Reset = shouldResetIdleFromHealth({ status: 'ok' }, 0);
    expect(probe1Reset).toBe(false); // NOT reset — this is the problem

    // If the extraction doesn't go through the gateway (external workload),
    // touchModelRequest is never called. The only protection is gpuUtil > 0.
    // With 30s probe interval, a short GPU burst may be completely missed.

    // After first job ends at T0+2min, GPU goes back to 0%.
    // Idle timer is still at T0 (from startGpuMonitoring).
    // At T0+15min, the pod is auto-stopped — only 13 min after first job finished.
    const idleCheck = checkIdleAction(T0, 0, T0 + TIMEOUT, TIMEOUT, false);
    expect(idleCheck.action).toBe('stop');

    // The second extraction request arrives at, say, T0+5min — but if the gateway
    // doesn't know about it, the idle timer keeps ticking from T0.
  });

  it('gateway-routed request resets idle (touchModelRequest equivalent)', () => {
    const T0 = Date.now();

    // Pod ready, idle starts at T0
    // First extraction at T0+1min → touchModelRequest sets lastModelRequestTime = T0+1min
    const firstJobTime = T0 + 60_000;
    const idleAfterJob = checkIdleAction(firstJobTime, 0, firstJobTime + 1000, 15 * 60_000, false);
    expect(idleAfterJob.action).toBe('none');

    // 14 min later (T0+15min) — still within timeout from first job, but warning (>75%)
    const check14min = checkIdleAction(firstJobTime, 0, firstJobTime + 14 * 60_000, 15 * 60_000, false);
    expect(check14min.action).toBe('warning'); // 14/15 = 93% > 75% threshold

    // 10 min later — still within timeout, no warning yet
    const check10min = checkIdleAction(firstJobTime, 0, firstJobTime + 10 * 60_000, 15 * 60_000, false);
    expect(check10min.action).toBe('none'); // 10/15 = 67% < 75%

    // 16 min after first job (T0+17min) — timeout from first job
    const check16min = checkIdleAction(firstJobTime, 0, firstJobTime + 16 * 60_000, 15 * 60_000, false);
    expect(check16min.action).toBe('stop');
  });

  it('full HybrIK timeline simulation', () => {
    // Simulate the exact user-reported scenario
    const BOOT_READY = 1000; // T=0: pod becomes ready (after 13 min boot)
    const TIMEOUT_MS = 15 * 60_000;
    let lastModelReq = BOOT_READY; // startGpuMonitoring sets this

    // T=0: Pod ready, lastModelReq = BOOT_READY
    expect(checkIdleAction(lastModelReq, 0, BOOT_READY, TIMEOUT_MS, false).action).toBe('none');

    // T=30s: First health probe — no GPU activity yet (just booted)
    const probe1 = BOOT_READY + 30_000;
    if (shouldResetIdleFromHealth({ status: 'ok', model_loaded: true }, 0)) {
      lastModelReq = probe1;
    }
    expect(checkIdleAction(lastModelReq, 0, probe1, TIMEOUT_MS, false).action).toBe('none');

    // T=1min: User sends first GLB extraction (external, not via gateway)
    // touchModelRequest NOT called because it's a direct HTTP call to the pod
    // GPU starts working

    // T=1.5min: Health probe — GPU util = 85%
    const probe2 = BOOT_READY + 90_000;
    if (shouldResetIdleFromHealth({ status: 'ok' }, 85)) {
      lastModelReq = probe2; // RESET — gpuUtil > 0
    }
    expect(checkIdleAction(lastModelReq, 0, probe2, TIMEOUT_MS, false).action).toBe('none');

    // T=3min: First extraction done. GPU util = 0%.
    const probe3 = BOOT_READY + 3 * 60_000;
    if (shouldResetIdleFromHealth({ status: 'ok' }, 0)) {
      lastModelReq = probe3;
    }
    // lastModelReq is still at probe2 (1.5min) — no reset

    // T=3.5min: Another probe — GPU still 0%
    const probe4 = BOOT_READY + 3.5 * 60_000;
    if (shouldResetIdleFromHealth({ status: 'ok' }, 0)) {
      lastModelReq = probe4;
    }

    // T=16.5min: 15 min after last activity (probe2 at 1.5min) → STOP
    const stopTime = lastModelReq + TIMEOUT_MS;
    const stopCheck = checkIdleAction(lastModelReq, 0, stopTime, TIMEOUT_MS, false);
    expect(stopCheck.action).toBe('stop');

    // The user wanted to send a second job at ~T=5min, but the pod will be
    // stopped at T=16.5min. If the second job was at T=5min, it would work.
    // But if the second job is at T=17min... too late.
    const secondJobAt17 = checkIdleAction(lastModelReq, 0, BOOT_READY + 17 * 60_000, TIMEOUT_MS, false);
    expect(secondJobAt17.action).toBe('stop'); // machine already stopped
  });

  it('FIXED: last_request_at survives the probe gap', () => {
    // Same scenario as the probe gap bug, but the GPU server now reports
    // last_request_at in its /health response.
    const T0 = Date.now();
    let lastModelReq = T0;
    const TIMEOUT_MS = 15 * 60_000;

    // Probe 1 at T=0: util=0, but last_request_at not set yet
    expect(shouldResetIdleFromHealth({ status: 'ok', last_request_at: 0 }, 0, TIMEOUT_MS, T0)).toBe(false);

    // Job runs T=5s to T=25s. GPU server records last_request_at = T+25s.
    const jobEndTimeSec = Math.floor((T0 + 25_000) / 1000);

    // Probe 2 at T=30s: util=0, BUT last_request_at = T+25s (5s ago = recent!)
    const probeTime = T0 + 30_000;
    const shouldReset = shouldResetIdleFromHealth(
      { status: 'ok', last_request_at: jobEndTimeSec },
      0,
      TIMEOUT_MS,
      probeTime,
    );
    expect(shouldReset).toBe(true); // FIX: the job is detected via timestamp

    // Reset idle timer
    lastModelReq = probeTime;

    // Now the machine stays alive for 15 more minutes from this point
    const check = checkIdleAction(lastModelReq, 0, lastModelReq + 14 * 60_000, TIMEOUT_MS, false);
    expect(check.action).not.toBe('stop');
  });

  it('FIXED: active_requests > 0 during processing prevents stop', () => {
    // The GPU server reports active_requests=1 while processing
    const shouldReset = shouldResetIdleFromHealth({ active_requests: 1 }, 0);
    expect(shouldReset).toBe(true);
  });

  it('scenario where GPU util probe is always 0 but pod is busy (probe gap bug)', () => {
    // The 30s probe interval means we can miss short GPU bursts entirely.
    // If an extraction takes 20s and the probe happens at 0s and 30s,
    // and the GPU work happens at 5s-25s, both probes see 0%.
    const T0 = Date.now();
    let lastModelReq = T0;

    // Probe 1 at T=0: util=0 (job hasn't started)
    expect(shouldResetIdleFromHealth({}, 0)).toBe(false);

    // Job runs T=5s to T=25s (GPU at 90%) — but NO probe during this window

    // Probe 2 at T=30s: util=0 (job finished 5s ago)
    expect(shouldResetIdleFromHealth({}, 0)).toBe(false);

    // Idle timer is still at T0 — the 20s of GPU work was completely invisible!
    // After 15 min from T0, the pod gets stopped even though it processed a job.
    const check = checkIdleAction(T0, 0, T0 + 15 * 60_000, 15 * 60_000, false);
    expect(check.action).toBe('stop');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Source Code Structural Tests — Verify Critical Wiring
// ═══════════════════════════════════════════════════════════════════════════════

describe('gpu-monitor-loop.ts — idle wiring', () => {
  const src = readSource('server/gpu-monitor-loop.ts');

  it('startGpuMonitoring resets lastModelRequestTime to Date.now()', () => {
    expect(src).toContain('setLastModelRequestTime(Date.now())');
  });

  it('uses checkIdleAction for idle decisions', () => {
    expect(src).toContain('checkIdleAction');
  });

  it('uses shouldResetIdleFromHealth for health-based idle reset', () => {
    expect(src).toContain('shouldResetIdleFromHealth');
  });

  it('resets idle warning flag on resetIdleState', () => {
    expect(src).toContain('idleWarned = false');
    expect(src).toContain('resetIdleState');
  });

  it('does NOT reset monitorCrashRecoveryAttempts in resetIdleState (intentional)', () => {
    const resetFn = src.slice(src.indexOf('export function resetIdleState'));
    const resetBody = resetFn.slice(0, resetFn.indexOf('}') + 1);
    expect(resetBody).not.toContain('monitorCrashRecoveryAttempts');
  });

  it('IDLE_TIMEOUT_MS defaults to 15 minutes', () => {
    expect(src).toContain('IDLE_TIMEOUT_MS = 15 * 60_000');
  });

  it('IDLE_DESTROY_MS defaults to 2 hours', () => {
    expect(src).toContain('IDLE_DESTROY_MS = 2 * 60 * 60_000');
  });

  it('has configurable setIdleTimeoutMs', () => {
    expect(src).toContain('export function setIdleTimeoutMs');
  });

  it('has configurable setIdleDestroyMs', () => {
    expect(src).toContain('export function setIdleDestroyMs');
  });
});

describe('gpu-idle-manager.ts — stop flow', () => {
  const src = readSource('server/gpu-idle-manager.ts');

  it('resolves provider client and credentials before stopping', () => {
    expect(src).toContain("provider === 'runpod'");
    expect(src).toContain("provider === 'vast'");
    expect(src).toContain("provider === 'tensordock'");
    expect(src).toContain("provider === 'modal'");
  });

  it('calls client.stopInstance (not deleteInstance) to preserve disk', () => {
    expect(src).toContain('client.stopInstance(podId, credentials)');
    // Should NOT call deleteInstance in the happy path
    const stopFnStart = src.indexOf('export async function autoStopGpu');
    const stopFnBody = src.slice(stopFnStart, src.indexOf('\n}', stopFnStart) + 2);
    const tryBlockStart = stopFnBody.indexOf('try {');
    const tryBlockEnd = stopFnBody.indexOf('} catch', tryBlockStart);
    const tryBlock = stopFnBody.slice(tryBlockStart, tryBlockEnd);
    expect(tryBlock).not.toContain('deleteInstance');
  });

  it('falls back to autoTerminateGpu on stop failure', () => {
    expect(src).toContain('autoTerminateGpu(reason)');
  });

  it('stops monitoring after auto-stop', () => {
    expect(src).toContain('stopGpuMonitoring()');
  });

  it('schedules auto-destroy after stop', () => {
    expect(src).toContain('scheduleAutoDestroy(IDLE_DESTROY_MS)');
  });

  it('transitions to stopped state (not idle)', () => {
    expect(src).toContain("status: 'stopped'");
    expect(src).toContain('deploymentSM.markStopped');
  });

  it('emits gpu.stopped event', () => {
    expect(src).toContain("emitGatewayEvent('gpu.stopped'");
  });

  it('updates pipeline to remove GPU endpoint', () => {
    expect(src).toContain('gpuEndpoint: undefined');
  });
});

describe('gpu-destroy-timer.ts — auto-destroy scheduling', () => {
  const src = readSource('server/gpu-destroy-timer.ts');

  it('clears existing timer before scheduling new one', () => {
    expect(src).toContain('clearAutoDestroyTimer()');
  });

  it('calls autoTerminateGpu with auto_destroy reason', () => {
    expect(src).toContain("autoTerminateGpu('auto_destroy')");
  });

  it('clearAutoDestroyTimer nullifies timer', () => {
    expect(src).toContain('destroyTimer = null');
  });

  it('broadcasts destroy event on WebSocket', () => {
    expect(src).toContain("action: 'destroy'");
  });
});

describe('gpu-resume-manager.ts — resume clears destroy timer', () => {
  const src = readSource('server/gpu-resume-manager.ts');

  it('clears auto-destroy timer on resume attempt', () => {
    expect(src).toContain('clearAutoDestroyTimer()');
  });

  it('starts GPU monitoring after successful resume', () => {
    expect(src).toContain('startGpuMonitoring()');
  });

  it('polls health until ready with timeout', () => {
    expect(src).toContain('RESUME_TIMEOUT_MS');
    expect(src).toContain('probeGpuHealth');
  });

  it('falls back to fresh deploy on resume failure', () => {
    expect(src).toContain('startDeployWithTiers');
  });

  it('cleans up orphaned pod on resume failure', () => {
    expect(src).toContain('client.deleteInstance(podId, credentials)');
  });
});

describe('state.ts — touchModelRequest wiring', () => {
  const src = readSource('server/state.ts');

  it('touchModelRequest updates lastModelRequestTime', () => {
    expect(src).toContain('lastModelRequestTime = Date.now()');
  });

  it('touchModelRequest calls resetIdleState', () => {
    expect(src).toContain('resetIdleState');
  });

  it('touchModelRequest triggers auto-resume when pod is stopped', () => {
    expect(src).toContain('sm.isStopped');
    expect(src).toContain('resumeOrDeploy');
  });

  it('guards against concurrent auto-resume', () => {
    expect(src).toContain('autoResumeInFlight');
  });

  it('lastModelRequestTime is initialized to 0 (not Date.now())', () => {
    expect(src).toContain('lastModelRequestTime = 0');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Edge Cases and Race Conditions
// ═══════════════════════════════════════════════════════════════════════════════

describe('edge cases — idle timer boundaries', () => {
  const TIMEOUT = 15 * 60_000;

  it('1ms before timeout → no stop', () => {
    const now = Date.now();
    const result = checkIdleAction(now - TIMEOUT + 1, 0, now, TIMEOUT, false);
    expect(result.action).not.toBe('stop');
  });

  it('exactly at timeout → stop', () => {
    const now = Date.now();
    const result = checkIdleAction(now - TIMEOUT, 0, now, TIMEOUT, false);
    expect(result.action).toBe('stop');
  });

  it('1ms past timeout → stop', () => {
    const now = Date.now();
    const result = checkIdleAction(now - TIMEOUT - 1, 0, now, TIMEOUT, false);
    expect(result.action).toBe('stop');
  });

  it('warning threshold boundary — 74.9% → no warning', () => {
    const now = Date.now();
    const idleMs = Math.floor(TIMEOUT * 0.749);
    const result = checkIdleAction(now - idleMs, 0, now, TIMEOUT, false);
    expect(result.action).toBe('none');
  });

  it('warning threshold boundary — 75% → warning', () => {
    const now = Date.now();
    const idleMs = TIMEOUT * 0.75;
    const result = checkIdleAction(now - idleMs, 0, now, TIMEOUT, false);
    expect(result.action).toBe('warning');
  });

  it('negative idle time (clock skew) → no stop', () => {
    const now = Date.now();
    const result = checkIdleAction(now + 60_000, 0, now, TIMEOUT, false); // future timestamp
    expect(result.action).toBe('none');
  });

  it('very large idle time → still returns stop (no overflow)', () => {
    const now = Date.now();
    const result = checkIdleAction(now - 365 * 24 * 60 * 60_000, 0, now, TIMEOUT, false); // 1 year idle
    expect(result.action).toBe('stop');
    if (result.action === 'stop') {
      expect(result.idleMin).toBeGreaterThan(0);
    }
  });
});

describe('edge cases — health-based idle reset', () => {
  it('handles undefined/missing fields gracefully', () => {
    expect(shouldResetIdleFromHealth({ random_field: 42 }, 0)).toBe(false);
  });

  it('handles training as non-boolean value', () => {
    // training='true' (string) should NOT trigger reset
    expect(shouldResetIdleFromHealth({ training: 'true' }, 0)).toBe(false);
    // training=1 (number) should NOT trigger reset
    expect(shouldResetIdleFromHealth({ training: 1 }, 0)).toBe(false);
  });

  it('handles model_loaded as non-boolean value', () => {
    // model_loaded=0 should NOT trigger reset
    expect(shouldResetIdleFromHealth({ model_loaded: 0 }, 0)).toBe(false);
  });

  it('GPU util exactly 0.0 does not trigger reset', () => {
    expect(shouldResetIdleFromHealth({}, 0.0)).toBe(false);
  });

  it('GPU util at 0.1% triggers reset', () => {
    expect(shouldResetIdleFromHealth({}, 0.1)).toBe(true);
  });

  it('multiple signals: last_request_at + active_requests both trigger', () => {
    const oneMinAgo = Date.now() - 60_000;
    expect(shouldResetIdleFromHealth({ last_request_at: oneMinAgo, active_requests: 1 }, 0)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Adaptive Idle Timeout — scales with boot cost and model size
// ═══════════════════════════════════════════════════════════════════════════════

describe('estimateBootTimeFromImage — model size heuristic', () => {
  it('70B models get long boot estimate (~600s)', () => {
    expect(estimateBootTimeFromImage('marcosremar/llama-70b:latest')).toBe(600);
    expect(estimateBootTimeFromImage('marcosremar/mixtral:latest')).toBe(600);
  });

  it('32B models get medium-long boot estimate (~400s)', () => {
    expect(estimateBootTimeFromImage('marcosremar/qwen-32b:latest')).toBe(400);
    expect(estimateBootTimeFromImage('marcosremar/gemma-27b:latest')).toBe(400);
  });

  it('7B models get short boot estimate (~180s)', () => {
    expect(estimateBootTimeFromImage('marcosremar/gemma-4b:latest')).toBe(180);
    expect(estimateBootTimeFromImage('marcosremar/phi-7b:latest')).toBe(180);
  });

  it('HybrIK gets medium boot estimate (~300s)', () => {
    expect(estimateBootTimeFromImage('marcosremar/hybrik-x:latest')).toBe(300);
  });

  it('WiLoR gets medium boot estimate (~300s)', () => {
    expect(estimateBootTimeFromImage('marcosremar/wilor:latest')).toBe(300);
  });

  it('unknown images get default (~250s)', () => {
    expect(estimateBootTimeFromImage('marcosremar/custom-thing:latest')).toBe(250);
  });
});

describe('computeAdaptiveIdleTimeout — post-ready idle', () => {
  it('uses actual boot duration when available (2x multiplier)', () => {
    // Boot took 5 min (300s) → idle timeout = 300 * 2 = 600s = 10 min
    const timeout = computeAdaptiveIdleTimeout({
      lastBootDurationMs: 300_000,
      avgBootTimeS: 0,
      dockerImage: '',
      isBooting: false,
    });
    expect(timeout).toBe(600_000); // 10 min
  });

  it('falls back to avgBootTimeS when no lastBootDuration', () => {
    // Historical avg: 200s → idle timeout = 200 * 2 = 400s
    const timeout = computeAdaptiveIdleTimeout({
      lastBootDurationMs: 0,
      avgBootTimeS: 200,
      dockerImage: '',
      isBooting: false,
    });
    expect(timeout).toBe(10 * 60_000); // 6.67 min → clamped to 10 min minimum
  });

  it('falls back to image-based estimate when no history', () => {
    // hybrik-x → 300s estimate → 300 * 2 = 600s = 10 min
    const timeout = computeAdaptiveIdleTimeout({
      lastBootDurationMs: 0,
      avgBootTimeS: 0,
      dockerImage: 'marcosremar/hybrik-x:latest',
      isBooting: false,
    });
    expect(timeout).toBe(600_000); // 10 min
  });

  it('large model (70B) gets longer idle timeout', () => {
    // 70B → 600s estimate → 600 * 2 = 1200s = 20 min
    const timeout = computeAdaptiveIdleTimeout({
      lastBootDurationMs: 0,
      avgBootTimeS: 0,
      dockerImage: 'marcosremar/llama-70b:latest',
      isBooting: false,
    });
    expect(timeout).toBe(1200_000); // 20 min
  });

  it('small model (7B) gets shorter idle timeout', () => {
    // 7B → 180s estimate → 180 * 2 = 360s = 6 min → clamped to 10 min minimum
    const timeout = computeAdaptiveIdleTimeout({
      lastBootDurationMs: 0,
      avgBootTimeS: 0,
      dockerImage: 'marcosremar/gemma-4b:latest',
      isBooting: false,
    });
    expect(timeout).toBe(10 * 60_000); // 10 min (minimum floor)
  });

  it('enforces minimum idle timeout (10 min)', () => {
    // Very fast boot: 30s → 30 * 2 = 60s, but minimum = 10 min
    const timeout = computeAdaptiveIdleTimeout({
      lastBootDurationMs: 30_000,
      avgBootTimeS: 0,
      dockerImage: '',
      isBooting: false,
    });
    expect(timeout).toBe(10 * 60_000);
  });

  it('enforces maximum idle timeout (60 min)', () => {
    // Extremely long boot: 45 min → 45 * 2 = 90 min → capped at 60 min
    const timeout = computeAdaptiveIdleTimeout({
      lastBootDurationMs: 45 * 60_000,
      avgBootTimeS: 0,
      dockerImage: '',
      isBooting: false,
    });
    expect(timeout).toBe(60 * 60_000);
  });

  it('actual boot time takes priority over history and image estimate', () => {
    // All three sources available — lastBootDurationMs wins
    const timeout = computeAdaptiveIdleTimeout({
      lastBootDurationMs: 600_000, // 10 min actual → 20 min timeout
      avgBootTimeS: 200,           // would give 6.67 min
      dockerImage: 'marcosremar/gemma-4b:latest', // would give 6 min
      isBooting: false,
    });
    expect(timeout).toBe(1200_000); // 20 min from actual boot time
  });

  it('history takes priority over image estimate', () => {
    const timeout = computeAdaptiveIdleTimeout({
      lastBootDurationMs: 0,
      avgBootTimeS: 400, // 400s → 800s = 13.3 min
      dockerImage: 'marcosremar/gemma-4b:latest', // would give 6 min
      isBooting: false,
    });
    expect(timeout).toBe(800_000); // 13.3 min from history
  });
});

describe('computeAdaptiveIdleTimeout — boot grace (during init)', () => {
  it('provides boot grace of 1.5x estimated boot time', () => {
    // 70B model: 600s estimate → 1.5x = 900s = 15 min
    // But min boot grace = 20 min, so clamped up
    const timeout = computeAdaptiveIdleTimeout({
      lastBootDurationMs: 0,
      avgBootTimeS: 0,
      dockerImage: 'marcosremar/llama-70b:latest',
      isBooting: true,
    });
    expect(timeout).toBe(20 * 60_000); // 20 min minimum boot grace
  });

  it('extends boot grace beyond minimum for very slow boots', () => {
    // Actual boot took 20 min → 1.5x = 30 min > 20 min minimum
    const timeout = computeAdaptiveIdleTimeout({
      lastBootDurationMs: 20 * 60_000,
      avgBootTimeS: 0,
      dockerImage: '',
      isBooting: true,
    });
    expect(timeout).toBe(30 * 60_000); // 30 min (1.5x actual boot)
  });

  it('uses historical boot time for boot grace when no current boot data', () => {
    // History: avg 600s → 1.5x = 900s = 15 min → clamped to 20 min min
    const timeout = computeAdaptiveIdleTimeout({
      lastBootDurationMs: 0,
      avgBootTimeS: 600,
      dockerImage: '',
      isBooting: true,
    });
    expect(timeout).toBe(20 * 60_000); // 20 min minimum
  });

  it('boot grace is always >= 20 min regardless of model size', () => {
    // Small model: 180s estimate → 1.5x = 270s = 4.5 min → clamped to 20 min
    const timeout = computeAdaptiveIdleTimeout({
      lastBootDurationMs: 0,
      avgBootTimeS: 0,
      dockerImage: 'marcosremar/gemma-4b:latest',
      isBooting: true,
    });
    expect(timeout).toBe(20 * 60_000);
  });
});

describe('adaptive idle + checkIdleAction integration', () => {
  it('HybrIK machine: boot 13 min → idle timeout = 26 min (not 15)', () => {
    const bootMs = 13 * 60_000;
    const timeout = computeAdaptiveIdleTimeout({
      lastBootDurationMs: bootMs,
      avgBootTimeS: 0,
      dockerImage: 'marcosremar/hybrik-x:latest',
      isBooting: false,
    });
    expect(timeout).toBe(26 * 60_000); // 2x boot time

    // With 26-min timeout, the machine survives between jobs
    const T0 = Date.now();
    const idleAt20min = checkIdleAction(T0, 0, T0 + 20 * 60_000, timeout, false);
    expect(idleAt20min.action).not.toBe('stop'); // NOT stopped at 20 min

    const idleAt27min = checkIdleAction(T0, 0, T0 + 27 * 60_000, timeout, false);
    expect(idleAt27min.action).toBe('stop'); // stopped at 27 min
  });

  it('fast-boot model (2 min) → idle timeout = 10 min (minimum)', () => {
    const bootMs = 2 * 60_000;
    const timeout = computeAdaptiveIdleTimeout({
      lastBootDurationMs: bootMs,
      avgBootTimeS: 0,
      dockerImage: 'marcosremar/gemma-4b:latest',
      isBooting: false,
    });
    expect(timeout).toBe(10 * 60_000); // minimum floor

    const T0 = Date.now();
    const idleAt9min = checkIdleAction(T0, 0, T0 + 9 * 60_000, timeout, false);
    expect(idleAt9min.action).not.toBe('stop');

    const idleAt11min = checkIdleAction(T0, 0, T0 + 11 * 60_000, timeout, false);
    expect(idleAt11min.action).toBe('stop');
  });

  it('70B model (10 min boot) → idle timeout = 20 min', () => {
    const timeout = computeAdaptiveIdleTimeout({
      lastBootDurationMs: 10 * 60_000,
      avgBootTimeS: 0,
      dockerImage: 'marcosremar/llama-70b:latest',
      isBooting: false,
    });
    expect(timeout).toBe(20 * 60_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Multi-Job Workload Simulation
// ═══════════════════════════════════════════════════════════════════════════════

describe('multi-job workload patterns', () => {
  const TIMEOUT = 15 * 60_000;
  const PROBE_INTERVAL = 30_000;

  function simulateWorkload(jobs: { startOffsetMs: number; durationMs: number }[]) {
    const T0 = 1_000_000; // arbitrary start
    let lastModelReq = T0; // startGpuMonitoring initial value
    let idleWarned = false;
    const events: { time: number; action: string; detail?: string }[] = [];

    // Run probes every 30s for 20 minutes
    const totalSimTime = 20 * 60_000;
    for (let t = 0; t <= totalSimTime; t += PROBE_INTERVAL) {
      const now = T0 + t;

      // Check if any job is running at this probe time
      const activeJob = jobs.find(
        j => now >= T0 + j.startOffsetMs && now < T0 + j.startOffsetMs + j.durationMs
      );
      const gpuUtil = activeJob ? 85 : 0;

      // Health probe: reset idle if GPU is busy
      if (shouldResetIdleFromHealth({ status: 'ok' }, gpuUtil)) {
        lastModelReq = now;
        events.push({ time: t, action: 'idle_reset', detail: `gpuUtil=${gpuUtil}` });
      }

      // Idle check
      const result = checkIdleAction(lastModelReq, 0, now, TIMEOUT, idleWarned);
      if (result.action === 'stop') {
        events.push({ time: t, action: 'STOP', detail: `idle ${result.action === 'stop' ? result.idleMin : 0} min` });
        return { stoppedAt: t, events };
      } else if (result.action === 'warning') {
        idleWarned = true;
        events.push({ time: t, action: 'warning', detail: `${result.remainingSec}s remaining` });
      }
    }
    return { stoppedAt: null, events };
  }

  it('single job at T=0 → stops 15 min after job ends', () => {
    const result = simulateWorkload([
      { startOffsetMs: 0, durationMs: 60_000 }, // 1 min job
    ]);
    expect(result.stoppedAt).not.toBeNull();
    // Job ends at 60s, idle timer resets during job. Last reset at ~30s probe.
    // Stop should be ~15 min after last reset during job.
    expect(result.stoppedAt!).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it('two jobs 5 min apart → machine survives', () => {
    const result = simulateWorkload([
      { startOffsetMs: 0, durationMs: 60_000 },       // Job 1: T=0 to T=1min
      { startOffsetMs: 5 * 60_000, durationMs: 60_000 }, // Job 2: T=5min to T=6min
    ]);
    // Machine should not stop before 20 min because job 2 resets idle
    // Last idle reset from job 2 at ~5.5min, stop at ~20.5min (outside our 20min window)
    if (result.stoppedAt !== null) {
      expect(result.stoppedAt).toBeGreaterThanOrEqual(19 * 60_000);
    }
  });

  it('job that lasts longer than timeout → machine stays alive', () => {
    const result = simulateWorkload([
      { startOffsetMs: 0, durationMs: 18 * 60_000 }, // 18 min job
    ]);
    // During the 18-min job, every probe resets idle. Stop comes 15 min after job ends.
    // Job ends at 18min, stop at 33min — outside our 20min window
    expect(result.stoppedAt).toBeNull();
  });

  it('very short job (5s) between probes → MISSED (the probe gap bug)', () => {
    // Job runs from T=5s to T=10s — between probes at T=0s and T=30s
    const result = simulateWorkload([
      { startOffsetMs: 5000, durationMs: 5000 },
    ]);
    // Both probes see gpuUtil=0. The job is invisible.
    // Machine stops at ~15 min from T0 (initial startGpuMonitoring reset)
    expect(result.stoppedAt).not.toBeNull();
    expect(result.stoppedAt!).toBeLessThanOrEqual(16 * 60_000);
    // No idle_reset events should be recorded (job was invisible)
    const resets = result.events.filter(e => e.action === 'idle_reset');
    expect(resets.length).toBe(0);
  });

  it('periodic short jobs keep machine alive', () => {
    // Jobs every 10 min, each lasting 2 min
    const result = simulateWorkload([
      { startOffsetMs: 0, durationMs: 2 * 60_000 },
      { startOffsetMs: 10 * 60_000, durationMs: 2 * 60_000 },
    ]);
    // Second job resets idle at ~10min. Stop would be 25min (outside 20min window)
    expect(result.stoppedAt).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Multi-job with last_request_at fix
// ═══════════════════════════════════════════════════════════════════════════════

describe('multi-job with last_request_at — probe gap fix verified', () => {
  const TIMEOUT = 15 * 60_000;
  const PROBE_INTERVAL = 30_000;

  function simulateWorkloadWithTimestamp(
    jobs: { startOffsetMs: number; durationMs: number }[],
    simTimeMs: number = 35 * 60_000,
  ) {
    const T0 = Date.now();
    let lastModelReq = T0;
    let idleWarned = false;

    const totalSimTime = simTimeMs;
    for (let t = 0; t <= totalSimTime; t += PROBE_INTERVAL) {
      const now = T0 + t;

      // Check if any job is running OR was recently completed
      const activeJob = jobs.find(
        j => now >= T0 + j.startOffsetMs && now < T0 + j.startOffsetMs + j.durationMs,
      );
      const gpuUtil = activeJob ? 85 : 0;

      // Find the most recent completed job for last_request_at (epoch ms)
      let lastJobEndMs = 0;
      for (const j of jobs) {
        const jobEnd = T0 + j.startOffsetMs + j.durationMs;
        if (jobEnd <= now && jobEnd > lastJobEndMs) lastJobEndMs = jobEnd;
      }

      // Health probe with last_request_at (pass `now` for deterministic testing)
      if (shouldResetIdleFromHealth(
        { status: 'ok', last_request_at: lastJobEndMs > 0 ? lastJobEndMs : 0 },
        gpuUtil,
        TIMEOUT,
        now,
      )) {
        lastModelReq = now;
      }

      const result = checkIdleAction(lastModelReq, 0, now, TIMEOUT, idleWarned);
      if (result.action === 'stop') {
        return { stoppedAt: t };
      } else if (result.action === 'warning') {
        idleWarned = true;
      }
    }
    return { stoppedAt: null };
  }

  it('short job (5s) between probes is NOW detected via last_request_at', () => {
    // Previously: this job was invisible and machine stopped at 15 min.
    // Now: last_request_at keeps resetting idle for ~15 min, then idle runs 15 more min.
    // Total: ~30 min before stop (vs 15 min without the fix).
    const result = simulateWorkloadWithTimestamp([
      { startOffsetMs: 5000, durationMs: 5000 },
    ]);
    expect(result.stoppedAt).not.toBeNull();
    // Should stop around 30 min (15 min while last_request_at is "recent" + 15 min idle)
    expect(result.stoppedAt!).toBeGreaterThanOrEqual(29 * 60_000);
    expect(result.stoppedAt!).toBeLessThanOrEqual(32 * 60_000);
  });

  it('two short jobs 10 min apart: machine stays alive past 35 min', () => {
    const result = simulateWorkloadWithTimestamp([
      { startOffsetMs: 5000, durationMs: 5000 },
      { startOffsetMs: 10 * 60_000 + 5000, durationMs: 5000 },
    ]);
    // Second job at T=10min extends lifetime. Stop would be at ~40 min.
    expect(result.stoppedAt).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Heartbeat Endpoint
// ═══════════════════════════════════════════════════════════════════════════════

describe('GPU heartbeat endpoint — source verification', () => {
  const src = readSource('server/gpu-handlers.ts');
  const routeSrc = readSource('server/routes/gateway/gpu.ts');

  it('handleGpuHeartbeat handler exists', () => {
    expect(src).toContain('export async function handleGpuHeartbeat');
  });

  it('heartbeat resets lastModelRequestTime', () => {
    expect(src).toContain('setLastModelRequestTime(Date.now())');
  });

  it('heartbeat calls resetIdleState', () => {
    const fnIdx = src.indexOf('handleGpuHeartbeat');
    const fnBody = src.slice(fnIdx, fnIdx + 1500);
    expect(fnBody).toContain('resetIdleState');
  });

  it('heartbeat route is registered as POST /v1/gpu/heartbeat', () => {
    expect(routeSrc).toContain("'POST /v1/gpu/heartbeat'");
    expect(routeSrc).toContain('handleGpuHeartbeat');
  });

  it('heartbeat accepts optional source field', () => {
    const fnIdx = src.indexOf('handleGpuHeartbeat');
    const fnBody = src.slice(fnIdx, fnIdx + 1500);
    expect(fnBody).toContain('body.source');
  });

  it('heartbeat accepts optional active_requests field', () => {
    const fnIdx = src.indexOf('handleGpuHeartbeat');
    const fnBody = src.slice(fnIdx, fnIdx + 1500);
    expect(fnBody).toContain('activeRequests');
  });

  it('heartbeat returns idleTimeoutMs and lastModelRequestAt', () => {
    const fnIdx = src.indexOf('handleGpuHeartbeat');
    const fnBody = src.slice(fnIdx, fnIdx + 1500);
    expect(fnBody).toContain('idleTimeoutMs');
    expect(fnBody).toContain('lastModelRequestAt');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. GPU Health Metrics — parseAndStoreGpuMetrics
// ═══════════════════════════════════════════════════════════════════════════════

describe('gpu-health-metrics.ts — GPU utilization parsing', () => {
  const src = readSource('server/gpu-health-metrics.ts');

  it('parses gpu_util_pct field', () => {
    expect(src).toContain('gpu_util_pct');
  });

  it('parses gpu_utilization field (alternative name)', () => {
    expect(src).toContain('gpu_utilization');
  });

  it('parses utilization field (short name)', () => {
    expect(src).toContain("typeof data.utilization === 'number'");
  });

  it('defaults utilization to -1 when not provided', () => {
    expect(src).toContain(': -1');
  });

  it('tracks consecutive zero-utilization probes', () => {
    expect(src).toContain('consecutiveZeroUtilProbes');
  });

  it('warns after 10 consecutive zero-util probes (~5 min)', () => {
    expect(src).toContain('ZERO_UTIL_WARNING_THRESHOLD = 10');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Integration — Full Auto-Stop Lifecycle Source Verification
// ═══════════════════════════════════════════════════════════════════════════════

describe('full auto-stop lifecycle — source wiring', () => {
  it('monitor loop imports autoStopGpu dynamically', () => {
    const src = readSource('server/gpu-monitor-loop.ts');
    expect(src).toContain("import('./gpu-idle-manager')");
    expect(src).toContain('autoStopGpu');
  });

  it('autoStopGpu stops monitoring and warmth monitor', () => {
    const src = readSource('server/gpu-idle-manager.ts');
    expect(src).toContain('stopGpuMonitoring()');
    expect(src).toContain('stopWarmthMonitor()');
  });

  it('autoStopGpu clears GPU pipeline endpoint', () => {
    const src = readSource('server/gpu-idle-manager.ts');
    expect(src).toContain('updateActivePipeline');
    expect(src).toContain('gpuEndpoint: undefined');
  });

  it('auto-destroy timer imports autoTerminateGpu', () => {
    const src = readSource('server/gpu-destroy-timer.ts');
    expect(src).toContain("import('./gpu-terminate')");
  });

  it('resume manager clears destroy timer before resume attempt', () => {
    const src = readSource('server/gpu-resume-manager.ts');
    const clearIdx = src.indexOf('clearAutoDestroyTimer');
    const startIdx = src.indexOf('client.startInstance');
    expect(clearIdx).toBeLessThan(startIdx);
  });

  it('touchModelRequest is called from ai-handlers (gateway-routed requests)', () => {
    const src = readSource('server/ai-handlers.ts');
    expect(src).toContain('touchModelRequest');
  });

  it('idle logic module is imported in monitor loop', () => {
    const src = readSource('server/gpu-monitor-loop.ts');
    expect(src).toContain("from './gpu-idle-logic'");
  });

  it('monitor uses computeAdaptiveIdleTimeout for idle checks', () => {
    const src = readSource('server/gpu-monitor-loop.ts');
    expect(src).toContain('computeAdaptiveIdleTimeout');
    expect(src).toContain('effectiveTimeout');
    expect(src).toContain('healthCheckTimeout');
  });

  it('heartbeat route is wired in GPU route registration', () => {
    const src = readSource('server/routes/gateway/gpu.ts');
    expect(src).toContain('handleGpuHeartbeat');
  });
});
