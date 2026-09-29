/**
 * Timeout factory — unified timeout handling.
 *
 * Fixes: #134, #143 (3 different timeout patterns)
 *
 * Usage:
 * ```ts
 * import { withTimeout, withTimeoutSignal } from './timeout';
 *
 * // Pattern 1: Promise timeout
 * const result = await withTimeout(fetch(url), 5000);
 *
 * // Pattern 2: AbortSignal timeout
 * const signal = withTimeoutSignal(5000);
 * const result = await fetch(url, { signal });
 * ```
 */

/**
 * Wrap a promise with a timeout.
 *
 * @example
 * ```ts
 * const result = await withTimeout(fetchData(), 5000, 'Data fetch timed out');
 * ```
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message?: string,
): Promise<T> {
  // Use Promise.race so the timeout actively interrupts the promise, instead
  // of merely setting an AbortController signal that the caller may not check.
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(
      () => reject(new TimeoutError(message ?? `Operation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timerId);
  }
}

/**
 * Create an AbortSignal that auto-aborts after timeout.
 *
 * @example
 * ```ts
 * const signal = withTimeoutSignal(5000);
 * const response = await fetch(url, { signal });
 * ```
 */
export function withTimeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

/**
 * Race a promise against a timeout — returns null on timeout instead of throwing.
 *
 * @example
 * ```ts
 * const result = await tryWithTimeout(fetchData(), 5000);
 * if (result === null) {
 *   console.log('Timed out');
 * }
 * ```
 */
export async function tryWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  try {
    return await withTimeout(promise, timeoutMs);
  } catch {
    return null;
  }
}

/**
 * Custom timeout error class.
 */
export class TimeoutError extends Error {
  public readonly timeoutMs: number;

  constructor(message: string, timeoutMs?: number) {
    super(message);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs ?? 0;
  }
}

/**
 * Execute a function with a timeout.
 *
 * @example
 * ```ts
 * const result = await timeoutCall(() => provider.chat(messages), 30_000);
 * ```
 */
export async function timeoutCall<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  message?: string,
): Promise<T> {
  return withTimeout(fn(), timeoutMs, message);
}
