/**
 * Bug: createPerKeyRateLimiter().getStats() returns NEGATIVE `resetMs`
 * once the window has already elapsed but the entry hasn't been touched
 * yet (no fresh check() call to roll it over).
 *
 * Formula: `windowMs - (now - entry.windowStart)`. With windowStart
 * sufficiently far in the past, the subtraction produces a negative
 * value. Downstream uses `resetMs` for `Retry-After` headers and
 * setTimeout retry scheduling — a negative value is malformed.
 *
 * Fix: clamp at 0, or detect the window-expired state and report 0.
 */
import { describe, it, expect } from 'vitest';
import { createPerKeyRateLimiter } from '../../src/middleware/per-key-rate-limit';

describe('createPerKeyRateLimiter — getStats resetMs non-negative', () => {
  it('does not return a negative resetMs after window expiry', () => {
    const quotas = new Map([['k1', { maxRequests: 10, windowMs: 100 }]]);
    const limiter = createPerKeyRateLimiter(quotas);

    // Trigger one check to seed an entry.
    limiter.check('k1');

    // Manually invoke getStats AFTER the window has long since elapsed.
    // Simulate by sleeping past the window. (50ms past 100ms window.)
    const start = Date.now();
    while (Date.now() - start < 150) { /* spin briefly */ }

    const s = limiter.getStats('k1');
    expect(s).not.toBeNull();
    expect(s!.resetMs).toBeGreaterThanOrEqual(0);
  });
});
