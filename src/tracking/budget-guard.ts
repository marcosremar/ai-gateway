/**
 * Budget Guard — pre-request budget enforcement with graceful degradation.
 *
 * Before each AI request, checks the user's daily spend against their limit:
 *   1. Under degradeThreshold: pass through unchanged.
 *   2. Between degradeThreshold and blockThreshold: swap expensive models
 *      to cheaper alternatives (e.g. gpt-4o → gpt-4o-mini).
 *   3. At or above blockThreshold: hard-block with BudgetExceededError.
 */

import type { SpendTracker } from './spend-tracker';
import type { FallbackEntry } from '../providers/fallback';

// ── Error ────────────────────────────────────────────────────────────────────

export class BudgetExceededError extends Error {
  readonly status = 429;
  readonly currentUsd: number;
  readonly limitUsd: number;

  constructor(currentUsd: number, limitUsd: number) {
    super(
      `Daily budget exceeded: $${currentUsd.toFixed(4)} spent of $${limitUsd.toFixed(2)} limit. ` +
      `Requests are blocked until the next billing day.`,
    );
    this.name = 'BudgetExceededError';
    this.currentUsd = currentUsd;
    this.limitUsd = limitUsd;
  }
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface BudgetGuardConfig {
  /** Model downgrade map: expensive model → cheaper alternative */
  downgrades?: Record<string, string>;
  /** Spend percentage (0-1) at which to start downgrading. Default: 0.8 */
  degradeThreshold?: number;
  /** Spend percentage (0-1) at which to hard-block. Default: 1.0 */
  blockThreshold?: number;
}

export interface BudgetCheckResult {
  /** The (possibly modified) fallback chain */
  chain: FallbackEntry[];
  /** Whether any models were swapped to cheaper alternatives */
  downgraded: boolean;
  /** Human-readable reason when downgraded or blocked */
  reason?: string;
}

// ── Default downgrades ───────────────────────────────────────────────────────

// Only models that have a genuinely cheaper tier belong here. Self-mapping
// entries (model → itself) were dead config: the `!== model` guard in
// checkAndDowngrade already skips them, so listing "already cheapest" models
// here just obscured which models actually downgrade (#555). Removed.
const DEFAULT_DOWNGRADES: Record<string, string> = {
  'gpt-4o': 'gpt-4o-mini',
  'gpt-4o-transcribe': 'gpt-4o-mini-transcribe',
  'llama-3.3-70b-versatile': 'llama-3.1-8b-instant',
};

// ── Guard ────────────────────────────────────────────────────────────────────

export class BudgetGuard {
  private spendTracker: SpendTracker;
  private downgrades: Record<string, string>;
  private degradeThreshold: number;
  private blockThreshold: number;

  constructor(spendTracker: SpendTracker, config?: BudgetGuardConfig) {
    this.spendTracker = spendTracker;
    this.downgrades = config?.downgrades ?? DEFAULT_DOWNGRADES;
    this.degradeThreshold = config?.degradeThreshold ?? 0.8;
    this.blockThreshold = config?.blockThreshold ?? 1.0;
  }

  /**
   * Check the user's daily spend and optionally downgrade models in the chain.
   *
   * @param userId   - User identifier for spend lookup
   * @param chain    - Fallback chain of provider/model entries
   * @param stage    - Pipeline stage (for logging context)
   * @param dailyLimitUsd - The user's daily budget limit in USD
   * @returns A BudgetCheckResult with the (possibly modified) chain
   * @throws BudgetExceededError when spend >= blockThreshold * dailyLimitUsd
   */
  async checkAndDowngrade(
    userId: string,
    chain: FallbackEntry[],
    stage: string,
    dailyLimitUsd: number,
  ): Promise<BudgetCheckResult> {
    // No limit configured → pass through
    if (dailyLimitUsd <= 0) {
      return { chain, downgraded: false };
    }

    const summary = await this.spendTracker.getDailySummary(userId);
    const currentUsd = summary.totalCostUsd;
    const pct = currentUsd / dailyLimitUsd;

    // ── Hard block ─────────────────────────────────────────────────────────
    if (pct >= this.blockThreshold) {
      throw new BudgetExceededError(currentUsd, dailyLimitUsd);
    }

    // ── Degrade: swap expensive models to cheaper alternatives ─────────────
    if (pct >= this.degradeThreshold) {
      const downgraded: FallbackEntry[] = [];
      let anySwapped = false;

      for (const entry of chain) {
        const model = entry.model;
        if (model && this.downgrades[model] && this.downgrades[model] !== model) {
          downgraded.push({ provider: entry.provider, model: this.downgrades[model] });
          anySwapped = true;
        } else {
          downgraded.push({ ...entry });
        }
      }

      if (anySwapped) {
        const pctStr = (pct * 100).toFixed(0);
        return {
          chain: downgraded,
          downgraded: true,
          reason:
            `[${stage}] Budget at ${pctStr}% ($${currentUsd.toFixed(4)}/$${dailyLimitUsd.toFixed(2)}), ` +
            `downgraded to cheaper models`,
        };
      }

      // All models in chain are already cheapest — pass through unchanged
      return { chain: chain.map((e) => ({ ...e })), downgraded: false };
    }

    // ── Under threshold: pass through unchanged ────────────────────────────
    return { chain, downgraded: false };
  }
}
