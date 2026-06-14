/**
 * Percentage-based routing for A/B testing and gradual rollouts.
 * 
 * Enables routing a percentage of traffic to different providers/models.
 * Useful for:
 * - A/B testing new models
 * - Gradual rollouts (10% → 50% → 100%)
 * - Feature flags
 * - Canary deployments
 */

import { createHash } from 'crypto';

export interface PercentageRoute {
  provider: string;
  model?: string;
  percentage: number; // 0-100
  /** Optional endpoint override */
  endpoint?: string;
  /** Metadata for tracking */
  metadata?: Record<string, unknown>;
}

export interface PercentageRoutingOptions {
  /** Route configuration */
  routes: PercentageRoute[];
  /** Deterministic hashing key (e.g., user ID, session ID) */
  hashKey: string;
  /** Seed for randomization (optional, defaults to hashKey) */
  seed?: string;
  /** Enable sticky sessions (same hashKey always goes to same route) */
  sticky?: boolean;
  /**
   * Optional availability filter. Routes whose provider returns `false`
   * (credit-blocked, cooling down, circuit-open) are excluded before
   * selection so traffic isn't wasted on a doomed provider (#360).
   */
  isAvailable?: (route: PercentageRoute) => boolean;
}

/**
 * Normalize route weights so they sum to exactly 100. If the configured
 * percentages sum to <100 the leftover would always bias the last route, and
 * if they sum to >100 later routes become unreachable; scaling each weight by
 * `100 / total` removes that skew while preserving relative proportions (#358).
 * Returns a new array; the input is not mutated. Zero/negative totals are
 * returned unchanged (caller decides what to do with an empty allocation).
 */
export function normalizeRouteWeights(routes: PercentageRoute[]): PercentageRoute[] {
  const total = routes.reduce((sum, r) => sum + Math.max(0, r.percentage), 0);
  if (total <= 0) return routes.map((r) => ({ ...r }));
  const scale = 100 / total;
  return routes.map((r) => ({ ...r, percentage: Math.max(0, r.percentage) * scale }));
}

/**
 * Select a route based on percentage allocation.
 * Uses consistent hashing to ensure the same hashKey always gets the same route
 * (unless sticky is false, then it uses weighted random).
 */
export function selectPercentageRoute(options: PercentageRoutingOptions): PercentageRoute | null {
  const { hashKey, seed, sticky = true, isAvailable } = options;

  // Filter to available providers first (#360) so a sticky bucket never lands
  // on a credit-blocked / cooling-down route.
  const candidates = isAvailable ? options.routes.filter(isAvailable) : options.routes;
  if (candidates.length === 0) return null;

  if (!sticky) return selectRandomRoute(candidates);

  // Normalize weights to a 100 total so a partial/over allocation doesn't skew
  // the distribution toward the last (or unreachable) route (#358).
  const routes = normalizeRouteWeights(candidates);

  // Generate deterministic number from hashKey. Use 4 bytes (32-bit) instead of
  // 2 (#359): 16 bits only gives ~1/65535 granularity which is lossy for fine
  // splits (e.g. a 0.1% canary). 32 bits is smooth to ~1e-7.
  const hash = createHash('sha256')
    .update(seed ?? hashKey)
    .digest();

  const hashValue = ((hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]) >>> 0;
  const percentage = (hashValue / 0xffffffff) * 100;

  // Find which route this percentage maps to
  let cumulative = 0;
  for (const route of routes) {
    cumulative += route.percentage;
    if (percentage <= cumulative) {
      return route;
    }
  }

  // Floating-point dust at the very top of the range (percentage ≈ 100) can
  // slip past the cumulative compare — fall through to the last route.
  return routes[routes.length - 1] || null;
}

/**
 * Select a route with random distribution (non-sticky).
 * Each call can return different route based on weights.
 */
export function selectRandomRoute(routes: PercentageRoute[]): PercentageRoute | null {
  if (routes.length === 0) return null;
  
  const totalPercentage = routes.reduce((sum, r) => sum + r.percentage, 0);
  const random = Math.random() * totalPercentage;
  
  let cumulative = 0;
  for (const route of routes) {
    cumulative += route.percentage;
    if (random <= cumulative) {
      return route;
    }
  }
  
  return routes[routes.length - 1];
}

/**
 * Build percentage routes from a config array.
 *
 * Preserves the optional `endpoint` and `metadata` fields (#361) so
 * distributed-profile A/B tests can target specific pods, not just a
 * provider/model pair.
 */
export function buildPercentageRoutes(
  config: Array<{ provider: string; model?: string; weight: number; endpoint?: string; metadata?: Record<string, unknown> }>
): PercentageRoute[] {
  return config.map(c => ({
    provider: c.provider,
    model: c.model,
    percentage: c.weight,
    ...(c.endpoint !== undefined && { endpoint: c.endpoint }),
    ...(c.metadata !== undefined && { metadata: c.metadata }),
  }));
}

/**
 * Example usage:
 * 
 * // A/B test: 80% Groq, 20% OpenAI
 * const route = selectPercentageRoute({
 *   routes: [
 *     { provider: 'groq', percentage: 80 },
 *     { provider: 'openai', percentage: 20 },
 *   ],
 *   hashKey: userId,  // Same user always gets same route
 * });
 * 
 * // Gradual rollout: start with 10%
 * const route = selectPercentageRoute({
 *   routes: [
 *     { provider: 'groq', percentage: 10, model: 'llama-3.3-70b-versatile' },
 *     { provider: 'groq', percentage: 90, model: 'llama-3.1-8b-instant' },
 *   ],
 *   hashKey: sessionId,
 * });
 */
