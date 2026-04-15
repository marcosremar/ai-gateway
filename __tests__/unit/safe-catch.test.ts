/**
 * Safe Catch Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  safePromise,
  safeSync,
  safeClose,
  safeCleanup,
  safeCatch,
  withTimeout,
} from '../../src/safe-catch';

vi.mock('../../src/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('safePromise', () => {
  it('should return result on success', async () => {
    const result = await safePromise(Promise.resolve(42), 'test');
    expect(result).toBe(42);
  });

  it('should return default value on failure', async () => {
    const error = new Error('Test error');
    const result = await safePromise(Promise.reject(error), 'test', {
      defaultValue: 'fallback',
    });
    expect(result).toBe('fallback');
  });

  it('should rethrow when rethrow option is true', async () => {
    const error = new Error('Test error');
    await expect(
      safePromise(Promise.reject(error), 'test', { rethrow: true })
    ).rejects.toThrow('Test error');
  });

  it('should handle non-Error rejections', async () => {
    const result = await safePromise(Promise.reject('string error'), 'test', {
      defaultValue: 'fallback',
    });
    expect(result).toBe('fallback');
  });
});

describe('safeSync', () => {
  it('should return result on success', () => {
    const result = safeSync(() => 42, 'test');
    expect(result).toBe(42);
  });

  it('should return default value on failure', () => {
    const result = safeSync(() => { throw new Error('Test'); }, 'test', {
      defaultValue: 'fallback',
    });
    expect(result).toBe('fallback');
  });

  it('should rethrow when rethrow option is true', () => {
    expect(() =>
      safeSync(() => { throw new Error('Test'); }, 'test', { rethrow: true })
    ).toThrow('Test');
  });
});

describe('safeClose', () => {
  it('should call close method', async () => {
    const closeable = { close: vi.fn().mockResolvedValue(undefined) };
    await safeClose(closeable, 'test');
    expect(closeable.close).toHaveBeenCalled();
  });

  it('should call end method if close not available', async () => {
    const closeable = { end: vi.fn().mockResolvedValue(undefined) };
    await safeClose(closeable, 'test');
    expect(closeable.end).toHaveBeenCalled();
  });

  it('should call destroy method if close/end not available', async () => {
    const closeable = { destroy: vi.fn() };
    await safeClose(closeable, 'test');
    expect(closeable.destroy).toHaveBeenCalled();
  });

  it('should handle null resource', async () => {
    // Should not throw with null
    await safeClose(null, 'test');
    expect(true).toBe(true); // If we reach here, it didn't throw
  });

  it('should not throw on close error', async () => {
    const closeable = {
      close: vi.fn().mockRejectedValue(new Error('Close failed')),
    };
    // Should not throw even when close fails
    await safeClose(closeable, 'test');
    expect(closeable.close).toHaveBeenCalled();
  });
});

describe('safeCleanup', () => {
  it('should cleanup multiple resources', async () => {
    const resource1 = { close: vi.fn().mockResolvedValue(undefined) };
    const resource2 = { end: vi.fn().mockResolvedValue(undefined) };
    
    await safeCleanup([
      { name: 'res1', resource: resource1 },
      { name: 'res2', resource: resource2 },
    ]);
    
    expect(resource1.close).toHaveBeenCalled();
    expect(resource2.end).toHaveBeenCalled();
  });
});

describe('safeCatch', () => {
  it('should return a function that logs errors', () => {
    const handler = safeCatch('test-context');
    expect(() => handler(new Error('Test'))).not.toThrow();
  });

  it('should handle string errors', () => {
    const handler = safeCatch('test-context');
    expect(() => handler('string error')).not.toThrow();
  });
});

describe('withTimeout', () => {
  it('should return result if promise resolves in time', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'test');
    expect(result).toBe(42);
  });

  it('should throw timeout error if promise takes too long', async () => {
    const slowPromise = new Promise(resolve => setTimeout(resolve, 100));
    await expect(withTimeout(slowPromise, 50, 'test')).rejects.toThrow('test timed out');
  });
});
