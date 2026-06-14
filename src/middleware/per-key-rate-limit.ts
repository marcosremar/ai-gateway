/**
 * Per-API-Key rate limiting middleware.
 *
 * Unlike the global rate limiter (which applies to all requests),
 * this tracks usage per API key and enforces individual quotas.
 *
 * Quotas are configured via environment variable or can be loaded from
 * a database/Redis in production.
 *
 * @example
 * ```ts
 * // ENV: RATE_LIMIT_KEYS="sk-abc:100,sk-def:50"
 * const limiter = createPerKeyRateLimiter();
 *
 * // In request handler:
 * const result = limiter.check(apiKey);
 * if (!result.allowed) {
 *   return res.writeHead(429).end(JSON.stringify({
 *     error: 'Rate limit exceeded',
 *     retryAfterMs: result.retryAfterMs,
 *   }));
 * }
 * ```
 */

import { createLogger } from '../logger';
import { maskApiKey } from './sanitization';

const log = createLogger('per-key-rate-limit');

export interface KeyQuota {
  /** Max requests per window */
  maxRequests: number;
  /** Window size in ms (default: 60_000 = 1 minute) */
  windowMs?: number;
}

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Current request count in window */
  current: number;
  /** Max allowed in window */
  max: number;
  /** Remaining requests in window */
  remaining: number;
  /** Time until window resets (ms) */
  resetMs: number;
  /** Time to wait before retrying (if limited) */
  retryAfterMs?: number;
}

/**
 * Parse per-key quotas from environment variable.
 *
 * Format: `key1:100,key2:50,key3:1000`
 * Keys not in the list use the default quota.
 */
export function parseKeyQuotas(
  envVar = 'RATE_LIMIT_KEYS',
  defaultQuota = 100,
): Map<string, KeyQuota> {
  const raw = process.env[envVar];
  const quotas = new Map<string, KeyQuota>();

  if (raw) {
    for (const entry of raw.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;

      const [key, maxStr] = trimmed.split(':');
      // Skip empty keys (`:100,sk-abc:50` would otherwise create a quota for
      // the empty-string key, matched by unauthenticated/empty-key callers).
      if (!key || !key.trim()) {
        log.warn({ entry: trimmed }, 'Skipping rate-limit entry with empty key');
        continue;
      }
      const maxRequests = parseInt(maxStr ?? '100', 10);

      // Reject non-finite or non-positive quotas. `parseInt('0')`/negatives
      // previously slipped through (only `isNaN` was checked), producing a
      // bucket that blocks *every* request for that key — a silent DoS from a
      // config typo. Skip the bad entry rather than apply it.
      if (!Number.isFinite(maxRequests) || maxRequests <= 0) {
        log.warn({ entry: trimmed }, 'Skipping rate-limit entry with invalid (<=0) quota');
        continue;
      }
      quotas.set(key.trim(), { maxRequests });
    }
  }

  // Add default quota for unknown keys, but only if not explicitly set
  // in the env var (e.g. RATE_LIMIT_KEYS="*:200,sk-abc:50").
  if (!quotas.has('*')) {
    quotas.set('*', { maxRequests: defaultQuota });
  }

  return quotas;
}

/**
 * Create a per-key rate limiter.
 *
 * Uses an in-memory sliding window counter per API key.
 */
export function createPerKeyRateLimiter(quotas?: Map<string, KeyQuota>, defaultQuota = 100) {
  const keyQuotas = quotas ?? parseKeyQuotas('RATE_LIMIT_KEYS', defaultQuota);

  // Per-key tracking: key → { count, windowStart }
  const tracking = new Map<string, { count: number; windowStart: number }>();

  return {
    /**
     * Check if a request from the given API key is allowed.
     *
     * `opts.cost` (#686) lets a single expensive request consume more than one
     * unit of the per-window quota. The speech/STT/TTS path fires STT→LLM→TTS —
     * far more spend than a cheap `/v1/models` call — so a cost-weighted quota
     * stops one key from draining the shared GPU/token budget with a burst of
     * heavy requests even while staying under a flat request count. Defaults to
     * 1 (unchanged behavior). A cost < 1 is clamped to 1; non-finite is ignored.
     */
    check(apiKey: string, opts: { cost?: number } = {}): RateLimitResult {
      const cost =
        Number.isFinite(opts.cost) && (opts.cost as number) > 1
          ? Math.floor(opts.cost as number)
          : 1;
      const quota = keyQuotas.get(apiKey) ?? keyQuotas.get('*') ?? { maxRequests: defaultQuota };
      const windowMs = quota.windowMs ?? 60_000;
      const now = Date.now();

      let entry = tracking.get(apiKey);

      // Reset window if expired
      if (!entry || now - entry.windowStart >= windowMs) {
        entry = { count: 0, windowStart: now };
        tracking.set(apiKey, entry);
      }

      entry.count += cost;

      const remaining = Math.max(0, quota.maxRequests - entry.count);
      // Clamp to non-negative — `now - entry.windowStart` can exceed
      // windowMs in a window-rollover edge case, producing a negative
      // Retry-After header that browsers interpret unpredictably.
      const resetMs = Math.max(0, windowMs - (now - entry.windowStart));

      if (entry.count > quota.maxRequests) {
        const retryAfterMs = resetMs;
        log.log(
          // Use the shared masking policy so logged keys are consistent across
          // the codebase (short keys collapse to *** instead of leaking a
          // 4-char prefix).
          { apiKey: maskApiKey(apiKey), count: entry.count, max: quota.maxRequests },
          'Per-key rate limit exceeded',
        );

        return {
          allowed: false,
          current: entry.count,
          max: quota.maxRequests,
          remaining: 0,
          resetMs,
          retryAfterMs,
        };
      }

      return {
        allowed: true,
        current: entry.count,
        max: quota.maxRequests,
        remaining,
        resetMs,
      };
    },

    /**
     * Get current usage stats for an API key.
     */
    getStats(apiKey: string): RateLimitResult | null {
      const quota = keyQuotas.get(apiKey) ?? keyQuotas.get('*');
      if (!quota) return null;

      const entry = tracking.get(apiKey);
      if (!entry) {
        return {
          allowed: true,
          current: 0,
          max: quota.maxRequests,
          remaining: quota.maxRequests,
          resetMs: quota.windowMs ?? 60_000,
        };
      }

      const windowMs = quota.windowMs ?? 60_000;
      const now = Date.now();
      const elapsed = now - entry.windowStart;

      // If the window has already expired but no check() rolled the
      // entry over yet, report a fresh window: 0 used, full reset.
      // Without this, `windowMs - elapsed` was negative — corrupting
      // Retry-After headers and setTimeout-based retries.
      if (elapsed >= windowMs) {
        return {
          allowed: true,
          current: 0,
          max: quota.maxRequests,
          remaining: quota.maxRequests,
          resetMs: windowMs,
        };
      }

      const resetMs = Math.max(0, windowMs - elapsed);

      return {
        allowed: entry.count <= quota.maxRequests,
        current: entry.count,
        max: quota.maxRequests,
        remaining: Math.max(0, quota.maxRequests - entry.count),
        resetMs,
      };
    },

    /**
     * Reset the counter for an API key.
     */
    reset(apiKey: string): void {
      tracking.delete(apiKey);
    },

    /**
     * Reset all counters.
     */
    resetAll(): void {
      tracking.clear();
    },

    /**
     * Update quota for an API key.
     */
    setQuota(apiKey: string, quota: KeyQuota): void {
      keyQuotas.set(apiKey, quota);
    },
  };
}
