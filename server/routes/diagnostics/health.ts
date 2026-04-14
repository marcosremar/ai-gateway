/**
 * Health routes — liveness and readiness probes
 *
 * Routes:
 *   GET /health                       — Liveness probe
 */

export function registerHealthRoutes(handlers: Record<string, Function>): void {
  const gh = require('../../gpu-handlers');

  Object.assign(handlers, {
    'GET /health': gh.handleHealth,
  });
}
