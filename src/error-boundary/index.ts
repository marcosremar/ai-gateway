/**
 * Error Boundary — catches and handles errors at module boundaries.
 *
 * Fixes: #051-075 (async errors), #301-320 (error handling patterns)
 *
 * Usage:
 * ```ts
 * import { errorBoundary, withErrorBoundary } from './error-boundary';
 *
 * // Wrap a function
 * const safeFn = withErrorBoundary(riskyFn, {
 *   fallback: () => defaultResult,
 *   onError: (err) => log.error(err),
 * });
 *
 * // Or use the class
 * const boundary = new ErrorBoundary();
 * const result = await boundary.run(async () => doWork());
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('error-boundary');

export interface ErrorBoundaryOptions {
  /** Fallback value on error */
  fallback?: unknown;
  /** Called when error occurs */
  onError?: (error: Error, context?: string) => void;
  /** Whether to rethrow after handling */
  rethrow?: boolean;
  /** Context string for logging */
  context?: string;
}

const DEFAULT_OPTIONS: Required<Omit<ErrorBoundaryOptions, 'fallback'>> & { fallback?: unknown } = {
  fallback: undefined,
  onError: (error, context) => {
    log.error({ error: error.message, context }, 'Error boundary caught');
  },
  rethrow: false,
  context: 'unknown',
};

export class ErrorBoundary {
  private options: Required<Omit<ErrorBoundaryOptions, 'fallback'>> & { fallback?: unknown };
  private errorCount = 0;
  private lastError: Error | null = null;

  constructor(options: ErrorBoundaryOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Run a function within the boundary.
   */
  async run<T>(fn: () => Promise<T>, context?: string): Promise<T | undefined> {
    try {
      const result = await fn();
      return result;
    } catch (error) {
      this.errorCount++;
      this.lastError = error instanceof Error ? error : new Error(String(error));

      this.options.onError(this.lastError, context ?? this.options.context);

      if (this.options.rethrow) {
        throw this.lastError;
      }

      return this.options.fallback as T | undefined;
    }
  }

  /**
   * Sync version of run.
   */
  runSync<T>(fn: () => T, context?: string): T | undefined {
    try {
      return fn();
    } catch (error) {
      this.errorCount++;
      this.lastError = error instanceof Error ? error : new Error(String(error));

      this.options.onError(this.lastError, context ?? this.options.context);

      if (this.options.rethrow) {
        throw this.lastError;
      }

      return this.options.fallback as T | undefined;
    }
  }

  /**
   * Get error statistics.
   */
  getStats(): { errorCount: number; lastError: Error | null } {
    return {
      errorCount: this.errorCount,
      lastError: this.lastError,
    };
  }

  /**
   * Reset error count.
   */
  reset(): void {
    this.errorCount = 0;
    this.lastError = null;
  }
}

/**
 * Wrap a function with an error boundary.
 */
export function withErrorBoundary<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => TReturn,
  options: ErrorBoundaryOptions = {},
): (...args: TArgs) => TReturn | undefined {
  const boundary = new ErrorBoundary(options);

  return (...args: TArgs) => {
    return boundary.runSync(() => fn(...args), options.context);
  };
}

/**
 * Wrap an async function with an error boundary.
 */
export function withAsyncErrorBoundary<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  options: ErrorBoundaryOptions = {},
): (...args: TArgs) => Promise<TReturn | undefined> {
  const boundary = new ErrorBoundary(options);

  return async (...args: TArgs) => {
    return boundary.run(() => fn(...args), options.context);
  };
}
