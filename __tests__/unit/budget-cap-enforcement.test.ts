/**
 * P0-1: Budget cap enforcement
 *
 * Regression test for the 2026-03-25 incident where a single day burned
 * $130 despite a $50 daily cap being configured. Root cause at the time:
 * the cap was only checked inside the monitor loop of an already-running
 * pod — nothing stopped a fresh deploy from starting when current spend
 * was already near cap.
 *
 * This suite asserts the BEHAVIOR we want: canAffordDeploy() returns a
 * structured decision that every deploy-entry path can consult before
 * touching any provider client.
 *
 * See docs/improvement-plan.md item P0-1 for the full rationale.
 *
 * IMPORTANT: DAILY_BUDGET_USD is read once at module load from env. To
 * test cap behavior we must set the env var BEFORE importing state.ts.
 * We use vitest's `beforeAll` with `vi.resetModules()` to re-import a
 * fresh copy of the module with a known cap.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('canAffordDeploy — budget cap enforcement', () => {
  describe('with cap = $50', () => {
    let state: typeof import('../../server/state');

    beforeEach(async () => {
      process.env.DAILY_BUDGET_USD = '50';
      vi.resetModules();
      state = await import('../../server/state');
      state.setDailyGpuSpendUsd(0);
    });

    it('allows a fresh deploy when spend is zero', () => {
      const decision = state.canAffordDeploy(2);
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('under_cap');
      expect(decision.currentSpend).toBe(0);
      expect(decision.projected).toBe(2);
      expect(decision.cap).toBe(50);
    });

    it('allows a deploy at 50% of cap', () => {
      state.setDailyGpuSpendUsd(25);
      const decision = state.canAffordDeploy(2);
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('under_cap');
    });

    it('allows a deploy at 79% of cap', () => {
      state.setDailyGpuSpendUsd(39.49); // 78.98%
      const decision = state.canAffordDeploy(2);
      expect(decision.allowed).toBe(true);
    });

    it('REFUSES a deploy at 80% of cap (soft limit)', () => {
      state.setDailyGpuSpendUsd(40); // 80.00%
      const decision = state.canAffordDeploy(2);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('soft_limit_exceeded');
    });

    it('REFUSES a deploy at 90% of cap', () => {
      state.setDailyGpuSpendUsd(45);
      const decision = state.canAffordDeploy(2);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('soft_limit_exceeded');
    });

    // The specific regression from 2026-03-25: spend was near cap and a
    // new deploy pushed projected total over the top. This must be refused.
    it('REFUSES when projected cost would exceed cap — the 2026-03-25 scenario', () => {
      state.setDailyGpuSpendUsd(49);
      const decision = state.canAffordDeploy(2);
      expect(decision.allowed).toBe(false);
      // 49 + 2 = 51 > 50 → hard limit exceeded AND 49/50=98% also triggers
      // soft limit. Contract: hard_limit wins when projection exceeds cap
      // because it's the objective reason for refusal (math), whereas soft
      // limit is a state signal. This ordering lets alerts distinguish
      // "projection math refused the deploy" from "we just tripped 80%
      // without a specific deploy request".
      expect(decision.reason).toBe('hard_limit_exceeded');
      expect(decision.projected).toBe(51);
    });

    it('REFUSES when spend is at cap', () => {
      state.setDailyGpuSpendUsd(50);
      const decision = state.canAffordDeploy(0.01);
      expect(decision.allowed).toBe(false);
    });

    it('REFUSES with hard_limit_exceeded when spend is zero but estimate exceeds cap', () => {
      // Edge case: caller passes an absurdly high estimate. We must refuse
      // even though current spend is zero — the projection is what matters.
      const decision = state.canAffordDeploy(60);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('hard_limit_exceeded');
      expect(decision.projected).toBe(60);
    });

    it('uses default estimate of $2 when argument is omitted', () => {
      state.setDailyGpuSpendUsd(47.99);
      // 47.99 + 2 (default) = 49.99 which is > 0.8*50=40 → soft limit
      const decision = state.canAffordDeploy();
      expect(decision.allowed).toBe(false);
      expect(decision.projected).toBeCloseTo(49.99, 2);
    });
  });

  describe('with cap = 0 (no limit)', () => {
    let state: typeof import('../../server/state');

    beforeEach(async () => {
      delete process.env.DAILY_BUDGET_USD;
      vi.resetModules();
      state = await import('../../server/state');
      state.setDailyGpuSpendUsd(0);
    });

    it('always allows when cap is 0', () => {
      state.setDailyGpuSpendUsd(1_000_000);
      const decision = state.canAffordDeploy(500);
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('no_cap');
      expect(decision.cap).toBe(0);
    });
  });

  describe('with cap = $10 — tight budget edge cases', () => {
    let state: typeof import('../../server/state');

    beforeEach(async () => {
      process.env.DAILY_BUDGET_USD = '10';
      vi.resetModules();
      state = await import('../../server/state');
      state.setDailyGpuSpendUsd(0);
    });

    it('allows a deploy up to 79.9% of a $10 cap', () => {
      state.setDailyGpuSpendUsd(7.99);
      const decision = state.canAffordDeploy(0.01);
      expect(decision.allowed).toBe(true);
    });

    it('refuses exactly at 80% of a $10 cap', () => {
      state.setDailyGpuSpendUsd(8);
      const decision = state.canAffordDeploy(0.01);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('soft_limit_exceeded');
    });
  });
});
