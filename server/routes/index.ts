/**
 * Route modules index — re-exports all route registration functions.
 *
 * Directory structure:
 *   gateway/     — Core AI gateway endpoints (inference, pipeline, GPU, config)
 *   compute/     — Compute resource management (workloads, bots, images)
 *   diagnostics/ — Observability (health, metrics)
 *
 * Usage in ws-server.ts:
 *   import { registerAllRoutes } from './routes';
 *   registerAllRoutes(handlers);
 */

import { registerInferenceRoutes } from './gateway/inference';
import { registerPipelineRoutes } from './gateway/pipeline';
import { registerGpuRoutes } from './gateway/gpu';
import { matchGpuDynamicRoute } from './gateway/gpu';
import { registerGpuInfoRoutes } from './gateway/gpu-info';
import { registerGpuSettingsRoutes } from './gateway/gpu-settings';
import { registerConfigRoutes } from './gateway/config';
import { registerAppRoutes, matchAppDynamicRoute } from './gateway/apps';
import { registerWorkloadRoutes } from './compute/workloads';
import { registerBotRoutes } from './compute/bots';
import { registerImageRoutes, getDockerDynamicMatcher } from './compute/images';
import { registerHealthRoutes } from './diagnostics/health';
import { registerMetricsRoutes } from './diagnostics/metrics';
import { registerToolsRoutes } from './diagnostics/tools';
import {
  handleLightningStatus,
  handleLightningStart,
  handleLightningStop,
  handleLightningSessionStart,
  handleLightningSessionEnd,
} from '../lightning-handlers';

// Re-export individual register functions for selective use
export {
  registerInferenceRoutes,
  registerPipelineRoutes,
  registerGpuRoutes,
  matchGpuDynamicRoute,
  registerGpuInfoRoutes,
  registerGpuSettingsRoutes,
  registerConfigRoutes,
  registerAppRoutes,
  matchAppDynamicRoute,
  registerWorkloadRoutes,
  registerBotRoutes,
  registerImageRoutes,
  getDockerDynamicMatcher,
  registerHealthRoutes,
  registerMetricsRoutes,
  registerToolsRoutes,
};

/**
 * Register all HTTP routes into the handler map.
 * Called by ws-server.ts to populate the flat route table.
 */
export function registerAllRoutes(handlers: Record<string, Function>): void {
  // Gateway
  registerGpuRoutes(handlers);
  registerGpuInfoRoutes(handlers);
  registerGpuSettingsRoutes(handlers);
  registerConfigRoutes(handlers);
  registerAppRoutes(handlers);
  registerInferenceRoutes(handlers);

  // Compute
  registerBotRoutes(handlers);
  registerImageRoutes(handlers);
  registerWorkloadRoutes(handlers);

  // Diagnostics
  registerHealthRoutes(handlers);
  registerMetricsRoutes(handlers);
  registerToolsRoutes(handlers);

  // Pipeline (WebSocket — no HTTP routes)
  registerPipelineRoutes(handlers);

  // Lightning AI studio
  handlers['GET /v1/lightning/status'] = handleLightningStatus;
  handlers['POST /v1/lightning/start'] = handleLightningStart;
  handlers['POST /v1/lightning/stop'] = handleLightningStop;
  handlers['POST /v1/lightning/session/start'] = handleLightningSessionStart;
  handlers['POST /v1/lightning/session/end'] = handleLightningSessionEnd;
}

export function getGpuDynamicMatcher(): typeof matchGpuDynamicRoute {
  return matchGpuDynamicRoute;
}

export function getAppDynamicMatcher(): typeof matchAppDynamicRoute {
  return matchAppDynamicRoute;
}
