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

  /** Stale threshold: if a provider hasn't been used in this many ms, penalise it */
  private static readonly STALE_THRESHOLD_MS = 60_000;
  /** Penalty multiplier for stale providers */
  private static readonly STALE_PENALTY = 1.1;
  /** Max providers to track (prevents unbounded growth) */
  private static readonly MAX_PROVIDERS = 50;

  constructor(decayFactor: number = 0.3) {
    this.decayFactor = Math.max(0, Math.min(1, decayFactor));
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
    // Peak update: conservative blend — keeps track of worst-case
    existing.peak = Math.max(existing.ewma, latencyMs * 0.5 + existing.peak * 0.5);
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
   */
  pickBest(candidates: string[], costOf?: (provider: string) => number | null): string | null {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    let bestProvider: string | null = null;
    let bestLatency = Infinity;
    const unknowns: string[] = [];

    for (const c of candidates) {
      const latency = this.getLatency(c);
      if (latency === null) {
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
