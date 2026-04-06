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
const SPEND_TTL_SECS = 48 * 60 * 60; // 48 hours
const MAX_RECORDS_PER_DAY = 10_000;

function recordsKey(userId: string, date: string): string {
  return `${SPEND_LIST_PREFIX}${userId}:${date}`;
}

function dailyKey(userId: string, date: string): string {
  return `${SPEND_DAILY_PREFIX}${userId}:${date}`;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── Tracker ───────────────────────────────────────────────────────────────────

export class SpendTracker {
  private stateStore: StateStore;
  private pricingTable?: Record<string, ModelPricing>;

  constructor(stateStore: StateStore, pricingTable?: Record<string, ModelPricing>) {
    this.stateStore = stateStore;
    this.pricingTable = pricingTable;
  }

  /**
   * Record a spend event. Cost is auto-calculated if not provided (set to 0).
   */
  async record(record: SpendRecord): Promise<void> {
    // Guard against negative costs corrupting budget enforcement
    if (record.costUsd < 0) {
      console.warn(`[spend-tracker] Ignoring record with negative cost: $${record.costUsd} (provider=${record.provider})`);
      return;
    }

    const date = new Date(record.timestamp).toISOString().slice(0, 10);
    const rKey = recordsKey(record.userId, date);
    const dKey = dailyKey(record.userId, date);

    try {
      // Append to daily records list (used by getDailySummary for per-provider breakdown)
      await this.stateStore.rpush(rKey, JSON.stringify(record));
      await this.stateStore.ltrim(rKey, -MAX_RECORDS_PER_DAY, -1);

      // Update daily aggregates in hash (fast path for budget checks)
      const daily = await this.stateStore.hgetall(dKey);
      const existingCost = parseFloat(daily['totalCost'] ?? '0');
      const existingCount = parseInt(daily['requestCount'] ?? '0', 10);
      await this.stateStore.hset(dKey, 'totalCost', (existingCost + record.costUsd).toFixed(6));
      await this.stateStore.hset(dKey, 'requestCount', String(existingCount + 1));
    } catch {
      // Non-critical — swallow
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

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async sumDailyCost(userId: string, date: string): Promise<string> {
    const summary = await this.getDailySummary(userId, date);
    return summary.totalCostUsd.toFixed(6);
  }

  private async countDailyRequests(userId: string, date: string): Promise<string> {
    const summary = await this.getDailySummary(userId, date);
    return String(summary.requestCount);
  }
}
