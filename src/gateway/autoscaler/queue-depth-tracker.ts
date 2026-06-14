/**
 * Queue Depth Tracker — tracks in-flight requests per tier.
 * Provides queue depth as a proactive scaling signal.
 *
 * Uses StateStore KV for persistence.
 */

import type { KvStore } from '../../deps';

export interface QueueDepthConfig {
  /** Queue depth above which to trigger scale-up. Default: 5 */
  scaleUpThreshold: number;
  /** Queue depth below which it's safe to scale down. Default: 1 */
  scaleDownThreshold: number;
  /** Max queue depth per tier before rejecting. Default: 20 */
  perTierMax: number;
}

export const DEFAULT_QUEUE_DEPTH_CONFIG: QueueDepthConfig = {
  scaleUpThreshold: 5,
  scaleDownThreshold: 1,
  perTierMax: 20,
};

function depthKey(tierIndex: number): string {
  return `queue-depth:${tierIndex}`;
}

/**
 * #291 — decide whether a cached total is still fresh enough to reuse.
 *
 * `getTotalDepth` SCANs `queue-depth:*` and GETs every key on each
 * `shouldScaleUp` call — expensive per request on Redis. This lets the tracker
 * cache the scanned total and only re-scan when the cache is older than
 * `ttlMs`. Returns true when the cached value is still usable. Pure + exported.
 */
export function isTotalCacheFresh(
  cachedAtMs: number | null,
  now: number,
  ttlMs: number,
): boolean {
  if (cachedAtMs === null) return false;
  if (!(ttlMs > 0)) return false;
  return now - cachedAtMs < ttlMs;
}

export class QueueDepthTracker {
  /** #291 — short-lived cache of the scanned total to avoid a SCAN per call. */
  private cachedTotal: number | null = null;
  private cachedTotalAt: number | null = null;
  private readonly totalCacheTtlMs: number;

  constructor(private readonly store: KvStore, opts: { totalCacheTtlMs?: number } = {}) {
    // Default 1s: long enough to collapse a burst of shouldScaleUp() calls into
    // one SCAN, short enough that scale-up decisions stay responsive.
    this.totalCacheTtlMs = opts.totalCacheTtlMs ?? 1_000;
  }

  /** Invalidate the cached total (called on every write). */
  private invalidateTotalCache(): void {
    this.cachedTotal = null;
    this.cachedTotalAt = null;
  }

  private async getCount(tierIndex: number): Promise<number> {
    const raw = await this.store.get(depthKey(tierIndex));
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return isNaN(n) ? 0 : Math.max(0, n);
  }

  /** Increment the queue depth for a tier. Returns the new depth. */
  async increment(tierIndex: number): Promise<number> {
    const current = await this.getCount(tierIndex);
    const next = current + 1;
    await this.store.set(depthKey(tierIndex), String(next));
    this.invalidateTotalCache();
    return next;
  }

  /** Decrement the queue depth for a tier (floor at 0). Returns the new depth. */
  async decrement(tierIndex: number): Promise<number> {
    const current = await this.getCount(tierIndex);
    const next = Math.max(0, current - 1);
    await this.store.set(depthKey(tierIndex), String(next));
    this.invalidateTotalCache();
    return next;
  }

  /** Get current queue depth for a tier. */
  async getDepth(tierIndex: number): Promise<number> {
    return this.getCount(tierIndex);
  }

  /** Get total queue depth across all tiers. */
  async getTotalDepth(): Promise<number> {
    // #291: reuse a recently-scanned total to avoid a SCAN + N GETs on every
    // shouldScaleUp() call under load. Writes invalidate the cache, so the
    // value is at most `totalCacheTtlMs` stale and never stale across a change.
    if (this.cachedTotal !== null && isTotalCacheFresh(this.cachedTotalAt, Date.now(), this.totalCacheTtlMs)) {
      return this.cachedTotal;
    }
    let total = 0;
    try {
      const keys: string[] = [];
      // Without `await`, scan is dispatched but the for-loop below runs
      // before its callback has a chance to populate `keys`, so the
      // function reported zero queue depth on every call.
      await this.store.scan('queue-depth:*', (k) => { keys.push(...k); });
      for (const key of keys) {
        try {
          const raw = await this.store.get(key);
          if (raw) {
            const n = parseInt(raw, 10);
            if (!isNaN(n) && n > 0) total += n;
          }
        } catch {
          // Skip keys that fail to fetch
        }
      }
    } catch {
      // Return partial result if scan fails
    }
    // Cache the freshly-scanned total so a burst of reads collapses to one scan.
    this.cachedTotal = total;
    this.cachedTotalAt = Date.now();
    return total;
  }

  /** Returns true if total queue depth exceeds the scale-up threshold. */
  async shouldScaleUp(config: QueueDepthConfig = DEFAULT_QUEUE_DEPTH_CONFIG): Promise<boolean> {
    const total = await this.getTotalDepth();
    return total > config.scaleUpThreshold;
  }

  /** Returns true if the tier's queue depth exceeds its max capacity. */
  async shouldReject(tierIndex: number, config: QueueDepthConfig = DEFAULT_QUEUE_DEPTH_CONFIG): Promise<boolean> {
    const depth = await this.getDepth(tierIndex);
    return depth > config.perTierMax;
  }
}
