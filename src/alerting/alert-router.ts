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

    // Dedup check
    const dedupeKey = `${payload.severity}:${payload.title}:${payload.message}`;
    const lastSeen = this.recentKeys.get(dedupeKey);
    if (lastSeen && now - lastSeen < this.dedupeWindowMs) return;
    this.recentKeys.set(dedupeKey, now);

    // Clean old dedup keys
    for (const [key, ts] of this.recentKeys) {
      if (now - ts > this.dedupeWindowMs) this.recentKeys.delete(key);
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
