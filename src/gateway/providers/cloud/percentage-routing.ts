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
}

/**
 * Select a route based on percentage allocation.
 * Uses consistent hashing to ensure the same hashKey always gets the same route
 * (unless sticky is false, then it uses weighted random).
 */
export function selectPercentageRoute(options: PercentageRoutingOptions): PercentageRoute | null {
  const { routes, hashKey, seed, sticky = true } = options;
  
  if (routes.length === 0) return null;

  if (!sticky) return selectRandomRoute(routes);
  
  // Generate deterministic number from hashKey
  const hash = createHash('sha256')
    .update(seed ?? hashKey)
    .digest();
  
  // Use first 2 bytes for 0-100 range
  const hashValue = (hash[0] << 8) | hash[1];
  const percentage = (hashValue / 65535) * 100;
  
  // Find which route this percentage maps to
  let cumulative = 0;
  for (const route of routes) {
    cumulative += route.percentage;
    if (percentage <= cumulative) {
      return route;
    }
  }
  
  // If percentages don't sum to 100, could fall through to last route
  // or return null if there's an "other" catch-all
  
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
 * Build percentage routes from config array
 */
export function buildPercentageRoutes(
  config: Array<{ provider: string; model?: string; weight: number }>
): PercentageRoute[] {
  return config.map(c => ({
    provider: c.provider,
    model: c.model,
    percentage: c.weight,
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
