import type { ListStore } from '../../deps';

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

/**
 * #253 — P95 over a *time* window rather than a fixed sample count.
 *
 * `countRecentBreaches`/`computeP95` over the last 20 samples make P95 the
 * ~19th value — unstable, and easily driven by one or two outliers. When
 * latency samples carry timestamps, this computes P95 over only the samples
 * within `windowMs` of `now`, so a burst of recent traffic gives a
 * statistically meaningful P95 and old samples age out. Returns null when no
 * sample falls in the window.
 */
export function computeP95TimeWindow(
  samples: Array<{ value: number; ts: number }>,
  windowMs: number,
  now: number = Date.now(),
): number | null {
  const cutoff = now - windowMs;
  const inWindow = samples.filter((s) => s.ts >= cutoff).map((s) => s.value);
  return computeP95(inWindow);
}

/**
 * #254 — sustained-breach detector over a longer tail using a ratio.
 *
 * `countRecentBreaches` only inspects the last 3 samples and the caller
 * requires all 3 to breach, so a sustained-but-jittery degradation (e.g. 2 of
 * the last 5 over threshold, repeatedly) never trips scale-up. This looks at
 * the last `window` samples and returns true when the *fraction* over
 * threshold is at least `minRatio`.
 */
export function isSustainedBreach(
  samples: number[],
  maxMs: number,
  opts: { window?: number; minRatio?: number } = {},
): boolean {
  const { window = 10, minRatio = 0.5 } = opts;
  const recent = samples.slice(-window);
  if (recent.length === 0) return false;
  const breaches = recent.filter((s) => s > maxMs).length;
  return breaches / recent.length >= minRatio;
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
