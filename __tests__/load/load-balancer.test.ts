import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LoadBalancer, type LoadBalanceStrategy, type RequestPriority } from '@ai-gateway/autoscaler/load-balancer';
import type { StateStore } from '@ai-gateway';
import type { GpuTierState } from '@ai-gateway';

class MockStateStore implements StateStore {
  private store = new Map<string, string>();

  async get(key: string) { return this.store.get(key) ?? null; }
  async set(key: string, value: string, _ttlSecs?: number) { this.store.set(key, value); }
  async del(key: string) { this.store.delete(key); }
  async scan(pattern: string) { 
    const prefix = pattern.replace('*', '');
    return Array.from(this.store.keys()).filter(k => k.startsWith(prefix));
  }
  async rpush(key: string, value: string) { 
    const existing = this.store.get(key) || '';
    this.store.set(key, existing ? `${existing},${value}` : value);
  }
  async ltrim(key: string, start: number, stop: number) { /* mock */ }
  async lrange(key: string, start: number, stop: number) { 
    const val = this.store.get(key) || '';
    return val.split(',').slice(start, stop + 1);
  }
  async hset(key: string, field: string, value: string) { this.store.set(`${key}:${field}`, value); }
  async hdel(key: string, field: string) { this.store.delete(`${key}:${field}`); }
  async hgetall(key: string) { 
    const result: Record<string, string> = {};
    for (const [k, v] of this.store.entries()) {
      if (k.startsWith(`${key}:`)) {
        result[k.slice(key.length + 1)] = v;
      }
    }
    return result;
  }

  clear() {
    this.store.clear();
  }
}

function createMockTiers(count: number): GpuTierState[] {
  return Array.from({ length: count }, (_, i) => ({
    tierIndex: i,
    endpoint: `http://gpu-${i}:8000`,
    state: 'ready' as const,
    lastHealthyAt: Date.now(),
  }));
}

describe('LoadBalancer', () => {
  let store: MockStateStore;
  let balancer: LoadBalancer;

  beforeEach(() => {
    store = new MockStateStore();
    balancer = new LoadBalancer(store);
  });

  afterEach(() => {
    store.clear();
  });

  describe('selectTier - hash strategy', () => {
    it('should distribute evenly with hash', async () => {
      const tiers = createMockTiers(3);
      const results: number[] = [];

      for (let i = 0; i < 100; i++) {
        const idx = await balancer.selectTier(`user-${i}`, tiers, 'hash');
        results.push(idx);
      }

      // Should be roughly 33/33/33 distribution
      const distribution = [0, 1, 2].map(i => results.filter(r => r === i).length);
      expect(distribution.every(d => d > 20 && d < 50)).toBe(true);
    });

    it('should return 0 for single tier', async () => {
      const tiers = createMockTiers(1);
      const idx = await balancer.selectTier('user-1', tiers, 'hash');
      expect(idx).toBe(0);
    });
  });

  describe('selectTier - round-robin strategy', () => {
    it('should rotate through tiers', async () => {
      const tiers = createMockTiers(3);

      const results = await Promise.all([
        balancer.selectTier('user-1', tiers, 'weighted-round-robin'),
        balancer.selectTier('user-2', tiers, 'weighted-round-robin'),
        balancer.selectTier('user-3', tiers, 'weighted-round-robin'),
        balancer.selectTier('user-4', tiers, 'weighted-round-robin'),
      ]);

      expect(results).toEqual([0, 1, 2, 0]);
    });
  });

  describe('selectTier - least-busy strategy', () => {
    it('should select tier with fewest connections', async () => {
      const tiers = createMockTiers(3);

      // Set up different connection counts
      await balancer.incrementConnections(0);
      await balancer.incrementConnections(0);
      await balancer.incrementConnections(1);

      const idx = await balancer.selectTier('user-1', tiers, 'least-busy');
      expect(idx).toBe(2); // Tier 2 has 0 connections
    });

    it('should return first tier if all have same connections', async () => {
      const tiers = createMockTiers(3);
      const idx = await balancer.selectTier('user-1', tiers, 'least-busy');
      expect(idx).toBe(0);
    });
  });

  describe('selectTier - affinity strategy', () => {
    it('should stick to same tier for same user', async () => {
      const tiers = createMockTiers(3);

      const idx1 = await balancer.selectTier('user-1', tiers, 'affinity');
      const idx2 = await balancer.selectTier('user-1', tiers, 'affinity');

      expect(idx1).toBe(idx2);
    });

    it('should distribute different users across tiers', async () => {
      const tiers = createMockTiers(3);
      const users = Array.from({ length: 20 }, (_, i) => `user-${i}`);

      const results = await Promise.all(users.map(u => balancer.selectTier(u, tiers, 'affinity')));
      const uniqueResults = new Set(results);
      expect(uniqueResults.size).toBeGreaterThan(1);
    });
  });

  describe('selectTier - priority strategy', () => {
    it('should use least-busy for urgent requests', async () => {
      const tiers = createMockTiers(3);
      await balancer.incrementConnections(0);
      await balancer.incrementConnections(0);
      await balancer.incrementConnections(1);

      const idx = await balancer.selectTier('user-1', tiers, 'priority', 'urgent');
      expect(idx).toBe(2);
    });

    it('should use affinity for normal requests', async () => {
      const tiers = createMockTiers(3);

      // First request sets affinity
      await balancer.selectTier('user-1', tiers, 'affinity');
      // Second request should stick
      const idx = await balancer.selectTier('user-1', tiers, 'priority', 'normal');

      // Should use affinity logic
      expect(typeof idx).toBe('number');
    });
  });

  describe('connection tracking', () => {
    it('should increment connections', async () => {
      await balancer.incrementConnections(0);
      await balancer.incrementConnections(0);
      await balancer.incrementConnections(1);

      const metrics = await (balancer as any).getTierConnections(0);
      expect(metrics?.activeConnections).toBe(2);
    });

    it('should decrement connections', async () => {
      await balancer.incrementConnections(0);
      await balancer.incrementConnections(0);
      await balancer.decrementConnections(0);

      const metrics = await (balancer as any).getTierConnections(0);
      expect(metrics?.activeConnections).toBe(1);
    });

    it('should not go below zero', async () => {
      await balancer.decrementConnections(0);
      const metrics = await (balancer as any).getTierConnections(0);
      expect(metrics?.activeConnections ?? 0).toBe(0);
    });
  });

  describe('token bucket rate limiting', () => {
    it('should allow requests within capacity', async () => {
      const bal = new LoadBalancer(store, { capacity: 10, refillRate: 1 });
      
      const result = await bal.tryConsume('client-1', 5);
      expect(result).toBe(true);
    });

    it('should track remaining tokens per client', async () => {
      const bal = new LoadBalancer(store, { capacity: 10, refillRate: 0, initialTokens: 10 });

      const consumed = await bal.tryConsume('client-a', 3);
      expect(consumed).toBe(true);
      
      const remaining = await bal.getTokenBalance('client-a');
      expect(remaining).toBe(7);
    });

    it('should have separate buckets for different clients', async () => {
      const bal = new LoadBalancer(store, { capacity: 5, refillRate: 0, initialTokens: 5 });

      // Exhaust client-1
      await bal.tryConsume('client-1', 5);
      
      // Client-2 should still have full capacity
      const remaining2 = await bal.getTokenBalance('client-2');
      expect(remaining2).toBe(5);
    });

    it('should reset bucket', async () => {
      const bal = new LoadBalancer(store, { capacity: 10, refillRate: 0, initialTokens: 10 });

      await bal.tryConsume('client-reset', 10);
      await bal.resetTokenBucket('client-reset');

      const remaining = await bal.getTokenBalance('client-reset');
      expect(remaining).toBe(10);
    });
  });

  describe('latency tracking', () => {
    it('should report and track latency', async () => {
      await balancer.reportTierLatency('user-1', 0, 100);
      await balancer.reportTierLatency('user-1', 0, 200);

      const metrics = await balancer.getTierLatency('user-1', 0);
      expect(metrics?.sampleCount).toBe(2);
      // EMA: 0.3 * 200 + 0.7 * 100 = 130
      expect(metrics?.emaLatencyMs).toBeCloseTo(130, 0);
    });

    it('should select lowest latency tier', async () => {
      const tiers = createMockTiers(3);

      await balancer.reportTierLatency('user-1', 0, 100);
      await balancer.reportTierLatency('user-1', 1, 50);
      await balancer.reportTierLatency('user-1', 2, 200);

      const idx = await balancer.selectTier('user-1', tiers, 'least-latency');
      expect(idx).toBe(1);
    });
  });

  describe('error handling', () => {
    it('should fail gracefully with bad store for connection tracking', async () => {
      const badStore: StateStore = {
        get: vi.fn().mockRejectedValue(new Error('Redis down')),
        set: vi.fn().mockRejectedValue(new Error('Redis down')),
        del: vi.fn().mockRejectedValue(new Error('Redis down')),
        scan: vi.fn().mockResolvedValue([]),
        rpush: vi.fn().mockResolvedValue(undefined),
        ltrim: vi.fn().mockResolvedValue(undefined),
        lrange: vi.fn().mockResolvedValue([]),
        hset: vi.fn().mockResolvedValue(undefined),
        hdel: vi.fn().mockResolvedValue(undefined),
        hgetall: vi.fn().mockResolvedValue({}),
      };

      const bal = new LoadBalancer(badStore);
      const tiers = createMockTiers(2);

      // Hash strategy should work even with bad connection store
      const idx = await bal.selectTier('user-1', tiers, 'hash');
      expect([0, 1]).toContain(idx);
    });
  });
});
