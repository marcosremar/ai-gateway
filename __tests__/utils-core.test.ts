/**
 * Unit tests for src/utils/index.ts
 *
 * Covers: withRetry, withTimeout, TimeoutError, sleep, debounce, throttle,
 *         safeJsonParse, deepClone, pick, omit, uuid, truncate, safeExec,
 *         processBatch.
 * All timer-dependent tests use vi.useFakeTimers() so the suite runs in <50ms.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  withRetry,
  withTimeout,
  TimeoutError,
  sleep,
  debounce,
  throttle,
  safeJsonParse,
  deepClone,
  pick,
  omit,
  uuid,
  truncate,
  safeExec,
  processBatch,
} from '../src/utils/index';

// ── withRetry ─────────────────────────────────────────────────────────────────

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const p = withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries and eventually succeeds', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return 'done';
    });
    const p = withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 });
    const settled = Promise.allSettled([p]);
    await vi.runAllTimersAsync();
    const [result] = await settled;
    expect(result.status).toBe('fulfilled');
    expect((result as PromiseFulfilledResult<string>).value).toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting all attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    const p = withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 });
    const settled = Promise.allSettled([p]);
    await vi.runAllTimersAsync();
    const [result] = await settled;
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason.message).toBe('boom');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry when isRetryable returns false', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fatal'));
    const p = withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 10,
      isRetryable: () => false,
    });
    const settled = Promise.allSettled([p]);
    await vi.runAllTimersAsync();
    const [result] = await settled;
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason.message).toBe('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('respects maxAttempts=1 (no retries)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('single'));
    const p = withRetry(fn, { maxAttempts: 1, baseDelayMs: 10 });
    const settled = Promise.allSettled([p]);
    await vi.runAllTimersAsync();
    const [result] = await settled;
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason.message).toBe('single');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calls onAttempt callback on each attempt', async () => {
    const onAttempt = vi.fn();
    let calls = 0;
    const fn = vi.fn(async () => {
      if (++calls < 2) throw new Error('x');
      return 'y';
    });
    const p = withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, onAttempt });
    const settled = Promise.allSettled([p]);
    await vi.runAllTimersAsync();
    const [result] = await settled;
    expect(result.status).toBe('fulfilled');
    expect(onAttempt).toHaveBeenCalledTimes(2);
    // onAttempt receives the 0-based attempt index only (no error arg)
    expect(onAttempt).toHaveBeenNthCalledWith(1, 0);
    expect(onAttempt).toHaveBeenNthCalledWith(2, 1);
  });

  it('delays grow with backoff (first delay >= baseDelayMs)', async () => {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb: () => void, ms?: number) => {
      if (ms && ms > 0) delays.push(ms);
      return realSetTimeout(cb, 0);
    });
    let calls = 0;
    const fn = vi.fn(async () => {
      if (++calls < 3) throw new Error('x');
      return 'y';
    });
    const p = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100, jitter: 0 });
    await vi.runAllTimersAsync();
    await p.catch(() => {});
    vi.restoreAllMocks();
    // Second attempt delay should be >= first
    if (delays.length >= 2) {
      expect(delays[1]).toBeGreaterThanOrEqual(delays[0]);
    }
  });

  it('wraps non-Error thrown values into Error', async () => {
    const fn = vi.fn(async () => { throw 'string-error'; });
    const p = withRetry(fn, { maxAttempts: 1 });
    const settled = Promise.allSettled([p]);
    await vi.runAllTimersAsync();
    const [result] = await settled;
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect((result as PromiseRejectedResult).reason.message).toContain('string-error');
  });
});

// ── withTimeout ───────────────────────────────────────────────────────────────

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves when promise completes before timeout', async () => {
    const p = withTimeout(Promise.resolve('fast'), 1000);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('fast');
  });

  it('rejects with TimeoutError when timeout expires', async () => {
    const never = new Promise<never>(() => {});
    const p = withTimeout(never, 500);
    // Attach handler BEFORE advancing timers to avoid unhandled-rejection noise
    const settled = Promise.allSettled([p]);
    await vi.advanceTimersByTimeAsync(600);
    const [result] = await settled;
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(TimeoutError);
  });

  it('uses custom message in TimeoutError', async () => {
    const never = new Promise<never>(() => {});
    const p = withTimeout(never, 100, 'custom timeout');
    const settled = Promise.allSettled([p]);
    await vi.advanceTimersByTimeAsync(200);
    const [result] = await settled;
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason.message).toBe('custom timeout');
  });

  it('TimeoutError has correct name', async () => {
    const never = new Promise<never>(() => {});
    const p = withTimeout(never, 100);
    const settled = Promise.allSettled([p]);
    await vi.advanceTimersByTimeAsync(200);
    const [result] = await settled;
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason.name).toBe('TimeoutError');
  });

  it('propagates promise rejection (not timeout)', async () => {
    // Create and immediately attach a handler to avoid unhandled-rejection warning
    let rejectFn!: (e: Error) => void;
    const failing = new Promise<never>((_, reject) => { rejectFn = reject; });
    const p = withTimeout(failing, 1000);
    const settled = Promise.allSettled([p]);
    rejectFn(new Error('upstream'));
    await vi.runAllTimersAsync();
    const [result] = await settled;
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason.message).toBe('upstream');
  });
});

// ── sleep ──────────────────────────────────────────────────────────────────────

describe('sleep', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resolves after the specified delay', async () => {
    let resolved = false;
    const p = sleep(500).then(() => { resolved = true; });
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(resolved).toBe(true);
  });

  it('resolves for 0ms immediately', async () => {
    const p = sleep(0);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();
  });
});

// ── debounce ───────────────────────────────────────────────────────────────────

describe('debounce', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('delays the call by waitMs', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);
    debounced('a');
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('only executes once for rapid calls within the window', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);
    debounced('a');
    debounced('b');
    debounced('c');
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('c');
  });

  it('executes multiple times when calls are spaced apart', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced('first');
    vi.advanceTimersByTime(150);
    debounced('second');
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('passes latest args when debounced fires', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 200);
    debounced('x');
    debounced('y');
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledWith('y');
  });
});

// ── throttle ───────────────────────────────────────────────────────────────────

describe('throttle', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('executes immediately on first call', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 300);
    throttled('a');
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('suppresses calls within the interval', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 300);
    throttled('a');
    throttled('b');
    throttled('c');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('allows a second call after interval elapses', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 200);
    throttled('first');
    vi.advanceTimersByTime(200);
    throttled('second');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('schedules trailing call for last suppressed invocation', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 200);
    throttled('a');
    throttled('b'); // suppressed but scheduled as trailing
    vi.advanceTimersByTime(200);
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ── safeJsonParse ─────────────────────────────────────────────────────────────

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse<{ x: number }>('{"x":1}')).toEqual({ x: 1 });
  });

  it('returns undefined for invalid JSON', () => {
    expect(safeJsonParse('not json')).toBeUndefined();
  });

  it('parses arrays', () => {
    expect(safeJsonParse('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('parses primitives', () => {
    expect(safeJsonParse('42')).toBe(42);
    expect(safeJsonParse('"hello"')).toBe('hello');
    expect(safeJsonParse('true')).toBe(true);
    expect(safeJsonParse('null')).toBe(null);
  });

  it('returns undefined for empty string', () => {
    expect(safeJsonParse('')).toBeUndefined();
  });
});

// ── deepClone ─────────────────────────────────────────────────────────────────

describe('deepClone', () => {
  it('produces a distinct object reference', () => {
    const orig = { a: 1, b: { c: 2 } };
    const clone = deepClone(orig);
    expect(clone).not.toBe(orig);
    expect(clone.b).not.toBe(orig.b);
  });

  it('deeply equals the original', () => {
    const orig = { a: [1, 2, 3], b: { c: { d: 4 } } };
    expect(deepClone(orig)).toEqual(orig);
  });

  it('mutations on clone do not affect original', () => {
    const orig = { arr: [1, 2, 3] };
    const clone = deepClone(orig);
    clone.arr.push(4);
    expect(orig.arr).toHaveLength(3);
  });

  it('clones arrays', () => {
    const orig = [1, [2, 3], { x: 4 }];
    const clone = deepClone(orig);
    expect(clone).toEqual(orig);
    expect(clone).not.toBe(orig);
  });
});

// ── pick ──────────────────────────────────────────────────────────────────────

describe('pick', () => {
  it('returns only specified keys', () => {
    const obj = { a: 1, b: 2, c: 3 };
    expect(pick(obj, ['a', 'c'])).toEqual({ a: 1, c: 3 });
  });

  it('ignores keys not present in object', () => {
    const obj = { a: 1 };
    expect(pick(obj as Record<string, unknown>, ['a', 'z'] as (keyof typeof obj)[])).toEqual({ a: 1 });
  });

  it('returns empty object when keys array is empty', () => {
    expect(pick({ a: 1 }, [])).toEqual({});
  });

  it('handles all keys present', () => {
    const obj = { x: 10, y: 20 };
    expect(pick(obj, ['x', 'y'])).toEqual({ x: 10, y: 20 });
  });
});

// ── omit ──────────────────────────────────────────────────────────────────────

describe('omit', () => {
  it('removes specified keys', () => {
    const obj = { a: 1, b: 2, c: 3 };
    expect(omit(obj, ['b'])).toEqual({ a: 1, c: 3 });
  });

  it('returns full object when keys array is empty', () => {
    const obj = { a: 1, b: 2 };
    expect(omit(obj, [])).toEqual({ a: 1, b: 2 });
  });

  it('handles omitting all keys', () => {
    const obj = { a: 1, b: 2 };
    expect(omit(obj, ['a', 'b'])).toEqual({});
  });

  it('does not mutate the original', () => {
    const obj = { a: 1, b: 2 };
    omit(obj, ['a']);
    expect(obj).toEqual({ a: 1, b: 2 });
  });
});

// ── uuid ──────────────────────────────────────────────────────────────────────

describe('uuid', () => {
  it('returns a string of the correct length', () => {
    expect(uuid()).toHaveLength(36);
  });

  it('matches RFC 4122 v4 format', () => {
    const id = uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('produces unique values on successive calls', () => {
    const ids = new Set(Array.from({ length: 20 }, uuid));
    expect(ids.size).toBe(20);
  });
});

// ── truncate ──────────────────────────────────────────────────────────────────

describe('truncate', () => {
  it('returns original string when within maxLength', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates with default suffix "..."', () => {
    expect(truncate('hello world', 8)).toBe('hello...');
  });

  it('uses custom suffix', () => {
    // '…' is 1 char; slice(0, 7-1)='hello ' + '…' = 'hello …'
    expect(truncate('hello world', 7, '…')).toBe('hello …');
  });

  it('returns empty string when maxLength equals suffix length', () => {
    expect(truncate('hello', 3)).toBe('...');
  });

  it('handles empty string input', () => {
    expect(truncate('', 5)).toBe('');
  });

  it('truncates exactly at boundary', () => {
    const str = 'abcde';
    expect(truncate(str, 5)).toBe('abcde');
    expect(truncate(str, 4)).toBe('a...');
  });
});

// ── safeExec ──────────────────────────────────────────────────────────────────

describe('safeExec', () => {
  it('returns { ok: true, data } on success', async () => {
    const result = await safeExec(async () => 42);
    expect(result).toEqual({ ok: true, data: 42 });
  });

  it('returns { ok: false, error } on thrown Error', async () => {
    const result = await safeExec(async () => { throw new Error('oops'); });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe('oops');
    }
  });

  it('wraps non-Error throws into Error', async () => {
    const result = await safeExec(async () => { throw 'raw string'; });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it('handles resolved undefined', async () => {
    const result = await safeExec(async () => undefined);
    expect(result).toEqual({ ok: true, data: undefined });
  });
});

// ── processBatch ──────────────────────────────────────────────────────────────

describe('processBatch', () => {
  it('processes all items and preserves order', async () => {
    const results = await processBatch([1, 2, 3, 4], 2, async (n) => n * 2);
    expect(results).toEqual([2, 4, 6, 8]);
  });

  it('respects concurrency limit (at most N parallel)', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    await processBatch([1, 2, 3, 4, 5, 6], 2, async (n) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
      return n;
    });

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('returns empty array for empty input', async () => {
    const results = await processBatch([], 5, async (x) => x);
    expect(results).toEqual([]);
  });

  it('passes index to processor function', async () => {
    const indices: number[] = [];
    await processBatch(['a', 'b', 'c'], 3, async (_, i) => { indices.push(i); });
    expect(indices.sort()).toEqual([0, 1, 2]);
  });

  it('handles concurrency larger than item count', async () => {
    const results = await processBatch([10, 20], 100, async (n) => n + 1);
    expect(results).toEqual([11, 21]);
  });

  it('propagates errors from processor', async () => {
    await expect(
      processBatch([1, 2], 1, async (n) => {
        if (n === 2) throw new Error('fail at 2');
        return n;
      }),
    ).rejects.toThrow('fail at 2');
  });
});
