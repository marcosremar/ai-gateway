/**
 * GPU settings routes — latency configuration and host management
 *
 * Routes (currently registered in ws-server.ts):
 *   GET   /v1/gpu/latency/settings   — Get latency test settings
 *   PATCH /v1/gpu/latency/settings   — Update latency test settings
 *   POST  /v1/gpu/latency/run        — Trigger manual latency run
 *   PATCH /v1/gpu/latency/hosts      — Update latency host list
 *   GET   /v1/gpu/latency/hosts      — Get host latency data
 *   POST  /v1/gpu/latency/probe      — Probe specific host latency
 *
 * TODO: These routes are currently defined in ws-server.ts.
 * This file will own their registration once ws-server.ts is refactored.
 */

export const routes = {};
