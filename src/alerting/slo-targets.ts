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

// ── SLO breach window tracker (#598 follow-on) ─────────────────────────────────
// `evaluateSlos()` finds breaches in a single snapshot and `breachAction(count)`
// maps a COUNT to an escalation, but nothing held the breaches over time, so the
// page (2 in 30m) / failover (5 in 60m) WINDOWS in SLO_BREACH_POLICY were dead
// config — the count had to come from somewhere. This tracker records breaches
// with timestamps and computes the windowed recent count, closing the loop. Pure
// in-memory + clock-injectable for tests; per-metric so a single noisy SLO
// doesn't escalate an unrelated one.

export interface SloBreachRecord {
  metric: SloMetricKey;
  observed: number;
  target: number;
  at: number; // epoch ms
}

/** The escalation decision for a metric, derived from its windowed breach count. */
export interface SloEscalation {
  metric: SloMetricKey;
  /** Breaches counted within the failover window (the widest policy window). */
  recentCount: number;
  action: 'none' | 'warn' | 'page' | 'failover';
}

export class SloBreachTracker {
  /** metric → ascending-by-time breach timestamps (+ context), bounded. */
  private breaches = new Map<SloMetricKey, SloBreachRecord[]>();
  private readonly now: () => number;
  /** Hard cap per metric so a sustained breach storm can't grow unbounded. */
  private readonly maxPerMetric: number;

  constructor(opts: { now?: () => number; maxPerMetric?: number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.maxPerMetric =
      Number.isFinite(opts.maxPerMetric) && (opts.maxPerMetric as number) > 0
        ? (opts.maxPerMetric as number)
        : 1000;
  }

  /**
   * Record every breach in an `evaluateSlos()` result. Returns the per-metric
   * escalation decisions AFTER recording, so a caller can route alerts in one
   * step. The widest policy window (failoverWindowMs) bounds retention.
   */
  recordBreaches(breaches: SloBreach[]): SloEscalation[] {
    const at = this.now();
    for (const b of breaches) {
      this.record(b.metric, b.observed, b.target, at);
    }
    // Decide for every metric that has any retained breach (incl. ones just
    // recorded and ones still inside the window from earlier calls).
    const out: SloEscalation[] = [];
    for (const metric of this.breaches.keys()) {
      const count = this.recentCount(metric);
      if (count > 0) out.push({ metric, recentCount: count, action: breachAction(count) });
    }
    return out;
  }

  /** Record a single breach for `metric`. */
  record(metric: SloMetricKey, observed: number, target: number, at = this.now()): void {
    let list = this.breaches.get(metric);
    if (!list) {
      list = [];
      this.breaches.set(metric, list);
    }
    list.push({ metric, observed, target, at });
    this.prune(metric, at);
  }

  /**
   * Count breaches for `metric` within the failover window (the widest policy
   * window, so it covers both page and failover decisions). Prunes stale entries
   * as a side effect.
   */
  recentCount(metric: SloMetricKey, windowMs = SLO_BREACH_POLICY.failoverWindowMs): number {
    const list = this.breaches.get(metric);
    if (!list || list.length === 0) return 0;
    const cutoff = this.now() - windowMs;
    let count = 0;
    for (const r of list) if (r.at > cutoff) count++;
    return count;
  }

  /** Escalation action for a single metric based on its windowed breach count. */
  actionFor(metric: SloMetricKey): 'none' | 'warn' | 'page' | 'failover' {
    return breachAction(this.recentCount(metric));
  }

  /** Drop entries older than the widest policy window (+ enforce the hard cap). */
  private prune(metric: SloMetricKey, at: number): void {
    const list = this.breaches.get(metric);
    if (!list) return;
    const cutoff = at - SLO_BREACH_POLICY.failoverWindowMs;
    // Entries are appended in time order, so drop the stale prefix.
    let drop = 0;
    while (drop < list.length && list[drop].at <= cutoff) drop++;
    if (drop > 0) list.splice(0, drop);
    if (list.length > this.maxPerMetric) list.splice(0, list.length - this.maxPerMetric);
    if (list.length === 0) this.breaches.delete(metric);
  }

  /** Reset all tracked breaches (tests / daily reset). */
  clear(): void {
    this.breaches.clear();
  }
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
