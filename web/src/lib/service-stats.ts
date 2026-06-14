/**
 * Pure helpers for service latency stats (#950).
 *
 * `FallbackChainList` previously computed the latency subtitle suffix inside a
 * non-memoized closure (`getLatencySuffix`) that read `serviceStats` from scope,
 * while the `serviceOptions` `useMemo` only listed `serviceStats` in its deps —
 * a staleness footgun. The decision logic is extracted here as a pure function so
 * the memo can depend on stable inputs and the behavior is unit-testable.
 */

export interface ServiceStatsData {
  stats: Record<string, { avgMs: number; samples: number }>;
  coldStart: { provider: string; coldTtfbMs: number; warmTtfbAvgMs: number } | null;
  warmth?: unknown;
}

/** Providers whose cold start is serverless-style (~10s), not a real GPU boot. */
export const SERVERLESS_LATENCY_IDS = new Set(['modal', 'modal-moss']);

/**
 * Build the latency subtitle suffix for a `stage::provider` pair.
 *
 * Returns `''` when there is nothing to show, otherwise a ` · `-prefixed string
 * like ` · ~120ms · cold: 12s`. Pure — `stats` is injected.
 */
export function latencySuffix(
  stage: string,
  provider: string,
  stats: ServiceStatsData | null | undefined,
): string {
  if (!stats) return '';
  const parts: string[] = [];

  const stat = stats.stats[`${stage}::${provider}`];
  if (stat) parts.push(`~${stat.avgMs}ms`);

  if (provider === 'gpu' && stats.coldStart) {
    parts.push(`cold: ${Math.round(stats.coldStart.coldTtfbMs / 1000)}s`);
  }
  if (SERVERLESS_LATENCY_IDS.has(provider) && stats.coldStart) {
    // Modal-style cold start is different — typically 5-15s.
    parts.push('cold: ~10s');
  }

  return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
}
