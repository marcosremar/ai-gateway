/**
 * Orphan cleanup must skip instances whose status is the canonical
 * `stopped` (EXITED normalized), not the raw provider string `EXITED`.
 *
 * After listInstances started returning normalizeInstanceStatus(...), the
 * old `i.status === 'EXITED'` check never matched and would try to
 * terminate already-dead pods (or worse, miss the skip entirely for
 * cleanupAllPods and terminate nothing when status was already stopped).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isTerminalInstanceStatus,
  normalizeInstanceStatus,
} from '../../src/gateway/providers/gpu/instance-status';

const orphanCleanupSource = readFileSync(
  join(__dirname, '../../server/gpu-orphan-cleanup.ts'),
  'utf8',
);

/** Mirror of the RunPod orphan / cleanupAllPods dead-state skip. */
function shouldSkipOrphanCandidate(status: string | null | undefined): boolean {
  return isTerminalInstanceStatus(status) || normalizeInstanceStatus(status) === 'unknown';
}

describe('orphan cleanup — EXITED normalized to stopped is skipped', () => {
  it('EXITED → stopped is skipped (canonical path)', () => {
    expect(shouldSkipOrphanCandidate('stopped')).toBe(true);
    expect(shouldSkipOrphanCandidate('EXITED')).toBe(true);
    expect(shouldSkipOrphanCandidate('error')).toBe(true);
    expect(shouldSkipOrphanCandidate('unknown')).toBe(true);
  });

  it('running / booting are NOT skipped', () => {
    expect(shouldSkipOrphanCandidate('running')).toBe(false);
    expect(shouldSkipOrphanCandidate('booting')).toBe(false);
  });

  it('gpu-orphan-cleanup uses isTerminalInstanceStatus, not raw EXITED compare', () => {
    expect(orphanCleanupSource).toContain('isTerminalInstanceStatus');
    expect(orphanCleanupSource).not.toContain("i.status === 'EXITED'");
    expect(orphanCleanupSource).not.toContain("inst.status !== 'EXITED'");
    expect(orphanCleanupSource).toContain("VAST_SWEEP_STATUSES = ['running', 'booting', 'stopped']");
  });
});
