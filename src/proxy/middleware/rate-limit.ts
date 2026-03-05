/**
 * Simple in-memory rate limiter (per-IP, sliding window).
 */

export class RateLimiter {
  private buckets = new Map<string, number[]>();
  private rpm: number;

  constructor(rpm: number) {
    this.rpm = rpm;
  }

  /** Returns true if the request is allowed */
  check(ip: string): boolean {
    if (this.rpm <= 0) return true;
    const now = Date.now();
    const windowMs = 60_000;
    let bucket = this.buckets.get(ip);
    if (!bucket) {
      bucket = [];
      this.buckets.set(ip, bucket);
    }

    // Prune old entries
    while (bucket.length > 0 && now - bucket[0] > windowMs) bucket.shift();

    if (bucket.length >= this.rpm) return false;
    bucket.push(now);
    return true;
  }
}
