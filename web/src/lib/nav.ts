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

// ── Sidebar nav-item helpers (#935) ───────────────────────────────────────────
//
// Divider nav entries used to carry a meaningless `icon: LayoutDashboard` even
// though the Sidebar never renders an icon for dividers — dead, misleading
// config. These predicates make the divider-vs-link distinction explicit and
// are used to derive the valid-route set without relying on an icon being set.

/** Minimal shape of a sidebar entry for routing/predicate logic. Pure-data. */
export interface NavItemLike {
  id: string;
  divider?: boolean;
}

/** True when a nav item is a section divider (not a navigable link). Pure. */
export function isNavSection(item: NavItemLike): boolean {
  return item.divider === true;
}

/** True when a nav item is a navigable link (has a real route). Pure. */
export function isNavLink(item: NavItemLike): boolean {
  return item.divider !== true;
}

/** Collect the set of valid route ids (link items only) from a nav list. Pure. */
export function validRoutesFromNav(items: ReadonlyArray<NavItemLike>): Set<string> {
  return new Set(items.filter(isNavLink).map((item) => item.id));
}

// ── Static-export route constraint (#963) ─────────────────────────────────────
//
// The `[...slug]` catch-all pre-renders one HTML shell per route under
// `output: 'export'`. The slug list was a hand-maintained array inline in the
// page, easy to drift from the real nav/redirect set and capable of exploding
// the export if widened carelessly. Centralizing it here gives one source of
// truth and lets `generateStaticParams` be derived + unit-tested.

/**
 * The explicit, bounded set of client routes that get their own pre-rendered
 * HTML file in the static export. Deliberately a closed allow-list (NOT derived
 * from every nav id) so the export can't explode and unknown deep links still
 * fall back to the SPA's `index.html`. Includes legacy-compat routes that
 * `ROUTE_REDIRECTS` maps to live pages so a direct refresh of an old URL works.
 */
export const STATIC_EXPORT_ROUTES: readonly string[] = [
  // Dashboard root
  'dashboard',
  // Config
  'config/services',
  'config/apps',
  'config/apps/new',
  'config/guardrails',
  'config/api-keys',
  'config/labs',
  'config/vast-serverless',
  // Legacy compat (kept routable via ROUTE_REDIRECTS)
  'config/profiles',
  'config/profiles/new',
  // Tools
  'tools/playground',
  'tools/bot',
  'tools/auto-swap',
  'tools/standby',
  // Monitor
  'monitor/latency',
  'monitor/reputation',
  'monitor/logs',
  'monitor/readiness',
];

/**
 * Build the Next `generateStaticParams` payload from the bounded route list:
 * each `a/b/c` route → `{ slug: ['a','b','c'] }`. Pure; exported for tests so the
 * static-export surface is verifiable without a Next build. Empty/whitespace
 * routes are dropped so a stray entry can't emit a `{ slug: [] }` (which would
 * collide with the index route).
 */
export function staticSlugParams(
  routes: readonly string[] = STATIC_EXPORT_ROUTES,
): Array<{ slug: string[] }> {
  return routes
    .map((r) => r.split('/').map((s) => s.trim()).filter(Boolean))
    .filter((slug) => slug.length > 0)
    .map((slug) => ({ slug }));
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
