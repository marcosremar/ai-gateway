/**
 * metrics.ts — framework-free helpers for the Overview/provider dashboards.
 *
 * Extracted from `OverviewSection.tsx` so the cost-sensitive computations are
 * pure, memoizable, and unit-testable without React/DOM:
 *
 *   - #945 `computeStageLatencies` ran on every poll/render with an O(n log n)
 *     sort over ~100 entries; pulling it out lets the section wrap it in
 *     `useMemo` keyed on the raw entries.
 *   - #946 the sparkline polyline recomputed `Math.max(...trend)` once per
 *     point; `sparklinePoints` hoists the max to a single pass.
 */

export interface StageLatency {
  cold: number | null;
  warm: number | null;
  samples: number;
  provider: string;
}

/** Minimal shape of a request-log entry needed for latency math. */
export interface LatencyLogEntry {
  stage: string;
  provider: string;
  latencyMs: number;
  timestamp: number;
  success: boolean;
}

/** Gap (ms) above which a sample counts as a cold-start latency. */
export const COLD_GAP_MS = 60_000;

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

/**
 * Bucket successful request-log entries by stage and split each stage's
 * latencies into cold (preceded by a >60s gap) vs warm. Pure (#945).
 */
export function computeStageLatencies(entries: LatencyLogEntry[]): Record<string, StageLatency> {
  const byStage: Record<string, LatencyLogEntry[]> = {};
  for (const e of entries) {
    if (!e.success) continue;
    (byStage[e.stage] ??= []).push(e);
  }

  const result: Record<string, StageLatency> = {};
  for (const [stage, stageEntries] of Object.entries(byStage)) {
    const sorted = [...stageEntries].sort((a, b) => a.timestamp - b.timestamp);
    const provider = sorted[sorted.length - 1]?.provider || '';
    if (sorted.length === 0) {
      result[stage] = { cold: null, warm: null, samples: 0, provider };
      continue;
    }
    const cold: number[] = [];
    const warm: number[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const gap = i === 0 ? Infinity : sorted[i].timestamp - sorted[i - 1].timestamp;
      (gap > COLD_GAP_MS ? cold : warm).push(sorted[i].latencyMs);
    }
    result[stage] = { cold: mean(cold), warm: mean(warm), samples: sorted.length, provider };
  }
  return result;
}

/**
 * Per-provider latency trend windows (last `window` successful samples). Pure;
 * used to feed the sparkline. (#946 companion to #945.)
 */
export function computeProviderTrends(
  entries: LatencyLogEntry[],
  window = 20,
): Record<string, number[]> {
  const byProvider: Record<string, number[]> = {};
  for (const e of entries) {
    if (!e.success) continue;
    (byProvider[e.provider] ??= []).push(e.latencyMs);
  }
  const trends: Record<string, number[]> = {};
  for (const [provider, latencies] of Object.entries(byProvider)) {
    trends[provider] = latencies.slice(-window);
  }
  return trends;
}

/**
 * Build an SVG polyline `points` string for a sparkline. The max is computed
 * once (not per-point as the inline `.map(Math.max(...trend))` did, #946).
 * Returns `''` when there are fewer than 2 points (nothing to draw). Pure.
 */
export function sparklinePoints(
  trend: number[],
  width = 38,
  height = 14,
  pad = 1,
): string {
  if (!trend || trend.length < 2) return '';
  const max = Math.max(...trend);
  const lastX = trend.length - 1;
  return trend
    .map((v, i) => {
      const x = (i / lastX) * width + pad;
      const y = max > 0 ? height + pad - (v / max) * height : (height + 2 * pad) / 2;
      return `${x},${y}`;
    })
    .join(' ');
}
