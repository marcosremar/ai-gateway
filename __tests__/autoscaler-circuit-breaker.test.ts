import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TierCircuitBreaker } from '@ai-gateway/autoscaler/circuit-breaker';
import type { KvStore } from '@ai-gateway/deps';

function makeStore(): KvStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { data.set(key, value); }),
    del: vi.fn(async (key: string) => { data.delete(key); }),
    scan: vi.fn(async (pattern: string) => {
      const prefix = pattern.replace('*', '');
      return [...data.keys()].filter((k) => k.startsWith(prefix));
    }),
    // ListStore + HashStore stubs (not used by circuit breaker)
    rpush: vi.fn(),
    ltrim: vi.fn(),
    lrange: vi.fn(async () => []),
    hset: vi.fn(),
    hdel: vi.fn(),
    hgetall: vi.fn(async () => ({})),
  };
}

describe('TierCircuitBreaker', () => {
  let store: ReturnType<typeof makeStore>;
  let cb: TierCircuitBreaker;

  beforeEach(() => {
    store = makeStore();
    cb = new TierCircuitBreaker(store);
  });

  it('starts in closed state', async () => {
    expect(await cb.getState(0)).toBe('closed');
    expect(await cb.isAvailable(0)).toBe(true);
  });

  it('stays closed below failure threshold', async () => {
    await cb.recordFailure(0);
    await cb.recordFailure(0);
    expect(await cb.getState(0)).toBe('closed');
  });

  it('opens after reaching failure threshold (default 3)', async () => {
    await cb.recordFailure(0);
    await cb.recordFailure(0);
    await cb.recordFailure(0);
    expect(await cb.getState(0)).toBe('open');
    expect(await cb.isAvailable(0)).toBe(false);
  });

  it('resets failure count on success in closed state', async () => {
    await cb.recordFailure(0);
    await cb.recordFailure(0);
    await cb.recordSuccess(0);
    // Now 2 more failures should not open (count was reset to 0)
    await cb.recordFailure(0);
    await cb.recordFailure(0);
    expect(await cb.getState(0)).toBe('closed');
  });

  it('transitions open → half-open after recovery timeout', async () => {
    const fastCb = new TierCircuitBreaker(store, { recoveryTimeoutMs: 100 });
    await fastCb.recordFailure(0);
    await fastCb.recordFailure(0);
    await fastCb.recordFailure(0);
    expect(await fastCb.getState(0)).toBe('open');

    // Manipulate the openedAt to simulate time passing
    const raw = store.data.get('circuit:0')!;
    const parsed = JSON.parse(raw);
    parsed.openedAt = Date.now() - 200; // 200ms ago, past the 100ms timeout
    store.data.set('circuit:0', JSON.stringify(parsed));

    expect(await fastCb.getState(0)).toBe('half-open');
    expect(await fastCb.isAvailable(0)).toBe(true);
  });

  it('closes from half-open after enough successes (default 2)', async () => {
    const fastCb = new TierCircuitBreaker(store, { recoveryTimeoutMs: 0 });
    // Open the circuit
    await fastCb.recordFailure(0);
    await fastCb.recordFailure(0);
    await fastCb.recordFailure(0);

    // Time-based transition to half-open happens on next getState
    expect(await fastCb.getState(0)).toBe('half-open');

    await fastCb.recordSuccess(0);
    expect(await fastCb.getState(0)).toBe('half-open'); // need 2 successes
    await fastCb.recordSuccess(0);
    expect(await fastCb.getState(0)).toBe('closed');
  });

  it('re-opens on any failure in half-open', async () => {
    const fastCb = new TierCircuitBreaker(store, { recoveryTimeoutMs: 100 });
    await fastCb.recordFailure(0);
    await fastCb.recordFailure(0);
    await fastCb.recordFailure(0);
    expect(await fastCb.getState(0)).toBe('open');

    // Manually force transition to half-open by backdating openedAt
    const raw = store.data.get('circuit:0')!;
    const parsed = JSON.parse(raw);
    parsed.openedAt = Date.now() - 200;
    store.data.set('circuit:0', JSON.stringify(parsed));
    expect(await fastCb.getState(0)).toBe('half-open');

    await fastCb.recordSuccess(0); // 1 success
    await fastCb.recordFailure(0); // failure re-opens
    // openedAt is now fresh, so recovery timeout hasn't elapsed yet
    expect(await fastCb.getState(0)).toBe('open');
  });

  it('tracks tiers independently', async () => {
    await cb.recordFailure(0);
    await cb.recordFailure(0);
    await cb.recordFailure(0);

    expect(await cb.getState(0)).toBe('open');
    expect(await cb.getState(1)).toBe('closed');
  });

  it('reset() returns tier to closed', async () => {
    await cb.recordFailure(0);
    await cb.recordFailure(0);
    await cb.recordFailure(0);
    expect(await cb.getState(0)).toBe('open');

    await cb.reset(0);
    expect(await cb.getState(0)).toBe('closed');
  });

  it('getAll() returns all tracked tiers', async () => {
    await cb.recordFailure(0);
    await cb.recordFailure(0);
    await cb.recordFailure(0);
    await cb.recordSuccess(1); // creates entry for tier 1

    const all = await cb.getAll();
    expect(all.get(0)).toBe('open');
    expect(all.get(1)).toBe('closed');
    expect(all.size).toBe(2);
  });

  it('custom config: failureThreshold=5', async () => {
    const customCb = new TierCircuitBreaker(store, { failureThreshold: 5 });
    for (let i = 0; i < 4; i++) await customCb.recordFailure(0);
    expect(await customCb.getState(0)).toBe('closed');
    await customCb.recordFailure(0);
    expect(await customCb.getState(0)).toBe('open');
  });

  it('custom config: successThreshold=1 in half-open', async () => {
    const customCb = new TierCircuitBreaker(store, {
      recoveryTimeoutMs: 0,
      successThreshold: 1,
    });
    await customCb.recordFailure(0);
    await customCb.recordFailure(0);
    await customCb.recordFailure(0);
    expect(await customCb.getState(0)).toBe('half-open');

    await customCb.recordSuccess(0);
    expect(await customCb.getState(0)).toBe('closed');
  });

  it('persists state across instances', async () => {
    await cb.recordFailure(0);
    await cb.recordFailure(0);
    await cb.recordFailure(0);
    expect(await cb.getState(0)).toBe('open');

    // Create new instance with same store
    const cb2 = new TierCircuitBreaker(store);
    expect(await cb2.getState(0)).toBe('open');
  });
});
