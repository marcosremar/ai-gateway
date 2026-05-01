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

class MetricsCollector {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, MetricSeries>();
  private samples: MetricSample[] = [];
  private maxSamples = 10_000;

  /**
   * Increment a counter.
   */
  increment(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = this.makeKey(name, labels);
    const current = this.counters.get(key) ?? 0;
    this.counters.set(key, current + value);

    this.addSample({ type: 'counter', name, value: current + value, labels, timestamp: new Date().toISOString() });
  }

  /**
   * Set a gauge value.
   */
  gauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.makeKey(name, labels);
    this.gauges.set(key, value);

    this.addSample({ type: 'gauge', name, value, labels, timestamp: new Date().toISOString() });
  }

  /**
   * Record a histogram sample.
   */
  histogram(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.makeKey(name, labels);

    if (!this.histograms.has(key)) {
      this.histograms.set(key, { name, type: 'histogram', samples: [], labels });
    }

    const series = this.histograms.get(key)!;
    series.samples.push(value);

    // Keep only last 1000 samples per series
    if (series.samples.length > 1000) {
      series.samples.shift();
    }

    this.addSample({ type: 'histogram', name, value, labels, timestamp: new Date().toISOString() });
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
      p50: sorted[Math.floor(count * 0.5)],
      p95: sorted[Math.floor(count * 0.95)],
      p99: sorted[Math.floor(count * 0.99)],
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
      recentSamples: this.samples.length,
    };
  }

  /**
   * Reset all metrics.
   */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.samples = [];
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

    // Histograms
    for (const [key, series] of this.histograms.entries()) {
      const stats = this.getHistogramStats(series.name, series.labels);
      if (stats) {
        lines.push(`${key}_count ${stats.count}`);
        lines.push(`${key}_sum ${stats.sum}`);
        lines.push(`${key}_bucket{le="0.5"} ${stats.p50}`);
        lines.push(`${key}_bucket{le="0.95"} ${stats.p95}`);
        lines.push(`${key}_bucket{le="0.99"} ${stats.p99}`);
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

  private addSample(sample: MetricSample): void {
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
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
