/**
 * Retry Policy Engine — configurable retry strategies.
 *
 * Fixes: #983 (retry pattern), #993 (retry patterns)
 *
 * Usage:
 * ```ts
 * import { retryPolicy, createRetryPolicy } from './retry-policy';
 *
 * // Define a policy
 * const policy = createRetryPolicy({
 *   maxAttempts: 3,
 *   backoff: 'exponential',
 *   baseDelayMs: 1000,
 *   isRetryable: (err) => err.code === 'NETWORK_ERROR',
 * });
 *
 * // Execute with retry
 * const result = await policy.execute(() => provider.chat(messages));
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('retry-policy');

export type BackoffStrategy = 'fixed' | 'linear' | 'exponential' | 'jittered';

export interface RetryPolicyOptions {
  /** Max retry attempts (default: 3) */
  maxAttempts?: number;
  /** Backoff strategy (default: 'exponential') */
  backoff?: BackoffStrategy;
  /** Base delay in ms (default: 1000) */
  baseDelayMs?: number;
  /** Max delay cap in ms (default: 30000) */
  maxDelayMs?: number;
  /** Jitter factor 0-1 (default: 0.5) */
  jitter?: number;
  /** Check if error is retryable (default: all errors) */
  isRetryable?: (error: Error) => boolean;
  /** Called before each retry */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<RetryPolicyOptions> = {
  maxAttempts: 3,
  backoff: 'exponential',
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  jitter: 0.5,
  isRetryable: () => true,
  onRetry: () => {},
};

/**
 * Calculate delay for next retry attempt.
 */
function calculateDelay(
  attempt: number,
  strategy: BackoffStrategy,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: number,
): number {
  let delay: number;

  switch (strategy) {
    case 'fixed':
      delay = baseDelayMs;
      break;

    case 'linear':
      delay = baseDelayMs * (attempt + 1);
      break;

    case 'exponential':
      delay = baseDelayMs * 2 ** attempt;
      break;

    case 'jittered':
      delay = baseDelayMs * 2 ** attempt + Math.random() * jitter * baseDelayMs;
      break;

    default:
      delay = baseDelayMs;
  }

  return Math.min(delay, maxDelayMs);
}

export class RetryPolicy {
  private options: Required<RetryPolicyOptions>;
  private executionCount = 0;
  private successCount = 0;
  private failureCount = 0;

  constructor(options: RetryPolicyOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Execute a function with retry logic.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.executionCount++;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.options.maxAttempts; attempt++) {
      try {
        const result = await fn();
        this.successCount++;
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.options.isRetryable(lastError) || attempt === this.options.maxAttempts - 1) {
          this.failureCount++;
          throw lastError;
        }

        const delay = calculateDelay(
          attempt,
          this.options.backoff,
          this.options.baseDelayMs,
          this.options.maxDelayMs,
          this.options.jitter,
        );

        this.options.onRetry(attempt + 1, lastError, delay);

        log.warn(
          {
            attempt: attempt + 1,
            maxAttempts: this.options.maxAttempts,
            delayMs: Math.round(delay),
            error: lastError.message,
          },
          'Retry after error',
        );

        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // Should not reach here
    throw lastError;
  }

  /**
   * Get policy statistics.
   */
  getStats(): {
    executions: number;
    successes: number;
    failures: number;
    successRate: number;
  } {
    return {
      executions: this.executionCount,
      successes: this.successCount,
      failures: this.failureCount,
      successRate: this.executionCount > 0 ? this.successCount / this.executionCount : 0,
    };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.executionCount = 0;
    this.successCount = 0;
    this.failureCount = 0;
  }
}

/**
 * Create a retry policy.
 */
export function createRetryPolicy(options: RetryPolicyOptions = {}): RetryPolicy {
  return new RetryPolicy(options);
}

/**
 * Standard retry policies for AI Gateway.
 */
export const RetryPolicies = {
  /** Quick retry for transient errors */
  Quick: new RetryPolicy({
    maxAttempts: 3,
    backoff: 'exponential',
    baseDelayMs: 500,
    maxDelayMs: 5_000,
  }),

  /** Standard retry for provider calls */
  Standard: new RetryPolicy({
    maxAttempts: 3,
    backoff: 'exponential',
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
  }),

  /** Conservative retry for expensive operations */
  Conservative: new RetryPolicy({
    maxAttempts: 2,
    backoff: 'linear',
    baseDelayMs: 2_000,
    maxDelayMs: 10_000,
  }),

  /** Aggressive retry for critical operations */
  Aggressive: new RetryPolicy({
    maxAttempts: 5,
    backoff: 'jittered',
    baseDelayMs: 200,
    maxDelayMs: 10_000,
  }),
} as const;
