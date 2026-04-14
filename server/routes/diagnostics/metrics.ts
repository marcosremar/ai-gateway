/**
 * Metrics and diagnostics routes — observability endpoints
 *
 * Routes (currently registered in ws-server.ts):
 *   GET  /metrics                     — Prometheus-compatible metrics
 *   GET  /v1/requests/log             — Request log
 *   GET  /v1/service-stats            — Service statistics
 *   GET  /v1/errors/summary           — Error summary
 *   GET  /v1/errors/alerts            — Error alerts
 *   POST /v1/errors/alerts/acknowledge — Acknowledge alerts
 *   GET  /v1/diagnostics/scores       — Diagnostic scores
 *   POST /v1/diagnostics/cleanup      — Cleanup diagnostics
 *   POST /v1/diagnostics/benchmark    — Run diagnostics benchmark
 *
 * TODO: These routes are currently defined in ws-server.ts.
 * This file will own their registration once ws-server.ts is refactored.
 */

export const routes = {};
