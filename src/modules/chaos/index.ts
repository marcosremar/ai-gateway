/**
 * Chaos testing helpers — inject random failures to test resilience.
 *
 * Use these in test suites to verify that the system handles
 * network failures, timeouts, and provider outages gracefully.
 *
 * @example
 * ```ts
 * import { chaosMonkey, injectLatency, injectFailure } from './chaos';
 *
 * it('should handle provider failures', async () => {
 *   chaosMonkey.enable({ failureRate: 0.3, latency: [100, 5000] });
 *
 *   const result = await withChaos(() => provider.chat(messages));
 *   expect(result).toBeDefined();
 *
 *   chaosMonkey.disable();
 * });
 * ```
 */

import { sleep } from '../utils';

// ── Chaos Monkey ─────────────────────────────────────────────────────────────

export interface ChaosConfig {
  /** Probability of failure 0-1 (default: 0.1) */
  failureRate?: number;
  /** Latency range in ms [min, max] (default: no added latency) */
  latency?: [number, number];
  /** Error messages to throw on failure (default: random selection) */
  errors?: string[];
}

const DEFAULT_ERRORS = [
  'Network error: Connection refused',
  'Network error: ETIMEDOUT',
  'Network error: ECONNRESET',
  'Request aborted',
  'Internal server error',
  'Service unavailable',
  'Gateway timeout',
];

class ChaosMonkey {
  private enabled = false;
  private config: ChaosConfig = {};

  /** Enable chaos injection */
  enable(config: ChaosConfig = {}): void {
    this.enabled = true;
    this.config = {
      failureRate: 0.1,
      errors: DEFAULT_ERRORS,
      ...config,
    };
  }

  /** Disable chaos injection */
  disable(): void {
    this.enabled = false;
  }

  /** Check if chaos is enabled */
  isActive(): boolean {
    return this.enabled;
  }

  /** Get current config */
  getConfig(): ChaosConfig {
    return this.config;
  }

  /** Should this request fail? */
  shouldFail(): boolean {
    return Math.random() < (this.config.failureRate ?? 0);
  }

  /** Get a random error message */
  getError(): string {
    const errors = this.config.errors ?? DEFAULT_ERRORS;
    return errors[Math.floor(Math.random() * errors.length)];
  }

  /** Get a random latency value from the configured range */
  getLatencyMs(): number {
    const [min, max] = this.config.latency ?? [0, 0];
    return min + Math.random() * (max - min);
  }
}

/** Global chaos monkey instance */
export const chaosMonkey = new ChaosMonkey();

/**
 * Wrap a function with chaos injection.
 *
 * May add latency or throw errors based on the current config.
 */
export async function withChaos<T>(fn: () => Promise<T>): Promise<T> {
  if (!chaosMonkey.isActive()) {
    return fn();
  }

  // Inject latency
  const latency = chaosMonkey.getLatencyMs();
  if (latency > 0) {
    await sleep(latency);
  }

  // Inject failure
  if (chaosMonkey.shouldFail()) {
    throw new Error(chaosMonkey.getError());
  }

  return fn();
}

/**
 * Wrap a synchronous function with chaos injection.
 */
export function withChaosSync<T>(fn: () => T): T {
  if (!chaosMonkey.isActive()) {
    return fn();
  }

  if (chaosMonkey.shouldFail()) {
    throw new Error(chaosMonkey.getError());
  }

  return fn();
}

// ── Specific Failure Injectors ───────────────────────────────────────────────

/**
 * Create a function that fails with a given probability.
 *
 * @example
 * ```ts
 * const flakyProvider = injectFailure(originalProvider, 0.3);
 * // 30% of calls will throw
 * ```
 */
export function injectFailure<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  failureRate: number,
): T {
  return (async (...args: unknown[]) => {
    if (Math.random() < failureRate) {
      throw new Error(DEFAULT_ERRORS[Math.floor(Math.random() * DEFAULT_ERRORS.length)]);
    }
    return fn(...args);
  }) as T;
}

/**
 * Create a function that adds random latency.
 *
 * @example
 * ```ts
 * const slowProvider = injectLatency(originalProvider, [500, 5000]);
 * // Adds 500-5000ms of random delay
 * ```
 */
export function injectLatency<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  range: [number, number],
): T {
  return (async (...args: unknown[]) => {
    const [min, max] = range;
    const delay = min + Math.random() * (max - min);
    await sleep(delay);
    return fn(...args);
  }) as T;
}

/**
 * Create a function that sometimes returns slow responses.
 */
export function injectSlowResponse<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  p99LatencyMs: number,
): T {
  return (async (...args: unknown[]) => {
    // p99 latency: 99% of calls are fast, 1% are very slow
    if (Math.random() < 0.01) {
      await sleep(p99LatencyMs);
    }
    return fn(...args);
  }) as T;
}

/**
 * Create a function that returns partial/corrupted data occasionally.
 */
export function injectDataCorruption<
  T extends (...args: unknown[]) => Promise<Record<string, unknown>>,
>(fn: T, corruptionRate: number): T {
  return (async (...args: unknown[]) => {
    const result = await fn(...args);

    if (Math.random() < corruptionRate) {
      // Corrupt a random field
      const keys = Object.keys(result);
      if (keys.length > 0) {
        const randomKey = keys[Math.floor(Math.random() * keys.length)];
        (result as Record<string, unknown>)[randomKey] = null;
      }
    }

    return result;
  }) as T;
}
