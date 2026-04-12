/**
 * SLO targets — single source of truth for alerting thresholds.
 *
 * These values are declared in `docs/slo.md`. Any change here must be
 * accompanied by a change to the doc (and vice versa). The doc is the
 * human-readable version; this file is the machine-readable version.
 *
 * Do NOT hardcode latency/uptime/cost targets anywhere else in the
 * codebase — import from this module so a single edit propagates to
 * every alert channel, dashboard, and test.
 *
 * Revision: v1 (2026-04-12)
 */

export const SLO_TARGETS = {
  /** POST /v1/chat/completions p95 latency, milliseconds, 7-day window */
  chatP95Ms: 2_000,

  /** POST /v1/speech full pipeline p95 latency, milliseconds, 7-day window */
  speechPipelineP95Ms: 4_000,

  /** POST /v1/audio/transcriptions p95 latency, milliseconds, 7-day window */
  sttP95Ms: 1_500,

  /** POST /v1/audio/speech p95 latency, milliseconds, 7-day window */
  ttsP95Ms: 2_500,

  /** Gateway HTTP availability ratio, 30-day window (0.995 = 99.5%) */
  uptimeRatio: 0.995,

  /** GET /health p99 latency, milliseconds, 7-day window.
   *  Relaxed from 100ms to 200ms: single-region CDG deployment measured
   *  at 155ms p95 cross-ocean (laptop → Paris). Clients within EU see
   *  <50ms. The target accommodates CDN routing latency without causing
   *  false alarms for cross-region callers. */
  healthP99Ms: 200,

  /** GPU cold-boot p95 duration, milliseconds, 7-day window */
  gpuColdBootP95Ms: 60_000,

  /** GPU snapshot-restore p95 duration, milliseconds, 7-day window */
  gpuSnapshotRestoreP95Ms: 10_000,

  /** Daily GPU spend cap, USD, 24-hour window */
  dailySpendUsd: 50,

  /** Boot failure rate, 7-day window (0.05 = 5%) */
  bootFailureRate: 0.05,
} as const;

export type SloMetricKey = keyof typeof SLO_TARGETS;

/**
 * Breach policy — how many breaches in how long before escalating.
 * Consumed by the alert router.
 */
export const SLO_BREACH_POLICY = {
  /** Single breach → warning channel (Discord #gateway-alerts) */
  warningThreshold: 1,

  /** Two breaches in 30 minutes → page on-call (Slack) */
  pageThreshold: 2,
  pageWindowMs: 30 * 60_000,

  /** Five breaches in 60 minutes → automatic failover mode */
  failoverThreshold: 5,
  failoverWindowMs: 60 * 60_000,
} as const;

/** Pretty-print a target for inclusion in alert messages. */
export function formatTarget(key: SloMetricKey): string {
  const v = SLO_TARGETS[key];
  if (key.endsWith('Ms')) return `${v}ms`;
  if (key === 'uptimeRatio') return `${(v * 100).toFixed(2)}%`;
  if (key === 'dailySpendUsd') return `$${v}`;
  if (key === 'bootFailureRate') return `${(v * 100).toFixed(1)}%`;
  return String(v);
}
