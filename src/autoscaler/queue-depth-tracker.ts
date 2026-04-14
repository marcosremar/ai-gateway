/**
 * Queue Depth Tracker — tracks in-flight requests per tier.
 * Provides queue depth as a proactive scaling signal.
 *
 * Uses StateStore KV for persistence.
 */

import type { KvStore } from '../deps';

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

export class QueueDepthTracker {
  constructor(private readonly store: KvStore) {}

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
    return next;
  }

  /** Decrement the queue depth for a tier (floor at 0). Returns the new depth. */
  async decrement(tierIndex: number): Promise<number> {
    const current = await this.getCount(tierIndex);
    const next = Math.max(0, current - 1);
    await this.store.set(depthKey(tierIndex), String(next));
    return next;
  }

  /** Get current queue depth for a tier. */
  async getDepth(tierIndex: number): Promise<number> {
    return this.getCount(tierIndex);
  }

  /** Get total queue depth across all tiers. */
  async getTotalDepth(): Promise<number> {
    let total = 0;
    try {
      const keys: string[] = [];
      this.store.scan('queue-depth:*', (k) => { keys.push(...k); });
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
