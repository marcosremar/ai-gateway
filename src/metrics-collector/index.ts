/**
 * Metrics Collector — collects and aggregates system metrics.
 *
 * Fixes: #834 (production monitoring), #733-735 (metrics, alerting helpers)
 *
 * Usage:
 * ```ts
 * import { metrics } from './metrics-collector';
 *
 * // Record metrics
 * metrics.increment('requests.total', { method: 'POST', path: '/v1/chat' });
 * metrics.histogram('request.duration_ms', 234, { provider: 'groq' });
 * metrics.gauge('gpu.memory_used_mb', 512, { gpuType: 'RTX 4090' });
 *
 * // Get metrics
 * const snapshot = metrics.getSnapshot();
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('metrics');

/**
 * Nearest-rank percentile over an already-sorted ascending array.
 * `p` is a fraction in [0, 1]. Returns 0 for an empty array.
 * This is the gateway-wide percentile convention (see server/metrics.ts
 * computePercentile) and guarantees the p50 <= p95 <= p99 ordering for
 * any sample size, unlike a raw `Math.floor(n * p)` index.
 */
export function percentileIndex(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.ceil(p * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, Math.min(sortedAsc.length - 1, idx))];
}

/**
 * Split a serialized metric key (`name{k="v",...}` or `name`) into its base
 * name and the inner label string (without braces). Used by the Prometheus
 * summary export to inject the `quantile` label alongside existing labels.
 */
function splitKey(key: string): { base: string; labels: string } {
  const brace = key.indexOf('{');
  if (brace === -1) return { base: key, labels: '' };
  return { base: key.slice(0, brace), labels: key.slice(brace + 1, key.lastIndexOf('}')) };
}

/** Append a `name="value"` label to an existing (possibly empty) label string. */
function appendLabel(labels: string, name: string, value: string): string {
  const pair = `${name}="${value}"`;
  return labels ? `${labels},${pair}` : pair;
}

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricSample {
  type: MetricType;
  name: string;
  value: number;
  labels: Record<string, string>;
  timestamp: string;
}

export interface MetricSeries {
  name: string;
  type: MetricType;
  samples: number[];
  labels: Record<string, string>;
}

/**
 * Max distinct label-sets retained per metric base name before new series are
 * dropped. A high-cardinality label (userId, requestId, model variant) would
 * otherwise grow the counters/gauges/histograms Maps without bound — the
 * classic Prometheus cardinality blowup (#589). Override via env for ops tuning.
 */
const MAX_SERIES_PER_METRIC = (() => {
  const n = Number(process.env.METRICS_MAX_SERIES_PER_METRIC);
  return Number.isFinite(n) && n > 0 ? n : 1000;
})();

class MetricsCollector {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, MetricSeries>();
  /** base metric name → set of distinct serialized keys seen (cardinality cap). */
  private seriesKeys = new Map<string, Set<string>>();
  /** Count of (name) records dropped because the per-metric series cap was hit. */
  private droppedCardinality = 0;
  /** base names we've already warned about (warn once per metric). */
  private warnedCardinality = new Set<string>();
  /** Active per-metric series cap. Defaults from env; tunable at runtime. */
  private maxSeriesPerMetric = MAX_SERIES_PER_METRIC;

  /** Override the per-metric cardinality cap (runtime tuning / tests). */
  setMaxSeriesPerMetric(n: number): void {
    if (Number.isFinite(n) && n > 0) this.maxSeriesPerMetric = n;
  }
  /**
   * Total samples observed. Previously every record pushed a full MetricSample
   * object (incl. `new Date().toISOString()`) into a 10k ring that was only
   * ever read as `.length` — pure hot-path allocation for a number. Keep the
   * count, drop the array.
   */
  private sampleCount = 0;

  /**
   * Cardinality gate. Returns true if `key` is already tracked for `name`, or if
   * accepting a new key keeps `name` within MAX_SERIES_PER_METRIC. Returns false
   * (and counts the drop) when `name` is at the cap and `key` is new — protecting
   * the Maps from unbounded growth on a high-cardinality label.
   */
  private withinCardinalityBudget(name: string, key: string): boolean {
    let keys = this.seriesKeys.get(name);
    if (!keys) {
      keys = new Set();
      this.seriesKeys.set(name, keys);
    }
    if (keys.has(key)) return true;
    if (keys.size >= this.maxSeriesPerMetric) {
      this.droppedCardinality++;
      if (!this.warnedCardinality.has(name)) {
        this.warnedCardinality.add(name);
        log.warn(
          `[metrics] cardinality cap (${this.maxSeriesPerMetric}) hit for "${name}" — ` +
            `dropping new label-sets. Reduce label cardinality or raise METRICS_MAX_SERIES_PER_METRIC.`,
        );
      }
      return false;
    }
    keys.add(key);
    return true;
  }

  /** Number of records dropped because a per-metric series cap was reached. */
  getDroppedCardinalityCount(): number {
    return this.droppedCardinality;
  }

  /**
   * Increment a counter.
   */
  increment(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = this.makeKey(name, labels);
    if (!this.withinCardinalityBudget(name, key)) return;
    const current = this.counters.get(key) ?? 0;
    this.counters.set(key, current + value);
    this.sampleCount++;
  }

  /**
   * Set a gauge value.
   */
  gauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.makeKey(name, labels);
    if (!this.withinCardinalityBudget(name, key)) return;
    this.gauges.set(key, value);
    this.sampleCount++;
  }

  /**
   * Record a histogram sample.
   */
  histogram(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.makeKey(name, labels);
    if (!this.withinCardinalityBudget(name, key)) return;

    if (!this.histograms.has(key)) {
      this.histograms.set(key, { name, type: 'histogram', samples: [], labels });
    }

    const series = this.histograms.get(key)!;
    series.samples.push(value);

    // Keep only last 1000 samples per series
    if (series.samples.length > 1000) {
      series.samples.shift();
    }

    this.sampleCount++;
  }

  /**
   * Get counter value.
   */
  getCounter(name: string, labels: Record<string, string> = {}): number {
    const key = this.makeKey(name, labels);
    return this.counters.get(key) ?? 0;
  }

  /**
   * Get gauge value.
   */
  getGauge(name: string, labels: Record<string, string> = {}): number | undefined {
    const key = this.makeKey(name, labels);
    return this.gauges.get(key);
  }

  /**
   * Get histogram statistics.
   */
  getHistogramStats(name: string, labels: Record<string, string> = {}): {
    count: number;
    sum: number;
    avg: number;
    min: number;
    max: number;
    p50: number;
    p95: number;
    p99: number;
  } | null {
    const key = this.makeKey(name, labels);
    const series = this.histograms.get(key);
    if (!series || series.samples.length === 0) return null;

    const sorted = [...series.samples].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
      count,
      sum,
      avg: sum / count,
      min: sorted[0],
      max: sorted[count - 1],
      // Nearest-rank percentile (matches server/metrics.ts computePercentile).
      // The previous `Math.floor(count * p)` overshot for small samples —
      // e.g. floor(3 * 0.99) = 2 = the last element, so p99 collapsed to max
      // and overstated tail latency. `ceil(count * p) - 1` keeps p50 <= p95 <= p99.
      p50: percentileIndex(sorted, 0.5),
      p95: percentileIndex(sorted, 0.95),
      p99: percentileIndex(sorted, 0.99),
    };
  }

  /**
   * Get all counters.
   */
  getCounters(): Record<string, number> {
    return Object.fromEntries(this.counters.entries());
  }

  /**
   * Get all gauges.
   */
  getGauges(): Record<string, number> {
    return Object.fromEntries(this.gauges.entries());
  }

  /**
   * Get snapshot of all metrics.
   */
  getSnapshot(): {
    counters: Record<string, number>;
    gauges: Record<string, number>;
    histograms: Record<string, ReturnType<MetricsCollector['getHistogramStats']>>;
    recentSamples: number;
  } {
    const histogramStats: Record<string, ReturnType<MetricsCollector['getHistogramStats']>> = {};

    for (const [key, series] of this.histograms.entries()) {
      histogramStats[key] = this.getHistogramStats(series.name, series.labels);
    }

    return {
      counters: this.getCounters(),
      gauges: this.getGauges(),
      histograms: histogramStats,
      recentSamples: this.sampleCount,
    };
  }

  /**
   * Reset all metrics.
   */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.seriesKeys.clear();
    this.warnedCardinality.clear();
    this.droppedCardinality = 0;
    this.sampleCount = 0;
  }

  /**
   * Export metrics in Prometheus format.
   */
  exportPrometheus(): string {
    const lines: string[] = [];

    // Counters
    for (const [key, value] of this.counters.entries()) {
      lines.push(`${key} ${value}`);
    }

    // Gauges
    for (const [key, value] of this.gauges.entries()) {
      lines.push(`${key} ${value}`);
    }

    // Histograms — exported as Prometheus *summaries*, not histograms.
    // We hold precomputed quantiles (p50/p95/p99), so emitting them as
    // `_bucket{le="0.5"}` was invalid: `le` is a cumulative upper-bound count,
    // and feeding a quantile value into it makes histogram_quantile() return
    // garbage. A summary exposes precomputed quantiles via the `quantile`
    // label, which is exactly what we have. See:
    // https://prometheus.io/docs/concepts/metric_types/#summary
    for (const [key, series] of this.histograms.entries()) {
      const stats = this.getHistogramStats(series.name, series.labels);
      if (stats) {
        const { base, labels } = splitKey(key);
        lines.push(`${base}{${appendLabel(labels, 'quantile', '0.5')}} ${stats.p50}`);
        lines.push(`${base}{${appendLabel(labels, 'quantile', '0.95')}} ${stats.p95}`);
        lines.push(`${base}{${appendLabel(labels, 'quantile', '0.99')}} ${stats.p99}`);
        lines.push(`${base}_sum${labels ? `{${labels}}` : ''} ${stats.sum}`);
        lines.push(`${base}_count${labels ? `{${labels}}` : ''} ${stats.count}`);
      }
    }

    return lines.join('\n') + '\n';
  }

  private makeKey(name: string, labels: Record<string, string>): string {
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    return labelStr ? `${name}{${labelStr}}` : name;
  }
}

/**
 * Global metrics collector instance.
 */
export const metrics = new MetricsCollector();

/**
 * Standard metric names for AI Gateway.
 */
export const METRICS = {
  // Request metrics
  REQUESTS_TOTAL: 'http_requests_total',
  REQUEST_DURATION_MS: 'http_request_duration_ms',
  REQUEST_ERRORS_TOTAL: 'http_request_errors_total',

  // Provider metrics
  PROVIDER_CALLS_TOTAL: 'provider_calls_total',
  PROVIDER_LATENCY_MS: 'provider_latency_ms',
  PROVIDER_ERRORS_TOTAL: 'provider_errors_total',
  PROVIDER_FAILOVERS_TOTAL: 'provider_failovers_total',

  // GPU metrics
  GPU_INSTANCES_ACTIVE: 'gpu_instances_active',
  GPU_BOOT_DURATION_MS: 'gpu_boot_duration_ms',
  GPU_HEALTH_CHECKS_TOTAL: 'gpu_health_checks_total',
  GPU_IDLE_TIMEOUTS_TOTAL: 'gpu_idle_timeouts_total',

  // Pipeline metrics
  PIPELINE_EXECUTIONS_TOTAL: 'pipeline_executions_total',
  PIPELINE_DURATION_MS: 'pipeline_duration_ms',
  PIPELINE_ERRORS_TOTAL: 'pipeline_errors_total',

  // Cost metrics
  COST_TOTAL_USD: 'cost_total_usd',
  COST_PER_REQUEST_USD: 'cost_per_request_usd',
  BUDGET_USAGE_PERCENT: 'budget_usage_percent',

  // System metrics
  MEMORY_USED_MB: 'memory_used_mb',
  CPU_USAGE_PERCENT: 'cpu_usage_percent',
  ACTIVE_CONNECTIONS: 'active_connections',
  QUEUE_DEPTH: 'queue_depth',
} as const;
