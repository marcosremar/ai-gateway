/**
 * Chain Diversifier — Auto-Diversification of Fallback Chains
 *
 * Pure function that runs at chain-build time (zero per-request overhead).
 * Checks if all entries in a fallback chain are from the same provider,
 * and if so, auto-injects a backup from a different provider at the end.
 *
 * This ensures resilience: if a provider goes down, the fallback chain
 * has at least one entry from a different provider family.
 */

import type { FallbackEntry } from './fallback';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface DiversifyConfig {
  /** Whether auto-diversification is enabled. Default: true */
  enabled?: boolean;
  /** Minimum distinct provider IDs required in the chain. Default: 2 */
  minFamilies?: number;
  /** Custom backup entries per stage, overriding DEFAULT_BACKUPS */
  backupEntries?: Partial<Record<string, FallbackEntry[]>>;
  /**
   * Where to inject the cross-family backup(s). Default `'tail'` keeps the
   * historical behaviour (appended last). `'early'` inserts the backup right
   * after the primary (index 1) so true family diversity is reached earlier in
   * the chain — otherwise the only different-provider entry is reached
   * worst-case last, after every same-family entry has failed (#313).
   */
  insertPosition?: 'tail' | 'early';
}

// ---------------------------------------------------------------------------
// Default Backup Entries
// ---------------------------------------------------------------------------

/** Default backup entries per pipeline stage (used when no custom backups configured) */
const DEFAULT_BACKUPS: Record<string, FallbackEntry[]> = {
  stt: [
    { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
    { provider: 'groq', model: 'whisper-large-v3-turbo' },
    { provider: 'deepgram', model: 'nova-3' },
  ],
  llm: [
    { provider: 'openai', model: 'gpt-4o-mini' },
    { provider: 'groq', model: 'llama-3.3-70b-versatile' },
    { provider: 'fireworks', model: 'accounts/fireworks/models/llama-v3p3-70b-instruct' },
  ],
  tts: [
    { provider: 'openai', model: 'gpt-4o-mini-tts' },
    { provider: 'groq', model: 'playai-tts' },
  ],
};

// ---------------------------------------------------------------------------
// Core Function
// ---------------------------------------------------------------------------

/**
 * Ensures a fallback chain has entries from at least `minFamilies` distinct providers.
 *
 * If the chain is mono-provider (or has fewer than minFamilies distinct providers),
 * backup entries are appended from DEFAULT_BACKUPS (or config.backupEntries) until
 * the diversity requirement is met or no more eligible backups exist.
 *
 * A backup entry is eligible if:
 *   1. Its provider is in `availableProviders` (i.e., has an API key configured)
 *   2. Its provider is not already present in the chain
 *
 * @param chain             - The original fallback chain
 * @param stage             - Pipeline stage ('stt' | 'llm' | 'tts' | etc.)
 * @param availableProviders - Set of provider IDs that have valid API keys
 * @param config            - Optional configuration overrides
 * @returns A new chain with backup entries appended if needed, or the original chain unchanged
 */
export function diversifyChain(
  chain: FallbackEntry[],
  stage: string,
  availableProviders: Set<string>,
  config?: DiversifyConfig,
): FallbackEntry[] {
  // Disabled via config
  if (config?.enabled === false) {
    return chain;
  }

  // Empty chain — nothing to diversify
  if (chain.length === 0) {
    return chain;
  }

  const minFamilies = config?.minFamilies ?? 2;

  // Collect distinct provider IDs already in the chain
  const existingProviders = new Set(chain.map((entry) => entry.provider));

  // Already diverse enough
  if (existingProviders.size >= minFamilies) {
    return chain;
  }

  // Resolve backup entries for this stage
  const backups = config?.backupEntries?.[stage] ?? DEFAULT_BACKUPS[stage];
  if (!backups || backups.length === 0) {
    return chain;
  }

  // Collect eligible backups first so we can choose where to insert them.
  const providers = new Set(existingProviders);
  const chosen: FallbackEntry[] = [];

  for (const backup of backups) {
    // Stop once we have enough distinct providers
    if (providers.size >= minFamilies) {
      break;
    }

    // Skip if this provider is already in the chain
    if (providers.has(backup.provider)) {
      continue;
    }

    // Skip if the provider doesn't have an API key configured
    if (!availableProviders.has(backup.provider)) {
      continue;
    }

    chosen.push(backup);
    providers.add(backup.provider);
  }

  if (chosen.length === 0) return chain;

  // Build the diversified chain (clone to avoid mutating the original).
  if ((config?.insertPosition ?? 'tail') === 'early') {
    // Insert the cross-family backups right after the primary so a different
    // provider is the *second* thing tried, not the last (#313).
    return [chain[0], ...chosen, ...chain.slice(1)];
  }
  return [...chain, ...chosen];
}
