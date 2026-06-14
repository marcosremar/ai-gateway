/**
 * WebSocket Rate Limiter.
 *
 * Fixes Gap #5: No rate limiting on WebSocket layer.
 *
 * Limits the number of messages a single WebSocket connection can send
 * within a time window to prevent abuse and DoS.
 */

import { createLogger } from '../logger';

const log = createLogger('ws-rate-limit');

interface RateLimitConfig {
  /** Max messages per window */
  maxMessages: number;
  /** Window duration in ms */
  windowMs: number;
  /** Action when limit exceeded */
  onExceeded?: (ws: unknown) => void;
}

const DEFAULT_CONFIG: Required<RateLimitConfig> = {
  maxMessages: 100,
  windowMs: 60_000, // 1 minute
  onExceeded: (ws: unknown) => {
    log.warn({}, 'WebSocket rate limit exceeded — closing connection');
    if (typeof (ws as any).close === 'function') {
      (ws as any).close(4029, 'Rate limit exceeded');
    }
  },
};

interface WindowState {
  count: number;
  windowStart: number;
}

/**
 * Create a WebSocket rate limiter.
 *
 * Usage:
 * ```typescript
 * const limiter = createWsRateLimiter({ maxMessages: 50, windowMs: 30_000 });
 *
 * wss.on('connection', (ws) => {
 *   ws.on('message', (data) => {
 *     if (!limiter.check(ws)) return; // Rate limited
 *     // Handle message
 *   });
 * });
 * ```
 */
export function createWsRateLimiter(config: Partial<RateLimitConfig> = {}) {
  const cfg: Required<RateLimitConfig> = { ...DEFAULT_CONFIG, ...config };
  const connections = new WeakMap<object, WindowState>();

  return {
    /**
     * Check if a WebSocket connection is within rate limits.
     * Returns true if allowed, false if rate limited.
     */
    check(ws: object): boolean {
      const now = Date.now();
      let state = connections.get(ws);

      // Initialize or reset window
      if (!state || now - state.windowStart > cfg.windowMs) {
        state = { count: 0, windowStart: now };
        connections.set(ws, state);
      }

      state.count++;

      if (state.count > cfg.maxMessages) {
        log.warn({ count: state.count, max: cfg.maxMessages }, 'WS rate limit exceeded');
        cfg.onExceeded(ws);
        return false;
      }

      return true;
    },

    /**
     * Get current rate limit status for a connection.
     */
    getStatus(ws: object): { count: number; remaining: number; windowMs: number } {
      const state = connections.get(ws);
      if (!state) {
        return { count: 0, remaining: cfg.maxMessages, windowMs: cfg.windowMs };
      }

      const now = Date.now();
      if (now - state.windowStart > cfg.windowMs) {
        return { count: 0, remaining: cfg.maxMessages, windowMs: cfg.windowMs };
      }

      return {
        count: state.count,
        remaining: Math.max(0, cfg.maxMessages - state.count),
        // Clamp to non-negative. `now - state.windowStart` can momentarily
        // exceed windowMs at the rollover boundary (the `>` check above uses
        // strict greater-than), which previously produced a NEGATIVE remaining
        // window — corrupting any Retry-After/backoff math a caller derives.
        windowMs: Math.max(0, cfg.windowMs - (now - state.windowStart)),
      };
    },

    /**
     * Reset rate limit for a connection.
     */
    reset(ws: object): void {
      connections.delete(ws);
    },
  };
}
