import { describe, it, expect } from 'vitest';
import { CircuitBreaker, CircuitBreakerRegistry } from '../src/providers/circuit-breaker';

describe('CircuitBreaker', () => {
  it('starts closed and allows requests', () => {
    const cb = new CircuitBreaker();
    expect(cb.allowRequest()).toBe(true);
    expect(cb.getStats().state).toBe('closed');
  });

  it('opens after failureThreshold consecutive failures', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.allowRequest()).toBe(true); // still closed
    cb.recordFailure(); // 3rd → opens
    expect(cb.allowRequest()).toBe(false);
    expect(cb.getStats().state).toBe('open');
  });

  it('resets failure count on success', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess(); // resets count
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.allowRequest()).toBe(true); // not at threshold yet
  });

  it('transitions to half-open after resetTimeout', () => {
    let now = 1000;
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 5000, now: () => now });
    cb.recordFailure();
    cb.recordFailure(); // opens
    expect(cb.allowRequest()).toBe(false);

    now += 5001; // past timeout
    expect(cb.allowRequest()).toBe(true); // half-open probe allowed
    expect(cb.getStats().state).toBe('half_open');
  });

  it('closes on success during half-open', () => {
    let now = 1000;
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 100, now: () => now });
    cb.recordFailure();
    cb.recordFailure();
    now += 200;
    cb.allowRequest(); // transitions to half-open
    cb.recordSuccess(); // probe succeeded → close
    expect(cb.getStats().state).toBe('closed');
    expect(cb.allowRequest()).toBe(true);
  });

  it('re-opens on failure during half-open', () => {
    let now = 1000;
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 100, now: () => now });
    cb.recordFailure();
    cb.recordFailure();
    now += 200;
    cb.allowRequest(); // half-open
    cb.recordFailure(); // probe failed → re-open
    expect(cb.getStats().state).toBe('open');
    expect(cb.allowRequest()).toBe(false);
  });

  it('reset() forces closed', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure();
    expect(cb.getStats().state).toBe('open');
    cb.reset();
    expect(cb.getStats().state).toBe('closed');
    expect(cb.allowRequest()).toBe(true);
  });
});

describe('CircuitBreakerRegistry', () => {
  it('creates breakers on demand per provider', () => {
    const reg = new CircuitBreakerRegistry({ failureThreshold: 2 });
    const groq = reg.get('groq');
    const openai = reg.get('openai');
    expect(groq).not.toBe(openai);
    expect(reg.get('groq')).toBe(groq); // same instance
  });

  it('allStats reports all providers', () => {
    const reg = new CircuitBreakerRegistry();
    reg.get('groq').recordFailure();
    reg.get('openai').recordSuccess();
    const stats = reg.allStats();
    expect(Object.keys(stats)).toContain('groq');
    expect(Object.keys(stats)).toContain('openai');
    expect(stats.groq.failures).toBe(1);
    expect(stats.openai.successes).toBe(1);
  });

  it('providers are isolated', () => {
    const reg = new CircuitBreakerRegistry({ failureThreshold: 2 });
    reg.get('groq').recordFailure();
    reg.get('groq').recordFailure(); // groq opens
    expect(reg.get('groq').allowRequest()).toBe(false);
    expect(reg.get('openai').allowRequest()).toBe(true); // unaffected
  });
});
