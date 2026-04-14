/**
 * GPU info routes — catalog, offers, compatibility, reputation
 *
 * Routes (currently registered in ws-server.ts):
 *   GET /v1/gpu/types                — Available GPU types
 *   GET /v1/gpu/catalog              — Full GPU catalog
 *   GET /v1/gpu/offers               — Current market offers
 *   GET /v1/gpu/compatibility        — GPU compatibility matrix
 *   GET /v1/gpu/reputation           — Provider reputation scores
 *   GET /v1/gpu/my-location          — Client geolocation
 *
 * TODO: These routes are currently defined in ws-server.ts.
 * This file will own their registration once ws-server.ts is refactored.
 */

export const routes = {};
