/**
 * Budget — value object representing daily spend cap + current spend.
 * Pure, immutable. Use `.canAfford()` to ask permission for a new deploy.
 */

export interface BudgetDecision {
  allowed: boolean;
  reason: 'no_cap' | 'under_cap' | 'soft_limit_exceeded' | 'hard_limit_exceeded';
  currentSpend: number;
  projected: number;
  cap: number;
}

/** Threshold above which soft-limit refuses new deploys (but keeps running ones). */
const SOFT_LIMIT_RATIO = 0.8;

export class Budget {
  private constructor(
    private readonly capUsd: number,
    private readonly currentSpendUsd: number,
  ) {}

  /** Create a Budget from raw numbers. cap=0 means unlimited. */
  static of(capUsd: number, currentSpendUsd: number): Budget {
    if (capUsd < 0) throw new Error(`Budget cap cannot be negative: ${capUsd}`);
    if (currentSpendUsd < 0) throw new Error(`Current spend cannot be negative: ${currentSpendUsd}`);
    return new Budget(capUsd, currentSpendUsd);
  }

  /** An unlimited budget — always allows deploys. */
  static unlimited(currentSpendUsd = 0): Budget {
    return new Budget(0, currentSpendUsd);
  }

  get cap(): number { return this.capUsd; }
  get currentSpend(): number { return this.currentSpendUsd; }
  get isUnlimited(): boolean { return this.capUsd <= 0; }

  /**
   * Check whether a deploy with the given estimated cost is allowed.
   * Returns a structured decision with a reason code.
   */
  canAfford(estimatedCostUsd: number): BudgetDecision {
    if (estimatedCostUsd < 0) throw new Error(`Estimated cost cannot be negative: ${estimatedCostUsd}`);
    const projected = this.currentSpendUsd + estimatedCostUsd;

    if (this.isUnlimited) {
      return { allowed: true, reason: 'no_cap', currentSpend: this.currentSpendUsd, projected, cap: this.capUsd };
    }
    if (projected > this.capUsd) {
      return { allowed: false, reason: 'hard_limit_exceeded', currentSpend: this.currentSpendUsd, projected, cap: this.capUsd };
    }
    if (this.currentSpendUsd / this.capUsd >= SOFT_LIMIT_RATIO) {
      return { allowed: false, reason: 'soft_limit_exceeded', currentSpend: this.currentSpendUsd, projected, cap: this.capUsd };
    }
    return { allowed: true, reason: 'under_cap', currentSpend: this.currentSpendUsd, projected, cap: this.capUsd };
  }

  /** Return a new Budget reflecting additional spend. */
  add(extraCostUsd: number): Budget {
    return new Budget(this.capUsd, this.currentSpendUsd + extraCostUsd);
  }
}

export class BudgetExceededError extends Error {
  constructor(public readonly decision: BudgetDecision) {
    super(`Budget exceeded: ${decision.reason} (spend=$${decision.currentSpend.toFixed(2)}, projected=$${decision.projected.toFixed(2)}, cap=$${decision.cap.toFixed(2)})`);
    this.name = 'BudgetExceededError';
  }
}
