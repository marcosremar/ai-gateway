/**
 * Circuit Breaker — prevents hammering a failing provider.
 *
 * State machine:
 *   CLOSED  → normal operation, all requests pass through
 *   OPEN    → provider is failing, requests short-circuit immediately
 *   HALF_OPEN → cooldown expired, allow ONE probe request to test recovery
 *
 * Transitions:
 *   CLOSED → OPEN: after `failureThreshold` consecutive failures
 *   OPEN → HALF_OPEN: after `resetTimeoutMs` elapses
 *   HALF_OPEN → CLOSED: if the probe request succeeds
 *   HALF_OPEN → OPEN: if the probe request fails (restarts cooldown)
 *
 * Why this matters for LLM proxies: without a circuit breaker, when Groq
 * returns 500 on every request, each request still pays the full timeout
 * (5-15s) before falling back to the next provider. With a circuit breaker,
 * the second request sees the breaker is OPEN and falls back in <1ms.
 * For a 3-provider fallback chain, this reduces worst-case from ~45s to ~15s.
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening. Default: 5. */
  failureThreshold?: number;
  /** Time in ms to stay open before transitioning to half-open. Default: 30s. */
  resetTimeoutMs?: number;
  /** Clock function for testing. */
  now?: () => number;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  openedAt: number | null;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT_MS = 30_000;

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private lastFailureAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private openedAt: number | null = null;
  private probeInFlight = false;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Check if a request should be allowed through.
   * Returns true if the circuit is closed or half-open (probe allowed).
   * Returns false if the circuit is open (short-circuit immediately).
   */
  allowRequest(): boolean {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      // Check if enough time has passed to try a probe
      const elapsed = this.now() - (this.openedAt ?? 0);
      if (elapsed >= this.resetTimeoutMs) {
        this.state = 'half_open';
        this.probeInFlight = true;
        return true; // allow one probe
      }
      return false; // still in cooldown
    }

    // half_open — allow the probe request only if one isn't already in flight
    if (this.probeInFlight) {
      return false;
    }
    this.probeInFlight = true;
    return true;
  }

  /**
   * True while the circuit is open and its cooldown has not elapsed. Unlike `allowRequest()` it never moves the
   * breaker to half-open, so a caller can filter a chain without consuming the single probe slot.
   */
  isOpen(): boolean {
    return this.state === 'open' && this.now() - (this.openedAt ?? 0) < this.resetTimeoutMs;
  }

  /**
   * The request that held the half-open probe slot ended without saying anything about health (e.g. the deployment
   * is still booting): free the slot so the next request can probe, without changing the state.
   */
  releaseProbe(): void {
    this.probeInFlight = false;
  }

  /** Record a successful request. Closes the circuit if half-open. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses++;
    this.lastSuccessAt = this.now();
    this.probeInFlight = false;

    if (this.state === 'half_open') {
      this.state = 'closed';
      this.openedAt = null;
    }
  }

  /** Record a failed request. Opens the circuit after threshold consecutive failures. */
  recordFailure(): void {
    this.consecutiveFailures++;
    this.consecutiveSuccesses = 0;
    this.lastFailureAt = this.now();
    const wasProbeInFlight = this.probeInFlight;
    this.probeInFlight = false;

    if (this.state === 'half_open') {
      // Probe failed — re-open with fresh cooldown
      this.state = 'open';
      this.openedAt = this.now();
      return;
    }

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  /** Current state for observability. */
  getStats(): CircuitBreakerStats {
    // Return current state without auto-transition to avoid mutation side effects
    return {
      state: this.state,
      failures: this.consecutiveFailures,
      successes: this.consecutiveSuccesses,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      openedAt: this.openedAt,
    };
  }

  /** Force the circuit closed (manual override). */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAt = null;
    this.probeInFlight = false;
  }
}

/**
 * Registry of circuit breakers keyed by provider ID.
 * Shared across the fallback chain so all requests to the same provider
 * contribute to the same failure count.
 */
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();
  private readonly defaultOpts: CircuitBreakerOptions;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.defaultOpts = opts;
  }

  /** Get or create a circuit breaker for a provider. */
  get(providerId: string): CircuitBreaker {
    let cb = this.breakers.get(providerId);
    if (!cb) {
      cb = new CircuitBreaker(this.defaultOpts);
      this.breakers.set(providerId, cb);
    }
    return cb;
  }

  /** Get stats for all providers (for /health or /metrics). */
  allStats(): Record<string, CircuitBreakerStats> {
    const result: Record<string, CircuitBreakerStats> = {};
    for (const [id, cb] of this.breakers) {
      result[id] = cb.getStats();
    }
    return result;
  }

  /** Reset all breakers. */
  resetAll(): void {
    for (const cb of this.breakers.values()) cb.reset();
  }
}
