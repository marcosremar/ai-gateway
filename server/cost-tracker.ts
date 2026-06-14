/**
 * Cost Tracker — estimated per-request inference cost tracking.
 *
 * Tracks approximate cost for each inference request by provider and stage.
 * GPU requests are zero-cost here (included in hourly GPU rental).
 *
 * Usage:
 *   recordInferenceCost('groq', 'stt');
 *   recordInferenceCost('openai', 'llm', 1500);  // 1500 tokens
 *   const stats = getInferenceCostStats();
 */

// Daily-spend counter lives in the cost-state module (server/state re-exports
// it). Import it directly so cloud spend folds into the SAME budget counter the
// deploy gate reads — a lazy require() would duplicate the module under some
// loaders and silently drop the accrual.
import { dailyGpuSpendUsd, setDailyGpuSpendUsd } from '../src/gateway/state/cost-state';

// ── Approximate costs per request or per 1K tokens ──────────────────────────

const COST_PER_REQUEST: Record<string, number> = {
  'groq:stt': 0.001, // ~$0.001 per STT request
  'groq:llm': 0.0005, // ~$0.0005 per 1K tokens
  'openai:stt': 0.006, // ~$0.006 per minute
  'openai:llm': 0.003, // ~$0.003 per 1K tokens
  'openai:tts': 0.015, // ~$0.015 per 1K chars
  'fireworks:stt': 0.002, // ~$0.002 per STT request
  'fireworks:llm': 0.001, // ~$0.001 per 1K tokens
  'openrouter:llm': 0.002, // ~$0.002 per 1K tokens (varies by model)
  'gpu:stt': 0, // included in hourly cost
  'gpu:llm': 0,
  'gpu:tts': 0,
  'modal:tts': 0.001, // ~$0.001 per TTS request
  'modal:stt': 0.001,
  'modal:llm': 0.001,
};

// ── State ───────────────────────────────────────────────────────────────────

let totalInferenceCostUsd = 0;
let requestCount = 0;
/** Per-provider cost breakdown for `/metrics` (mirrors metricsCounters.byProvider). */
const costByProvider: Record<string, number> = {};
/** Count of requests whose provider:stage pair has no entry in COST_PER_REQUEST. */
let unmappedCount = 0;
/** Provider:stage keys we've already warned about (warn once, not per-request). */
const warnedUnmapped = new Set<string>();

export interface InferenceCostStats {
  totalUsd: number;
  requests: number;
  avgCostPerRequest: number;
  /** Per-provider cost breakdown (USD). */
  byProvider: Record<string, number>;
  /** Number of requests that hit an unmapped provider:stage (recorded as $0). */
  unmappedRequests: number;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Record an inference cost for a provider + stage combination.
 * If tokens are provided, cost is scaled per 1K tokens; otherwise flat per-request.
 *
 * Cloud (non-GPU) cost is also folded into the daily budget counter so the
 * deploy budget gate (canAffordDeploy → dailyGpuSpendUsd) sees combined
 * GPU + cloud spend; a runaway cloud loop now counts toward DAILY_BUDGET_USD.
 * GPU stages are $0 here (their cost is the hourly rental tracked separately).
 */
export function recordInferenceCost(provider: string, stage: string, tokens?: number): void {
  const key = `${provider}:${stage}`;
  const mapped = Object.prototype.hasOwnProperty.call(COST_PER_REQUEST, key);
  const baseCost = mapped ? COST_PER_REQUEST[key] : 0;
  const cost = tokens ? baseCost * (tokens / 1000) : baseCost;

  totalInferenceCostUsd += cost;
  requestCount++;
  costByProvider[provider] = (costByProvider[provider] ?? 0) + cost;

  // An unmapped pair silently records $0 — surface it so spend gaps are visible
  // instead of vanishing. Warn once per key; count every occurrence.
  if (!mapped) {
    unmappedCount++;
    if (!warnedUnmapped.has(key)) {
      warnedUnmapped.add(key);
      // Lazy require keeps this module importable in isolation (unit tests).
      try {
        const { createLogger } = require('../src/logger');
        createLogger('cost-tracker').warn(
          `No cost mapping for "${key}" — recording $0. Add it to COST_PER_REQUEST or pricing.ts.`,
        );
      } catch { /* logger unavailable (test harness) — counter still increments */ }
    }
  }

  // Fold cloud inference cost into the daily budget counter. GPU is $0 here and
  // accrued via the hourly-rental monitor loop, so only non-zero cloud cost is
  // added. Best-effort: never let budget bookkeeping break the request path.
  if (cost > 0) {
    accrueCloudSpendToBudget(cost);
  }
}

/**
 * Add cloud inference cost to the daily GPU spend counter so the budget gate
 * accounts for it. Reads/writes via state.ts's re-exported cost-state setter.
 */
function accrueCloudSpendToBudget(costUsd: number): void {
  try {
    setDailyGpuSpendUsd(dailyGpuSpendUsd + costUsd);
  } catch {
    /* never let budget bookkeeping break the request path */
  }
}

/** Get cumulative inference cost statistics. */
export function getInferenceCostStats(): InferenceCostStats {
  const byProvider: Record<string, number> = {};
  for (const [p, v] of Object.entries(costByProvider)) {
    byProvider[p] = Math.round(v * 10000) / 10000;
  }
  return {
    totalUsd: Math.round(totalInferenceCostUsd * 10000) / 10000,
    requests: requestCount,
    avgCostPerRequest: requestCount > 0
      ? Math.round((totalInferenceCostUsd / requestCount) * 10000) / 10000
      : 0,
    byProvider,
    unmappedRequests: unmappedCount,
  };
}

/** Reset counters (e.g. daily reset via cron or monitor loop). */
export function resetDailyInferenceCost(): void {
  totalInferenceCostUsd = 0;
  requestCount = 0;
  unmappedCount = 0;
  for (const k of Object.keys(costByProvider)) delete costByProvider[k];
  warnedUnmapped.clear();
}
