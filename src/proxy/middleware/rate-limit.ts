/**
 * Token bucket rate limiter with burst allowance.
 *
 * Replaces sliding window with token bucket for better burst handling.
 * Identifies clients by API key when available, falls back to socket IP.
 * Periodically cleans up expired buckets to prevent memory leaks.
 */

import type { IncomingMessage } from 'http';

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  /** Maximum tokens (burst capacity = 1.5x per-second rate) */
  private readonly capacity: number;
  /** Tokens added per millisecond */
  private readonly refillRatePerMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly MAX_BUCKETS = 10_000;

  constructor(rpm: number) {
    // Token bucket: capacity = RPM (allows full minute burst), refills at RPM/60s rate
    this.capacity = Math.max(1, rpm);
    this.refillRatePerMs = rpm / 60_000;
    // Cleanup stale buckets every 60 seconds
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /**
   * Extract a stable client identifier.
   * Prefers API key (partial hash) over IP to avoid x-forwarded-for spoofing.
   */
  static clientId(req: IncomingMessage): string {
    const auth = req.headers.authorization;
    if (auth) {
      const token = auth.replace(/^Bearer\s+/i, '');
      if (token.length >= 8) {
        return `key:${token.substring(0, 8)}`;
      }
    }
    return `ip:${req.socket.remoteAddress || 'unknown'}`;
  }

  /** Returns true if the request is allowed */
  check(clientId: string): boolean {
    if (this.refillRatePerMs <= 0) return true;

    const now = Date.now();
    let bucket = this.buckets.get(clientId);

    if (!bucket) {
      // New client starts with full bucket
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(clientId, bucket);

      // Evict oldest if too many buckets
      if (this.buckets.size > RateLimiter.MAX_BUCKETS) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined && oldest !== clientId) this.buckets.delete(oldest);
      }
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill;
    if (elapsed > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillRatePerMs);
      bucket.lastRefill = now;
    }

    if (bucket.tokens < 1) {
      console.warn(`[rate-limit] Rate limit exceeded for ${clientId}`);
      return false;
    }

    bucket.tokens -= 1;
    return true;
  }

  /** Remove buckets idle for more than 2 minutes */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > 120_000) {
        this.buckets.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
