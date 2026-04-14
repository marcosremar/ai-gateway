import { describe, it, expect, beforeEach } from 'vitest';
import { BenchmarkTracker, type BootBenchmark, type InferenceBenchmark } from '@ai-gateway/tracking/benchmark-tracker';
import type { StateStore } from '@ai-gateway/deps';

/** In-memory StateStore for testing — implements KvStore + ListStore + HashStore */
class InMemoryStateStore implements StateStore {
  private kv = new Map<string, string>();
  private lists = new Map<string, string[]>();
  private hashes = new Map<string, Map<string, string>>();

  async get(key: string) { return this.kv.get(key) ?? null; }
  async set(key: string, value: string) { this.kv.set(key, value); }
  async del(key: string) { this.kv.delete(key); this.lists.delete(key); this.hashes.delete(key); }
  async scan(pattern: string) {
    const prefix = pattern.replace('*', '');
    return [...this.kv.keys(), ...this.lists.keys()].filter(k => k.startsWith(prefix));
  }
  async rpush(key: string, value: string) {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
  }
  async ltrim(key: string, start: number, stop: number) {
    const list = this.lists.get(key) ?? [];
    // Redis ltrim: start and stop are 0-based, inclusive. Negative = from end.
    const len = list.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : stop;
    this.lists.set(key, list.slice(s, e + 1));
  }
  async lrange(key: string, start: number, stop: number) {
    const list = this.lists.get(key) ?? [];
    const len = list.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : stop;
    return list.slice(s, e + 1);
  }
  async hset(key: string, field: string, value: string) {
    const m = this.hashes.get(key) ?? new Map();
    m.set(field, value);
    this.hashes.set(key, m);
  }
  async hdel(key: string, field: string) { this.hashes.get(key)?.delete(field); }
  async hgetall(key: string) {
    const m = this.hashes.get(key);
    return m ? Object.fromEntries(m) : {};
  }
}

function makeBoot(overrides: Partial<BootBenchmark> = {}): BootBenchmark {
  return {
    userId: 'user-1',
    provider: 'runpod',
    tierIndex: 0,
    durationMs: 30000,
    wasDiscovered: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeInference(overrides: Partial<InferenceBenchmark> = {}): InferenceBenchmark {
  return {
    userId: 'user-1',
    provider: 'runpod',
    endpoint: 'http://test:8000',
    totalMs: 2000,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('BenchmarkTracker', () => {
  let store: InMemoryStateStore;
  let tracker: BenchmarkTracker;

  beforeEach(() => {
    store = new InMemoryStateStore();
    tracker = new BenchmarkTracker(store);
  });

  // ── recordBoot + getRecentBoots ───────────────────────────────────────

  describe('recordBoot + getRecentBoots', () => {
    it('records and retrieves boot benchmarks', async () => {
      const boot = makeBoot({ timestamp: new Date('2026-03-03T10:00:00Z').getTime() });
      await tracker.recordBoot(boot);

      const boots = await tracker.getRecentBoots('user-1', '2026-03-03');
      expect(boots).toHaveLength(1);
      expect(boots[0].durationMs).toBe(30000);
      expect(boots[0].provider).toBe('runpod');
    });

    it('returns empty for no data', async () => {
      const boots = await tracker.getRecentBoots('user-1', '2026-01-01');
      expect(boots).toEqual([]);
    });
  });

  // ── recordInference + getRecentInferences ─────────────────────────────

  describe('recordInference + getRecentInferences', () => {
    it('records and retrieves inference benchmarks', async () => {
      const inf = makeInference({ timestamp: new Date('2026-03-03T12:00:00Z').getTime() });
      await tracker.recordInference(inf);

      const infs = await tracker.getRecentInferences('user-1', '2026-03-03');
      expect(infs).toHaveLength(1);
      expect(infs[0].totalMs).toBe(2000);
    });

    it('returns empty for no data', async () => {
      const infs = await tracker.getRecentInferences('user-1', '2026-01-01');
      expect(infs).toEqual([]);
    });
  });

  // ── getDailySummary ───────────────────────────────────────────────────

  describe('getDailySummary', () => {
    const date = '2026-03-03';
    const ts = (h: number) => new Date(`2026-03-03T${String(h).padStart(2, '0')}:00:00Z`).getTime();

    it('computes stats (count, mean, p50, p95, min, max)', async () => {
      await tracker.recordBoot(makeBoot({ durationMs: 10000, timestamp: ts(10) }));
      await tracker.recordBoot(makeBoot({ durationMs: 20000, timestamp: ts(11) }));
      await tracker.recordBoot(makeBoot({ durationMs: 30000, timestamp: ts(12) }));

      const summary = await tracker.getDailySummary('user-1', date);
      expect(summary.boot).not.toBeNull();
      expect(summary.boot!.count).toBe(3);
      expect(summary.boot!.mean).toBe(20000);
      expect(summary.boot!.min).toBe(10000);
      expect(summary.boot!.max).toBe(30000);
    });

    it('computes per-stage inference stats', async () => {
      await tracker.recordInference(makeInference({
        sttMs: 100, llmMs: 200, ttsMs: 300, totalMs: 600, ttfaMs: 150, timestamp: ts(10),
      }));
      await tracker.recordInference(makeInference({
        sttMs: 120, llmMs: 180, ttsMs: 280, totalMs: 580, ttfaMs: 140, timestamp: ts(11),
      }));

      const summary = await tracker.getDailySummary('user-1', date);
      expect(summary.inference.total).not.toBeNull();
      expect(summary.inference.total!.count).toBe(2);
      expect(summary.inference.stt).not.toBeNull();
      expect(summary.inference.stt!.count).toBe(2);
      expect(summary.inference.llm).not.toBeNull();
      expect(summary.inference.tts).not.toBeNull();
      expect(summary.inference.ttfa).not.toBeNull();
    });

    it('computes per-provider breakdown', async () => {
      await tracker.recordBoot(makeBoot({ provider: 'runpod', durationMs: 10000, timestamp: ts(10) }));
      await tracker.recordBoot(makeBoot({ provider: 'tensordock', durationMs: 20000, timestamp: ts(11) }));
      await tracker.recordInference(makeInference({ provider: 'runpod', totalMs: 500, timestamp: ts(12) }));

      const summary = await tracker.getDailySummary('user-1', date);
      expect(summary.byProvider['runpod']).toBeDefined();
      expect(summary.byProvider['runpod'].boot!.count).toBe(1);
      expect(summary.byProvider['runpod'].inference!.count).toBe(1);
      expect(summary.byProvider['tensordock']).toBeDefined();
      expect(summary.byProvider['tensordock'].boot!.count).toBe(1);
    });

    it('returns null stats for empty data', async () => {
      const summary = await tracker.getDailySummary('user-1', date);
      expect(summary.boot).toBeNull();
      expect(summary.inference.total).toBeNull();
      expect(summary.inference.stt).toBeNull();
    });
  });

  // ── getTrend ──────────────────────────────────────────────────────────

  describe('getTrend', () => {
    it('returns multi-day trend data', async () => {
      // Record data for today
      await tracker.recordBoot(makeBoot({ durationMs: 15000 }));
      await tracker.recordInference(makeInference({ totalMs: 1000 }));

      const trend = await tracker.getTrend('user-1', 3);
      expect(trend.dates).toHaveLength(3);
      expect(trend.bootP95).toHaveLength(3);
      expect(trend.inferP95).toHaveLength(3);
      expect(trend.inferMean).toHaveLength(3);
      // Today should have data, previous days null
      const today = new Date().toISOString().slice(0, 10);
      const todayIdx = trend.dates.indexOf(today);
      expect(todayIdx).toBeGreaterThanOrEqual(0);
      expect(trend.bootP95[todayIdx]).toBe(15000);
    });

    it('returns null for empty days', async () => {
      const trend = await tracker.getTrend('user-1', 7);
      expect(trend.dates).toHaveLength(7);
      expect(trend.bootP95.every(v => v === null)).toBe(true);
      expect(trend.inferP95.every(v => v === null)).toBe(true);
    });
  });

  // ── Data isolation ────────────────────────────────────────────────────

  describe('data isolation', () => {
    it('different users have separate data', async () => {
      const ts1 = new Date('2026-03-03T10:00:00Z').getTime();
      await tracker.recordBoot(makeBoot({ userId: 'user-a', durationMs: 5000, timestamp: ts1 }));
      await tracker.recordBoot(makeBoot({ userId: 'user-b', durationMs: 9000, timestamp: ts1 }));

      const bootsA = await tracker.getRecentBoots('user-a', '2026-03-03');
      const bootsB = await tracker.getRecentBoots('user-b', '2026-03-03');
      expect(bootsA).toHaveLength(1);
      expect(bootsA[0].durationMs).toBe(5000);
      expect(bootsB).toHaveLength(1);
      expect(bootsB[0].durationMs).toBe(9000);
    });

    it('different dates have separate data', async () => {
      await tracker.recordBoot(makeBoot({ durationMs: 5000, timestamp: new Date('2026-03-01T10:00:00Z').getTime() }));
      await tracker.recordBoot(makeBoot({ durationMs: 9000, timestamp: new Date('2026-03-02T10:00:00Z').getTime() }));

      const day1 = await tracker.getRecentBoots('user-1', '2026-03-01');
      const day2 = await tracker.getRecentBoots('user-1', '2026-03-02');
      expect(day1).toHaveLength(1);
      expect(day1[0].durationMs).toBe(5000);
      expect(day2).toHaveLength(1);
      expect(day2[0].durationMs).toBe(9000);
    });
  });
});
