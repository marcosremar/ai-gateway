import { describe, test, expect, vi } from 'vitest';
import { CircuitBreaker } from '../src/gateway/providers/cloud/circuit-breaker';

describe('CircuitBreaker - Null openedAt handling', () => {
  test('should handle null openedAt without throwing error', () => {
    const breaker = new CircuitBreaker();

    // Initially state should be closed
    expect(breaker.allowRequest()).toBe(true);

    // Record a failure to transition to open state
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    // State should now be open
    expect(breaker.allowRequest()).toBe(false);

    // Mock time to be exactly resetTimeoutMs in the future
    const mockTime = Date.now() + 30_000; // 30 seconds
    const mockNow = vi.fn().mockReturnValue(mockTime);

    // Create new breaker with mock time function
    const testBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeoutMs: 30_000,
      now: mockNow
    });

    // Open the circuit
    testBreaker.recordFailure();
    testBreaker.recordFailure();
    testBreaker.recordFailure();
    testBreaker.recordFailure();
    testBreaker.recordFailure();

    // Should be open
    expect(testBreaker.allowRequest()).toBe(false);

    // Advance time beyond reset timeout
    mockNow.mockReturnValue(mockTime + 31_000);

    // Should now allow a probe request
    expect(testBreaker.allowRequest()).toBe(true);
    expect(testBreaker.allowRequest()).toBe(false); // Second request should be blocked
  });

  test('should not allow multiple probe requests', () => {
    const breaker = new CircuitBreaker();

    // Open the circuit
    for (let i = 0; i < 5; i++) {
      breaker.recordFailure();
    }

    // Mock time to be exactly resetTimeoutMs in the future
    const mockTime = Date.now() + 30_000;

    // Create spy for now function
    const mockNow = vi.fn().mockReturnValue(mockTime);
    const testBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeoutMs: 30_000,
      now: mockNow
    });

    // Open the circuit
    for (let i = 0; i < 5; i++) {
      testBreaker.recordFailure();
    }

    // Advance time beyond reset timeout
    mockNow.mockReturnValue(mockTime + 31_000);

    // Allow first probe
    expect(testBreaker.allowRequest()).toBe(true);

    // Second request should be blocked (probe in flight)
    expect(testBreaker.allowRequest()).toBe(false);

    // Record success on probe - should close the circuit
    testBreaker.recordSuccess();

    // Now should allow requests normally
    expect(testBreaker.allowRequest()).toBe(true);
  });
});