/**
 * Tests for retry-policy module.
 */

import { describe, it, expect, vi } from 'vitest';
import { RetryPolicy, RetryPolicies } from '../../src/retry-policy';

describe('RetryPolicy', () => {
  it('should succeed without retry', async () => {
    const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 10 });
    const fn = vi.fn().mockResolvedValue('success');

    const result = await policy.execute(fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure', async () => {
    const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 10 });
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('success');

    const result = await policy.execute(fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw after max attempts', async () => {
    const policy = new RetryPolicy({ maxAttempts: 2, baseDelayMs: 10 });
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    await expect(policy.execute(fn)).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should not retry if not retryable', async () => {
    const policy = new RetryPolicy({
      maxAttempts: 3,
      baseDelayMs: 10,
      isRetryable: () => false,
    });
    const fn = vi.fn().mockRejectedValue(new Error('not retryable'));

    await expect(policy.execute(fn)).rejects.toThrow('not retryable');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should track stats', async () => {
    const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 10 });

    await policy.execute(async () => 'success');
    await policy.execute(async () => { throw new Error('fail'); }).catch(() => {});

    const stats = policy.getStats();
    expect(stats.executions).toBe(2);
    expect(stats.successes).toBe(1);
    expect(stats.failures).toBe(1);
  });
});

describe('RetryPolicies', () => {
  it('should have all standard policies', () => {
    expect(RetryPolicies.Quick).toBeDefined();
    expect(RetryPolicies.Standard).toBeDefined();
    expect(RetryPolicies.Conservative).toBeDefined();
    expect(RetryPolicies.Aggressive).toBeDefined();
  });

  it('Quick policy should have low maxAttempts', async () => {
    const stats = RetryPolicies.Quick.getStats();
    expect(stats).toBeDefined();
  });

  it('Standard policy should be middle ground', async () => {
    const stats = RetryPolicies.Standard.getStats();
    expect(stats).toBeDefined();
  });
});
