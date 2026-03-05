import type { ListStore } from '../deps';

/** Keep last N latency samples per user */
const LATENCY_WINDOW_SIZE = 20;
/** How many consecutive high-latency samples before triggering boot */
export const LATENCY_BREACH_COUNT = 3;

/** Compute p95 from a list of latency samples (nearest-rank method) */
export function computeP95(samples: number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

/** Count how many of the most recent samples exceed the threshold */
export function countRecentBreaches(samples: number[], maxMs: number): number {
  const recent = samples.slice(-LATENCY_BREACH_COUNT);
  return recent.filter((s) => s > maxMs).length;
}

export class LatencyTracker {
  private stateStore: ListStore;

  constructor(stateStore: ListStore) {
    this.stateStore = stateStore;
  }

  private key(userId: string): string {
    return `autoscaler:latency:${userId}`;
  }

  /**
   * Report a completed audio request latency for a user.
   * Called from the audio transports after each completed round-trip.
   */
  async reportLatency(userId: string, totalMs: number): Promise<void> {
    const key = this.key(userId);
    await this.stateStore.rpush(key, String(totalMs));
    await this.stateStore.ltrim(key, -LATENCY_WINDOW_SIZE, -1);
  }

  /** Get latency stats: p95, samples, and breach count */
  async getLatencyStats(userId: string, maxLatencyMs?: number): Promise<{ p95: number | null; samples: number[]; breaches: number }> {
    const raw = await this.stateStore.lrange(this.key(userId), 0, -1);
    const samples = raw.map(Number).filter((n) => !isNaN(n));
    if (samples.length === 0) return { p95: null, samples: [], breaches: 0 };
    const p95 = computeP95(samples);
    const breaches = maxLatencyMs != null
      ? countRecentBreaches(samples, maxLatencyMs)
      : 0;
    return { p95, samples, breaches };
  }
}
