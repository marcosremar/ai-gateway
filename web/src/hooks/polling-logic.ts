/**
 * polling-logic.ts — framework-free helpers for tab-visibility-aware polling.
 *
 * Kept free of any React import so the pure logic is unit-testable in a plain
 * (non-DOM, non-React) environment. The React hook lives in `polling.ts` and
 * re-exports these.
 *
 * Fixes: #940 (pause polling loops when the tab is hidden), #952 (slow down
 * background polling instead of hammering the gateway).
 */

/**
 * Decide whether a polling tick should fire.
 *
 * When the document is hidden we skip the tick entirely — the next
 * `visibilitychange` will trigger an immediate refresh, so backgrounded tabs
 * stop hitting `/health`, `/gpu/status`, etc.
 */
export function shouldPoll(documentHidden: boolean): boolean {
  return !documentHidden;
}

/**
 * Compute the effective poll interval given tab visibility.
 *
 * Hidden tabs poll on a much slower keepalive cadence (or not at all) instead of
 * the foreground cadence. Pass `hiddenIntervalMs = null` (the default) to stop
 * polling entirely while hidden.
 */
export function effectivePollInterval(
  baseIntervalMs: number,
  documentHidden: boolean,
  hiddenIntervalMs: number | null = null,
): number | null {
  if (!documentHidden) return baseIntervalMs;
  return hiddenIntervalMs;
}

/** GPU statuses that indicate an active transition — poll faster to show progress. */
export const ACTIVE_GPU_STATUSES = new Set([
  'booting',
  'deploying',
  'pulling',
  'starting',
  'benchmarking',
]);

/** Fast poll interval (ms) used during active GPU transitions. */
export const FAST_GPU_INTERVAL_MS = 2000;

/**
 * Pick the effective GPU-status poll cadence: fast while transitioning,
 * otherwise the caller's base interval.
 */
export function gpuPollInterval(status: string | undefined, baseIntervalMs: number): number {
  return status != null && ACTIVE_GPU_STATUSES.has(status) ? FAST_GPU_INTERVAL_MS : baseIntervalMs;
}
