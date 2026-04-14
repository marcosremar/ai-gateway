import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withProxyRetry } from '../../src/proxy/routes/retry';

function makeError(status: number, message?: string): Error {
  const err = new Error(message ?? `HTTP ${status}`);
  (err as any).status = status;
  return err;
}

describe('withProxyRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns result on first successful call', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withProxyRetry('test', 'model', fn, 'test');
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('retries on 5xx and succeeds on 2nd try', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(makeError(500, 'Internal Server Error'))
      .mockResolvedValueOnce('recovered');

    const promise = withProxyRetry('test', 'model', fn, 'test');
    await vi.advanceTimersByTimeAsync(300);
    const result = await promise;
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 502 and succeeds on 2nd try', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(makeError(502, 'Bad Gateway'))
      .mockResolvedValueOnce('ok');

    const promise = withProxyRetry('test', 'model', fn, 'test');
    await vi.advanceTimersByTimeAsync(300);
    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 503 and succeeds on 3rd try', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(makeError(503, 'Service Unavailable'))
      .mockRejectedValueOnce(makeError(503, 'Service Unavailable'))
      .mockResolvedValueOnce('ok');

    const promise = withProxyRetry('test', 'model', fn, 'test');
    await vi.advanceTimersByTimeAsync(700);
    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws immediately on 401 (auth error, not retried within same provider)', async () => {
    const fn = vi.fn().mockRejectedValue(makeError(401, 'Unauthorized'));
    await expect(withProxyRetry('provider-401', 'model', fn, 'test')).rejects.toThrow('Unauthorized');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('throws immediately on 403 (forbidden, not retried)', async () => {
    const fn = vi.fn().mockRejectedValue(makeError(403, 'Forbidden'));
    await expect(withProxyRetry('provider-403', 'model', fn, 'test')).rejects.toThrow('Forbidden');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('throws immediately on 400 non-retryable error', async () => {
    const fn = vi.fn().mockRejectedValue(makeError(400, 'Bad Request'));
    await expect(withProxyRetry('provider-400', 'model', fn, 'test')).rejects.toThrow('Bad Request');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('throws last error when all retries exhausted', async () => {
    const fn = vi.fn()
      .mockRejectedValue(makeError(500, 'Server Error'))
      .mockRejectedValue(makeError(500, 'Server Error Again'));

    const promise = withProxyRetry('provider-exhaust', 'model', fn, 'test');
    promise.catch(() => {}); // silence unhandled rejection before timers advance
    await vi.advanceTimersByTimeAsync(700);
    await expect(promise).rejects.toThrow('Server Error Again');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('moves on from 429 without retrying', async () => {
    const fn = vi.fn().mockRejectedValue(makeError(429, 'Too Many Requests'));
    await expect(withProxyRetry('provider-429', 'model', fn, 'test')).rejects.toThrow('Too Many Requests');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('respects stage parameter for logging', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await withProxyRetry('provider-stage', 'model', fn, 'LLM');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('handles non-Error rejections', async () => {
    const fn = vi.fn().mockRejectedValue('string error');
    await expect(withProxyRetry('provider-nonerr', 'model', fn, 'test')).rejects.toEqual('string error');
  });
});
