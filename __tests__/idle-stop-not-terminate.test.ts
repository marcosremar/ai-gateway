// ── Idle Stop (not Terminate) — cold-start plan A3 ──────────────────────────
// Reducing the idle timeout from 15 to 5 min only pays off if the idle
// action is STOP (preserves disk, fast resume) rather than TERMINATE
// (destroys disk, requires full cold boot). Destroy only happens 2h later
// if the pod is never resumed.
//
// These tests cover the CONTRACT — they read the constants and wiring in
// the worktree without spinning up real pods.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf-8');

describe('Idle Stop (not Terminate) — cold-start plan A3', () => {
  it('IDLE_TIMEOUT_MS in gpu-monitor-loop is 5 minutes (was 15)', () => {
    const src = read('server/gpu-monitor-loop.ts');
    // Match the declaration line exactly to avoid picking up the comment.
    expect(src).toMatch(/export let IDLE_TIMEOUT_MS = 5 \* 60_000;/);
    // The file-level constant must not contain the old 15-min value.
    expect(src).not.toMatch(/export let IDLE_TIMEOUT_MS = 15 \* 60_000;/);
  });

  it('IDLE_TIMEOUT_MS in constants.ts is 5 minutes', () => {
    const src = read('server/constants.ts');
    expect(src).toMatch(/IDLE_TIMEOUT_MS: 5 \* 60_000,/);
  });

  it('IDLE_DESTROY_MS stays at 2 hours (destroy only after long stop)', () => {
    const src = read('server/gpu-monitor-loop.ts');
    expect(src).toMatch(/IDLE_DESTROY_MS = 2 \* 60 \* 60_000/);
  });

  it('idle action on timeout calls autoStopGpu (not autoTerminateGpu)', () => {
    const src = read('server/gpu-monitor-loop.ts');
    // The "stop" branch must import autoStopGpu, not autoTerminateGpu.
    const stopBranchMatch = src.match(/idleResult\.action === 'stop'[\s\S]{0,500}/);
    expect(stopBranchMatch).not.toBeNull();
    const branch = stopBranchMatch![0];
    expect(branch).toContain('autoStopGpu');
    // Destroy only happens via scheduled timer in gpu-idle-manager, NOT
    // synchronously inline here.
    expect(branch).not.toMatch(/autoTerminateGpu\(/);
  });

  it('autoStopGpu schedules auto-destroy after IDLE_DESTROY_MS (not sync terminate)', () => {
    const src = read('server/gpu-idle-manager.ts');
    // After the idle-pause refactor the provider-level stop happens inside
    // pauseInstanceForIdle (which internally calls client.stopInstance or
    // client.hibernate). The contract here is: the manager pauses rather
    // than deletes, and schedules a 2h auto-destroy.
    expect(src).toMatch(/pauseInstanceForIdle\(/);
    expect(src).toContain('scheduleAutoDestroy(IDLE_DESTROY_MS)');
  });

  it('default idleTimeoutMin in DEFAULT_CONFIG is 5', () => {
    const src = read('server/config-persistence.ts');
    // DEFAULT_CONFIG uses 5, not 15.
    expect(src).toMatch(/idleTimeoutMin:\s*5,/);
  });
});
