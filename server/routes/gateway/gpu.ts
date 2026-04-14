/**
 * GPU lifecycle routes — deploy, stop, resume, terminate, status
 *
 * Routes:
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
 *   POST /v1/gpu/snapshot            — Create snapshot
 *   GET  /v1/gpu/snapshot            — List snapshots
 *   POST /v1/gpu/snapshot/restore    — Restore snapshot
 *   DELETE /v1/gpu/snapshot           — Delete snapshot
 *   GET  /v1/gpu/sweep               — Sweep idle pods
 *   GET  /v1/gpu/lifecycle-logs      — Lifecycle event logs
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
 */

import { createLogger } from '../../../src/logger';
const log = createLogger('routes/gpu');

export function registerGpuRoutes(handlers: Record<string, Function>): void {
  const gh = require('../../gpu-handlers');

  Object.assign(handlers, {
    'POST /v1/gpu/deploy': gh.handleGpuDeploy,
    'GET /v1/gpu/status': gh.handleGpuStatus,
    'POST /v1/gpu/stop': gh.handleGpuStop,
    'POST /v1/gpu/resume': gh.handleGpuResume,
    'POST /v1/gpu/terminate': gh.handleGpuTerminate,
    'GET /v1/gpu/logs': gh.handleGpuLogs,
    'GET /v1/gpu/inspect': gh.handleGpuInspect,
    'GET /v1/gpu/deploy-history': gh.handleGpuDeployHistory,
    'GET /v1/gpu/logs/events': gh.handleGpuEventLogs,
    'GET /v1/gpu/list': gh.handleGpuList,
    'POST /v1/gpu/preflight': gh.handlePreflightCheck,
    'GET /v1/gpu/readiness/status': gh.handleGetGpuReadinessStatus,
    'GET /v1/gpu/readiness/history': gh.handleGetGpuReadinessHistory,
    'POST /v1/gpu/readiness/reset': gh.handlePostResetReadiness,
    // SnapGPU snapshot CRUD (proxied to the snapgpu-gateway in the GPU pod)
    'POST /v1/gpu/snapshot': gh.handleSnapshotCreate,
    'GET /v1/gpu/snapshot': gh.handleSnapshotList,
    'POST /v1/gpu/snapshot/restore': gh.handleSnapshotRestore,
    'DELETE /v1/gpu/snapshot': gh.handleSnapshotDelete,
    // Canary deployment status
    'GET /v1/canary/status': gh.handleCanaryStatus,
    // Performance profiling
    'GET /v1/performance': gh.handlePerformanceStats,
    // GPU sweep
    'GET /v1/gpu/sweep': async (_req: any, res: any) => {
      try {
        const { sweepAllProviders } = await import('../../../src/autoscaler/gpu-sweep');
        const report = await sweepAllProviders();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report));
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    },
    // GPU lifecycle logs
    'GET /v1/gpu/lifecycle-logs': async (req: any, res: any) => {
      try {
        const { readRecentLogs } = await import('../../../src/autoscaler/file-lifecycle-logger');
        const url = new URL(req.url, 'http://localhost');
        const lines = parseInt(url.searchParams.get('lines') || '100', 10);
        const logs = readRecentLogs(Math.min(lines, 1000));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(logs));
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    },
  });

  // Vast.ai template + serverless routes
  try {
    const vgh = require('../../gpu-handlers-vast');
    Object.assign(handlers, {
      // Templates
      'GET /v1/gpu/vast/templates': vgh.handleVastTemplates,
      'POST /v1/gpu/vast/templates': vgh.handleVastTemplateCreate,
      'PUT /v1/gpu/vast/templates': vgh.handleVastTemplateUpdate,
      'DELETE /v1/gpu/vast/templates': vgh.handleVastTemplateDelete,
      'POST /v1/gpu/vast/templates/find-or-create': vgh.handleVastTemplateFindOrCreate,
      // Serverless endpoints
      'GET /v1/gpu/vast/endpoints': vgh.handleVastEndpoints,
      'POST /v1/gpu/vast/endpoints': vgh.handleVastEndpointCreate,
      'DELETE /v1/gpu/vast/endpoints': vgh.handleVastEndpointDelete,
      'POST /v1/gpu/vast/endpoints/logs': vgh.handleVastEndpointLogs,
      'POST /v1/gpu/vast/endpoints/route': vgh.handleVastEndpointRoute,
      // Worker groups
      'GET /v1/gpu/vast/workergroups': vgh.handleVastWorkerGroups,
      'POST /v1/gpu/vast/workergroups': vgh.handleVastWorkerGroupCreate,
      'PUT /v1/gpu/vast/workergroups': vgh.handleVastWorkerGroupUpdate,
      'DELETE /v1/gpu/vast/workergroups': vgh.handleVastWorkerGroupDelete,
    });
  } catch (e: any) {
    log.warn(`[routes/gpu] Vast.ai handlers not loaded: ${e.message?.slice(0, 80)}`);
  }
}
