/**
 * Grafana Dashboard Configuration for AI Gateway.
 *
 * Fixes: #834 (production monitoring), #835 (alerting configuration)
 *
 * Import this JSON into Grafana to create the dashboard.
 */

export const GRAFANA_DASHBOARD = {
  dashboard: {
    title: 'AI Gateway — Production Monitoring',
    tags: ['ai-gateway', 'production'],
    timezone: 'browser',
    panels: [
      // ── Request Metrics ─────────────────────────────────────────────────────
      {
        title: 'Request Rate (req/min)',
        type: 'graph',
        targets: [{ expr: 'rate(http_requests_total[5m]) * 60' }],
        gridPos: { x: 0, y: 0, w: 12, h: 8 },
      },
      {
        title: 'Error Rate (%)',
        type: 'graph',
        targets: [{ expr: 'rate(http_request_errors_total[5m]) / rate(http_requests_total[5m]) * 100' }],
        gridPos: { x: 12, y: 0, w: 12, h: 8 },
        thresholds: [{ value: 1, color: 'yellow' }, { value: 5, color: 'red' }],
      },

      // ── Latency ─────────────────────────────────────────────────────────────
      {
        title: 'Request Latency (p50, p95, p99)',
        type: 'graph',
        targets: [
          { expr: 'histogram_quantile(0.50, rate(http_request_duration_ms_bucket[5m]))', legend: 'p50' },
          { expr: 'histogram_quantile(0.95, rate(http_request_duration_ms_bucket[5m]))', legend: 'p95' },
          { expr: 'histogram_quantile(0.99, rate(http_request_duration_ms_bucket[5m]))', legend: 'p99' },
        ],
        gridPos: { x: 0, y: 8, w: 24, h: 8 },
      },

      // ── Provider Metrics ────────────────────────────────────────────────────
      {
        title: 'Provider Call Rate',
        type: 'graph',
        targets: [{ expr: 'rate(provider_calls_total[5m])' }],
        gridPos: { x: 0, y: 16, w: 8, h: 8 },
      },
      {
        title: 'Provider Error Rate',
        type: 'graph',
        targets: [{ expr: 'rate(provider_errors_total[5m]) / rate(provider_calls_total[5m]) * 100' }],
        gridPos: { x: 8, y: 16, w: 8, h: 8 },
      },
      {
        title: 'Provider Failover Count',
        type: 'graph',
        targets: [{ expr: 'rate(provider_failovers_total[5m])' }],
        gridPos: { x: 16, y: 16, w: 8, h: 8 },
      },

      // ── GPU Metrics ─────────────────────────────────────────────────────────
      {
        title: 'Active GPU Instances',
        type: 'singlestat',
        targets: [{ expr: 'gpu_instances_active' }],
        gridPos: { x: 0, y: 24, w: 6, h: 4 },
      },
      {
        title: 'GPU Boot Time (p95)',
        type: 'singlestat',
        targets: [{ expr: 'histogram_quantile(0.95, rate(gpu_boot_duration_ms_bucket[5m]))' }],
        gridPos: { x: 6, y: 24, w: 6, h: 4 },
      },
      {
        title: 'GPU Health Checks',
        type: 'graph',
        targets: [{ expr: 'rate(gpu_health_checks_total[5m])' }],
        gridPos: { x: 12, y: 24, w: 6, h: 4 },
      },
      {
        title: 'GPU Idle Timeouts',
        type: 'graph',
        targets: [{ expr: 'rate(gpu_idle_timeouts_total[5m])' }],
        gridPos: { x: 18, y: 24, w: 6, h: 4 },
      },

      // ── Pipeline Metrics ────────────────────────────────────────────────────
      {
        title: 'Pipeline Execution Rate',
        type: 'graph',
        targets: [{ expr: 'rate(pipeline_executions_total[5m])' }],
        gridPos: { x: 0, y: 28, w: 8, h: 8 },
      },
      {
        title: 'Pipeline Latency (p95)',
        type: 'graph',
        targets: [{ expr: 'histogram_quantile(0.95, rate(pipeline_duration_ms_bucket[5m]))' }],
        gridPos: { x: 8, y: 28, w: 8, h: 8 },
      },
      {
        title: 'Pipeline Error Rate',
        type: 'graph',
        targets: [{ expr: 'rate(pipeline_errors_total[5m]) / rate(pipeline_executions_total[5m]) * 100' }],
        gridPos: { x: 16, y: 28, w: 8, h: 8 },
      },

      // ── Cost Metrics ────────────────────────────────────────────────────────
      {
        title: 'Total Cost (USD)',
        type: 'singlestat',
        targets: [{ expr: 'cost_total_usd' }],
        gridPos: { x: 0, y: 36, w: 8, h: 4 },
      },
      {
        title: 'Cost per Request (USD)',
        type: 'singlestat',
        targets: [{ expr: 'cost_per_request_usd' }],
        gridPos: { x: 8, y: 36, w: 8, h: 4 },
      },
      {
        title: 'Budget Usage (%)',
        type: 'gauge',
        targets: [{ expr: 'budget_usage_percent' }],
        gridPos: { x: 16, y: 36, w: 8, h: 4 },
        thresholds: [{ value: 80, color: 'yellow' }, { value: 100, color: 'red' }],
      },

      // ── System Metrics ──────────────────────────────────────────────────────
      {
        title: 'Memory Usage (MB)',
        type: 'graph',
        targets: [{ expr: 'memory_used_mb' }],
        gridPos: { x: 0, y: 40, w: 8, h: 8 },
      },
      {
        title: 'Active Connections',
        type: 'graph',
        targets: [{ expr: 'active_connections' }],
        gridPos: { x: 8, y: 40, w: 8, h: 8 },
      },
      {
        title: 'Queue Depth',
        type: 'graph',
        targets: [{ expr: 'queue_depth' }],
        gridPos: { x: 16, y: 40, w: 8, h: 8 },
      },
    ],

    // ── Alert Rules ───────────────────────────────────────────────────────────
    alerts: [
      {
        name: 'High Error Rate',
        condition: 'rate(http_request_errors_total[5m]) / rate(http_requests_total[5m]) * 100 > 5',
        for: '5m',
        severity: 'critical',
        channel: '#alerts-critical',
      },
      {
        name: 'High Latency (p95)',
        condition: 'histogram_quantile(0.95, rate(http_request_duration_ms_bucket[5m])) > 5000',
        for: '5m',
        severity: 'warning',
        channel: '#alerts-warning',
      },
      {
        name: 'GPU Instance Down',
        condition: 'gpu_instances_active == 0',
        for: '2m',
        severity: 'critical',
        channel: '#alerts-critical',
      },
      {
        name: 'Budget Exceeded',
        condition: 'budget_usage_percent > 100',
        for: '1m',
        severity: 'critical',
        channel: '#alerts-critical',
      },
      {
        name: 'Memory Usage High',
        condition: 'memory_used_mb > 512',
        for: '10m',
        severity: 'warning',
        channel: '#alerts-warning',
      },
      {
        name: 'Provider Failover Spike',
        condition: 'rate(provider_failovers_total[5m]) > 10',
        for: '5m',
        severity: 'warning',
        channel: '#alerts-warning',
      },
    ],
  },
};

// ── Alert-rule accessors (#1000) ──────────────────────────────────────────────
//
// The dashboard ships real Prometheus-style alert rules (error-rate, p95
// latency, GPU-down, budget, memory, failover) wired to the Slack/Discord
// channels the gateway alerts through. These pure accessors make the rules
// queryable (and unit-testable) without re-deriving the structure elsewhere — a
// channel router or `/health` summary can consume `alertsBySeverity` /
// `alertChannels` directly.

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface GrafanaAlertRule {
  name: string;
  condition: string;
  for: string;
  severity: AlertSeverity;
  channel: string;
}

/** All configured alert rules from the dashboard. Pure. */
export function getAlertRules(): GrafanaAlertRule[] {
  return (GRAFANA_DASHBOARD.dashboard.alerts ?? []) as GrafanaAlertRule[];
}

/** Alert rules filtered by severity. Pure. */
export function alertsBySeverity(severity: AlertSeverity): GrafanaAlertRule[] {
  return getAlertRules().filter((a) => a.severity === severity);
}

/** Distinct alert names (handy for asserting coverage of key SLOs). Pure. */
export function alertNames(): string[] {
  return getAlertRules().map((a) => a.name);
}

/** Distinct notification channels referenced by the alert rules. Pure. */
export function alertChannels(): string[] {
  return [...new Set(getAlertRules().map((a) => a.channel))];
}

/** True when at least one alert routes to the given channel. Pure. */
export function hasAlertForChannel(channel: string): boolean {
  return getAlertRules().some((a) => a.channel === channel);
}
