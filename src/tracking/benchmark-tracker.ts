/**
 * Benchmark Tracker — persists boot and inference timing data for historical analysis.
 *
 * Uses the StateStore interface for persistence (Redis-backed in production).
 * Follows the same pattern as SpendTracker.
 */

import type { StateStore } from '../deps';
import { defaultLogger } from '../logger';
import type { Logger } from '../deps';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BootBenchmark {
  userId: string;
  provider: string;
  tierIndex: number;
  durationMs: number;
  gpuType?: string;
  wasDiscovered: boolean;
  instanceId?: string;
  timestamp: number;
}

export interface InferenceBenchmark {
  userId: string;
  provider: string;
  endpoint: string;
  sttMs?: number;
  llmMs?: number;
  ttsMs?: number;
  totalMs: number;
  /** Time to first audio byte */
  ttfaMs?: number;
  timestamp: number;
}

export interface BenchmarkStats {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

export interface BenchmarkSummary {
  date: string;
  boot: BenchmarkStats | null;
  inference: {
    total: BenchmarkStats | null;
    stt: BenchmarkStats | null;
    llm: BenchmarkStats | null;
    tts: BenchmarkStats | null;
    ttfa: BenchmarkStats | null;
  };
  byProvider: Record<string, {
    boot: BenchmarkStats | null;
    inference: BenchmarkStats | null;
  }>;
}

export interface BenchmarkTrend {
  dates: string[];
  bootP95: (number | null)[];
  inferP95: (number | null)[];
  inferMean: (number | null)[];
}

// ── Keys ──────────────────────────────────────────────────────────────────────

const BOOT_KEY_PREFIX = 'bench:boot:';
const INFER_KEY_PREFIX = 'bench:infer:';
const MAX_RECORDS_PER_DAY = 1000;

function bootKey(userId: string, date: string): string {
  return `${BOOT_KEY_PREFIX}${userId}:${date}`;
}

function inferKey(userId: string, date: string): string {
  return `${INFER_KEY_PREFIX}${userId}:${date}`;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Stats helpers ─────────────────────────────────────────────────────────────

function computeStats(values: number[]): BenchmarkStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    count: sorted.length,
    mean: Math.round(sum / sorted.length),
    p50: sorted[Math.floor(sorted.length * 0.5)]!,
    p95: sorted[Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1)]!,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

// ── Tracker ───────────────────────────────────────────────────────────────────

export class BenchmarkTracker {
  private stateStore: StateStore;
  private logger: Logger;

  constructor(stateStore: StateStore, logger?: Logger) {
    this.stateStore = stateStore;
    this.logger = logger ?? defaultLogger;
  }

  /** Record a boot benchmark (typically auto-recorded from boot_ok lifecycle events). */
  async recordBoot(record: BootBenchmark): Promise<void> {
    const date = new Date(record.timestamp).toISOString().slice(0, 10);
    const key = bootKey(record.userId, date);
    try {
      await this.stateStore.rpush(key, JSON.stringify(record));
      await this.stateStore.ltrim(key, -MAX_RECORDS_PER_DAY, -1);
    } catch (err) {
      this.logger.warn('[benchmark-tracker] Failed to record boot benchmark:', err);
    }
  }

  /** Record an inference benchmark. */
  async recordInference(record: InferenceBenchmark): Promise<void> {
    const date = new Date(record.timestamp).toISOString().slice(0, 10);
    const key = inferKey(record.userId, date);
    try {
      await this.stateStore.rpush(key, JSON.stringify(record));
      await this.stateStore.ltrim(key, -MAX_RECORDS_PER_DAY, -1);
    } catch (err) {
      this.logger.warn('[benchmark-tracker] Failed to record inference benchmark:', err);
    }
  }

  /** Get recent boot benchmarks for a user on a given date. */
  async getRecentBoots(userId: string, date?: string): Promise<BootBenchmark[]> {
    const d = date ?? todayStr();
    const key = bootKey(userId, d);
    try {
      const raw = await this.stateStore.lrange(key, 0, -1);
      return raw.map(r => {
        try { return JSON.parse(r) as BootBenchmark; }
        catch { return null; }
      }).filter((r): r is BootBenchmark => r !== null);
    } catch {
      return [];
    }
  }

  /** Get recent inference benchmarks for a user on a given date. */
  async getRecentInferences(userId: string, date?: string): Promise<InferenceBenchmark[]> {
    const d = date ?? todayStr();
    const key = inferKey(userId, d);
    try {
      const raw = await this.stateStore.lrange(key, 0, -1);
      return raw.map(r => {
        try { return JSON.parse(r) as InferenceBenchmark; }
        catch { return null; }
      }).filter((r): r is InferenceBenchmark => r !== null);
    } catch {
      return [];
    }
  }

  /** Get a daily summary with stats for boot and inference timings. */
  async getDailySummary(userId: string, date?: string): Promise<BenchmarkSummary> {
    const d = date ?? todayStr();
    const boots = await this.getRecentBoots(userId, d);
    const infers = await this.getRecentInferences(userId, d);

    // Boot stats
    const bootDurations = boots.map(b => b.durationMs);

    // Inference stats by stage
    const totalMs = infers.map(i => i.totalMs);
    const sttMs = infers.map(i => i.sttMs).filter((v): v is number => v != null);
    const llmMs = infers.map(i => i.llmMs).filter((v): v is number => v != null);
    const ttsMs = infers.map(i => i.ttsMs).filter((v): v is number => v != null);
    const ttfaMs = infers.map(i => i.ttfaMs).filter((v): v is number => v != null);

    // By provider
    const providers = new Set([
      ...boots.map(b => b.provider),
      ...infers.map(i => i.provider),
    ]);
    const byProvider: BenchmarkSummary['byProvider'] = {};
    for (const p of providers) {
      byProvider[p] = {
        boot: computeStats(boots.filter(b => b.provider === p).map(b => b.durationMs)),
        inference: computeStats(infers.filter(i => i.provider === p).map(i => i.totalMs)),
      };
    }

    return {
      date: d,
      boot: computeStats(bootDurations),
      inference: {
        total: computeStats(totalMs),
        stt: computeStats(sttMs),
        llm: computeStats(llmMs),
        tts: computeStats(ttsMs),
        ttfa: computeStats(ttfaMs),
      },
      byProvider,
    };
  }

  /** Get multi-day trend data for charts. */
  async getTrend(userId: string, days = 7): Promise<BenchmarkTrend> {
    const dates: string[] = [];
    const bootP95: (number | null)[] = [];
    const inferP95: (number | null)[] = [];
    const inferMean: (number | null)[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const d = date.toISOString().slice(0, 10);
      dates.push(d);

      const summary = await this.getDailySummary(userId, d);
      bootP95.push(summary.boot?.p95 ?? null);
      inferP95.push(summary.inference.total?.p95 ?? null);
      inferMean.push(summary.inference.total?.mean ?? null);
    }

    return { dates, bootP95, inferP95, inferMean };
  }
}
