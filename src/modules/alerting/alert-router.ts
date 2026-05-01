/**
 * AlertRouter — routes alerts to channels with dedup and rate limiting.
 */

import type { AlertChannel, AlertPayload, AlertRouterOptions } from './types';

export class AlertRouter {
  private channels: AlertChannel[];
  private dedupeWindowMs: number;
  private rateMax: number;
  private rateWindowMs: number;
  private recentKeys = new Map<string, number>(); // key → timestamp
  private rateBucket: number[] = []; // timestamps of recent sends

  constructor(channels: AlertChannel[], opts?: AlertRouterOptions) {
    this.channels = channels;
    this.dedupeWindowMs = opts?.dedupeWindowMs ?? 60_000;
    this.rateMax = opts?.rateLimit?.max ?? 10;
    this.rateWindowMs = opts?.rateLimit?.windowMs ?? 60_000;
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

    // Rate limit check
    this.rateBucket = this.rateBucket.filter((ts) => now - ts < this.rateWindowMs);
    if (this.rateBucket.length >= this.rateMax) return;
    this.rateBucket.push(now);

    // Send to all channels (fire-and-forget)
    await Promise.allSettled(
      this.channels.map((ch) => ch.send(payload)),
    );
  }
}
