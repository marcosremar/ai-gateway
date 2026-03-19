/**
 * Tier-level Circuit Breaker — tracks per-tier (per-pod) failure/success
 * with 3 states: closed → open → half-open → closed.
 *
 * Uses StateStore for persistence (survives restarts).
 */

import type { KvStore } from '../deps';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface TierCircuitBreakerConfig {
  /** Consecutive failures before opening the circuit. Default: 3 */
  failureThreshold: number;
  /** Time in ms before an open circuit transitions to half-open. Default: 30_000 */
  recoveryTimeoutMs: number;
  /** Successes needed in half-open to close. Default: 2 */
  successThreshold: number;
  /** Max concurrent probes allowed in half-open state. Default: 1 */
  halfOpenMaxConcurrent: number;
}

const DEFAULT_CONFIG: TierCircuitBreakerConfig = {
  failureThreshold: 3,
  recoveryTimeoutMs: 30_000,
  successThreshold: 2,
  halfOpenMaxConcurrent: 1,
};

interface PersistedCircuitState {
  failures: number;
  state: CircuitState;
  openedAt: number;
  halfOpenSuccesses: number;
}

function storeKey(tierIndex: number): string {
  return `circuit:${tierIndex}`;
}

function defaultState(): PersistedCircuitState {
  return { failures: 0, state: 'closed', openedAt: 0, halfOpenSuccesses: 0 };
}

export class TierCircuitBreaker {
  private readonly config: TierCircuitBreakerConfig;

  constructor(
    private readonly store: KvStore,
    config?: Partial<TierCircuitBreakerConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private async load(tierIndex: number): Promise<PersistedCircuitState> {
    const raw = await this.store.get(storeKey(tierIndex));
    if (!raw) return defaultState();
    try {
      return JSON.parse(raw) as PersistedCircuitState;
    } catch {
      return defaultState();
    }
  }

  private async save(tierIndex: number, s: PersistedCircuitState): Promise<void> {
    await this.store.set(storeKey(tierIndex), JSON.stringify(s));
  }

  /** Evaluate time-based transitions (open → half-open) */
  private applyTimeTransition(s: PersistedCircuitState): PersistedCircuitState {
    if (s.state === 'open' && s.openedAt > 0) {
      const elapsed = Date.now() - s.openedAt;
      if (elapsed >= this.config.recoveryTimeoutMs) {
        return { ...s, state: 'half-open', halfOpenSuccesses: 0 };
      }
    }
    return s;
  }

  async recordSuccess(tierIndex: number): Promise<void> {
    let s = this.applyTimeTransition(await this.load(tierIndex));

    if (s.state === 'half-open') {
      s.halfOpenSuccesses++;
      if (s.halfOpenSuccesses >= this.config.successThreshold) {
        s = { failures: 0, state: 'closed', openedAt: 0, halfOpenSuccesses: 0 };
      }
    } else {
      // In closed state, reset failure count on success
      s.failures = 0;
    }

    await this.save(tierIndex, s);
  }

  async recordFailure(tierIndex: number): Promise<void> {
    let s = this.applyTimeTransition(await this.load(tierIndex));

    s.failures++;

    if (s.state === 'half-open') {
      // Any failure in half-open re-opens
      s.state = 'open';
      s.openedAt = Date.now();
      s.halfOpenSuccesses = 0;
    } else if (s.failures >= this.config.failureThreshold) {
      s.state = 'open';
      s.openedAt = Date.now();
    }

    await this.save(tierIndex, s);
  }

  async getState(tierIndex: number): Promise<CircuitState> {
    const s = this.applyTimeTransition(await this.load(tierIndex));
    // Persist time transition if it happened
    const raw = await this.store.get(storeKey(tierIndex));
    const original = raw ? (JSON.parse(raw) as PersistedCircuitState) : defaultState();
    if (s.state !== original.state) {
      await this.save(tierIndex, s);
    }
    return s.state;
  }

  /** Returns true if the tier is available for traffic (closed or half-open). */
  async isAvailable(tierIndex: number): Promise<boolean> {
    const state = await this.getState(tierIndex);
    return state !== 'open';
  }

  /** Get circuit states for all tracked tiers. */
  async getAll(): Promise<Map<number, CircuitState>> {
    const keys = await this.store.scan('circuit:*');
    const result = new Map<number, CircuitState>();
    for (const key of keys) {
      const idx = parseInt(key.replace('circuit:', ''), 10);
      if (!isNaN(idx)) {
        result.set(idx, await this.getState(idx));
      }
    }
    return result;
  }

  /** Reset a tier's circuit to closed. */
  async reset(tierIndex: number): Promise<void> {
    await this.save(tierIndex, defaultState());
  }
}
