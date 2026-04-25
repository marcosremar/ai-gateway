/**
 * Docker image builder routes — GitHub OAuth + GHCR via Actions
 *
 * Routes (flat):
 *   POST   /v1/docker/auth                — Start GitHub OAuth device flow
 *   GET    /v1/docker/auth/status         — Poll device flow status
 *   GET    /v1/docker/auth/me             — Current GitHub user
 *   DELETE /v1/docker/auth                — Revoke / log out
 *   POST   /v1/docker/build               — Start a Docker image build
 *   GET    /v1/docker/builds              — List all builds
 *   GET    /v1/docker/images              — List successfully built images
 *
 * Dynamic routes (handled separately from flat lookup):
 *   GET    /v1/docker/builds/:id          — Get build status
 *
 * Note: Dynamic docker routes (/v1/docker/builds/:id) still need special
 * handling in ws-server.ts via matchDockerDynamicRoute. This function only
 * registers the flat (non-parameterized) routes.
 */

import { createLogger } from '../../../src/logger';
const log = createLogger('routes/images');

/** Register flat docker routes into the handler map. */
export function registerImageRoutes(handlers: Record<string, Function>): void {
  try {
    const ib = require('../../image-build-handlers');
    const dockerRoutes: Record<string, Function> = ib.getDockerRoutes();
    Object.assign(handlers, dockerRoutes);
    const di = require('../../docker-inspect');
    Object.assign(handlers, {
      'GET /v1/docker/inspect': di.handleDockerInspect,
      'POST /v1/docker/inspect': di.handleDockerInspect,
      'GET /v1/docker-inspect': di.handleDockerInspect,
      'POST /v1/docker-inspect': di.handleDockerInspect,
    });
  } catch (e: any) {
    log.warn(`[routes/images] image-build-handlers not loaded: ${e.message?.slice(0, 80)}`);
  }
}

/**
 * Get the dynamic route matcher for docker routes (e.g. /v1/docker/builds/:id).
 * Returns null if image-build-handlers is not available.
 */
export function getDockerDynamicMatcher(): ((method: string, pathname: string) => [Function, string[]] | null) | null {
  try {
    const ib = require('../../image-build-handlers');
    return ib.matchDockerDynamicRoute || null;
  } catch {
    return null;
  }
}
