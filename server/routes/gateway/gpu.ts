/**
 * GPU lifecycle routes — deploy, stop, resume, terminate, status
 *
 * Routes (currently registered in ws-server.ts):
 *   POST /v1/gpu/deploy              — Deploy GPU pod
 *   GET  /v1/gpu/status              — Current GPU status
 *   POST /v1/gpu/stop                — Stop running pod
 *   POST /v1/gpu/resume              — Resume stopped pod
 *   POST /v1/gpu/terminate           — Terminate pod
 *   GET  /v1/gpu/logs                — Pod logs
 *   GET  /v1/gpu/inspect             — Pod inspection
 *   GET  /v1/gpu/deploy-history      — Deployment history
 *   GET  /v1/gpu/logs/events         — Event logs
 *   GET  /v1/gpu/list                — List active pods
 *   POST /v1/gpu/preflight           — Pre-deploy checks
 *   GET  /v1/gpu/readiness/status    — GPU readiness status
 *   GET  /v1/gpu/readiness/history   — GPU readiness history
 *   POST /v1/gpu/readiness/reset     — Reset readiness state
 *   GET  /v1/gpu/sweep               — Sweep idle pods
 *   GET  /v1/gpu/lifecycle-logs      — Lifecycle event logs
 *   POST /v1/gpu/snapshot            — Create snapshot
 *   GET  /v1/gpu/snapshot            — List snapshots
 *   POST /v1/gpu/snapshot/restore    — Restore snapshot
 *   DELETE /v1/gpu/snapshot           — Delete snapshot
 *   GET  /v1/canary/status           — Canary deploy status
 *   GET  /v1/performance             — Performance stats
 *
 * Vast.ai-specific routes:
 *   GET    /v1/gpu/vast/templates              — List templates
 *   POST   /v1/gpu/vast/templates              — Create template
 *   PUT    /v1/gpu/vast/templates              — Update template
 *   DELETE /v1/gpu/vast/templates              — Delete template
 *   POST   /v1/gpu/vast/templates/find-or-create — Find or create template
 *   GET    /v1/gpu/vast/endpoints              — List endpoints
 *   POST   /v1/gpu/vast/endpoints              — Create endpoint
 *   DELETE /v1/gpu/vast/endpoints              — Delete endpoint
 *   POST   /v1/gpu/vast/endpoints/logs         — Endpoint logs
 *   POST   /v1/gpu/vast/endpoints/route        — Route to endpoint
 *   GET    /v1/gpu/vast/workergroups           — List worker groups
 *   POST   /v1/gpu/vast/workergroups           — Create worker group
 *   PUT    /v1/gpu/vast/workergroups           — Update worker group
 *   DELETE /v1/gpu/vast/workergroups           — Delete worker group
 *
 * TODO: These routes are currently defined in ws-server.ts.
 * This file will own their registration once ws-server.ts is refactored.
 */

export const routes = {};
