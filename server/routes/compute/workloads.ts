/**
 * Workload routes — unified workload CRUD lifecycle
 *
 * Routes (dynamic routing via routeWorkloadRequest):
 *   GET    /v1/workloads              — List all workloads
 *   POST   /v1/workloads              — Deploy workload { name, type, config }
 *   GET    /v1/workloads/:id          — Get workload status
 *   POST   /v1/workloads/:id/stop     — Stop workload
 *   POST   /v1/workloads/:id/start    — Start / resume workload
 *   DELETE /v1/workloads/:id          — Terminate workload
 *
 * Note: Workload routes use dynamic :id segments and are handled via
 * routeWorkloadRequest() before the flat handler lookup in ws-server.ts.
 * They are initialized in ws-server.ts alongside the workload registry
 * drivers (gpu, bot, db). This file exists as a documentation placeholder.
 */

// Workload routes use dynamic routing (routeWorkloadRequest) — no flat handler registration.
export function registerWorkloadRoutes(_handlers: Record<string, Function>): void {
  // Dynamic routing handled by ws-server.ts — see routeWorkloadRequest
}
