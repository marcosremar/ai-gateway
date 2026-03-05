/**
 * Declarative Fallback Chains — config-driven provider ordering per pipeline stage.
 *
 * Allows defining fallback chains declaratively in the AutoScalerConfig or
 * AIProfile, with per-chain options (cooldown, retries, timeout).
 *
 * Example config:
 * ```ts
 * fallbackChains: [{
 *   stage: 'llm',
 *   chain: [
 *     { provider: 'groq', model: 'llama-3.3-70b-versatile', priority: 1 },
 *     { provider: 'openai', model: 'gpt-4o-mini', priority: 2 },
 *     { provider: 'openai', model: 'gpt-4o', priority: 3 },
 *   ],
 *   retriesPerProvider: 1,
 *   timeoutMs: 10_000,
 * }]
 * ```
 */

import type { FallbackEntry, FallbackOptions } from './fallback';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FallbackChainEntry {
  provider: string;
  model?: string;
  /** Lower number = higher priority. Default: 0 */
  priority?: number;
}

export interface FallbackChainConfig {
  /** Pipeline stage this chain applies to */
  stage: 'stt' | 'llm' | 'tts' | 'image' | 'omni' | 'realtime';
  /** Ordered chain of providers to try */
  chain: FallbackChainEntry[];
  /** Cooldown in ms after a provider fails (per-chain override) */
  cooldownMs?: number;
  /** Retries per provider before moving to next (per-chain override) */
  retriesPerProvider?: number;
  /** Timeout per attempt in ms (per-chain override) */
  timeoutMs?: number;
}

// ── Resolver ──────────────────────────────────────────────────────────────────

export interface ResolvedChain {
  chain: FallbackEntry[];
  options: Partial<FallbackOptions>;
}

/**
 * Resolve a declarative fallback chain config into a FallbackEntry array
 * compatible with `withProviderFallback()`.
 *
 * Entries are sorted by priority (ascending). Per-chain options are mapped
 * to FallbackOptions fields.
 */
export function resolveDeclarativeChain(config: FallbackChainConfig): ResolvedChain {
  // Sort by priority (lower = first), stable sort
  const sorted = [...config.chain].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  const chain: FallbackEntry[] = sorted.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
  }));

  const options: Partial<FallbackOptions> = {};
  if (config.cooldownMs !== undefined) options.cooldownMs = config.cooldownMs;
  if (config.retriesPerProvider !== undefined) options.retriesPerProvider = config.retriesPerProvider;
  if (config.timeoutMs !== undefined) options.timeoutMs = config.timeoutMs;

  return { chain, options };
}

/**
 * Find a declarative chain for a specific stage from an array of configs.
 * Returns undefined if no chain is configured for that stage.
 */
export function findChainForStage(
  chains: FallbackChainConfig[] | undefined,
  stage: 'stt' | 'llm' | 'tts' | 'image' | 'omni' | 'realtime',
): FallbackChainConfig | undefined {
  if (!chains || chains.length === 0) return undefined;
  return chains.find((c) => c.stage === stage);
}
