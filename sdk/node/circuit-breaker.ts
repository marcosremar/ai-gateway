/**
 * Circuit breaker for GatewayHttpClient.
 *
 * States: closed → open → half_open → closed
 * - closed:    normal operation, failures are counted
 * - open:      requests are rejected immediately (CircuitOpenError)
 * - half_open: one test request is allowed through; success closes, failure re-opens
 */

import type { CircuitBreakerConfig } from './types';
import { DEFAULT_CIRCUIT_BREAKER } from './types';

export type CircuitState = 'closed' | 'open' | 'half_open';

export class CircuitOpenError extends Error {
  constructor(message = 'Circuit breaker is open — requests are blocked') {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER, ...config };
  }

  getState(): CircuitState {
    // Check if recovery timeout has elapsed while open
    if (this.state === 'open') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.recoveryTimeoutMs) {
        this.state = 'half_open';
        this.successCount = 0;
      }
    }
    return this.state;
  }

  /**
   * Call before making a request. Throws CircuitOpenError if open.
   */
  allowRequest(): void {
    const currentState = this.getState();
    if (currentState === 'open') {
      throw new CircuitOpenError();
    }
    // closed or half_open — allow
  }

  /**
   * Record a successful request.
   */
  recordSuccess(): void {
    if (this.state === 'half_open') {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.state = 'closed';
        this.failureCount = 0;
        this.successCount = 0;
      }
    } else {
      // In closed state, reset failure count on success
      this.failureCount = 0;
    }
  }

  /**
   * Record a failed request.
   */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half_open') {
      // Any failure in half_open re-opens
      this.state = 'open';
      this.successCount = 0;
    } else if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'open';
    }
  }

  /**
   * Reset to closed state (e.g. for testing).
   */
  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
  }
}
