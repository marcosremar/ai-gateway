// ── BabelCast Gateway — PeakEWMA Latency Tracker ─────────────────────────────
// Tracks exponentially weighted moving average of request latency per provider,
// using the peak (highest recent) value to be conservative about routing.
// Lightweight, in-memory only — no disk I/O in the hot path.

interface EWMAState {
  ewma: number;
  peak: number;
  lastUpdate: number;
  samples: number;
}

export interface EWMARanking {
  provider: string;
  ewmaMs: number;
  peakMs: number;
  samples: number;
}

// ── Pure helpers (exported for unit testing — no `this`, no state) ───────────

/**
 * #252 — staleness penalty scaled by *how* stale a provider is.
 *
 * The old code applied a flat ×1.1 to any provider unused >60s, so one idle for
 * 61s and one idle for an hour were distrusted equally. This grows the penalty
 * linearly with the number of stale-thresholds elapsed, capped at `maxFactor`,
 * so a long-cold provider is appropriately deprioritised. Below the threshold
 * there is no penalty (factor 1).
 */
export function stalePenaltyFactor(
  elapsedMs: number,
  thresholdMs = 60_000,
  perWindow = 0.1,
  maxFactor = 2.0,
): number {
  if (elapsedMs <= thresholdMs) return 1;
  const windows = elapsedMs / thresholdMs; // 1 window at the threshold
  const factor = 1 + (windows - 1) * perWindow;
  return Math.min(maxFactor, Math.max(1, factor));
}

/**
 * #251 — routing score that incorporates the tracked `peak` (tail latency).
 *
 * `ranking()`/`pickBest()` historically sorted on `ewma` alone, ignoring the
 * "PeakEWMA" intent: a provider with a low average but spiky tails ranked the
 * same as a steady one. This blends the (stale-adjusted) average with the peak
 * so a provider with bad tails is deprioritised. `peakWeight=0` reproduces the
 * legacy ewma-only behavior.
 */
export function effectiveScore(adjustedEwmaMs: number, peakMs: number, peakWeight = 0.3): number {
  const w = Math.max(0, Math.min(1, peakWeight));
  return adjustedEwmaMs * (1 - w) + Math.max(adjustedEwmaMs, peakMs) * w;
}

/**
 * #516 — slower-decaying / latch-on peak so a brief spike is *not* forgotten
 * within a few samples.
 *
 * The legacy formula `peak = max(ewma, latency*0.5 + peak*0.5)` decays the peak
 * toward the mean: a single 5s tail is averaged away after ~3 normal samples,
 * which defeats conservative tail-aware routing. This pure helper instead latches
 * the peak immediately to any new high-water latency and otherwise decays it only
 * slowly (default 5% per sample) toward the current EWMA, so a real spike keeps
 * the provider deprioritised for many samples. `decay=0.5` reproduces the old
 * mean-reverting behaviour for callers that want it.
 */
export function updatePeak(
  prevPeak: number,
  newLatencyMs: number,
  ewmaMs: number,
  decay = 0.05,
): number {
  // New high-water mark — latch on immediately.
  if (newLatencyMs >= prevPeak) return newLatencyMs;
  const d = Math.max(0, Math.min(1, decay));
  // Decay slowly toward the EWMA, but never below it (peak ≥ average by defn).
  const decayed = prevPeak * (1 - d) + ewmaMs * d;
  return Math.max(ewmaMs, decayed);
}

/**
 * PeakEWMA latency tracker per provider.
 *
 * EWMA formula: ewma = decayFactor * newValue + (1 - decayFactor) * oldEwma
 * Peak tracking: peak = max(ewma, newValue * 0.5 + peak * 0.5)
 * Time decay: if unused >60s, inflate EWMA by 10% to account for cold starts.
 */
export class EWMATracker {
  private providers: Map<string, EWMAState> = new Map();
  private decayFactor: number;
  /** #516 — how fast the tracked peak decays toward the mean (per sample). */
  private peakDecay: number;
  /** #517 — minimum samples before a provider's latency is trusted for routing. */
  private minSamples: number;

  /** Stale threshold: if a provider hasn't been used in this many ms, penalise it */
  private static readonly STALE_THRESHOLD_MS = 60_000;
  /** Penalty multiplier for stale providers */
  private static readonly STALE_PENALTY = 1.1;
  /** Max providers to track (prevents unbounded growth) */
  private static readonly MAX_PROVIDERS = 50;

  /**
   * @param decayFactor EWMA blend weight for new observations (0–1).
   * @param opts.peakDecay (#516) per-sample peak decay toward the mean (default 0.05).
   * @param opts.minSamples (#517) samples required before {@link pickBest} trusts
   *   a provider's latency; below this it is treated as "unknown" so one fast
   *   fluke cannot pin routing. Default 1 preserves the legacy behaviour.
   */
  constructor(decayFactor: number = 0.3, opts: { peakDecay?: number; minSamples?: number } = {}) {
    this.decayFactor = Math.max(0, Math.min(1, decayFactor));
    this.peakDecay = Math.max(0, Math.min(1, opts.peakDecay ?? 0.05));
    this.minSamples = Math.max(1, Math.floor(opts.minSamples ?? 1));
  }

  /** Record a completed request's latency for a provider */
  record(provider: string, latencyMs: number): void {
    const existing = this.providers.get(provider);
    const now = Date.now();

    if (!existing) {
      // Evict oldest if at capacity
      if (this.providers.size >= EWMATracker.MAX_PROVIDERS) {
        let oldestKey = '';
        let oldestTime = Infinity;
        for (const [k, v] of this.providers) {
          if (v.lastUpdate < oldestTime) { oldestTime = v.lastUpdate; oldestKey = k; }
        }
        if (oldestKey) this.providers.delete(oldestKey);
      }
      // First observation — initialise with this value
      this.providers.set(provider, {
        ewma: latencyMs,
        peak: latencyMs,
        lastUpdate: now,
        samples: 1,
      });
      return;
    }

    // EWMA update: blend new observation with existing estimate
    existing.ewma = this.decayFactor * latencyMs + (1 - this.decayFactor) * existing.ewma;
    // Peak update (#516): latch onto new highs, decay slowly toward the mean so
    // a brief tail spike keeps deprioritising the provider for many samples
    // instead of being averaged away after ~3 normal observations.
    existing.peak = updatePeak(existing.peak, latencyMs, existing.ewma, this.peakDecay);
    existing.lastUpdate = now;
    existing.samples++;
  }

  /** Get the current EWMA estimate for a provider, with stale penalty applied */
  getLatency(provider: string): number | null {
    const state = this.providers.get(provider);
    if (!state) return null;
    return this._applyStaleDecay(state);
  }

  /**
   * Get all tracked providers sorted by estimated latency (lowest first).
   * Applies stale penalty to providers that haven't been used recently.
   */
  ranking(): EWMARanking[] {
    const now = Date.now();
    const entries: EWMARanking[] = [];

    this.providers.forEach((state, provider) => {
      const adjustedEwma = this._applyStaleDecay(state, now);
      entries.push({
        provider,
        ewmaMs: Math.round(adjustedEwma),
        peakMs: Math.round(state.peak),
        samples: state.samples,
      });
    });

    // Sort by EWMA ascending (lowest/fastest first)
    entries.sort((a, b) => a.ewmaMs - b.ewmaMs);
    return entries;
  }

  /**
   * Pick the best (lowest latency) provider from a list of candidates.
   * Candidates without EWMA data are treated as unknown (returned only if no
   * known candidates).
   *
   * When all candidates are unknown (cold), an optional `costOf` lookup breaks
   * the tie by cheapest provider instead of falling back to array position —
   * otherwise a cold *expensive* provider listed first would beat a cold cheap
   * one (#355). Providers without a cost are treated as +Infinity (least
   * preferred); ties fall back to the original (configured-priority) order.
   *
   * #517 — a provider with fewer than `minSamples` observations is treated as
   * "unknown" here so a single fast fluke cannot pin routing to it; it only
   * becomes eligible once it has accumulated enough samples to be trusted.
   */
  pickBest(candidates: string[], costOf?: (provider: string) => number | null): string | null {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    let bestProvider: string | null = null;
    let bestLatency = Infinity;
    const unknowns: string[] = [];

    for (const c of candidates) {
      const state = this.providers.get(c);
      const latency = this.getLatency(c);
      // Not enough samples yet → distrust and treat as unknown (#517).
      if (latency === null || !state || state.samples < this.minSamples) {
        unknowns.push(c);
        continue;
      }
      if (latency < bestLatency) {
        bestLatency = latency;
        bestProvider = c;
      }
    }

    // If we have a known best, use it
    if (bestProvider !== null) return bestProvider;
    if (unknowns.length === 0) return null;

    // All-unknown tie-break by cost when a cost lookup is supplied.
    if (costOf) {
      let cheapest = unknowns[0];
      let cheapestCost = costOf(cheapest) ?? Infinity;
      for (let i = 1; i < unknowns.length; i++) {
        const c = costOf(unknowns[i]) ?? Infinity;
        if (c < cheapestCost) {
          cheapestCost = c;
          cheapest = unknowns[i];
        }
      }
      return cheapest;
    }

    // No cost signal — keep configured-priority order (first unknown).
    return unknowns[0];
  }

  /**
   * #251/#252 — tail-aware ranking.
   *
   * Like `ranking()` but sorts by a blended score that (a) penalises stale
   * providers proportionally to how stale they are (#252) and (b) folds in the
   * tracked `peak` so spiky-tail providers are deprioritised (#251). Returns
   * the same shape as `ranking()` plus the computed `scoreMs`. The legacy
   * `ranking()` is left untouched for back-compat.
   */
  rankingByScore(peakWeight = 0.3): Array<EWMARanking & { scoreMs: number }> {
    const now = Date.now();
    const entries: Array<EWMARanking & { scoreMs: number }> = [];
    this.providers.forEach((state, provider) => {
      const adjusted = state.ewma * stalePenaltyFactor(now - state.lastUpdate, EWMATracker.STALE_THRESHOLD_MS);
      const scoreMs = effectiveScore(adjusted, state.peak, peakWeight);
      entries.push({
        provider,
        ewmaMs: Math.round(adjusted),
        peakMs: Math.round(state.peak),
        samples: state.samples,
        scoreMs: Math.round(scoreMs),
      });
    });
    entries.sort((a, b) => a.scoreMs - b.scoreMs);
    return entries;
  }

  /** Update the decay factor (e.g., from Labs settings UI) */
  setDecayFactor(factor: number): void {
    this.decayFactor = Math.max(0, Math.min(1, factor));
  }

  /** Reset all tracking data */
  reset(): void {
    this.providers.clear();
  }

  /** Get raw state for debugging/status endpoints */
  getState(): Record<string, { ewmaMs: number; peakMs: number; samples: number; lastUpdate: number }> {
    const out: Record<string, { ewmaMs: number; peakMs: number; samples: number; lastUpdate: number }> = {};
    this.providers.forEach((state, provider) => {
      out[provider] = {
        ewmaMs: Math.round(state.ewma),
        peakMs: Math.round(state.peak),
        samples: state.samples,
        lastUpdate: state.lastUpdate,
      };
    });
    return out;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /** Apply stale penalty: if provider unused for >60s, inflate EWMA by 10% */
  private _applyStaleDecay(state: EWMAState, now: number = Date.now()): number {
    const elapsed = now - state.lastUpdate;
    if (elapsed > EWMATracker.STALE_THRESHOLD_MS) {
      return state.ewma * EWMATracker.STALE_PENALTY;
    }
    return state.ewma;
  }
}
