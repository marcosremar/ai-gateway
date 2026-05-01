/**
 * Cost anomaly detector.
 *
 * Scans API usage logs and flags unusual spending patterns.
 * Uses dependency injection - host app provides UsageLogStore implementation.
 */

import type { UsageLogStore } from '../deps';

export interface CostAnomaly {
  type: 'high_spend_user' | 'background_spike' | 'expensive_model' | 'untracked_realtime';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  data?: Record<string, unknown>;
}

export interface CostAnomalyDetectorConfig {
  highSpendThresholdUsd: number;
  backgroundSpikeMultiplier: number;
  expensiveModels: string[];
}

const DEFAULT_CONFIG: CostAnomalyDetectorConfig = {
  highSpendThresholdUsd: 1.0,
  backgroundSpikeMultiplier: 3,
  expensiveModels: ['gpt-4o', 'llama-3.3-70b-versatile', 'llama-3.1-70b-instruct'],
};

export function createCostAnomalyDetector(
  usageLogStore: UsageLogStore,
  config: Partial<CostAnomalyDetectorConfig> = {},
) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return {
    async detectAnomalies(): Promise<CostAnomaly[]> {
      const anomalies: CostAnomaly[] = [];
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);

      try {
        // 1. High-spend users today
        const highSpenders = await usageLogStore.groupByUser({
          startDate: todayStart,
          minCost: cfg.highSpendThresholdUsd,
        });

        for (const s of highSpenders) {
          anomalies.push({
            type: 'high_spend_user',
            severity: s.costUsd > 5 ? 'critical' : 'warning',
            message: `User ${s.userId} spent $${s.costUsd.toFixed(4)} today`,
            data: { userId: s.userId, costUsd: s.costUsd },
          });
        }

        // 2. Background call spike (today vs yesterday)
        const [bgToday, bgYesterday] = await Promise.all([
          usageLogStore.countByContext({ context: 'background', startDate: todayStart }),
          usageLogStore.countInRange({
            context: 'background',
            startDate: yesterdayStart,
            endDate: todayStart,
          }),
        ]);

        if (bgYesterday > 0 && bgToday > bgYesterday * cfg.backgroundSpikeMultiplier) {
          anomalies.push({
            type: 'background_spike',
            severity: 'warning',
            message: `Background calls spiked: ${bgToday} today vs ${bgYesterday} yesterday (${(bgToday / bgYesterday).toFixed(1)}x)`,
            data: { today: bgToday, yesterday: bgYesterday },
          });
        }

        // 3. Expensive models used in background tasks
        const expensiveBg = await usageLogStore.groupByModelAndRoute({
          context: 'background',
          models: cfg.expensiveModels,
          startDate: todayStart,
        });

        for (const e of expensiveBg) {
          anomalies.push({
            type: 'expensive_model',
            severity: 'info',
            message: `Background task "${e.route}" using expensive model "${e.model}" (${e.count} calls, $${e.costUsd.toFixed(4)})`,
            data: { model: e.model, route: e.route, count: e.count, costUsd: e.costUsd },
          });
        }

        // 4. Untracked realtime sessions
        const realtimeSessions = await usageLogStore.countByStage({
          stage: 'realtime',
          costUsd: 0,
          startDate: todayStart,
        });

        if (realtimeSessions > 0) {
          anomalies.push({
            type: 'untracked_realtime',
            severity: 'info',
            message: `${realtimeSessions} Realtime session(s) started today — per-request cost not trackable`,
            data: { count: realtimeSessions },
          });
        }
      } catch (error) {
        console.warn('[CostAnomalyDetector] Error:', error);
      }

      return anomalies;
    },
  };
}
