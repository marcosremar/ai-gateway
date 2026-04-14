/**
 * Tests for error-boundary module.
 */

import { describe, it, expect, vi } from 'vitest';
import { ErrorBoundary, withErrorBoundary, withAsyncErrorBoundary } from '../../src/error-boundary';

describe('ErrorBoundary', () => {
  it('should catch sync errors', () => {
    const boundary = new ErrorBoundary();
    const result = boundary.runSync(() => {
      throw new Error('Sync error');
    });

    expect(result).toBeUndefined();
    expect(boundary.getStats().errorCount).toBe(1);
  });

  it('should catch async errors', async () => {
    const boundary = new ErrorBoundary();
    const result = await boundary.run(async () => {
      throw new Error('Async error');
    });

    expect(result).toBeUndefined();
    expect(boundary.getStats().errorCount).toBe(1);
  });

  it('should return fallback value', async () => {
    const boundary = new ErrorBoundary({ fallback: 'fallback' });
    const result = await boundary.run(async () => {
      throw new Error('Error');
    });

    expect(result).toBe('fallback');
  });

  it('should rethrow if configured', async () => {
    const boundary = new ErrorBoundary({ rethrow: true });

    await expect(boundary.run(async () => {
      throw new Error('Rethrow');
    })).rejects.toThrow('Rethrow');
  });

  it('should call onError handler', async () => {
    const onError = vi.fn();
    const boundary = new ErrorBoundary({ onError });

    await boundary.run(async () => {
      throw new Error('Test error');
    }, 'test-context');

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('withErrorBoundary', () => {
  it('should wrap sync functions', () => {
    const fn = vi.fn().mockImplementation(() => {
      throw new Error('Error');
    });
    const wrapped = withErrorBoundary(fn, { fallback: 'fallback' });

    expect(wrapped()).toBe('fallback');
  });
});

describe('withAsyncErrorBoundary', () => {
  it('should wrap async functions', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Async error'));
    const wrapped = withAsyncErrorBoundary(fn, { fallback: 'async-fallback' });

    const result = await wrapped();
    expect(result).toBe('async-fallback');
  });
});
