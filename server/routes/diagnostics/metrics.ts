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

  // Observability — turn-latency + turn-records ring buffers
  const obsInit = require('../../observers-init');
  const handleTurnLatency = (_req: unknown, res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body?: string) => void }): void => {
    const items = obsInit.getRecentTurnLatencies();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: items.length, items }));
  };
  const handleTurns = (_req: unknown, res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body?: string) => void }): void => {
    const items = obsInit.getRecentTurns();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: items.length, items }));
  };
  const handleMuteState = (_req: unknown, res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body?: string) => void }): void => {
    const state = obsInit.getMuteState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
  };
  // OTLP exporter status — exposes pending/exported/failed/lastFailure.
  // 200 always when exporter not configured; payload signals enabled=false.
  const handleOtlpStatus = (_req: unknown, res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body?: string) => void }): void => {
    let payload: Record<string, unknown> = { enabled: false };
    try {
      const { getOtlpExporter } = require('../../../src/platform/observability/otlp-exporter');
      const exporter = getOtlpExporter();
      payload = exporter ? { enabled: true, ...exporter.stats() } : { enabled: false };
    } catch (e) {
      payload = { enabled: false, error: e instanceof Error ? e.message : String(e) };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const handleOtlpFlush = async (_req: unknown, res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body?: string) => void }): Promise<void> => {
    let payload: Record<string, unknown>;
    try {
      const { getOtlpExporter } = require('../../../src/platform/observability/otlp-exporter');
      const exporter = getOtlpExporter();
      if (!exporter) {
        res.writeHead(412, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'OTLP exporter not configured (set OTEL_EXPORTER_OTLP_ENDPOINT)' }));
        return;
      }
      payload = await exporter.flush();
    } catch (e) {
      payload = { error: e instanceof Error ? e.message : String(e) };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const handleSetMuteState = async (req: { on: (event: string, cb: (chunk: Buffer | string) => void) => void } & { headers?: Record<string, string | string[] | undefined> }, res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body?: string) => void }): Promise<void> => {
    let body = '';
    await new Promise<void>((resolve) => {
      req.on('data', (chunk: Buffer | string) => { body += chunk.toString(); });
      req.on('end', () => resolve());
    });
    let parsed: { strategy?: string };
    try { parsed = body ? JSON.parse(body) : {}; }
    catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }
    if (!parsed.strategy) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'strategy is required (always_mute_during_bot_speech | mute_until_first_word | never)' }));
      return;
    }
    const result = obsInit.setMuteStrategy(parsed.strategy);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  };

  Object.assign(handlers, {
    // Metrics
    'GET /v1/requests/log': mt.handleRequestLog,
    'GET /v1/service-stats': mt.handleServiceStats,
    'GET /metrics': mt.handleMetrics,
    'GET /v1/observability/turn-latency': handleTurnLatency,
    'GET /v1/observability/turns': handleTurns,
    'GET /v1/observability/mute-state': handleMuteState,
    'POST /v1/observability/mute-state': handleSetMuteState,
    'POST /v1/tools/dispatch': require('../../tools-dispatch-handler').handleToolsDispatch,
    'GET /v1/observability/otlp/status': handleOtlpStatus,
    'POST /v1/observability/otlp/flush': handleOtlpFlush,
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
