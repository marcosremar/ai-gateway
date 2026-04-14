/**
 * Chaos test auto-injection framework.
 *
 * Automatically inject failures into test suites to verify resilience.
 * Unlike the manual chaos monkey, this integrates with Vitest to
 * auto-inject failures across all tests in a suite.
 *
 * @example
 * ```ts
 * import { chaosInjection } from './chaos-injection';
 *
 * // Enable chaos injection for this describe block
 * describe('Provider resilience', () => {
 *   chaosInjection.enable({ failureRate: 0.2 });
 *
 *   it('should handle provider failures', async () => {
 *     // 20% of provider calls in this block will fail
 *     const result = await provider.chat(messages);
 *     expect(result).toBeDefined();
 *   });
 *
 *   afterAll(() => chaosInjection.disable());
 * });
 * ```
 */

import { vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createLogger } from '../logger';

const log = createLogger('chaos-injection');

export interface ChaosInjectionConfig {
  /** Probability of failure 0-1 (default: 0.1) */
  failureRate?: number;
  /** Which providers to target (default: all) */
  targetProviders?: string[];
  /** Error messages to use (default: random) */
  errorMessages?: string[];
  /** Log injected failures (default: true) */
  logFailures?: boolean;
}

const DEFAULT_ERRORS = [
  'Network error: Connection refused',
  'Network error: ETIMEDOUT',
  'Provider returned 500',
  'Request aborted',
  'Service unavailable',
];

class ChaosInjection {
  private enabled = false;
  private config: ChaosInjectionConfig = {};
  private failuresInjected = 0;
  private originalMocks = new Map<string, unknown>();

  /**
   * Enable chaos injection for the current test suite.
   */
  enable(config: ChaosInjectionConfig = {}): void {
    this.enabled = true;
    this.config = {
      failureRate: 0.1,
      errorMessages: DEFAULT_ERRORS,
      logFailures: true,
      ...config,
    };

    log.log(
      { failureRate: this.config.failureRate, targetProviders: this.config.targetProviders },
      'Chaos injection enabled',
    );
  }

  /**
   * Disable chaos injection.
   */
  disable(): void {
    this.enabled = false;
    this.config = {};
    log.log({}, 'Chaos injection disabled');
  }

  /**
   * Wrap a provider mock with chaos injection.
   *
   * Use this in your test setup to inject failures into mocked providers.
   *
   * @example
   * ```ts
   * const mockProvider = mockLLMProvider({ content: 'Hello' });
   * const chaosProvider = chaosInjection.wrap(mockProvider);
   * ```
   */
  wrap<T extends Record<string, (...args: unknown[]) => Promise<unknown>>>(
    provider: T,
    providerName: string,
  ): T {
    if (!this.enabled) return provider;

    const targets = this.config.targetProviders;
    if (targets && !targets.includes(providerName)) return provider;

    const wrapped = { ...provider } as T;

    for (const [method, fn] of Object.entries(provider)) {
      if (typeof fn !== 'function') continue;

      const originalFn = fn;
      const chaosFn = async (...args: unknown[]) => {
        if (Math.random() < (this.config.failureRate ?? 0)) {
          this.failuresInjected++;
          const error =
            this.config.errorMessages?.[
              Math.floor(Math.random() * this.config.errorMessages.length)
            ] ?? 'Unknown error';

          if (this.config.logFailures) {
            log.log(
              { provider: providerName, method, error, totalInjected: this.failuresInjected },
              'Chaos: Injecting failure',
            );
          }

          throw new Error(error);
        }

        return originalFn(...args);
      };

      (wrapped as Record<string, unknown>)[method] = vi.fn(chaosFn);
    }

    return wrapped;
  }

  /**
   * Get chaos injection stats.
   */
  getStats(): { enabled: boolean; failuresInjected: number } {
    return {
      enabled: this.enabled,
      failuresInjected: this.failuresInjected,
    };
  }

  /**
   * Reset stats.
   */
  resetStats(): void {
    this.failuresInjected = 0;
  }
}

/** Global chaos injection instance */
export const chaosInjection = new ChaosInjection();

/**
 * Convenience function to enable chaos injection in a describe block.
 *
 * @example
 * ```ts
 * describe('Resilience tests', () => {
 *   withChaos({ failureRate: 0.3 });
 *
 *   it('should handle failures', async () => { ... });
 * });
 * ```
 */
export function withChaos(config: ChaosInjectionConfig): void {
  beforeAll(() => chaosInjection.enable(config));
  afterAll(() => {
    chaosInjection.logStats();
    chaosInjection.disable();
  });
  afterEach(() => chaosInjection.resetStats());
}
