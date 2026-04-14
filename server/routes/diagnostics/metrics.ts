/**
 * Metrics and diagnostics routes — observability endpoints
 *
 * Routes:
 *   GET  /metrics                     — Prometheus-compatible metrics
 *   GET  /v1/requests/log             — Request log
 *   GET  /v1/service-stats            — Service statistics
 *   GET  /v1/errors/summary           — Error summary
 *   GET  /v1/errors/alerts            — Error alerts
 *   POST /v1/errors/alerts/acknowledge — Acknowledge alerts
 */

export function registerMetricsRoutes(handlers: Record<string, Function>): void {
  const mt = require('../../metrics');
  const gh = require('../../gpu-handlers');

  Object.assign(handlers, {
    // Metrics
    'GET /v1/requests/log': mt.handleRequestLog,
    'GET /v1/service-stats': mt.handleServiceStats,
    'GET /metrics': mt.handleMetrics,
    // Error summary
    'GET /v1/errors/summary': gh.handleErrorSummary,
    'GET /v1/errors/alerts': gh.handleErrorAlerts,
    'POST /v1/errors/alerts/acknowledge': gh.handleErrorAlerts,
  });
}
