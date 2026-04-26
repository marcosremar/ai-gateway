/**
 * Regression test: parseKeyQuotas should respect explicit wildcard (*)
 * in the env var instead of always overwriting it with the default.
 *
 * Bug: After parsing the env var, parseKeyQuotas unconditionally sets
 * quotas.set('*', { maxRequests: defaultQuota }), which overwrites any
 * explicit wildcard quota from the env var.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseKeyQuotas, createPerKeyRateLimiter } from '../../src/middleware/per-key-rate-limit';

describe('parseKeyQuotas wildcard handling', () => {
  const ENV_KEY = 'TEST_RATE_LIMIT_KEYS';

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it('should respect explicit wildcard quota from env var', () => {
    process.env[ENV_KEY] = '*:200,sk-abc:50';
    const quotas = parseKeyQuotas(ENV_KEY, 100);
    // The wildcard should be 200, not overwritten to 100
    expect(quotas.get('*')?.maxRequests).toBe(200);
  });

  it('should respect explicit wildcard quota when it is the only entry', () => {
    process.env[ENV_KEY] = '*:500';
    const quotas = parseKeyQuotas(ENV_KEY, 100);
    expect(quotas.get('*')?.maxRequests).toBe(500);
  });

  it('should use default quota for wildcard when env var has no wildcard', () => {
    process.env[ENV_KEY] = 'sk-abc:50';
    const quotas = parseKeyQuotas(ENV_KEY, 100);
    expect(quotas.get('*')?.maxRequests).toBe(100);
  });

  it('should use default quota for wildcard when env var is empty', () => {
    const quotas = parseKeyQuotas(ENV_KEY, 100);
    expect(quotas.get('*')?.maxRequests).toBe(100);
  });

  it('createPerKeyRateLimiter should enforce explicit wildcard quota', () => {
    process.env['RATE_LIMIT_KEYS'] = '*:5';
    const limiter = createPerKeyRateLimiter();
    // Should be limited to 5, not default 100
    for (let i = 0; i < 5; i++) {
      expect(limiter.check('unknown-key').allowed).toBe(true);
    }
    // The 6th request should be rejected (quota is 5, not 100)
    expect(limiter.check('unknown-key').allowed).toBe(false);
    delete process.env['RATE_LIMIT_KEYS'];
  });
});
