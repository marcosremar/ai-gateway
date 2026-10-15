// ── AI Gateway — ucast.me accounts: attempt limits ──────────────────────────
// Fixed-window counters per bucket key (IP or e-mail) for login, signup, password reset and activation. In memory:
// a restart resets them, which only ever loosens the limit for one window.

export interface Window { limit: number; windowMs: number }

export const ATTEMPT_LIMITS = {
  loginPerEmail: { limit: 10, windowMs: 15 * 60_000 },
  loginPerIp: { limit: 50, windowMs: 15 * 60_000 },
  signupPerIp: { limit: 10, windowMs: 60 * 60_000 },
  resetPerEmail: { limit: 3, windowMs: 60 * 60_000 },
  resetPerIp: { limit: 20, windowMs: 60 * 60_000 },
  activatePerIp: { limit: 30, windowMs: 10 * 60_000 },
} as const satisfies Record<string, Window>;

export class AttemptLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Counts one attempt; returns the seconds to wait when over the limit, else 0. */
  hit(bucket: string, w: Window): number {
    const now = this.now();
    if (this.hits.size > 50_000) this.sweep(now);
    let h = this.hits.get(bucket);
    if (!h || h.resetAt <= now) {
      h = { count: 0, resetAt: now + w.windowMs };
      this.hits.set(bucket, h);
    }
    h.count++;
    return h.count > w.limit ? Math.max(1, Math.ceil((h.resetAt - now) / 1000)) : 0;
  }

  /** Forgets a bucket (a successful login clears its e-mail's failures). */
  clear(bucket: string): void {
    this.hits.delete(bucket);
  }

  private sweep(now: number): void {
    for (const [k, h] of this.hits) if (h.resetAt <= now) this.hits.delete(k);
  }
}
