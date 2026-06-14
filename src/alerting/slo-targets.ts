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

/**
 * Resolve the effective daily-spend SLO in USD.
 *
 * `SLO_TARGETS.dailySpendUsd` is a static documented default, but the live cap
 * is `process.env.DAILY_BUDGET_USD`. If an operator raises the env cap, an SLO
 * check built on the static value would false-alarm (#599). Derive the SLO from
 * the same source the deploy gate reads, falling back to the documented default
 * when the env var is unset or invalid (0 / NaN / negative).
 *
 * @param env - environment to read (defaults to process.env; injectable for tests)
 */
export function resolveDailySpendSlo(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DAILY_BUDGET_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : SLO_TARGETS.dailySpendUsd;
}

// ── SLO evaluator (#598) ──────────────────────────────────────────────────────
// SLO_TARGETS + SLO_BREACH_POLICY existed but nothing compared live metrics
// against them, so the page/failover thresholds were dead config. This evaluator
// takes a metrics snapshot and returns the set of breached SLOs plus the
// recommended action per SLO_BREACH_POLICY. Pure + injectable for tests.

/** The subset of the metrics snapshot the SLO evaluator reads. All optional —
 *  a missing field simply skips that SLO (can't breach what you don't measure). */
export interface SloMetricsSnapshot {
  chatP95Ms?: number;
  speechPipelineP95Ms?: number;
  sttP95Ms?: number;
  ttsP95Ms?: number;
  healthP99Ms?: number;
  gpuColdBootP95Ms?: number;
  gpuSnapshotRestoreP95Ms?: number;
  /** Observed HTTP availability ratio (0-1). Breaches when BELOW target. */
  uptimeRatio?: number;
  /** Observed daily spend (USD). Breaches when ABOVE the live budget cap. */
  dailySpendUsd?: number;
  /** Observed boot failure rate (0-1). Breaches when ABOVE target. */
  bootFailureRate?: number;
}

export interface SloBreach {
  metric: SloMetricKey;
  observed: number;
  target: number;
  /** 'over' = observed exceeded a ceiling; 'under' = observed fell below a floor. */
  direction: 'over' | 'under';
}

/** SLOs where a HIGHER observed value than target is the breach (latency, spend). */
const CEILING_METRICS: SloMetricKey[] = [
  'chatP95Ms', 'speechPipelineP95Ms', 'sttP95Ms', 'ttsP95Ms', 'healthP99Ms',
  'gpuColdBootP95Ms', 'gpuSnapshotRestoreP95Ms', 'dailySpendUsd', 'bootFailureRate',
];

/**
 * Evaluate a metrics snapshot against the SLO targets. Returns every breached
 * SLO. The daily-spend target is resolved from the live budget env (#599) so it
 * never drifts from the deploy gate. `uptimeRatio` is a FLOOR (breach when below);
 * all other metrics are CEILINGS (breach when above).
 */
export function evaluateSlos(
  snap: SloMetricsSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): SloBreach[] {
  const breaches: SloBreach[] = [];
  const dailySpendTarget = resolveDailySpendSlo(env);

  for (const metric of CEILING_METRICS) {
    const observed = snap[metric as keyof SloMetricsSnapshot];
    if (observed === undefined) continue;
    const target = metric === 'dailySpendUsd' ? dailySpendTarget : (SLO_TARGETS[metric] as number);
    if (observed > target) {
      breaches.push({ metric, observed, target, direction: 'over' });
    }
  }

  // Uptime is a floor: breach when observed availability drops BELOW the target.
  if (snap.uptimeRatio !== undefined && snap.uptimeRatio < SLO_TARGETS.uptimeRatio) {
    breaches.push({
      metric: 'uptimeRatio',
      observed: snap.uptimeRatio,
      target: SLO_TARGETS.uptimeRatio,
      direction: 'under',
    });
  }

  return breaches;
}

/**
 * Map a count of recent breaches to the escalation action per SLO_BREACH_POLICY.
 * 'none' < 'warn' < 'page' < 'failover'.
 */
export function breachAction(recentBreachCount: number): 'none' | 'warn' | 'page' | 'failover' {
  if (recentBreachCount >= SLO_BREACH_POLICY.failoverThreshold) return 'failover';
  if (recentBreachCount >= SLO_BREACH_POLICY.pageThreshold) return 'page';
  if (recentBreachCount >= SLO_BREACH_POLICY.warningThreshold) return 'warn';
  return 'none';
}

/** Pretty-print a target for inclusion in alert messages. */
export function formatTarget(key: SloMetricKey): string {
  const v = SLO_TARGETS[key];
  if (key.endsWith('Ms')) return `${v}ms`;
  if (key === 'uptimeRatio') return `${(v * 100).toFixed(2)}%`;
  if (key === 'dailySpendUsd') return `$${v}`;
  if (key === 'bootFailureRate') return `${(v * 100).toFixed(1)}%`;
  return String(v);
}
