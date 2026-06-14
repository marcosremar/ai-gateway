/**
 * Framework-free navigation helpers (#936, #961).
 *
 * Cross-section navigation was hand-dispatched in several components via raw
 * `window.history.pushState` + `new PopStateEvent('popstate')`, each easy to
 * desync with `getRouteFromPath`. These pure functions hold the route-resolution
 * and URL-building logic so the React layer is a thin wrapper and the logic is
 * unit-testable without jsdom.
 */

/** Renamed/removed pages → their current canonical route. */
export const ROUTE_REDIRECTS: Record<string, string> = {
  'config/profiles': 'config/apps',
  'config/providers': 'config/apps',
  'config/deploy': 'config/apps',
  'tools/pipeline': 'tools/playground',
  'tools/pathbench': 'config/apps',
};

/** Strip a leading `#/` or `#` from a hash fragment. Pure. */
export function normalizeHash(hash: string): string {
  return hash.replace(/^#\//, '').replace(/^#/, '');
}

/** Strip leading/trailing slashes from a pathname. Pure. */
export function normalizePathname(pathname: string): string {
  return pathname.replace(/^\//, '').replace(/\/$/, '');
}

/**
 * Resolve the active route from a pathname + hash given the set of valid routes.
 *
 * Resolution order (matching the previous inline `getRouteFromPath`):
 *  1. exact hash match (`/#/config/providers`)
 *  2. exact pathname match
 *  3. explicit redirect of a removed/renamed page
 *  4. nested sub-route prefix match (`config/apps/edit/x` → `config/apps`)
 *  5. fallback to `overview`
 *
 * Pure — no `window` access; callers inject `location.pathname`/`location.hash`.
 */
export function resolveRoute(
  pathname: string,
  hash: string,
  validRoutes: ReadonlySet<string>,
  fallback = 'overview',
): string {
  const h = normalizeHash(hash);
  if (h && validRoutes.has(h)) return h;

  const path = normalizePathname(pathname);
  if (validRoutes.has(path)) return path;

  const redirect = ROUTE_REDIRECTS[path];
  if (redirect && validRoutes.has(redirect)) return redirect;

  for (const route of validRoutes) {
    if (path.startsWith(route + '/')) return route;
  }
  return fallback;
}

/** Build the clean URL path for a route id (`overview` → `/`). Pure. */
export function routeToPath(routeId: string): string {
  return routeId === 'overview' ? '/' : `/${routeId}`;
}

/**
 * Push a raw URL path and notify the in-app router (#936).
 *
 * Replaces the duplicated `window.history.pushState(...) +
 * new PopStateEvent('popstate')` pattern scattered across sections. The
 * `Dashboard` listens for `popstate`, so dispatching it re-runs
 * `getRouteFromPath` and keeps `activeTab` in sync. No-op outside the browser.
 */
export function navigateToPath(path: string): void {
  if (typeof window === 'undefined') return;
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
