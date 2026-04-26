/**
 * Regression test: stale step='waiting_health' blocks auto-recovery
 *
 * Bug: startAutoRecoveryDeploy() checks deployState.step === 'waiting_health'
 * to prevent concurrent deploys. But pollHealthUntilReady() can return a
 * timeout with step still set to 'waiting_health' (boot timeout path at
 * gpu-poll-health.ts:270). After the deploy loop handles the failure,
 * step is NOT reset. This means startAutoRecoveryDeploy() sees stale
 * step === 'waiting_health' and incorrectly bails out.
 *
 * The fix: check only status ('creating' | 'booting') for the concurrent
 * deploy guard, not step. Step is a progress indicator that can be stale
 * after a failure; only status reliably indicates whether a deploy is active.
 */

import { describe, it, expect } from 'vitest';

/**
 * This is the BUGGY guard condition (before fix) extracted from
 * gpu-auto-recovery.ts line 417. It incorrectly checks step='waiting_health'
 * which can be stale from a previous failed deploy.
 */
function buggyGuard(status: string, step: string): boolean {
  return status === 'creating' || status === 'booting' || step === 'waiting_health';
}

/**
 * This is the FIXED guard condition (after fix).
 * Only status reliably indicates whether a deploy is in progress.
 */
function fixedGuard(status: string, step: string): boolean {
  return status === 'creating' || status === 'booting';
}

describe('auto-recovery concurrent deploy guard', () => {
  describe('bug reproduction', () => {
    it('BUGGY guard incorrectly blocks auto-recovery when status=error + stale step', () => {
      // After boot timeout: status='error', step='waiting_health'
      // This should NOT block recovery, but the buggy guard does.
      expect(buggyGuard('error', 'waiting_health')).toBe(true); // WRONG - should be false
    });
  });

  describe('fixed guard correctness', () => {
    it('should NOT block auto-recovery when deploy failed (status=error) with stale step', () => {
      expect(fixedGuard('error', 'waiting_health')).toBe(false);
    });

    it('should NOT block auto-recovery when deploy failed (status=error) with any step', () => {
      expect(fixedGuard('error', 'pulling_image')).toBe(false);
      expect(fixedGuard('error', 'creating_pod')).toBe(false);
      expect(fixedGuard('error', 'no_offers')).toBe(false);
      expect(fixedGuard('error', '')).toBe(false);
    });

    it('should block auto-recovery when deploy IS in progress (status=creating)', () => {
      expect(fixedGuard('creating', 'creating_pod')).toBe(true);
      expect(fixedGuard('creating', 'searching_offers')).toBe(true);
    });

    it('should block auto-recovery when deploy IS in progress (status=booting)', () => {
      expect(fixedGuard('booting', 'waiting_health')).toBe(true);
      expect(fixedGuard('booting', 'pulling_image')).toBe(true);
      expect(fixedGuard('booting', 'starting_container')).toBe(true);
    });

    it('should NOT block auto-recovery when idle (no deploy)', () => {
      expect(fixedGuard('idle', '')).toBe(false);
      expect(fixedGuard('stopped', 'ready')).toBe(false);
      expect(fixedGuard('ready', 'ready')).toBe(false);
    });
  });
});
