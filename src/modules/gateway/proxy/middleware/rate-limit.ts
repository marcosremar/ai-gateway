/**
 * Token bucket rate limiter with burst allowance.
 *
 * Replaces sliding window with token bucket for better burst handling.
 * Identifies clients by API key when available, falls back to socket IP.
 * Periodically cleans up expired buckets to prevent memory leaks.
 */

import type { IncomingMessage } from 'http';
import { createHash } from 'crypto';
import { createLogger } from '../../../logger';

const log = createLogger('rate-limit');

interface Bucket {
  tokens: number;
  lastRefill: number;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/**
 * Token bucket rate limiter with burst allowance.
 *
 * Identifies clients by API key (hashed) when available, falling back to
 * socket IP. Each client gets its own bucket that refills at a steady rate.
 * Expired buckets are periodically cleaned up to prevent memory leaks.
 *
 * @example
 * ```typescript
 * const limiter = new RateLimiter(60); // 60 RPM
 * const result = limiter.check('client-123');
 * if (!result.allowed) {
 *   res.writeHead(429, {
 *     'X-RateLimit-Limit': String(result.limit),
 *     'X-RateLimit-Remaining': String(result.remaining),
 *     'X-RateLimit-Reset': String(result.resetAt),
 *   });
 * }
 * ```
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  /** Maximum tokens (burst capacity = 1.5x per-second rate) */
  private readonly capacity: number;
  /** Tokens added per millisecond */
  private readonly refillRatePerMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly MAX_BUCKETS = 10_000;

  /**
   * Create a rate limiter with the specified request rate.
   *
   * @param rpm - Maximum requests per minute. The bucket capacity equals this value,
   *              and tokens refill at `rpm / 60,000` tokens per millisecond.
   */
  constructor(rpm: number) {
    // Token bucket: capacity = RPM (allows full minute burst), refills at RPM/60s rate
    this.capacity = Math.max(1, rpm);
    this.refillRatePerMs = rpm / 60_000;
    // Cleanup stale buckets every 60 seconds
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /**
   * Extract a stable client identifier from an incoming HTTP request.
   *
   * Uses a SHA-256 hash of the API key (first 16 hex chars) to prevent rate
   * limit evasion via key prefix guessing. Falls back to the socket's
   * remote IP address if no API key is present.
   *
   * @param req - Incoming HTTP request
   * @returns A client identifier string prefixed with "key:" or "ip:"
   *
   * @example
   * ```typescript
   * const clientId = RateLimiter.clientId(req);
   * // "key:demo-client-id-xxxx" or "ip:192.168.1.1"
   * ```
   */
  static clientId(req: IncomingMessage): string {
    const auth = req.headers.authorization;
    if (auth) {
      const token = auth.replace(/^Bearer\s+/i, '').trim();
      // Always hash if a token is present — short tokens previously fell
      // through to IP bucketing, letting `Bearer x` escape per-key limits.
      if (token.length > 0) {
        return `key:${hashToken(token)}`;
      }
    }
    return `ip:${req.socket.remoteAddress || 'unknown'}`;
  }

  /**
   * Check whether a client is allowed to make a request and consume one token.
   *
   * Refills tokens based on elapsed time since the last check. Returns
   * rate limit header values suitable for `X-RateLimit-*` headers.
   *
   * @param clientId - Client identifier (from `RateLimiter.clientId()` or custom)
   * @returns Result indicating whether the request is allowed, along with rate limit metadata
   *
   * @example
   * ```typescript
   * const result = limiter.check('key:a1b2c3d4');
 * res.setHeader('X-RateLimit-Limit', String(result.limit));
   * res.setHeader('X-RateLimit-Remaining', String(result.remaining));
   * res.setHeader('X-RateLimit-Reset', String(result.resetAt));
   * ```
   */
  check(clientId: string): {
    allowed: boolean;
    /** Total capacity (tokens per window). Maps to X-RateLimit-Limit. */
    limit: number;
    /** Tokens remaining after this request. Maps to X-RateLimit-Remaining. */
    remaining: number;
    /** Unix epoch second when the bucket will be full again. Maps to X-RateLimit-Reset. */
    resetAt: number;
  } {
    if (this.refillRatePerMs <= 0) {
      log.warn(`refillRatePerMs <= 0 (${this.refillRatePerMs}), rate limiting disabled for ${clientId}`);
      return { allowed: true, limit: 0, remaining: 0, resetAt: 0 };
    }

    const now = Date.now();
    let bucket = this.buckets.get(clientId);

    if (!bucket) {
      // New client starts with full bucket
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(clientId, bucket);

      // Evict oldest if too many buckets
      if (this.buckets.size > RateLimiter.MAX_BUCKETS) {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [key, b] of this.buckets) {
          if (b.lastRefill < oldestTime) { oldestTime = b.lastRefill; oldestKey = key; }
        }
        if (oldestKey !== null) this.buckets.delete(oldestKey);
      }
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill;
    if (elapsed > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillRatePerMs);
    } else if (elapsed < -60_000) {
      // Clock went backwards by >1min (NTP adjustment) — reset to avoid stuck state
      bucket.tokens = this.capacity;
    }
    bucket.lastRefill = now;

    // Compute reset time: how long until the bucket is full again.
    // refillRatePerMs = capacity / 60_000, so time to full = (capacity - tokens) / refillRatePerMs ms.
    const msToFull = this.refillRatePerMs > 0
      ? Math.ceil((this.capacity - bucket.tokens) / this.refillRatePerMs)
      : 0;
    const resetAt = Math.ceil((now + msToFull) / 1000);

    if (bucket.tokens < 1) {
      return { allowed: false, limit: this.capacity, remaining: 0, resetAt };
    }

    bucket.tokens -= 1;
    return {
      allowed: true,
      limit: this.capacity,
      remaining: Math.floor(bucket.tokens),
      resetAt,
    };
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

  /**
   * Stop the cleanup timer and release resources.
   *
   * Call this when shutting down the server to prevent the Node.js event
   * loop from staying alive due to the unref'd interval timer.
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
