/**
 * Async error boundary — catches and handles all promise rejections.
 *
 * Fixes: #051-075 (Promise & async errors), #061-075 (async error handling)
 *
 * Usage:
 * ```ts
 * import { safeAsync, withRetry, withTimeout, onErrorResumeNext } from './async-errors';
 *
 * // Instead of: try { await fn(); } catch (e) { ... }
 * const result = await safeAsync(fn());
 *
 * // Instead of: manual retry loop
 * const result = await withRetry(fn, { maxRetries: 3 });
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('async-errors');

export type AsyncResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: Error };

/**
 * Wrap a promise in a Result type — never throws.
 *
 * @example
 * ```ts
 * const result = await safeAsync(fetchData());
 * if (result.ok) {
 *   console.log(result.data);
 * } else {
 *   console.error(result.error);
 * }
 * ```
 */
export async function safeAsync<T>(promise: Promise<T>): Promise<AsyncResult<T>> {
  try {
    const data = await promise;
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Execute a function with automatic retry on failure.
 *
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => provider.chat(messages),
 *   { maxRetries: 3, baseDelayMs: 1000, isRetryable: isRetryableError }
 * );
 * ```
 */
export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
  isRetryable?: (error: Error) => boolean;
  onRetry?: (attempt: number, error: Error) => void;
}

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  jitter: 0.5,
  isRetryable: () => true,
  onRetry: () => {},
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<AsyncResult<T>> {
  const opts: Required<RetryOptions> = { ...DEFAULT_RETRY, ...options };

  for (let attempt = 0; attempt < opts.maxRetries; attempt++) {
    const result = await safeAsync(fn());

    if (result.ok) return result;

    if (!opts.isRetryable(result.error) || attempt === opts.maxRetries - 1) {
      return result;
    }

    const delay = Math.min(
      opts.baseDelayMs * 2 ** attempt + Math.random() * opts.jitter * opts.baseDelayMs,
      opts.maxDelayMs,
    );

    opts.onRetry(attempt + 1, result.error);
    log.warn(
      { attempt: attempt + 1, maxRetries: opts.maxRetries, delayMs: Math.round(delay), error: result.error.message },
      'Retry after error',
    );

    await new Promise((r) => setTimeout(r, delay));
  }

  // Should not reach here
  return { ok: false, error: new Error('Retry exhausted') };
}

/**
 * Execute a function with timeout — returns Result instead of throwing.
 */
export async function withTimeoutResult<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message?: string,
): Promise<AsyncResult<T>> {
  return safeAsync(
    Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new TimeoutError(message ?? `Timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]),
  );
}

/**
 * Custom timeout error.
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Execute multiple functions, returning the first successful result.
 * Like Promise.any but with Result types.
 *
 * @example
 * ```ts
 * // Try providers in order, return first success
 * const result = await firstSuccess([
 *   () => groqProvider.chat(messages),
 *   () => openaiProvider.chat(messages),
 *   () => fallbackProvider.chat(messages),
 * ]);
 * ```
 */
export async function firstSuccess<T>(
  fns: Array<() => Promise<T>>,
): Promise<AsyncResult<T>> {
  const errors: Error[] = [];

  for (const fn of fns) {
    const result = await safeAsync(fn());
    if (result.ok) return result;
    errors.push(result.error);
  }

  return {
    ok: false,
    error: new AggregateError(errors, 'All functions failed'),
  };
}

/**
 * Execute a function, running cleanup regardless of success/failure.
 * Like try/finally but with Result types.
 */
export async function withCleanup<T>(
  fn: () => Promise<T>,
  cleanup: () => void | Promise<void>,
): Promise<AsyncResult<T>> {
  try {
    return await safeAsync(fn());
  } finally {
    try {
      await cleanup();
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, 'Cleanup failed');
    }
  }
}

/**
 * Execute a function with a fallback if it fails.
 *
 * @example
 * ```ts
 * const result = await withFallback(
 *   () => gpuProvider.process(data),
 *   () => cloudProvider.process(data),
 * );
 * ```
 */
export async function withFallback<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<AsyncResult<T>> {
  const primaryResult = await safeAsync(primary());
  if (primaryResult.ok) return primaryResult;

  log.warn(
    { error: primaryResult.error.message },
    'Primary failed, trying fallback',
  );

  return safeAsync(fallback());
}

/**
 * Execute fire-and-forget with error logging.
 *
 * @example
 * ```ts
 * // Don't await, but log errors
 * fireAndLog(cleanupOldRecords());
 * ```
 */
export function fireAndLog(promise: Promise<unknown>, context = ''): void {
  promise.catch((error) => {
    log.error(
      { error: error instanceof Error ? error.message : String(error), context },
      'Fire-and-forget failed',
    );
  });
}

/**
 * Create an async iterable that stops after a timeout.
 */
export async function* timeoutIterable<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
): AsyncIterable<T> {
  const deadline = Date.now() + timeoutMs;

  for await (const item of iterable) {
    if (Date.now() > deadline) {
      throw new TimeoutError(`Iteration timed out after ${timeoutMs}ms`);
    }
    yield item;
  }
}

/**
 * Wrap all methods of an object with error handling.
 *
 * @example
 * ```ts
 * const safeProvider = wrapAllErrors(provider);
 * const result = await safeProvider.chat(messages); // Returns Result
 * ```
 */
export function wrapAllErrors<T extends Record<string, (...args: unknown[]) => Promise<unknown>>>(
  obj: T,
): { [K in keyof T]: (...args: Parameters<T[K]>) => Promise<AsyncResult<Awaited<ReturnType<T[K]>>>> } {
  const wrapped = {} as Record<string, (...args: unknown[]) => Promise<AsyncResult<unknown>>>;

  for (const [key, fn] of Object.entries(obj)) {
    if (typeof fn === 'function') {
      wrapped[key] = (...args: unknown[]) => safeAsync(fn(...args) as Promise<unknown>);
    }
  }

  return wrapped as { [K in keyof T]: (...args: Parameters<T[K]>) => Promise<AsyncResult<Awaited<ReturnType<T[K]>>>> };
}
