/**
 * Shared utility functions used across the gateway.
 * Centralizes common patterns (retry, timeout, backoff, etc.)
 * to avoid duplication.
 */

import { createLogger } from '../logger';

const log = createLogger('utils');

// ── Retry with Exponential Backoff ──────────────────────────────────────────

export interface RetryOptions {
  /** Max number of attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay in ms (default: 1000) */
  baseDelayMs?: number;
  /** Max delay cap in ms (default: 30000) */
  maxDelayMs?: number;
  /** Jitter factor 0-1 (default: 0.5) */
  jitter?: number;
  /** Function to determine if error is retryable (default: all errors) */
  isRetryable?: (error: Error) => boolean;
  /** Optional callback per attempt (0-indexed) */
  onAttempt?: (attempt: number, error?: Error) => void;
}

export const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitter: 0.5,
  isRetryable: () => true,
  onAttempt: () => {},
};

/**
 * Execute an async function with exponential backoff retry.
 *
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => provider.chat(messages),
 *   { maxAttempts: 3, baseDelayMs: 500 }
 * );
 * ```
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const opts: Required<RetryOptions> = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      opts.onAttempt(attempt);
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (!opts.isRetryable(lastError) || attempt === opts.maxAttempts - 1) {
        throw lastError;
      }

      const delay = Math.min(
        opts.baseDelayMs * 2 ** attempt + Math.random() * opts.jitter * opts.baseDelayMs,
        opts.maxDelayMs,
      );

      log.warn(
        `Attempt ${attempt + 1}/${opts.maxAttempts} failed, retrying in ${Math.round(delay)}ms`,
        {
          error: lastError.message,
        },
      );

      await sleep(delay);
    }
  }

  throw lastError; // Should never reach here
}

// ── Timeout ─────────────────────────────────────────────────────────────────

/**
 * Wrap a promise with a timeout.
 *
 * @example
 * ```ts
 * const result = await withTimeout(fetchData(url), 5000);
 * ```
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message?: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new TimeoutError(message ?? `Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

// ── Sleep ───────────────────────────────────────────────────────────────────

/**
 * Sleep for a given number of milliseconds.
 * Returns a promise that resolves after the delay.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Debounce ────────────────────────────────────────────────────────────────

/**
 * Create a debounced version of a function that delays execution
 * until after `waitMs` have elapsed since the last call.
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  waitMs: number,
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), waitMs);
  };
}

// ── Throttle ────────────────────────────────────────────────────────────────

/**
 * Create a throttled version of a function that only executes
 * at most once per `intervalMs`.
 */
export function throttle<T extends (...args: unknown[]) => void>(
  fn: T,
  intervalMs: number,
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    const now = Date.now();
    const remaining = intervalMs - (now - lastCall);

    if (remaining <= 0) {
      lastCall = now;
      fn(...args);
    } else if (!timeout) {
      timeout = setTimeout(() => {
        lastCall = Date.now();
        timeout = null;
        fn(...args);
      }, remaining);
    }
  };
}

// ── Safe JSON Parse ─────────────────────────────────────────────────────────

/**
 * Parse JSON safely, returning undefined on failure instead of throwing.
 */
export function safeJsonParse<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

// ── Deep Clone (simple) ─────────────────────────────────────────────────────

/**
 * Deep clone a plain object using structuredClone (native) or JSON fallback.
 */
export function deepClone<T>(obj: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(obj);
  }
  return JSON.parse(JSON.stringify(obj)) as T;
}

// ── Pick / Omit helpers ─────────────────────────────────────────────────────

/**
 * Pick specific keys from an object.
 */
export function pick<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[],
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key] as Pick<T, K>[K];
    }
  }
  return result;
}

/**
 * Omit specific keys from an object.
 */
export function omit<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[],
): Omit<T, K> {
  const result = { ...obj };
  for (const key of keys) {
    delete result[key];
  }
  return result as Omit<T, K>;
}

// ── UUID (lightweight) ──────────────────────────────────────────────────────

/**
 * Generate a v4 UUID without external dependencies.
 */
export function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Truncate ────────────────────────────────────────────────────────────────

/**
 * Truncate a string to max length, appending suffix if truncated.
 */
export function truncate(str: string, maxLength: number, suffix = '...'): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - suffix.length) + suffix;
}

// ── Safe Execute ────────────────────────────────────────────────────────────

/**
 * Execute a function and return { ok, data, error } instead of throwing.
 *
 * @example
 * ```ts
 * const result = await safeExec(() => riskyOperation());
 * if (result.ok) { console.log(result.data); }
 * else { log.error(result.error); }
 * ```
 */
export async function safeExec<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; error: Error }> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

// ── Batch Processor ─────────────────────────────────────────────────────────

/**
 * Process items in batches with a concurrency limit.
 *
 * @example
 * ```ts
 * const results = await processBatch(items, 5, async (item) => process(item));
 * ```
 */
export async function processBatch<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await fn(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}
