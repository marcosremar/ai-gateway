/**
 * Global guardrail stats registry.
 * Singleton — read by the /health endpoint, written by GuardrailEngine.
 */

export interface GuardrailStats {
  /** Requests that passed all rules */
  passed: number;
  /** Requests blocked by a rule (action = 'block') */
  blocked: number;
  /** Requests flagged but allowed through (action = 'audit') */
  audited: number;
  /** Per-rule-type failure counts */
  ruleHits: Record<string, number>;
  /** Total rules evaluated */
  totalEvaluations: number;
  /** Timestamp of last block */
  lastBlockedAt: number | null;
}

const stats: GuardrailStats = {
  passed: 0,
  blocked: 0,
  audited: 0,
  ruleHits: {},
  totalEvaluations: 0,
  lastBlockedAt: null,
};

export function recordGuardrailPass(): void {
  stats.passed++;
  stats.totalEvaluations++;
}

export function recordGuardrailBlock(ruleType: string): void {
  stats.blocked++;
  stats.totalEvaluations++;
  stats.ruleHits[ruleType] = (stats.ruleHits[ruleType] ?? 0) + 1;
  stats.lastBlockedAt = Date.now();
}

export function recordGuardrailAudit(ruleType: string): void {
  stats.audited++;
  stats.totalEvaluations++;
  stats.ruleHits[ruleType] = (stats.ruleHits[ruleType] ?? 0) + 1;
}

export function getGuardrailStats(): GuardrailStats {
  return { ...stats, ruleHits: { ...stats.ruleHits } };
}

export function resetGuardrailStats(): void {
  stats.passed = 0;
  stats.blocked = 0;
  stats.audited = 0;
  stats.ruleHits = {};
  stats.totalEvaluations = 0;
  stats.lastBlockedAt = null;
}
