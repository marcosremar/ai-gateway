/**
 * GPU settings routes — latency configuration and host management
 *
 * Routes:
 *   GET   /v1/gpu/latency/settings   — Get latency test settings
 *   PATCH /v1/gpu/latency/settings   — Update latency test settings
 *   POST  /v1/gpu/latency/run        — Trigger manual latency run
 *   PATCH /v1/gpu/latency/hosts      — Update latency host list
 *   GET   /v1/gpu/latency/hosts      — Get host latency data
 *   POST  /v1/gpu/latency/probe      — Probe specific host latency
 */

export function registerGpuSettingsRoutes(handlers: Record<string, Function>): void {
  const gh = require('../../gpu-handlers');

  Object.assign(handlers, {
    'GET /v1/gpu/latency/settings': gh.handleGetLatencySettings,
    'PATCH /v1/gpu/latency/settings': gh.handlePatchLatencySettings,
    'POST /v1/gpu/latency/run': gh.handleTriggerLatencyRun,
    'PATCH /v1/gpu/latency/hosts': gh.handlePatchLatencyHosts,
    'POST /v1/gpu/latency/probe': gh.handleGpuLatencyProbe,
    // GET /v1/gpu/latency/hosts — return host latency data
    'GET /v1/gpu/latency/hosts': async (_req: any, res: any) => {
      try {
        const { getAllHostLatencies } = require('../../latency-db');
        const hosts = await getAllHostLatencies();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hosts }));
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hosts: [] }));
      }
    },
  });
}
