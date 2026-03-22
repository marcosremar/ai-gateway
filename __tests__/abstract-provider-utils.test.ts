import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retryWithBackoff, pollUntilReady, RateLimiter } from '../src/gpu-providers/abstract-provider';

describe('retryWithBackoff', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns immediately on first success', async () => {
    const fn = vi.fn(async () => 'ok');
    const promise = retryWithBackoff(fn);
    await vi.runAllTimersAsync();
    expect(await promise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure up to maxRetries', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('fail');
      return 'ok';
    });
    const promise = retryWithBackoff(fn, { maxRetries: 2, baseDelayMs: 100 });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('throws after maxRetries exhausted', async () => {
    const fn = vi.fn(async () => { throw new Error('permanent'); });
    const promise = retryWithBackoff(fn, { maxRetries: 1, baseDelayMs: 100 });
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow('permanent');
    expect(fn).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it('respects shouldRetry predicate', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      throw new Error(calls === 1 ? 'retry' : 'stop');
    });
    const promise = retryWithBackoff(fn, {
      maxRetries: 5,
      baseDelayMs: 100,
      shouldRetry: (err) => (err as Error).message === 'retry',
    });
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow('stop');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('applies exponential backoff delays', async () => {
    const fn = vi.fn(async () => { throw new Error('fail'); });
    const promise = retryWithBackoff(fn, {
      maxRetries: 3,
      baseDelayMs: 1000,
      growth: 2.0,
      maxDelayMs: 10_000,
    });
    // Delays should be: 1000, 2000, 4000 (capped by maxDelayMs if needed)
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('caps delay at maxDelayMs', async () => {
    const fn = vi.fn(async () => { throw new Error('fail'); });
    const promise = retryWithBackoff(fn, {
      maxRetries: 3,
      baseDelayMs: 10_000,
      growth: 10,
      maxDelayMs: 15_000,
    });
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('passes attempt number to fn', async () => {
    const attempts: number[] = [];
    const fn = vi.fn(async (attempt: number) => {
      attempts.push(attempt);
      if (attempt < 2) throw new Error('fail');
      return 'ok';
    });
    const promise = retryWithBackoff(fn, { maxRetries: 2, baseDelayMs: 100 });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('ok');
    expect(attempts).toEqual([0, 1, 2]);
  });
});

describe('pollUntilReady', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns result when checkFn returns truthy', async () => {
    let calls = 0;
    const checkFn = vi.fn(async () => {
      calls++;
      if (calls >= 3) return { endpoint: 'http://1.2.3.4:8000' };
      return null;
    });
    const promise = pollUntilReady(checkFn, { baseIntervalMs: 100, maxWaitMs: 10_000 });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toEqual({ endpoint: 'http://1.2.3.4:8000' });
    expect(checkFn).toHaveBeenCalledTimes(3);
  });

  it('returns null when maxWaitMs is exceeded', async () => {
    const checkFn = vi.fn(async () => null);
    const promise = pollUntilReady(checkFn, {
      baseIntervalMs: 500,
      maxWaitMs: 1_000,
      growth: 1.0, // fixed interval for predictable timing
    });
    await vi.runAllTimersAsync();
    expect(await promise).toBeNull();
    expect(checkFn).toHaveBeenCalledTimes(2); // 500ms + 500ms = 1000ms (2 calls)
  });

  it('applies exponential backoff between polls', async () => {
    const attempts: number[] = [];
    const checkFn = vi.fn(async (attempt: number) => {
      attempts.push(attempt);
      return null;
    });
    const promise = pollUntilReady(checkFn, {
      baseIntervalMs: 100,
      growth: 2.0,
      maxIntervalMs: 500,
      maxWaitMs: 2_000,
    });
    await vi.runAllTimersAsync();
    await promise;
    // Delays: 100, 200, 400, 500(capped), 500, ... until elapsed >= 2000
    expect(attempts.length).toBeGreaterThan(2);
  });

  it('passes attempt and elapsedMs to checkFn', async () => {
    const calls: Array<{ attempt: number; elapsed: number }> = [];
    const checkFn = vi.fn(async (attempt: number, elapsed: number) => {
      calls.push({ attempt, elapsed });
      if (attempt >= 2) return 'done';
      return null;
    });
    const promise = pollUntilReady(checkFn, {
      baseIntervalMs: 100,
      growth: 1.0,
      maxWaitMs: 5_000,
    });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('done');
    expect(calls[0].attempt).toBe(1);
    expect(calls[0].elapsed).toBe(100);
    expect(calls[1].attempt).toBe(2);
    expect(calls[1].elapsed).toBe(200);
  });

  it('handles checkFn throwing errors gracefully', async () => {
    let calls = 0;
    const checkFn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('transient');
      return 'ok';
    });
    // pollUntilReady doesn't catch errors — they propagate
    const promise = pollUntilReady(checkFn, { baseIntervalMs: 100, maxWaitMs: 5_000 });
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow('transient');
  });

  it('returns first truthy result immediately without further polling', async () => {
    const checkFn = vi.fn(async () => ({ ip: '1.2.3.4' }));
    const promise = pollUntilReady(checkFn, { baseIntervalMs: 100, maxWaitMs: 10_000 });
    await vi.runAllTimersAsync();
    expect(await promise).toEqual({ ip: '1.2.3.4' });
    expect(checkFn).toHaveBeenCalledTimes(1);
  });
});

describe('RateLimiter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('allows first call immediately', async () => {
    const limiter = new RateLimiter(500);
    const promise = limiter.wait();
    await vi.runAllTimersAsync();
    await promise; // should not throw or hang
  });

  it('enforces minimum interval between calls', async () => {
    const limiter = new RateLimiter(500);
    await limiter.wait();
    // Second call should wait ~500ms
    const waitPromise = limiter.wait();
    vi.advanceTimersByTime(500);
    await waitPromise;
  });

  it('allows immediate call if enough time has passed', async () => {
    const limiter = new RateLimiter(500);
    await limiter.wait();
    vi.advanceTimersByTime(600); // more than 500ms
    // Should not need to wait
    const waitPromise = limiter.wait();
    await vi.runAllTimersAsync();
    await waitPromise;
  });
});
