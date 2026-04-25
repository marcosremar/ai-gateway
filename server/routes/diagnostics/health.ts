/**
 * Health routes — liveness and readiness probes
 *
 * Routes:
 *   GET /health                       — Liveness probe
 *   HEAD /health                      — Lightweight liveness probe
 */

export function registerHealthRoutes(handlers: Record<string, Function>): void {
  const gh = require('../../gpu-handlers');

  Object.assign(handlers, {
    'GET /health': gh.handleHealth,
    'HEAD /health': (_req: any, res: any) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end();
    },
  });
}
