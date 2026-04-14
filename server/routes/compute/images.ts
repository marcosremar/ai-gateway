/**
 * Docker image builder routes — GitHub OAuth + GHCR via Actions
 *
 * Routes (currently registered in ws-server.ts via getDockerRoutes):
 *   POST   /v1/docker/auth                — Start GitHub OAuth device flow
 *   GET    /v1/docker/auth/status         — Poll device flow status
 *   GET    /v1/docker/auth/me             — Current GitHub user
 *   DELETE /v1/docker/auth                — Revoke / log out
 *   POST   /v1/docker/build               — Start a Docker image build
 *   GET    /v1/docker/builds              — List all builds
 *   GET    /v1/docker/builds/:id          — Get build status (dynamic)
 *   GET    /v1/docker/images              — List successfully built images
 *
 * TODO: These routes are currently defined in ws-server.ts (via image-build-handlers.ts).
 * This file will own their registration once ws-server.ts is refactored.
 */

export const routes = {};
