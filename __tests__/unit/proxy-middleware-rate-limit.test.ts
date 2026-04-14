import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../src/proxy/middleware/rate-limit';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(60); // 60 RPM
  });

  afterEach(() => {
    limiter.destroy();
  });

  it('allows first request', () => {
    expect(limiter.check('client-1').allowed).toBe(true);
  });

  it('rejects after exceeding capacity', () => {
    for (let i = 0; i < 60; i++) {
      limiter.check('client-1');
    }
    expect(limiter.check('client-1').allowed).toBe(false);
  });

  it('tracks clients independently', () => {
    for (let i = 0; i < 60; i++) {
      limiter.check('client-1');
    }
    expect(limiter.check('client-1').allowed).toBe(false);
    expect(limiter.check('client-2').allowed).toBe(true);
  });

  it('refills tokens over time', () => {
    vi.useFakeTimers();
    const rl = new RateLimiter(60);

    for (let i = 0; i < 60; i++) {
      rl.check('client-1');
    }
    expect(rl.check('client-1').allowed).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(rl.check('client-1').allowed).toBe(true);

    rl.destroy();
    vi.useRealTimers();
  });

  it('handles zero RPM gracefully', () => {
    const zeroLimiter = new RateLimiter(0);
    expect(zeroLimiter.check('client-1').allowed).toBe(true);
    zeroLimiter.destroy();
  });

  it('destroy clears interval', () => {
    const spy = vi.spyOn(globalThis, 'clearInterval');
    limiter.destroy();
    expect(spy).toHaveBeenCalled();
  });

  it('returns X-RateLimit-* header data', () => {
    const result = limiter.check('client-1');
    expect(result.limit).toBe(60);
    expect(result.remaining).toBeGreaterThanOrEqual(0);
    expect(result.remaining).toBeLessThanOrEqual(60);
    expect(result.resetAt).toBeGreaterThan(0);
  });

  it('remaining decreases with each request', () => {
    const first = limiter.check('client-1');
    const second = limiter.check('client-1');
    expect(second.remaining).toBeLessThan(first.remaining);
  });

  it('remaining is 0 when rejected', () => {
    for (let i = 0; i < 60; i++) limiter.check('client-1');
    const rejected = limiter.check('client-1');
    expect(rejected.allowed).toBe(false);
    expect(rejected.remaining).toBe(0);
  });

  describe('clientId', () => {
    it('extracts from Bearer token', () => {
      const req = {
        headers: { authorization: 'Bearer sk-12345678-abc' },
        socket: { remoteAddress: '1.2.3.4' },
      } as any;
      expect(RateLimiter.clientId(req)).toBe('key:sk-12345');
    });

    it('falls back to IP when no auth', () => {
      const req = {
        headers: {},
        socket: { remoteAddress: '1.2.3.4' },
      } as any;
      expect(RateLimiter.clientId(req)).toBe('ip:1.2.3.4');
    });

    it('falls back to IP when token too short', () => {
      const req = {
        headers: { authorization: 'Bearer abc' },
        socket: { remoteAddress: '1.2.3.4' },
      } as any;
      expect(RateLimiter.clientId(req)).toBe('ip:1.2.3.4');
    });

    it('handles unknown IP', () => {
      const req = { headers: {}, socket: {} } as any;
      expect(RateLimiter.clientId(req)).toBe('ip:unknown');
    });
  });
});
