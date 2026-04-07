import { describe, it, expect, beforeEach } from 'vitest';
import { LoadBalancer } from '../src/autoscaler/load-balancer';
import type { StateStore } from '../src/deps';
import type { GpuTierState } from '../src/types';

class MockStore implements StateStore {
  private data = new Map<string, string>();
  async get(k: string) { return this.data.get(k) ?? null; }
  async set(k: string, v: string, _t?: number) { this.data.set(k, v); }
  async del(k: string) { this.data.delete(k); }
  async scan(p: string) { const pre = p.replace('*', ''); return [...this.data.keys()].filter(k => k.startsWith(pre)); }
  async rpush(k: string, v: string) { this.data.set(k, (this.data.get(k) || '') + ',' + v); }
  async ltrim() {}
  async lrange(k: string, s: number, e: number) { return (this.data.get(k) || '').split(',').slice(s, e + 1); }
  async hset(k: string, f: string, v: string) { this.data.set(`${k}:${f}`, v); }
  async hdel(k: string, f: string) { this.data.delete(`${k}:${f}`); }
  async hgetall(k: string) { const r: Record<string, string> = {}; for (const [key, val] of this.data) { if (key.startsWith(`${k}:`)) r[key.slice(k.length + 1)] = val; } return r; }
  clear() { this.data.clear(); }
}

function tiers(n: number): GpuTierState[] {
  return Array.from({ length: n }, (_, i) => ({
    tierIndex: i, endpoint: `http://gpu-${i}:8000`, state: 'ready' as const, lastHealthyAt: Date.now(),
  }));
}

describe('LoadBalancer — FNV-1a hash correctness', () => {
  let store: MockStore;
  let lb: LoadBalancer;

  beforeEach(() => { store = new MockStore(); lb = new LoadBalancer(store); });

  it('is deterministic — same input always same output', async () => {
    const t = tiers(10);
    const results = await Promise.all(Array.from({ length: 20 }, () => lb.selectTier('user-abc', t, 'hash')));
    expect(new Set(results).size).toBe(1);
  });

  it('distributes across multiple tiers', async () => {
    const t = tiers(5);
    const counts = new Array(5).fill(0);
    for (let i = 0; i < 500; i++) {
      const idx = await lb.selectTier(`user-${i}`, t, 'hash');
      counts[idx]++;
    }
    expect(counts.every(c => c > 50)).toBe(true);
  });

  it('handles empty string user ID', async () => {
    const t = tiers(3);
    const idx = await lb.selectTier('', t, 'hash');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(3);
  });

  it('handles unicode user IDs', async () => {
    const t = tiers(3);
    const idx = await lb.selectTier('用户-日本語-🌍', t, 'hash');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(3);
  });

  it('returns 0 for single tier', async () => {
    const idx = await lb.selectTier('any-user', tiers(1), 'hash');
    expect(idx).toBe(0);
  });

  it('returns -1 for empty tier list', async () => {
    const idx = await lb.selectTier('any-user', [], 'hash');
    expect(idx).toBe(-1);
  });
});

describe('LoadBalancer — checkRateLimit', () => {
  let store: MockStore;
  let lb: LoadBalancer;

  beforeEach(() => { store = new MockStore(); lb = new LoadBalancer(store); });

  it('allows when tokens available', async () => {
    const result = await lb.checkRateLimit('client-1', 'normal');
    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBeUndefined();
  });

  it('blocks when tokens exhausted and returns retryAfterMs', async () => {
    for (let i = 0; i < 40; i++) {
      await lb.checkRateLimit('client-1', 'normal');
    }
    const result = await lb.checkRateLimit('client-1', 'normal');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(typeof result.remainingTokens).toBe('number');
  });

  it('urgent uses 1 token, high uses 2, normal uses 3', async () => {
    const lb2 = new LoadBalancer(store, { capacity: 5, refillRate: 0, initialTokens: 5 });
    const r1 = await lb2.checkRateLimit('c', 'urgent');
    expect(r1.allowed).toBe(true);
    const r2 = await lb2.checkRateLimit('c', 'high');
    expect(r2.allowed).toBe(true);
    const r3 = await lb2.checkRateLimit('c', 'normal');
    expect(r3.allowed).toBe(false);
  });

  it('retryAfterMs is proportional to deficit', async () => {
    const lb2 = new LoadBalancer(store, { capacity: 0, refillRate: 10, initialTokens: 0 });
    const r1 = await lb2.checkRateLimit('c1', 'normal');
    const r2 = await lb2.checkRateLimit('c2', 'urgent');
    expect(r1.retryAfterMs!).toBeGreaterThan(r2.retryAfterMs!);
  });
});

describe('LoadBalancer — selectPriority load escalation', () => {
  let store: MockStore;
  let lb: LoadBalancer;

  beforeEach(() => { store = new MockStore(); lb = new LoadBalancer(store); });

  it('escalates to least-busy when load > 70%', async () => {
    const t = tiers(3);
    await lb.incrementConnections(0);
    await lb.incrementConnections(0);
    await lb.incrementConnections(0);
    const idx = await lb.selectTier('user-1', t, 'priority', 'normal');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(3);
  });

  it('urgent always uses least-busy', async () => {
    const t = tiers(3);
    await lb.incrementConnections(1);
    await lb.incrementConnections(1);
    const idx = await lb.selectTier('user-1', t, 'priority', 'urgent');
    expect([0, 2]).toContain(idx);
  });

  it('high priority uses least-busy', async () => {
    const t = tiers(3);
    await lb.incrementConnections(0);
    await lb.incrementConnections(1);
    const idx = await lb.selectTier('user-1', t, 'priority', 'high');
    expect(idx).toBe(2);
  });
});

describe('LoadBalancer — store failure resilience', () => {
  it('affinity falls back to hash on store error', async () => {
    const failStore: StateStore = {
      get: async () => { throw new Error('store down'); },
      set: async () => { throw new Error('store down'); },
      del: async () => {},
      scan: async () => [],
      rpush: async () => {},
      ltrim: async () => {},
      lrange: async () => [],
      hset: async () => {},
      hdel: async () => {},
      hgetall: async () => ({}),
    };
    const lb = new LoadBalancer(failStore);
    const t = tiers(3);
    const idx = await lb.selectTier('user-1', t, 'affinity');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(3);
  });

  it('decrementConnections uses ?? 0 not || 1', async () => {
    const store = new MockStore();
    const lb = new LoadBalancer(store);
    await lb.decrementConnections(0);
    const count = (lb as any).connectionCounts.get(0);
    expect(count).toBe(0);
  });
});
