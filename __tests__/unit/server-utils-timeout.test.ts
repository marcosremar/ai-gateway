// Unit tests for server/utils/timeout.ts
// Verifies that withTimeout actually races against the timeout (the original
// implementation used AbortController but never connected the signal to the
// promise, so it never enforced any deadline).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  withTimeout,
  withTimeoutSignal,
  tryWithTimeout,
  timeoutCall,
  TimeoutError,
} from '../../server/utils/timeout';

// ── helpers ──────────────────────────────────────────────────────────────────

function forever<T = never>(): Promise<T> {
  return new Promise<T>(() => { /* never resolves */ });
}

function resolveAfter<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function rejectAfter(err: Error, ms: number): Promise<never> {
  // Attach a no-op rejection handler immediately so Node.js doesn't flag it as
  // unhandled when it fires before our test assertion catches it.
  const p = new Promise<never>((_, reject) => setTimeout(() => reject(err), ms));
  p.catch(() => undefined);
  return p;
}

// ── withTimeout ───────────────────────────────────────────────────────────────

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the promise value when it completes before the deadline', async () => {
    const promise = resolveAfter('hello', 100);
    const p = withTimeout(promise, 5000);
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe('hello');
  });

  it('rejects with TimeoutError when the promise does not settle in time', async () => {
    // Attach rejection handler before advancing timers to avoid unhandled-rejection warning.
    const p = withTimeout(forever(), 200);
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
  });

  it('includes the default message when no message is provided', async () => {
    const p = withTimeout(forever(), 250);
    const assertion = expect(p).rejects.toThrow('Operation timed out after 250ms');
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
  });

  it('uses the custom message when provided', async () => {
    const p = withTimeout(forever(), 100, 'GPU deploy timed out');
    const assertion = expect(p).rejects.toThrow('GPU deploy timed out');
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('TimeoutError has name=TimeoutError', async () => {
    const p = withTimeout(forever(), 50);
    p.catch(() => undefined); // suppress unhandled rejection
    await vi.advanceTimersByTimeAsync(50);
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      expect((e as TimeoutError).name).toBe('TimeoutError');
    }
  });

  it('re-throws the original error when the promise rejects before the deadline', async () => {
    const originalError = new Error('network error');
    const p = withTimeout(rejectAfter(originalError, 100), 5000);
    const assertion = expect(p).rejects.toBe(originalError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('does NOT trigger timeout when promise resolves just before the deadline', async () => {
    const p = withTimeout(resolveAfter('ok', 99), 100);
    await vi.advanceTimersByTimeAsync(99);
    await expect(p).resolves.toBe('ok');
  });

  it('clears the internal timer when promise resolves (no timer leak)', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    const p = withTimeout(resolveAfter('v', 10), 1000);
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(clearSpy).toHaveBeenCalled();
  });

  it('clears the internal timer when promise rejects before the deadline (no timer leak)', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    const err = new Error('boom');
    const p = withTimeout(rejectAfter(err, 10), 1000).catch(() => null);
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(clearSpy).toHaveBeenCalled();
  });

  it('resolves with undefined when the promise yields undefined', async () => {
    const p = withTimeout(resolveAfter(undefined, 10), 1000);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBeUndefined();
  });

  it('resolves with null when the promise yields null', async () => {
    const p = withTimeout(resolveAfter(null, 10), 1000);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBeNull();
  });

  it('resolves with an object value', async () => {
    const obj = { a: 1, b: 'two' };
    const p = withTimeout(resolveAfter(obj, 10), 1000);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe(obj);
  });

  it('times out a promise that resolves much later than the deadline', async () => {
    const p = withTimeout(resolveAfter('late', 10_000), 200);
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
  });
});

// ── TimeoutError ──────────────────────────────────────────────────────────────

describe('TimeoutError', () => {
  it('is an instance of Error', () => {
    const e = new TimeoutError('msg');
    expect(e).toBeInstanceOf(Error);
  });

  it('has name=TimeoutError', () => {
    expect(new TimeoutError('msg').name).toBe('TimeoutError');
  });

  it('stores the message', () => {
    expect(new TimeoutError('timed out').message).toBe('timed out');
  });

  it('defaults timeoutMs to 0 when not provided', () => {
    expect(new TimeoutError('msg').timeoutMs).toBe(0);
  });

  it('stores an explicit timeoutMs when provided', () => {
    expect(new TimeoutError('msg', 5000).timeoutMs).toBe(5000);
  });

  it('is caught by an Error catch clause', () => {
    expect(() => { throw new TimeoutError('t'); }).toThrow(Error);
  });
});

// ── tryWithTimeout ────────────────────────────────────────────────────────────

describe('tryWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the resolved value when the promise settles in time', async () => {
    const p = tryWithTimeout(resolveAfter(42, 50), 1000);
    await vi.advanceTimersByTimeAsync(50);
    await expect(p).resolves.toBe(42);
  });

  it('returns null on timeout instead of throwing', async () => {
    const p = tryWithTimeout(forever(), 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBeNull();
  });

  it('returns null when the promise rejects (swallows error)', async () => {
    const p = tryWithTimeout(rejectAfter(new Error('boom'), 50), 1000);
    await vi.advanceTimersByTimeAsync(50);
    await expect(p).resolves.toBeNull();
  });

  it('returns null for both timeout and rejection paths', async () => {
    const p1 = tryWithTimeout(forever(), 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await p1).toBeNull();

    const p2 = tryWithTimeout(rejectAfter(new Error('e'), 30), 1000);
    await vi.advanceTimersByTimeAsync(30);
    expect(await p2).toBeNull();
  });
});

// ── timeoutCall ───────────────────────────────────────────────────────────────

describe('timeoutCall', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls the function and returns its result when fast enough', async () => {
    const fn = vi.fn(() => resolveAfter('result', 10));
    const p = timeoutCall(fn, 1000);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('result');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('rejects with TimeoutError when the function is too slow', async () => {
    const fn = vi.fn(() => forever<string>());
    const p = timeoutCall(fn, 200);
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
    expect(fn).toHaveBeenCalledOnce();
  });

  it('passes the custom message to the TimeoutError', async () => {
    const p = timeoutCall(() => forever(), 100, 'LLM call timed out');
    const assertion = expect(p).rejects.toThrow('LLM call timed out');
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('re-throws the original function error when it rejects before the deadline', async () => {
    const boom = new Error('fn error');
    const p = timeoutCall(() => rejectAfter(boom, 50), 1000);
    const assertion = expect(p).rejects.toBe(boom);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it('calls the function exactly once', async () => {
    const fn = vi.fn(() => resolveAfter(1, 10));
    const p = timeoutCall(fn, 5000);
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ── withTimeoutSignal ─────────────────────────────────────────────────────────

describe('withTimeoutSignal', () => {
  it('returns an AbortSignal', () => {
    const signal = withTimeoutSignal(5000);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('is not aborted immediately', () => {
    const signal = withTimeoutSignal(5000);
    expect(signal.aborted).toBe(false);
  });

  it('exposes addEventListener as a function (usable with fetch)', () => {
    const signal = withTimeoutSignal(1000);
    expect(typeof signal.addEventListener).toBe('function');
  });
});
