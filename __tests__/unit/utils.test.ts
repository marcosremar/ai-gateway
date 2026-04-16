/**
 * Tests for utility functions.
 */

import { describe, it, expect, vi } from 'vitest';
import { withRetry, withTimeout, TimeoutError, sleep, debounce, throttle, safeJsonParse, uuid, truncate, safeExec } from '../../src/utils';

describe('withRetry', () => {
  it('should succeed on first try', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withRetry(fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('success');

    const result = await withRetry(fn, { baseDelayMs: 10, maxDelayMs: 50 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw after max attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    await expect(withRetry(fn, { maxAttempts: 2, baseDelayMs: 10 })).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should not retry if not retryable', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('not retryable'));
    const isRetryable = vi.fn().mockReturnValue(false);

    await expect(withRetry(fn, { maxAttempts: 3, isRetryable, baseDelayMs: 10 })).rejects.toThrow('not retryable');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withTimeout', () => {
  it('should resolve if promise resolves in time', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000);
    expect(result).toBe('ok');
  });

  it('should throw TimeoutError if too slow', async () => {
    await expect(withTimeout(new Promise((r) => setTimeout(r, 5000)), 100)).rejects.toThrow(TimeoutError);
  });
});

describe('sleep', () => {
  it('should wait for specified time', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });
});

describe('safeJsonParse', () => {
  it('should parse valid JSON', () => {
    expect(safeJsonParse('{"a": 1}')).toEqual({ a: 1 });
  });

  it('should return undefined for invalid JSON', () => {
    expect(safeJsonParse('not json')).toBeUndefined();
  });

  it('should return undefined for empty string', () => {
    expect(safeJsonParse('')).toBeUndefined();
  });
});

describe('uuid', () => {
  it('should generate valid UUID format', () => {
    const id = uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('should generate unique UUIDs', () => {
    const ids = new Set();
    for (let i = 0; i < 1000; i++) {
      ids.add(uuid());
    }
    expect(ids.size).toBe(1000);
  });
});

describe('truncate', () => {
  it('should not truncate short strings', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('should truncate long strings', () => {
    const result = truncate('this is a long string', 10);
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result).toContain('...');
  });

  it('should use custom suffix', () => {
    expect(truncate('long string', 8, '--')).toBe('long s--');
  });
});

describe('safeExec', () => {
  it('should return ok for successful function', async () => {
    const result = await safeExec(async () => 'success');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe('success');
    }
  });

  it('should return error for failing function', async () => {
    const result = await safeExec(async () => {
      throw new Error('failed');
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('failed');
    }
  });
});

describe('debounce', () => {
  it('should delay execution', async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    debounced();
    debounced();

    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('throttle', () => {
  it('should limit execution frequency', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    throttled();
    throttled();
    throttled();

    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
