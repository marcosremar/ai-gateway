/**
 * Cost anomaly detector.
 *
 * Scans API usage logs and flags unusual spending patterns.
 * Uses dependency injection - host app provides UsageLogStore implementation.
 */

import type { UsageLogStore } from '../deps';

export interface CostAnomaly {
  type: 'high_spend_user' | 'background_spike' | 'expensive_model' | 'untracked_realtime' | 'idle_gpu_waste';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  data?: Record<string, unknown>;
}

/** Minimal alert sink — the AlertRouter shape, kept structural to avoid a hard
 *  dependency (and a possible import cycle) on the alerting module. */
export interface AnomalyAlertSink {
  route(payload: {
    severity: 'info' | 'warning' | 'critical';
    title: string;
    message: string;
    timestamp: Date;
    metadata?: Record<string, unknown>;
  }): unknown;
}

/** Snapshot of a billing GPU's recent activity — supplied by the monitor loop. */
export interface IdleGpuSnapshot {
  /** Currently billing (rented) and >$0/hr. */
  active: boolean;
  costPerHr: number;
  /** Epoch ms of the last model request served, or 0/undefined if never. */
  lastRequestMs?: number;
}

export interface CostAnomalyDetectorConfig {
  highSpendThresholdUsd: number;
  backgroundSpikeMultiplier: number;
  expensiveModels: string[];
  /**
   * Absolute background-call count that is itself anomalous when there is no
   * prior-day baseline (first day, or after retention purge). Without this the
   * multiplier-based check no-ops on day one and a cost explosion is invisible.
   */
  absoluteBackgroundSpikeCount: number;
  /**
   * Minutes a billing GPU may go without serving a request before it is flagged
   * as idle-waste (#562) — the biggest waste class (paying $/hr for nothing).
   */
  idleGpuMinutes: number;
  /**
   * Realtime API per-minute price (USD). Used to estimate cost for sessions whose
   * per-request cost is untrackable, from their duration, instead of $0 (#561).
   */
  realtimeUsdPerMinute: number;
}

const DEFAULT_CONFIG: CostAnomalyDetectorConfig = {
  highSpendThresholdUsd: 1.0,
  backgroundSpikeMultiplier: 3,
  expensiveModels: ['gpt-4o', 'llama-3.3-70b-versatile', 'llama-3.1-70b-instruct'],
  absoluteBackgroundSpikeCount: 1000,
  idleGpuMinutes: 30,
  realtimeUsdPerMinute: 0.06, // ~OpenAI gpt-4o-mini-realtime audio order of magnitude
};

export interface CostAnomalyDetectorDeps {
  /** Returns the current billing-GPU snapshot for idle-waste detection (#562). */
  getIdleGpuSnapshot?: () => IdleGpuSnapshot | null | undefined;
  /** Alert sink for detectAndAlert() (#559/#560). */
  alertSink?: AnomalyAlertSink;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

export function createCostAnomalyDetector(
  usageLogStore: UsageLogStore,
  config: Partial<CostAnomalyDetectorConfig> = {},
  deps: CostAnomalyDetectorDeps = {},
) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const now = deps.now ?? (() => Date.now());

  /** Flag a billing GPU that has served no request for too long (#562). */
  function detectIdleGpuWaste(): CostAnomaly | null {
    const snap = deps.getIdleGpuSnapshot?.();
    if (!snap || !snap.active || snap.costPerHr <= 0) return null;
    const lastMs = snap.lastRequestMs ?? 0;
    const idleMs = now() - lastMs;
    const idleMinutes = idleMs / 60_000;
    if (lastMs > 0 && idleMinutes < cfg.idleGpuMinutes) return null;
    // Never served a request, or idle past the threshold → wasted spend.
    const wastedUsd = (idleMs / 3_600_000) * snap.costPerHr;
    return {
      type: 'idle_gpu_waste',
      severity: 'warning',
      message: lastMs > 0
        ? `GPU billing $${snap.costPerHr.toFixed(2)}/hr has served no request for ${Math.round(idleMinutes)}m (~$${wastedUsd.toFixed(2)} wasted)`
        : `GPU billing $${snap.costPerHr.toFixed(2)}/hr has never served a request`,
      data: {
        costPerHr: snap.costPerHr,
        idleMinutes: Math.round(idleMinutes),
        wastedUsd: Math.round(wastedUsd * 10000) / 10000,
      },
    };
  }

  const api = {
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
        } else if (bgYesterday === 0 && bgToday >= cfg.absoluteBackgroundSpikeCount) {
          // No baseline to compare against — fall back to an absolute threshold
          // so a day-one background-call explosion is still detected.
          anomalies.push({
            type: 'background_spike',
            severity: 'warning',
            message: `Background calls high with no prior-day baseline: ${bgToday} today (>= ${cfg.absoluteBackgroundSpikeCount})`,
            data: { today: bgToday, yesterday: bgYesterday, absolute: true },
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
          // Realtime APIs bill per audio-minute, so estimate cost from total
          // session duration (when the store can provide it) instead of leaving
          // it at $0 (#561). Falls back to a count-only message if unavailable.
          let estUsd: number | undefined;
          const durFn = (usageLogStore as Partial<{ sumRealtimeDurationMinutes: (q: unknown) => Promise<number> }>)
            .sumRealtimeDurationMinutes;
          if (typeof durFn === 'function') {
            try {
              const minutes = await durFn.call(usageLogStore, { stage: 'realtime', startDate: todayStart });
              if (Number.isFinite(minutes) && minutes > 0) {
                estUsd = Math.round(minutes * cfg.realtimeUsdPerMinute * 10000) / 10000;
              }
            } catch { /* duration query unavailable — fall through to count-only */ }
          }

          anomalies.push({
            type: 'untracked_realtime',
            severity: 'info',
            message: estUsd !== undefined
              ? `${realtimeSessions} Realtime session(s) today — est. $${estUsd.toFixed(4)} from audio-minute duration`
              : `${realtimeSessions} Realtime session(s) started today — per-request cost not trackable`,
            data: estUsd !== undefined
              ? { count: realtimeSessions, estUsd, estimated: true }
              : { count: realtimeSessions },
          });
        }

        // 5. Idle GPU waste (#562) — biggest waste class: a billing GPU with no
        // traffic. Fed by the monitor loop's snapshot rather than the usage log.
        const idle = detectIdleGpuWaste();
        if (idle) anomalies.push(idle);
      } catch (error) {
        console.warn('[CostAnomalyDetector] Error:', error);
      }

      return anomalies;
    },

    /**
     * Detect anomalies and route warning/critical ones to the alert sink
     * (#559/#560). Returns all detected anomalies. Without an `alertSink` this
     * behaves exactly like detectAnomalies() (no-op routing). Best-effort: a
     * failing sink never throws out of here.
     */
    async detectAndAlert(): Promise<CostAnomaly[]> {
      const anomalies = await api.detectAnomalies();
      const sink = deps.alertSink;
      if (sink) {
        for (const a of anomalies) {
          if (a.severity === 'info') continue; // only escalate warning/critical
          try {
            sink.route({
              severity: a.severity,
              title: `Cost anomaly: ${a.type}`,
              message: a.message,
              timestamp: new Date(now()),
              metadata: a.data,
            });
          } catch { /* never let alert delivery break detection */ }
        }
      }
      return anomalies;
    },
  };

  return api;
}
