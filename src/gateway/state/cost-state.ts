// ── Budget & Cost Tracking ──────────────────────────────────────────────────
// Daily GPU spend tracking and budget gate logic.
// Extracted from server/state.ts — Phase 5 DDD migration.

import { createLogger } from '../../platform/logger';

const log = createLogger('cost-state');

// ── Budget tracking ──────────────────────────────────────────────────────────
//
// Historical gotcha: 2026-03-25 saw a $130 daily spend even though the cap
// was $50. Root cause: the cap was only enforced *inside* the monitor loop
// of an already-running pod. Nothing prevented new deploys from starting
// when current spend was already near cap. The fix is canAffordDeploy()
// which projects the new deploy's cost against the cap BEFORE the deploy
// path touches any provider client. See P0-1 in docs/improvement-plan.md.

const _parsedBudget = process.env.DAILY_BUDGET_USD ? parseFloat(process.env.DAILY_BUDGET_USD) : 0;
if (process.env.DAILY_BUDGET_USD && isNaN(_parsedBudget)) {
  log.warn(`Warning: DAILY_BUDGET_USD="${process.env.DAILY_BUDGET_USD}" is not a valid number, defaulting to 0 (no limit)`);
}
export const DAILY_BUDGET_USD = isNaN(_parsedBudget) ? 0 : _parsedBudget; // 0 = no limit
export let dailyGpuSpendUsd = 0;
export let dailySpendResetDate = new Date().toDateString();

/** Default estimated cost of a new deploy if the caller doesn't pass one. */
const DEFAULT_ESTIMATED_DEPLOY_COST_USD = 2;

/**
 * Structured budget decision returned by canAffordDeploy(). Callers should
 * inspect `allowed` and emit `reason` in the deploy_rejected lifecycle event.
 */
export interface BudgetDecision {
  allowed: boolean;
  currentSpend: number;
  projected: number;
  cap: number;
  reason?: 'no_cap' | 'under_cap' | 'soft_limit_exceeded' | 'hard_limit_exceeded';
}

/**
 * Check whether a new deploy with the given estimated cost would fit under
 * the daily spend cap. This is the single authoritative gate — every code
 * path that starts a new GPU deploy must call this before touching a
 * provider client.
 *
 * @param estimatedCostUsd upper-bound estimate of what the new deploy
 *   will consume before the next monitor tick catches it. A reasonable
 *   default is 2 USD (one hour at typical 4090 spot price).
 * @returns BudgetDecision with structured reason codes
 */
export function canAffordDeploy(estimatedCostUsd: number = DEFAULT_ESTIMATED_DEPLOY_COST_USD): BudgetDecision {
  const cap = DAILY_BUDGET_USD;
  const currentSpend = dailyGpuSpendUsd;
  const projected = currentSpend + estimatedCostUsd;

  // Cap of 0 = no limit set, always allow.
  if (cap <= 0) {
    return { allowed: true, currentSpend, projected, cap, reason: 'no_cap' };
  }

  // Hard limit: projected spend would exceed the cap entirely. Refuse.
  if (projected > cap) {
    return { allowed: false, currentSpend, projected, cap, reason: 'hard_limit_exceeded' };
  }

  // Soft limit: already at >=80% of cap. Refuse new deploys but don't
  // interrupt running pods. The threshold of 0.8 matches the monitor-loop
  // soft-limit threshold so both paths agree.
  if (currentSpend / cap >= 0.8) {
    return { allowed: false, currentSpend, projected, cap, reason: 'soft_limit_exceeded' };
  }

  return { allowed: true, currentSpend, projected, cap, reason: 'under_cap' };
}

// ── Setters ─────────────────────────────────────────────────────────────────

export function setDailyGpuSpendUsd(v: number) { dailyGpuSpendUsd = v; }
export function setDailySpendResetDate(v: string) { dailySpendResetDate = v; }
