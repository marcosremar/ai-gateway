/**
 * App registry routes — runtime image/app declarations.
 *
 * Routes:
 *   GET    /v1/apps
 *   POST   /v1/apps
 *   GET    /v1/apps/:name
 *   DELETE /v1/apps/:name
 */

export function registerAppRoutes(handlers: Record<string, Function>): void {
  const ah = require('../../app-registry-handlers');

  Object.assign(handlers, {
    'GET /v1/apps': ah.handleAppsList,
    'POST /v1/apps': ah.handleAppsRegister,
  });
}

export function matchAppDynamicRoute(method: string, pathname: string): [Function, string[]] | null {
  const match = pathname.match(/^\/v1\/apps\/([^/]+)$/);
  if (!match) return null;

  const name = decodeURIComponent(match[1]);
  const upper = method.toUpperCase();
  const ah = require('../../app-registry-handlers');

  if (upper === 'GET') return [ah.handleAppsGet, [name]];
  if (upper === 'DELETE') return [ah.handleAppsDelete, [name]];
  return null;
}
