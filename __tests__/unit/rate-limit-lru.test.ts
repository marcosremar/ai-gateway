import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../src/proxy/middleware/rate-limit';

describe('RateLimiter — LRU eviction', () => {
  let limiter: RateLimiter;

  beforeEach(() => { limiter = new RateLimiter(100); });
  afterEach(() => { (limiter as any).cleanupTimer?.unref?.(); });

  it('evicts oldest bucket when exceeding MAX_BUCKETS', () => {
    const buckets = (limiter as any).buckets as Map<string, any>;
    for (let i = 0; i < 10_001; i++) {
      limiter.check(`client-${i}`);
    }
    expect(buckets.size).toBeLessThanOrEqual(10_000);
  });

  it('evicts least recently used, not newest', () => {
    const buckets = (limiter as any).buckets as Map<string, any>;
    limiter.check('first-client');
    for (let i = 1; i < 10_001; i++) {
      limiter.check(`client-${i}`);
    }
    expect(buckets.has('first-client')).toBe(false);
    expect(buckets.has('client-10000')).toBe(true);
  });

  it('actively used clients are not evicted', () => {
    const buckets = (limiter as any).buckets as Map<string, any>;
    limiter.check('active');
    for (let i = 0; i < 10_001; i++) {
      limiter.check(`filler-${i}`);
      limiter.check('active');
    }
    expect(buckets.has('active')).toBe(true);
  });

  it('cleanup removes idle buckets', () => {
    const buckets = (limiter as any).buckets as Map<string, any>;
    limiter.check('idle-client');
    const bucket = buckets.get('idle-client');
    bucket.lastRefill = Date.now() - 3 * 60 * 1000;
    (limiter as any).cleanup();
    expect(buckets.has('idle-client')).toBe(false);
  });
});
