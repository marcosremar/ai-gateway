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
 *   POST /v1/benchmark/paths          — Full path benchmark
 *   POST /v1/benchmark/realtime       — Realtime TTFC benchmark
 *   GET  /v1/diagnostics/scores       — Diagnostic scorecard
 */

export function registerMetricsRoutes(handlers: Record<string, Function>): void {
  const mt = require('../../metrics');
  const gh = require('../../gpu-handlers');
  const ah = require('../../agent-handlers');
  const bh = require('../../benchmark-handlers');
  const dh = require('../../diagnostics-handlers');

  Object.assign(handlers, {
    // Metrics
    'GET /v1/requests/log': mt.handleRequestLog,
    'GET /v1/service-stats': mt.handleServiceStats,
    'GET /metrics': mt.handleMetrics,
    // Error summary
    'GET /v1/errors/summary': gh.handleErrorSummary,
    'GET /v1/errors/alerts': gh.handleErrorAlerts,
    'POST /v1/errors/alerts/acknowledge': gh.handleErrorAlerts,
    // Pod agent telemetry (heartbeat from aigw_agent.py provisioned in each pod)
    'POST /v1/agent/heartbeat': ah.handleAgentHeartbeat,
    'GET /v1/agent/state': ah.handleAgentState,
    // Operator diagnostics and benchmarks
    'POST /v1/benchmark/paths': bh.handleBenchmarkPaths,
    'POST /v1/benchmark/realtime': bh.handleRealtimeTTFCBenchmark,
    'GET /v1/diagnostics/scores': dh.handleDiagnosticsScores,
    'POST /v1/diagnostics/cleanup': dh.handleDiagnosticsCleanup,
    'POST /v1/diagnostics/benchmark': dh.handleDiagnosticsBenchmark,
  });
}
