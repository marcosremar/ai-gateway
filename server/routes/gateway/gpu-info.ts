/**
 * GPU info routes — catalog, offers, compatibility, reputation
 *
 * Routes:
 *   GET /v1/gpu/offers               — Current market offers
 *   GET /v1/gpu/types                — Available GPU types
 *   GET /v1/gpu/catalog              — Full GPU catalog
 *   GET /v1/gpu/compatibility        — GPU compatibility matrix
 *   GET /v1/gpu/reputation           — Provider reputation scores
 *   GET /v1/gpu/my-location          — Client geolocation
 */

export function registerGpuInfoRoutes(handlers: Record<string, Function>): void {
  const gh = require('../../gpu-handlers');

  Object.assign(handlers, {
    'GET /v1/gpu/offers': gh.handleGpuOffers,
    'GET /v1/gpu/types': gh.handleGpuTypes,
    'GET /v1/gpu/catalog': gh.handleGpuCatalog,
    'GET /v1/gpu/compatibility': gh.handleGpuCompatibility,
    'GET /v1/gpu/reputation': gh.handleGpuReputation,
    'GET /v1/gpu/my-location': gh.handleGpuMyLocation,
  });
}
