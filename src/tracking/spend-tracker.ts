/**
 * Spend Tracker — records per-request costs and tracks daily budgets.
 *
 * Uses the StateStore interface for persistence (Redis-backed in production).
 */

import type { StateStore } from '../deps';
import { estimateRequestCost, type ModelPricing } from './pricing';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SpendRecord {
  userId: string;
  provider: string;
  model: string;
  stage: 'stt' | 'llm' | 'tts' | 'pipeline';
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: number;
}

export interface SpendSummary {
  date: string;
  totalCostUsd: number;
  requestCount: number;
  byProvider: Record<string, { costUsd: number; requests: number }>;
  byStage: Record<string, { costUsd: number; requests: number }>;
}

export interface BudgetConfig {
  /** Daily spend limit in USD */
  dailyLimitUsd: number;
  /** Alert threshold as fraction (0-1). Default: 0.8 (80%) */
  alertThreshold?: number;
}

export interface BudgetStatus {
  /** Whether the user is over budget */
  over: boolean;
  /** Current spend as fraction of limit (0-1+) */
  pct: number;
  /** The configured limit */
  limitUsd: number;
  /** Current total spend */
  currentUsd: number;
}

// ── Keys ──────────────────────────────────────────────────────────────────────

const SPEND_LIST_PREFIX = 'spend:records:';
const SPEND_DAILY_PREFIX = 'spend:daily:';
const MAX_RECORDS_PER_DAY = 10_000;
/** Scale factor for storing fractional dollars as integers (atomic hincrby). */
const MICROS_PER_USD = 1_000_000;

function recordsKey(userId: string, date: string): string {
  const sanitized = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${SPEND_LIST_PREFIX}${sanitized}:${date}`;
}

function dailyKey(userId: string, date: string): string {
  const sanitized = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${SPEND_DAILY_PREFIX}${sanitized}:${date}`;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── Tracker ───────────────────────────────────────────────────────────────────

export class SpendTracker {
  private stateStore: StateStore;
  private pricingTable?: Record<string, ModelPricing>;
  /**
   * Count of records rejected as invalid (negative/non-finite cost). A
   * systematic negative-cost bug would otherwise corrupt totals with only log
   * noise (#556); expose it so it can be surfaced as a metric / alert.
   */
  private invalidCount = 0;

  constructor(stateStore: StateStore, pricingTable?: Record<string, ModelPricing>) {
    this.stateStore = stateStore;
    this.pricingTable = pricingTable;
  }

  /** Number of records dropped for an invalid (negative/non-finite) cost. */
  getInvalidCount(): number {
    return this.invalidCount;
  }

  /**
   * Record a spend event. Cost is auto-calculated if not provided (set to 0).
   */
  async record(record: SpendRecord): Promise<void> {
    // Guard against negative / non-finite costs corrupting budget enforcement.
    // Count the drop (#556) so a systematic bad-cost bug is observable, not just
    // log noise.
    if (!Number.isFinite(record.costUsd) || record.costUsd < 0) {
      this.invalidCount++;
      console.warn(`[spend-tracker] Ignoring record with invalid cost: $${record.costUsd} (provider=${record.provider})`);
      return;
    }

    const date = new Date(record.timestamp).toISOString().slice(0, 10);
    const rKey = recordsKey(record.userId, date);
    const dKey = dailyKey(record.userId, date);

    try {
      // Append to daily records list (used by getDailySummary for per-provider breakdown)
      await this.stateStore.rpush(rKey, JSON.stringify(record));
      await this.stateStore.ltrim(rKey, -MAX_RECORDS_PER_DAY, -1);

      // Update daily aggregates in hash (fast path for budget checks).
      //
      // Previously this was a read-modify-write (hgetall → add → hset): two
      // concurrent records read the same `existingCost`/`existingCount` and the
      // later write clobbered the earlier increment, so per-user daily spend was
      // silently undercounted under concurrency. Use the store's atomic
      // increment instead.
      //
      // `hincrby` is integer-only across backends (Redis HINCRBY), so cost is
      // accumulated in integer micro-dollars (USD * 1e6). getDailyTotalFast()
      // divides back to dollars. requestCount is a plain integer increment.
      const micros = Math.round(record.costUsd * MICROS_PER_USD);
      await Promise.all([
        this.stateStore.hincrby(dKey, 'totalCostMicros', micros),
        this.stateStore.hincrby(dKey, 'requestCount', 1),
      ]);
    } catch (err) {
      // Non-critical — swallow but log for debugging
      console.warn('[spend-tracker] Failed to record spend:', err);
    }
  }

  /**
   * Fast O(1) read of a user's atomically-accumulated daily total + request
   * count from the `spend:daily:` hash. Unlike getDailySummary (which scans
   * and JSON-parses the whole records list), this reads the precomputed hash
   * maintained by record(). Use it for hot-path budget checks.
   */
  async getDailyTotalFast(userId: string, date?: string): Promise<{ totalCostUsd: number; requestCount: number }> {
    const d = date ?? todayStr();
    const dKey = dailyKey(userId, d);
    try {
      const daily = await this.stateStore.hgetall(dKey);
      const micros = parseInt(daily['totalCostMicros'] ?? '0', 10);
      const count = parseInt(daily['requestCount'] ?? '0', 10);
      return {
        totalCostUsd: (Number.isFinite(micros) ? micros : 0) / MICROS_PER_USD,
        requestCount: Number.isFinite(count) ? count : 0,
      };
    } catch {
      return { totalCostUsd: 0, requestCount: 0 };
    }
  }

  /**
   * Estimate cost for a request using the pricing table.
   */
  estimateCost(provider: string, model: string, inputTokens: number, outputTokens: number): number {
    return estimateRequestCost(provider, model, inputTokens, outputTokens, this.pricingTable);
  }

  /**
   * Get a daily summary for a user.
   */
  async getDailySummary(userId: string, date?: string): Promise<SpendSummary> {
    const d = date ?? todayStr();
    const rKey = recordsKey(userId, d);

    const summary: SpendSummary = {
      date: d,
      totalCostUsd: 0,
      requestCount: 0,
      byProvider: {},
      byStage: {},
    };

    try {
      const records = await this.stateStore.lrange(rKey, 0, -1);
      for (const raw of records) {
        let rec: SpendRecord;
        try {
          rec = JSON.parse(raw) as SpendRecord;
        } catch {
          // Skip corrupted records instead of aborting the entire summary
          continue;
        }
        summary.totalCostUsd += rec.costUsd;
        summary.requestCount++;

        // By provider
        if (!summary.byProvider[rec.provider]) {
          summary.byProvider[rec.provider] = { costUsd: 0, requests: 0 };
        }
        summary.byProvider[rec.provider].costUsd += rec.costUsd;
        summary.byProvider[rec.provider].requests++;

        // By stage
        if (!summary.byStage[rec.stage]) {
          summary.byStage[rec.stage] = { costUsd: 0, requests: 0 };
        }
        summary.byStage[rec.stage].costUsd += rec.costUsd;
        summary.byStage[rec.stage].requests++;
      }
    } catch {
      // Return partial summary on store error
    }

    return summary;
  }

  /**
   * Check if a user is over their daily budget.
   */
  async checkBudget(userId: string, budget: BudgetConfig): Promise<BudgetStatus> {
    const summary = await this.getDailySummary(userId);
    const pct = budget.dailyLimitUsd > 0 ? summary.totalCostUsd / budget.dailyLimitUsd : 0;

    return {
      over: summary.totalCostUsd >= budget.dailyLimitUsd,
      pct,
      limitUsd: budget.dailyLimitUsd,
      currentUsd: summary.totalCostUsd,
    };
  }

}
