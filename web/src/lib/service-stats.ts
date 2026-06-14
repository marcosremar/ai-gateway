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

/**
 * Normalize a raw `/v1/metrics/service-stats` payload into a well-formed
 * `ServiceStatsData` (#949).
 *
 * `FallbackChainList` previously hit the endpoint with a bare `fetch` and fed the
 * untyped JSON straight into state, so a partial/garbage response (missing
 * `stats`, non-object `coldStart`, malformed `{avgMs,samples}` entries) would
 * propagate `undefined`/`NaN` into the latency-suffix render. This pure helper
 * shapes the response defensively so the typed `getServiceStats()` client (and
 * any caller) always gets a usable object. Returns `null` only when there is
 * genuinely nothing usable.
 *
 * Pure — no `fetch`/`window`; the raw payload is injected.
 */
export function normalizeServiceStats(raw: unknown): ServiceStatsData | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const stats: Record<string, { avgMs: number; samples: number }> = {};
  const rawStats = obj.stats;
  if (rawStats && typeof rawStats === 'object') {
    for (const [key, val] of Object.entries(rawStats as Record<string, unknown>)) {
      if (!val || typeof val !== 'object') continue;
      const v = val as Record<string, unknown>;
      const avgMs = Number(v.avgMs);
      const samples = Number(v.samples);
      if (!Number.isFinite(avgMs)) continue;
      stats[key] = {
        avgMs: Math.round(avgMs),
        samples: Number.isFinite(samples) ? samples : 0,
      };
    }
  }

  let coldStart: ServiceStatsData['coldStart'] = null;
  const rawCold = obj.coldStart;
  if (rawCold && typeof rawCold === 'object') {
    const c = rawCold as Record<string, unknown>;
    const coldTtfbMs = Number(c.coldTtfbMs);
    if (typeof c.provider === 'string' && Number.isFinite(coldTtfbMs)) {
      const warmTtfbAvgMs = Number(c.warmTtfbAvgMs);
      coldStart = {
        provider: c.provider,
        coldTtfbMs,
        warmTtfbAvgMs: Number.isFinite(warmTtfbAvgMs) ? warmTtfbAvgMs : 0,
      };
    }
  }

  return { stats, coldStart, warmth: obj.warmth };
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
