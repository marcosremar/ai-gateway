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

export interface InferenceCostStats {
  totalUsd: number;
  requests: number;
  avgCostPerRequest: number;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Record an inference cost for a provider + stage combination.
 * If tokens are provided, cost is scaled per 1K tokens; otherwise flat per-request.
 */
export function recordInferenceCost(provider: string, stage: string, tokens?: number): void {
  const key = `${provider}:${stage}`;
  const baseCost = COST_PER_REQUEST[key] || 0;
  const cost = tokens ? baseCost * (tokens / 1000) : baseCost;
  totalInferenceCostUsd += cost;
  requestCount++;
}

/** Get cumulative inference cost statistics. */
export function getInferenceCostStats(): InferenceCostStats {
  return {
    totalUsd: Math.round(totalInferenceCostUsd * 10000) / 10000,
    requests: requestCount,
    avgCostPerRequest: requestCount > 0
      ? Math.round((totalInferenceCostUsd / requestCount) * 10000) / 10000
      : 0,
  };
}

/** Reset counters (e.g. daily reset via cron or monitor loop). */
export function resetDailyInferenceCost(): void {
  totalInferenceCostUsd = 0;
  requestCount = 0;
}
