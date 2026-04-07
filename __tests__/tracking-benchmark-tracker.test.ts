import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BenchmarkTracker } from '../src/tracking/benchmark-tracker';
import type { StateStore } from '../src/deps';
import type { BootBenchmark, InferenceBenchmark } from '../src/tracking/benchmark-tracker';

function makeStateStore(): StateStore & { data: Map<string, string[]> } {
  const data = new Map<string, string[]>();
  return {
    data,
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    incr: vi.fn(),
    hget: vi.fn(),
    hset: vi.fn(),
    hdel: vi.fn(),
    hgetall: vi.fn(),
    lrange: vi.fn(async (key: string, _start: number, _stop: number) => data.get(key) ?? []),
    rpush: vi.fn(async (key: string, value: string) => {
      const arr = data.get(key) ?? [];
      arr.push(value);
      data.set(key, arr);
    }),
    ltrim: vi.fn(async (key: string, start: number, stop: number) => {
      const arr = data.get(key) ?? [];
      if (start < 0 && stop < 0) {
        const s = arr.length + start;
        const e = arr.length + stop + 1;
        data.set(key, arr.slice(Math.max(0, s), e));
      }
    }),
    sadd: vi.fn(),
    srem: vi.fn(),
    smembers: vi.fn(() => []),
    expire: vi.fn(),
    ttl: vi.fn(() => -1),
  };
}

describe('BenchmarkTracker', () => {
  let store: ReturnType<typeof makeStateStore>;
  let tracker: BenchmarkTracker;

  beforeEach(() => {
    store = makeStateStore();
    tracker = new BenchmarkTracker(store);
  });

  describe('recordBoot', () => {
    it('persists boot benchmark', async () => {
      const record: BootBenchmark = {
        userId: 'user1',
        provider: 'runpod',
        tierIndex: 0,
        durationMs: 5000,
        wasDiscovered: false,
        instanceId: 'inst-1',
        timestamp: Date.now(),
      };
      await tracker.recordBoot(record);
      expect(store.rpush).toHaveBeenCalled();
    });

    it('swallows errors gracefully', async () => {
      store.rpush = vi.fn(() => Promise.reject(new Error('redis down')));
      await expect(tracker.recordBoot({
        userId: 'user1', provider: 'runpod', tierIndex: 0, durationMs: 5000, wasDiscovered: false, timestamp: Date.now(),
      })).resolves.toBeUndefined();
    });
  });

  describe('recordInference', () => {
    it('persists inference benchmark', async () => {
      const record: InferenceBenchmark = {
        userId: 'user1',
        provider: 'groq',
        endpoint: 'https://api.groq.com',
        sttMs: 200,
        llmMs: 300,
        ttsMs: 400,
        totalMs: 900,
        ttfaMs: 250,
        timestamp: Date.now(),
      };
      await tracker.recordInference(record);
      expect(store.rpush).toHaveBeenCalled();
    });
  });

  describe('getRecentBoots', () => {
    it('returns empty when no data', async () => {
      const boots = await tracker.getRecentBoots('user1');
      expect(boots).toEqual([]);
    });

    it('parses stored boot records', async () => {
      const record: BootBenchmark = {
        userId: 'user1', provider: 'runpod', tierIndex: 0, durationMs: 5000, wasDiscovered: false, timestamp: Date.now(),
      };
      await tracker.recordBoot(record);
      const boots = await tracker.getRecentBoots('user1');
      expect(boots).toHaveLength(1);
      expect(boots[0].durationMs).toBe(5000);
    });
  });

  describe('getRecentInferences', () => {
    it('parses stored inference records', async () => {
      const record: InferenceBenchmark = {
        userId: 'user1', provider: 'groq', endpoint: '', totalMs: 900, timestamp: Date.now(),
      };
      await tracker.recordInference(record);
      const infers = await tracker.getRecentInferences('user1');
      expect(infers).toHaveLength(1);
      expect(infers[0].totalMs).toBe(900);
    });

    it('ignores malformed entries', async () => {
      store.data.set(
        [...store.data.keys()][0] ?? 'bench:infer:user1:' + new Date().toISOString().slice(0, 10),
        ['not-json'],
      );
      const key = `bench:infer:user1:${new Date().toISOString().slice(0, 10)}`;
      store.data.set(key, ['not-json']);
      store.lrange = vi.fn(() => Promise.resolve(['not-json']));
      const infers = await tracker.getRecentInferences('user1');
      expect(infers).toEqual([]);
    });
  });

  describe('getDailySummary', () => {
    it('returns null stats when no data', async () => {
      const summary = await tracker.getDailySummary('user1');
      expect(summary.boot).toBeNull();
      expect(summary.inference.total).toBeNull();
    });

    it('computes stats from boot records', async () => {
      for (let i = 0; i < 5; i++) {
        await tracker.recordBoot({
          userId: 'user1', provider: 'runpod', tierIndex: 0,
          durationMs: 1000 + i * 500, wasDiscovered: false, timestamp: Date.now(),
        });
      }
      const summary = await tracker.getDailySummary('user1');
      expect(summary.boot).not.toBeNull();
      expect(summary.boot!.count).toBe(5);
      expect(summary.boot!.min).toBe(1000);
      expect(summary.boot!.max).toBe(3000);
    });

    it('computes stats from inference records by stage', async () => {
      await tracker.recordInference({
        userId: 'user1', provider: 'groq', endpoint: '',
        sttMs: 100, llmMs: 200, ttsMs: 300, totalMs: 600, ttfaMs: 120,
        timestamp: Date.now(),
      });
      const summary = await tracker.getDailySummary('user1');
      expect(summary.inference.stt).not.toBeNull();
      expect(summary.inference.llm).not.toBeNull();
      expect(summary.inference.tts).not.toBeNull();
      expect(summary.inference.ttfa).not.toBeNull();
    });

    it('groups by provider', async () => {
      await tracker.recordBoot({
        userId: 'user1', provider: 'runpod', tierIndex: 0, durationMs: 5000, wasDiscovered: false, timestamp: Date.now(),
      });
      await tracker.recordInference({
        userId: 'user1', provider: 'groq', endpoint: '', totalMs: 900, timestamp: Date.now(),
      });
      const summary = await tracker.getDailySummary('user1');
      expect(summary.byProvider['runpod']).toBeDefined();
      expect(summary.byProvider['groq']).toBeDefined();
    });
  });

  describe('getTrend', () => {
    it('returns arrays of correct length', async () => {
      const trend = await tracker.getTrend('user1', 7);
      expect(trend.dates).toHaveLength(7);
      expect(trend.bootP95).toHaveLength(7);
      expect(trend.inferP95).toHaveLength(7);
      expect(trend.inferMean).toHaveLength(7);
    });

    it('returns nulls when no data', async () => {
      const trend = await tracker.getTrend('user1', 3);
      expect(trend.bootP95.every(v => v === null)).toBe(true);
    });
  });
});
