/**
 * Tests for autoscaler/predictive-warmup.ts
 * - recordUsageForPrediction()
 * - shouldPreWarm()
 * - runPredictiveWarmupForUser()
 * - startPredictiveWarmupTicker()
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordUsageForPrediction,
  shouldPreWarm,
  runPredictiveWarmupForUser,
  startPredictiveWarmupTicker,
  type PredictiveWarmupConfig,
  type PredictiveWarmupDeps,
} from '../src/autoscaler/predictive-warmup';
import type { StateStore } from '../src/deps';

function makeStore() {
  const hashes = new Map<string, Record<string, string>>();
  const store: StateStore = {
    async get(key) { return null; },
    async set(key, value) {},
    async del(key) {},
    async scan(pattern) { return []; },
    async rpush(key, value) {},
    async ltrim(key, start, stop) {},
    async lrange(key, start, stop) { return []; },
    async hset(key, field, value) {
      if (!hashes.has(key)) hashes.set(key, {});
      hashes.get(key)![field] = value;
    },
    async hdel(key, field) { delete hashes.get(key)?.[field]; },
    async hgetall(key) { return hashes.get(key) ?? {}; },
  };
  return { store, hashes };
}

const silentLogger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('recordUsageForPrediction', () => {
  it('records usage for current bucket', async () => {
    const { store, hashes } = makeStore();
    await recordUsageForPrediction(store, 'user-1');

    const now = new Date();
    const bucket = now.getDay() * 24 + now.getHours();
    const key = `predictive:usage:user-1`;

    const bucketVal = hashes.get(key)?.[String(bucket)];
    expect(bucketVal).toBeDefined();
    expect(Number(bucketVal)).toBe(1);
  });

  it('increments existing count', async () => {
    const { store, hashes } = makeStore();
    const now = new Date();
    const bucket = now.getDay() * 24 + now.getHours();
    const key = `predictive:usage:user-1`;

    // Pre-set existing count
    hashes.set(key, { [String(bucket)]: '5' });

    await recordUsageForPrediction(store, 'user-1');

    expect(Number(hashes.get(key)?.[String(bucket)])).toBe(6);
  });

  it('does not throw on store errors', async () => {
    // hgetall succeeds but hset throws
    const errorStore: StateStore = {
      async get(key) { return null; },
      async set(key, value) {},
      async del(key) {},
      async scan(pattern) { return []; },
      async rpush(key, value) {},
      async ltrim(key, start, stop) {},
      async lrange(key, start, stop) { return []; },
      async hset(key, field, value) { throw new Error('hset error'); },
      async hdel(key, field) {},
      async hgetall(key) { return {}; },
    };
    await expect(recordUsageForPrediction(errorStore, 'user-1')).resolves.toBeUndefined();
  });
});

describe('shouldPreWarm', () => {
  const config: PredictiveWarmupConfig = {
    enabled: true,
    leadTimeMinutes: 10,
    minHourlyRequests: 3,
  };

  it('returns shouldWarm=false when no historical data', async () => {
    const { store } = makeStore();
    const result = await shouldPreWarm(store, 'user-1', config);
    expect(result.shouldWarm).toBe(false);
    expect(result.predictedRequests).toBe(0);
  });

  it('returns shouldWarm=true when bucket exceeds threshold', async () => {
    const { store, hashes } = makeStore();

    // Set high usage for the upcoming bucket
    const futureDate = new Date(Date.now() + 10 * 60 * 1000);
    const bucket = futureDate.getDay() * 24 + futureDate.getHours();
    hashes.set('predictive:usage:user-1', { [String(bucket)]: '5' });

    const result = await shouldPreWarm(store, 'user-1', config);
    expect(result.shouldWarm).toBe(true);
    expect(result.predictedRequests).toBe(5);
  });

  it('returns shouldWarm=false when bucket is below threshold', async () => {
    const { store, hashes } = makeStore();

    const futureDate = new Date(Date.now() + 10 * 60 * 1000);
    const bucket = futureDate.getDay() * 24 + futureDate.getHours();
    hashes.set('predictive:usage:user-1', { [String(bucket)]: '2' }); // < minHourlyRequests=3

    const result = await shouldPreWarm(store, 'user-1', config);
    expect(result.shouldWarm).toBe(false);
  });

  it('returns correct bucket index', async () => {
    const { store } = makeStore();
    const result = await shouldPreWarm(store, 'user-1', config);
    expect(result.bucket).toBeGreaterThanOrEqual(0);
    expect(result.bucket).toBeLessThan(168); // 7 * 24 = 168 buckets
  });

  it('uses defaults when config fields missing', async () => {
    const { store, hashes } = makeStore();
    const minConfig: PredictiveWarmupConfig = { enabled: true };

    // Default leadTimeMinutes=10, minHourlyRequests=3
    const futureDate = new Date(Date.now() + 10 * 60 * 1000);
    const bucket = futureDate.getDay() * 24 + futureDate.getHours();
    hashes.set('predictive:usage:user-1', { [String(bucket)]: '4' });

    const result = await shouldPreWarm(store, 'user-1', minConfig);
    expect(result.shouldWarm).toBe(true);
  });

  it('returns shouldWarm=false on store error', async () => {
    const errorStore: StateStore = {
      async get(key) { return null; },
      async set(key, value) {},
      async del(key) {},
      async scan(pattern) { return []; },
      async rpush(key, value) {},
      async ltrim(key, start, stop) {},
      async lrange(key, start, stop) { return []; },
      async hset(key, field, value) {},
      async hdel(key, field) {},
      async hgetall(key) { throw new Error('store error'); },
    };
    const result = await shouldPreWarm(errorStore, 'user-1', config);
    expect(result.shouldWarm).toBe(false);
  });
});

describe('runPredictiveWarmupForUser', () => {
  const baseConfig: PredictiveWarmupConfig = {
    enabled: true,
    leadTimeMinutes: 10,
    minHourlyRequests: 3,
  };

  it('returns false when config disabled', async () => {
    const { store } = makeStore();
    const deps: PredictiveWarmupDeps = {
      stateStore: store,
      triggerBoot: async () => true,
      listWarmupUsers: async () => [],
      logger: silentLogger,
    };

    const result = await runPredictiveWarmupForUser(deps, 'user-1', { ...baseConfig, enabled: false });
    expect(result).toBe(false);
  });

  it('returns false when shouldPreWarm is false (no data)', async () => {
    const { store } = makeStore();
    let bootCalled = false;
    const deps: PredictiveWarmupDeps = {
      stateStore: store,
      triggerBoot: async () => { bootCalled = true; return true; },
      listWarmupUsers: async () => [],
    };

    const result = await runPredictiveWarmupForUser(deps, 'user-1', baseConfig);
    expect(result).toBe(false);
    expect(bootCalled).toBe(false);
  });

  it('triggers boot when shouldPreWarm is true', async () => {
    const { store, hashes } = makeStore();

    // Set high usage for upcoming bucket
    const futureDate = new Date(Date.now() + 10 * 60 * 1000);
    const bucket = futureDate.getDay() * 24 + futureDate.getHours();
    hashes.set('predictive:usage:user-1', { [String(bucket)]: '5' });

    let bootCalled = false;
    const deps: PredictiveWarmupDeps = {
      stateStore: store,
      triggerBoot: async () => { bootCalled = true; return true; },
      listWarmupUsers: async () => [],
      logger: silentLogger,
    };

    const result = await runPredictiveWarmupForUser(deps, 'user-1', baseConfig);
    expect(result).toBe(true);
    expect(bootCalled).toBe(true);
  });

  it('handles boot trigger error gracefully', async () => {
    const { store, hashes } = makeStore();

    const futureDate = new Date(Date.now() + 10 * 60 * 1000);
    const bucket = futureDate.getDay() * 24 + futureDate.getHours();
    hashes.set('predictive:usage:user-1', { [String(bucket)]: '5' });

    const deps: PredictiveWarmupDeps = {
      stateStore: store,
      triggerBoot: async () => { throw new Error('boot failed'); },
      listWarmupUsers: async () => [],
      logger: silentLogger,
    };

    const result = await runPredictiveWarmupForUser(deps, 'user-1', baseConfig);
    expect(result).toBe(false);
  });
});

describe('startPredictiveWarmupTicker', () => {
  it('returns a cleanup function', () => {
    const { store } = makeStore();
    const deps: PredictiveWarmupDeps = {
      stateStore: store,
      triggerBoot: async () => false,
      listWarmupUsers: async () => [],
    };

    const cleanup = startPredictiveWarmupTicker(deps, 99999);
    expect(typeof cleanup).toBe('function');
    cleanup(); // Should not throw
  });

  it('cleanup stops the interval', async () => {
    const { store } = makeStore();
    let callCount = 0;
    const deps: PredictiveWarmupDeps = {
      stateStore: store,
      triggerBoot: async () => false,
      listWarmupUsers: async () => { callCount++; return []; },
    };

    const cleanup = startPredictiveWarmupTicker(deps, 10); // 10ms interval
    await new Promise(r => setTimeout(r, 50));
    cleanup();
    const countAtCleanup = callCount;
    await new Promise(r => setTimeout(r, 50));
    // After cleanup, count should not increase significantly
    expect(callCount).toBeLessThanOrEqual(countAtCleanup + 1);
  });
});
