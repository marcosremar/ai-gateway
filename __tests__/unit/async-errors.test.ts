/**
 * Tests for async-errors module.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  safeAsync,
  withRetry,
  withTimeoutResult,
  TimeoutError,
  firstSuccess,
  withCleanup,
  withFallback,
  fireAndLog,
  wrapAllErrors,
} from '../../src/async-errors';

describe('safeAsync', () => {
  it('should return ok for successful promise', async () => {
    const result = await safeAsync(Promise.resolve('success'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe('success');
  });

  it('should return error for failing promise', async () => {
    const result = await safeAsync(Promise.reject(new Error('failed')));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('failed');
  });
});

describe('withRetry', () => {
  it('should succeed without retry if first attempt works', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withRetry(fn, { baseDelayMs: 10 });
    expect(result.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('success');

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    expect(result.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should respect isRetryable', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('not retryable'));
    const isRetryable = vi.fn().mockReturnValue(false);

    const result = await withRetry(fn, { maxRetries: 3, isRetryable, baseDelayMs: 10 });
    expect(result.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withTimeoutResult', () => {
  it('should resolve if promise is fast', async () => {
    const result = await withTimeoutResult(Promise.resolve('ok'), 1000);
    expect(result.ok).toBe(true);
  });

  it('should return TimeoutError if too slow', async () => {
    const result = await withTimeoutResult(new Promise((r) => setTimeout(r, 5000)), 100);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(TimeoutError);
  });
});

describe('firstSuccess', () => {
  it('should return first successful result', async () => {
    const result = await firstSuccess([
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return 'slow';
      },
      async () => 'fast',
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe('fast');
  });

  it('should return error if all fail', async () => {
    const result = await firstSuccess([
      async () => {
        throw new Error('fail 1');
      },
      async () => {
        throw new Error('fail 2');
      },
    ]);

    expect(result.ok).toBe(false);
  });
});

describe('withCleanup', () => {
  it('should run cleanup on success', async () => {
    const cleanup = vi.fn();
    const result = await withCleanup(async () => 'success', cleanup);
    expect(result.ok).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('should run cleanup on failure', async () => {
    const cleanup = vi.fn();
    const result = await withCleanup(async () => {
      throw new Error('failed');
    }, cleanup);

    expect(result.ok).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('withFallback', () => {
  it('should use primary if it succeeds', async () => {
    const primary = vi.fn().mockResolvedValue('primary');
    const fallback = vi.fn().mockResolvedValue('fallback');

    const result = await withFallback(primary, fallback);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe('primary');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('should use fallback if primary fails', async () => {
    const primary = vi.fn().mockRejectedValue(new Error('primary failed'));
    const fallback = vi.fn().mockResolvedValue('fallback');

    const result = await withFallback(primary, fallback);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe('fallback');
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});

describe('wrapAllErrors', () => {
  it('should wrap all methods with error handling', async () => {
    const obj = {
      success: async () => 'ok',
      failure: async () => {
        throw new Error('failed');
      },
    };

    const wrapped = wrapAllErrors(obj);
    const successResult = await wrapped.success();
    const failureResult = await wrapped.failure();

    expect(successResult.ok).toBe(true);
    expect(failureResult.ok).toBe(false);
  });
});
