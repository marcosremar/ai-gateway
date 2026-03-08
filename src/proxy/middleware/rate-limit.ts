/**
 * In-memory rate limiter (sliding window).
 * Identifies clients by API key when available, falls back to socket IP.
 * Periodically cleans up expired buckets to prevent memory leaks.
 */

import type { IncomingMessage } from 'http';

export class RateLimiter {
  private buckets = new Map<string, number[]>();
  private rpm: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(rpm: number) {
    this.rpm = rpm;
    // Cleanup stale buckets every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60_000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /**
   * Extract a stable client identifier.
   * Prefers API key (partial hash) over IP to avoid x-forwarded-for spoofing.
   */
  static clientId(req: IncomingMessage): string {
    // Use Bearer token as client identity (more reliable than IP)
    const auth = req.headers.authorization;
    if (auth) {
      const token = auth.replace(/^Bearer\s+/i, '');
      if (token.length >= 8) {
        return `key:${token.substring(0, 8)}`;
      }
    }
    // Fallback to socket remote address (not x-forwarded-for, which is spoofable)
    return `ip:${req.socket.remoteAddress || 'unknown'}`;
  }

  /** Returns true if the request is allowed */
  check(clientId: string): boolean {
    if (this.rpm <= 0) return true;
    const now = Date.now();
    const windowMs = 60_000;
    let bucket = this.buckets.get(clientId);
    if (!bucket) {
      bucket = [];
      this.buckets.set(clientId, bucket);
    }

    // Prune old entries
    while (bucket.length > 0 && now - bucket[0] > windowMs) bucket.shift();

    if (bucket.length >= this.rpm) {
      console.warn(`[rate-limit] Rate limit exceeded for ${clientId} (${bucket.length}/${this.rpm} rpm)`);
      return false;
    }
    bucket.push(now);
    return true;
  }

  /** Remove buckets with no recent activity */
  private cleanup(): void {
    const now = Date.now();
    const windowMs = 60_000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.length === 0 || now - bucket[bucket.length - 1] > windowMs) {
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
