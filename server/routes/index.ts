/**
 * Route modules index — re-exports all route registration modules.
 *
 * Directory structure:
 *   gateway/     — Core AI gateway endpoints (inference, pipeline, GPU, config)
 *   compute/     — Compute resource management (workloads, bots, images)
 *   diagnostics/ — Observability (health, metrics)
 *
 * TODO: Once ws-server.ts is refactored, each module will export a
 * registerRoutes(handlers) function that populates the route table.
 */

// Gateway routes
export * as inference from './gateway/inference';
export * as pipeline from './gateway/pipeline';
export * as gpu from './gateway/gpu';
export * as gpuInfo from './gateway/gpu-info';
export * as gpuSettings from './gateway/gpu-settings';
export * as config from './gateway/config';

// Compute routes
export * as workloads from './compute/workloads';
export * as bots from './compute/bots';
export * as images from './compute/images';

// Diagnostics routes
export * as health from './diagnostics/health';
export * as metrics from './diagnostics/metrics';
