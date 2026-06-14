/**
 * AlertRouter — routes alerts to channels with dedup and rate limiting.
 */

import type { AlertChannel, AlertPayload, AlertRouterOptions } from './types';

export class AlertRouter {
  private channels: AlertChannel[];
  private dedupeWindowMs: number;
  private rateMax: number;
  private rateWindowMs: number;
  private retries: number;
  private retryDelayMs: number;
  private recentKeys = new Map<string, number>(); // key → timestamp
  private rateBucket: number[] = []; // timestamps of recent sends
  /** Count of non-critical alerts dropped by the rate limiter. */
  private suppressedCount = 0;
  /** Last time the dedupe map was fully swept (amortizes cleanup). */
  private lastDedupeSweep = 0;

  constructor(channels: AlertChannel[], opts?: AlertRouterOptions) {
    this.channels = channels;
    this.dedupeWindowMs = opts?.dedupeWindowMs ?? 60_000;
    this.rateMax = opts?.rateLimit?.max ?? 10;
    this.rateWindowMs = opts?.rateLimit?.windowMs ?? 60_000;
    this.retries = opts?.retries ?? 1;
    this.retryDelayMs = opts?.retryDelayMs ?? 200;
  }

  async route(payload: AlertPayload): Promise<void> {
    const now = Date.now();

    // Dedup check. Expire this key lazily on lookup so the common path touches a
    // single entry instead of scanning the whole map every call (#597).
    const dedupeKey = `${payload.severity}:${payload.title}:${payload.message}`;
    const lastSeen = this.recentKeys.get(dedupeKey);
    if (lastSeen !== undefined) {
      if (now - lastSeen < this.dedupeWindowMs) return;
      this.recentKeys.delete(dedupeKey); // stale — drop before re-adding
    }
    this.recentKeys.set(dedupeKey, now);

    // Amortized full sweep: only walk the whole map once per dedupe window
    // instead of on every route() call, bounding worst-case memory without the
    // per-alert O(n) cost during a storm.
    if (now - this.lastDedupeSweep >= this.dedupeWindowMs) {
      this.lastDedupeSweep = now;
      for (const [key, ts] of this.recentKeys) {
        if (now - ts > this.dedupeWindowMs) this.recentKeys.delete(key);
      }
    }

    // Rate limit check. Critical alerts ALWAYS deliver — during an incident the
    // most important alert must not be silently dropped by the limiter. Other
    // severities over the cap are dropped, but counted (suppressedCount) so the
    // suppression is observable.
    this.rateBucket = this.rateBucket.filter((ts) => now - ts < this.rateWindowMs);
    const overLimit = this.rateBucket.length >= this.rateMax;
    if (overLimit && payload.severity !== 'critical') {
      this.suppressedCount++;
      return;
    }
    this.rateBucket.push(now);

    // Send to all channels with bounded retry. A transient 503 previously meant
    // the alert was lost (allSettled discarded the rejection); retry once with
    // backoff before giving up.
    await Promise.allSettled(
      this.channels.map((ch) => this.sendWithRetry(ch, payload)),
    );
  }

  /** Number of non-critical alerts dropped by the rate limiter so far. */
  getSuppressedCount(): number {
    return this.suppressedCount;
  }

  private async sendWithRetry(ch: AlertChannel, payload: AlertPayload): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        await ch.send(payload);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < this.retries && this.retryDelayMs > 0) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs));
        }
      }
    }
    throw lastErr;
  }
}
