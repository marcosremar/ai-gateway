/**
 * Tests for tracking/spend-tracker.ts
 * - SpendTracker.record()
 * - SpendTracker.estimateCost()
 * - SpendTracker.getDailySummary()
 * - SpendTracker.checkBudget()
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SpendTracker, type SpendRecord } from '../src/tracking/spend-tracker';
import type { StateStore } from '../src/deps';

// ── In-memory StateStore mock ──────────────────────────────────────────────────

function makeStateStore(): StateStore & {
  lists: Map<string, string[]>;
  hashes: Map<string, Record<string, string>>;
  kvs: Map<string, string>;
} {
  const lists = new Map<string, string[]>();
  const hashes = new Map<string, Record<string, string>>();
  const kvs = new Map<string, string>();

  return {
    lists,
    hashes,
    kvs,

    async get(key: string) { return kvs.get(key) ?? null; },
    async set(key: string, value: string) { kvs.set(key, value); },
    async del(key: string) { kvs.delete(key); lists.delete(key); hashes.delete(key); },
    async scan(pattern: string) {
      const prefix = pattern.replace('*', '');
      return [...kvs.keys(), ...lists.keys(), ...hashes.keys()].filter(k => k.startsWith(prefix));
    },

    async hset(key: string, field: string, value: string) {
      if (!hashes.has(key)) hashes.set(key, {});
      hashes.get(key)![field] = value;
    },
    async hgetall(key: string) { return hashes.get(key) ?? {}; },
    async hdel(key: string, field: string) { delete hashes.get(key)?.[field]; },

    async rpush(key: string, value: string) {
      if (!lists.has(key)) lists.set(key, []);
      lists.get(key)!.push(value);
    },
    async lrange(key: string, start: number, stop: number) {
      const list = lists.get(key) ?? [];
      if (stop === -1) return list.slice(start);
      return list.slice(start, stop + 1);
    },
    async ltrim(key: string, start: number, stop: number) {
      const list = lists.get(key) ?? [];
      const trimmed = stop === -1 ? list.slice(start) : list.slice(start, stop + 1);
      lists.set(key, trimmed);
    },
  };
}

function makeRecord(overrides: Partial<SpendRecord> = {}): SpendRecord {
  return {
    userId: 'user-1',
    provider: 'openai',
    model: 'gpt-4o-mini',
    stage: 'llm',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.000045,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('SpendTracker', () => {
  let store: ReturnType<typeof makeStateStore>;
  let tracker: SpendTracker;

  beforeEach(() => {
    store = makeStateStore();
    tracker = new SpendTracker(store as unknown as StateStore);
  });

  describe('estimateCost()', () => {
    it('estimates cost for known model', () => {
      const cost = tracker.estimateCost('openai', 'gpt-4o', 1_000_000, 0);
      expect(cost).toBeCloseTo(2.5);
    });

    it('returns 0 for unknown model', () => {
      const cost = tracker.estimateCost('unknown', 'model', 1000, 500);
      expect(cost).toBe(0);
    });

    it('uses custom pricing table when provided', () => {
      const customTracker = new SpendTracker(store as unknown as StateStore, {
        'custom/model': { inputPer1M: 10, outputPer1M: 20 },
      });
      const cost = customTracker.estimateCost('custom', 'model', 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(30);
    });
  });

  describe('record()', () => {
    it('records a spend event to the list', async () => {
      const rec = makeRecord({ costUsd: 0.001 });
      await tracker.record(rec);

      const date = new Date(rec.timestamp).toISOString().slice(0, 10);
      const key = `spend:records:user-1:${date}`;
      expect(store.lists.get(key)?.length).toBe(1);
    });

    it('records multiple events', async () => {
      const now = Date.now();
      await tracker.record(makeRecord({ timestamp: now, costUsd: 0.001 }));
      await tracker.record(makeRecord({ timestamp: now, costUsd: 0.002 }));
      await tracker.record(makeRecord({ timestamp: now, costUsd: 0.003 }));

      const date = new Date(now).toISOString().slice(0, 10);
      const key = `spend:records:user-1:${date}`;
      expect(store.lists.get(key)?.length).toBe(3);
    });

    it('does not throw on store errors', async () => {
      const errorStore = {
        ...store,
        rpush: async () => { throw new Error('store error'); },
      };
      const errorTracker = new SpendTracker(errorStore as unknown as StateStore);
      // Should not throw
      await expect(errorTracker.record(makeRecord())).resolves.toBeUndefined();
    });
  });

  describe('getDailySummary()', () => {
    it('returns empty summary when no records', async () => {
      const summary = await tracker.getDailySummary('user-1');
      expect(summary.totalCostUsd).toBe(0);
      expect(summary.requestCount).toBe(0);
      expect(summary.byProvider).toEqual({});
      expect(summary.byStage).toEqual({});
    });

    it('aggregates totals correctly', async () => {
      const now = Date.now();
      const date = new Date(now).toISOString().slice(0, 10);

      await tracker.record(makeRecord({ timestamp: now, costUsd: 0.001, provider: 'openai', stage: 'stt' }));
      await tracker.record(makeRecord({ timestamp: now, costUsd: 0.002, provider: 'groq', stage: 'llm' }));
      await tracker.record(makeRecord({ timestamp: now, costUsd: 0.003, provider: 'openai', stage: 'tts' }));

      const summary = await tracker.getDailySummary('user-1', date);
      expect(summary.totalCostUsd).toBeCloseTo(0.006);
      expect(summary.requestCount).toBe(3);
    });

    it('groups by provider', async () => {
      const now = Date.now();
      const date = new Date(now).toISOString().slice(0, 10);

      await tracker.record(makeRecord({ timestamp: now, costUsd: 0.001, provider: 'openai' }));
      await tracker.record(makeRecord({ timestamp: now, costUsd: 0.002, provider: 'openai' }));
      await tracker.record(makeRecord({ timestamp: now, costUsd: 0.003, provider: 'groq' }));

      const summary = await tracker.getDailySummary('user-1', date);
      expect(summary.byProvider['openai'].costUsd).toBeCloseTo(0.003);
      expect(summary.byProvider['openai'].requests).toBe(2);
      expect(summary.byProvider['groq'].costUsd).toBeCloseTo(0.003);
      expect(summary.byProvider['groq'].requests).toBe(1);
    });

    it('groups by stage', async () => {
      const now = Date.now();
      const date = new Date(now).toISOString().slice(0, 10);

      await tracker.record(makeRecord({ timestamp: now, costUsd: 0.001, stage: 'stt' }));
      await tracker.record(makeRecord({ timestamp: now, costUsd: 0.002, stage: 'llm' }));
      await tracker.record(makeRecord({ timestamp: now, costUsd: 0.003, stage: 'llm' }));

      const summary = await tracker.getDailySummary('user-1', date);
      expect(summary.byStage['stt'].requests).toBe(1);
      expect(summary.byStage['llm'].requests).toBe(2);
      expect(summary.byStage['llm'].costUsd).toBeCloseTo(0.005);
    });

    it('skips corrupted records', async () => {
      const now = Date.now();
      const date = new Date(now).toISOString().slice(0, 10);
      const key = `spend:records:user-1:${date}`;

      // Inject invalid JSON
      store.lists.set(key, ['not-json', JSON.stringify(makeRecord({ timestamp: now, costUsd: 0.005 }))]);

      const summary = await tracker.getDailySummary('user-1', date);
      expect(summary.requestCount).toBe(1);
      expect(summary.totalCostUsd).toBeCloseTo(0.005);
    });

    it('returns partial summary on store errors', async () => {
      const errorStore = {
        ...store,
        lrange: async () => { throw new Error('store error'); },
      };
      const errorTracker = new SpendTracker(errorStore as unknown as StateStore);
      const summary = await errorTracker.getDailySummary('user-1');
      expect(summary.totalCostUsd).toBe(0);
      expect(summary.requestCount).toBe(0);
    });

    it('uses today when date not provided', async () => {
      const now = Date.now();
      await tracker.record(makeRecord({ timestamp: now, costUsd: 0.01 }));

      // Should return today's data without explicit date
      const summary = await tracker.getDailySummary('user-1');
      expect(summary.requestCount).toBe(1);
    });
  });

  describe('checkBudget()', () => {
    it('returns not-over when no spend', async () => {
      const status = await tracker.checkBudget('user-1', { dailyLimitUsd: 10 });
      expect(status.over).toBe(false);
      expect(status.pct).toBe(0);
      expect(status.limitUsd).toBe(10);
      expect(status.currentUsd).toBe(0);
    });

    it('returns over when spend exceeds limit', async () => {
      const now = Date.now();
      await tracker.record(makeRecord({ timestamp: now, costUsd: 5 }));
      await tracker.record(makeRecord({ timestamp: now, costUsd: 6 }));

      const status = await tracker.checkBudget('user-1', { dailyLimitUsd: 10 });
      expect(status.over).toBe(true);
      expect(status.currentUsd).toBeCloseTo(11);
    });

    it('calculates percentage correctly', async () => {
      const now = Date.now();
      await tracker.record(makeRecord({ timestamp: now, costUsd: 5 }));

      const status = await tracker.checkBudget('user-1', { dailyLimitUsd: 20 });
      expect(status.pct).toBeCloseTo(0.25); // 5/20 = 25%
      expect(status.over).toBe(false);
    });

    it('handles zero limit gracefully', async () => {
      const status = await tracker.checkBudget('user-1', { dailyLimitUsd: 0 });
      expect(status.pct).toBe(0);
      // 0 >= 0 → over=true (current spend meets the $0 limit)
      expect(status.over).toBe(true);
    });

    it('marks as over when exactly at limit', async () => {
      const now = Date.now();
      await tracker.record(makeRecord({ timestamp: now, costUsd: 10 }));

      const status = await tracker.checkBudget('user-1', { dailyLimitUsd: 10 });
      expect(status.over).toBe(true); // >= limit
    });
  });
});
