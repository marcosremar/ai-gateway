import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../src/proxy/middleware/rate-limit';

describe('RateLimiter — LRU eviction', () => {
  let limiter: RateLimiter;

  afterEach(() => {
    if (limiter) {
      (limiter as any).cleanupTimer && clearInterval((limiter as any).cleanupTimer);
    }
  });

  it('evicts least recently used bucket when exceeding MAX_BUCKETS (10000)', () => {
    limiter = new RateLimiter(100);
    const buckets = (limiter as any).buckets as Map<string, any>;

    for (let i = 0; i < 10001; i++) {
      limiter.check(`client-${i}`);
    }

    expect(buckets.size).toBeLessThanOrEqual(10000);
  });

  it('evicts oldest (least recently used) client, not newest', () => {
    limiter = new RateLimiter(1000);
    const buckets = (limiter as any).buckets as Map<string, any>;

    limiter.check('old-client');

    const oldBucket = buckets.get('old-client');
    oldBucket.lastRefill = Date.now() - 60000;

    for (let i = 0; i < 10000; i++) {
      limiter.check(`new-${i}`);
    }

    expect(buckets.has('old-client')).toBe(false);
  });

  it('never evicts actively used clients', () => {
    limiter = new RateLimiter(1000);
    const buckets = (limiter as any).buckets as Map<string, any>;

    limiter.check('active-client');

    for (let i = 0; i < 10000; i++) {
      limiter.check(`filler-${i}`);
      if (i % 100 === 0) limiter.check('active-client');
    }

    expect(buckets.has('active-client')).toBe(true);
  });

  it('does not evict the new client being added', () => {
    limiter = new RateLimiter(1000);
    const buckets = (limiter as any).buckets as Map<string, any>;

    for (let i = 0; i < 10005; i++) {
      const result = limiter.check(`client-${i}`);
      if (i >= 10001) {
        expect(buckets.has(`client-${i}`)).toBe(true);
      }
    }
  });
});

describe('RateLimiter — cleanup', () => {
  let limiter: RateLimiter;

  afterEach(() => {
    if (limiter) clearInterval((limiter as any).cleanupTimer);
  });

  it('cleanup removes buckets idle > 2 minutes', () => {
    limiter = new RateLimiter(100);
    const buckets = (limiter as any).buckets as Map<string, any>;

    limiter.check('idle-client');
    limiter.check('active-client');

    const idleBucket = buckets.get('idle-client');
    idleBucket.lastRefill = Date.now() - 3 * 60 * 1000;

    (limiter as any).cleanup();

    expect(buckets.has('active-client')).toBe(true);
    expect(buckets.has('idle-client')).toBe(false);
  });

  it('cleanup keeps recently used buckets', () => {
    limiter = new RateLimiter(100);
    const buckets = (limiter as any).buckets as Map<string, any>;

    limiter.check('recent-client');
    (limiter as any).cleanup();

    expect(buckets.has('recent-client')).toBe(true);
  });
});
