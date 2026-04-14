/**
 * Workload routes — unified workload CRUD lifecycle
 *
 * Routes (currently registered in ws-server.ts via routeWorkloadRequest):
 *   GET    /v1/workloads              — List all workloads
 *   POST   /v1/workloads              — Deploy workload { name, type, config }
 *   GET    /v1/workloads/:id          — Get workload status
 *   POST   /v1/workloads/:id/stop     — Stop workload
 *   POST   /v1/workloads/:id/start    — Start / resume workload
 *   DELETE /v1/workloads/:id          — Terminate workload
 *
 * TODO: These routes are currently defined in ws-server.ts (dynamic routing).
 * This file will own their registration once ws-server.ts is refactored.
 */

export const routes = {};
