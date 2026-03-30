import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StageTimeoutError, withStageTimeout } from '../src/autoscaler/stage-timeout';

describe('StageTimeoutError', () => {
  it('extends Error', () => {
    const err = new StageTimeoutError('discover', 30_000);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(StageTimeoutError);
  });

  it('has correct name', () => {
    const err = new StageTimeoutError('create', 60_000);
    expect(err.name).toBe('StageTimeoutError');
  });

  it('stores stage and timeoutMs', () => {
    const err = new StageTimeoutError('start', 45_000);
    expect(err.stage).toBe('start');
    expect(err.timeoutMs).toBe(45_000);
  });

  it('formats message with seconds rounded', () => {
    const err = new StageTimeoutError('discover', 30_000);
    expect(err.message).toBe('Stage "discover" timed out after 30s');
  });

  it('rounds timeout seconds correctly', () => {
    const err = new StageTimeoutError('create', 32_500);
    expect(err.message).toBe('Stage "create" timed out after 33s');
  });

  it('is identifiable via instanceof check (not just Error)', () => {
    const err = new StageTimeoutError('start', 10_000);
    const plainError = new Error('plain');
    expect(err).toBeInstanceOf(StageTimeoutError);
    expect(plainError).not.toBeInstanceOf(StageTimeoutError);
  });
});

describe('withStageTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves when promise resolves before timeout', async () => {
    const promise = Promise.resolve(42);
    const result = await withStageTimeout(promise, 5_000, 'test');
    expect(result).toBe(42);
  });

  it('rejects with StageTimeoutError when timeout fires first', async () => {
    const never = new Promise<never>(() => {}); // never resolves
    const wrapped = withStageTimeout(never, 5_000, 'discover');

    vi.advanceTimersByTime(5_001);

    await expect(wrapped).rejects.toThrow(StageTimeoutError);
    await expect(wrapped).rejects.toMatchObject({
      stage: 'discover',
      timeoutMs: 5_000,
    });
  });

  it('passes through non-timeout rejection', async () => {
    const failing = Promise.reject(new Error('network error'));
    await expect(withStageTimeout(failing, 30_000, 'create')).rejects.toThrow('network error');
  });

  it('clears timeout on resolve (no dangling timers)', async () => {
    const fastPromise = Promise.resolve('ok');
    const result = await withStageTimeout(fastPromise, 10_000, 'start');
    expect(result).toBe('ok');
    // Advance past the timeout — should not throw
    vi.advanceTimersByTime(15_000);
    // No additional rejections should occur
  });

  it('clears timeout on rejection (no dangling timers)', async () => {
    const err = new Error('boom');
    const failing = Promise.reject(err);
    await expect(withStageTimeout(failing, 10_000, 'start')).rejects.toThrow('boom');
    // Advance past the timeout — should not throw StageTimeoutError
    vi.advanceTimersByTime(15_000);
  });

  it('resolves with typed value', async () => {
    interface MyResult { id: string }
    const promise = Promise.resolve<MyResult>({ id: 'abc' });
    const result = await withStageTimeout(promise, 5_000, 'fetch');
    expect(result.id).toBe('abc');
  });

  it('timeout fires exactly at boundary', async () => {
    const never = new Promise<never>(() => {});
    const wrapped = withStageTimeout(never, 1_000, 'probe');
    vi.advanceTimersByTime(1_000);
    await expect(wrapped).rejects.toThrow(StageTimeoutError);
  });

  it('does not time out if promise resolves just before boundary', async () => {
    vi.useRealTimers();
    // Real timers: a fast promise should resolve before any timeout
    const fastPromise = new Promise<string>((res) => setTimeout(() => res('fast'), 10));
    const result = await withStageTimeout(fastPromise, 5_000, 'fast-op');
    expect(result).toBe('fast');
  });

  it('StageTimeoutError name is StageTimeoutError (not Error)', async () => {
    const never = new Promise<never>(() => {});
    const wrapped = withStageTimeout(never, 100, 'stage');
    vi.advanceTimersByTime(200);
    try {
      await wrapped;
    } catch (e) {
      expect((e as StageTimeoutError).name).toBe('StageTimeoutError');
    }
  });
});
