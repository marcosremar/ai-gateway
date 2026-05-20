/**
 * Runaway detector — pauses a provider that shows a rapid create/destroy
 * loop pattern before it burns through the daily budget.
 *
 * Historical context: on 2026-03-25, a runaway create/destroy loop on
 * RunPod burned $130 in a single day (vs $6/day average) and triggered
 * RunPod's abuse flag, blocking the account for 24 hours. The daily
 * budget cap caught the spend eventually (P0-1), but not before the loop
 * had damaged the relationship with the upstream provider. A runaway
 * detector catches the *shape* of the failure (rapid repeated starts)
 * independent of dollar cost, so we stop the loop in seconds rather
 * than minutes.
 *
 * Algorithm: per-provider sliding window of deploy_started timestamps.
 * If >MAX_STARTS events land within WINDOW_MS, pause that provider for
 * PAUSE_MS and emit a lifecycle event. Pauses are sticky until TTL or
 * an explicit clear().
 *
 * This module is framework-agnostic and pure-function. No I/O, no
 * dependencies beyond the injected clock. Testable without the engine.
 */

/** Default: 6 deploy_started events in 2 minutes is a runaway. */
const DEFAULT_MAX_STARTS = 6;
const DEFAULT_WINDOW_MS = 2 * 60_000;
const DEFAULT_PAUSE_MS = 15 * 60_000;

export interface RunawayDetectorOptions {
  maxStarts?: number;
  windowMs?: number;
  pauseMs?: number;
  now?: () => number;
}

export interface RunawayPauseEvent {
  provider: string;
  startCount: number;
  windowMs: number;
  pausedUntilMs: number;
}

interface ProviderState {
  starts: number[];          // unix ms timestamps of recent deploy_started events
  pausedUntilMs?: number;
  pauseReason?: string;
}

export class RunawayDetector {
  private readonly maxStarts: number;
  private readonly windowMs: number;
  private readonly pauseMs: number;
  private readonly now: () => number;
  private readonly states = new Map<string, ProviderState>();
  private readonly listeners: Array<(e: RunawayPauseEvent) => void> = [];

  constructor(opts: RunawayDetectorOptions = {}) {
    this.maxStarts = opts.maxStarts ?? DEFAULT_MAX_STARTS;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.pauseMs = opts.pauseMs ?? DEFAULT_PAUSE_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Register a callback fired each time a provider is paused. */
  onPause(listener: (e: RunawayPauseEvent) => void): void {
    this.listeners.push(listener);
  }

  /**
   * Record a deploy_started event. Returns true if the caller should
   * proceed with the deploy, false if the provider is currently paused
   * (either from a prior runaway trip or manual pause via `pause()`).
   *
   * If recording this event pushes the sliding window past the threshold,
   * the provider is immediately paused and onPause listeners fire BEFORE
   * this call returns false.
   */
  recordDeployStart(provider: string): boolean {
    const t = this.now();
    const state = this._getOrCreate(provider);

    // Is the provider already paused?
    if (state.pausedUntilMs && t < state.pausedUntilMs) {
      return false;
    }
    // Pause expired — clear it.
    if (state.pausedUntilMs && t >= state.pausedUntilMs) {
      delete state.pausedUntilMs;
      delete state.pauseReason;
    }

    // Trim the window to entries within the last windowMs.
    const cutoff = t - this.windowMs;
    while (state.starts.length > 0 && state.starts[0] < cutoff) {
      state.starts.shift();
    }

    // Record this event.
    state.starts.push(t);

    // Did we just cross the threshold? Pause if so. Use `>=` so the Nth
    // event trips the gate (was `>`, allowing maxStarts+1 burns first).
    if (state.starts.length >= this.maxStarts) {
      state.pausedUntilMs = t + this.pauseMs;
      state.pauseReason = `${state.starts.length} deploy_started events in ${this.windowMs / 1000}s`;
      this._emitPause({
        provider,
        startCount: state.starts.length,
        windowMs: this.windowMs,
        pausedUntilMs: state.pausedUntilMs,
      });
      return false;
    }

    return true;
  }

  /**
   * Check whether a provider is currently paused without recording a new
   * start event. Used by the deploy path for the "should I even try this
   * provider?" gate that doesn't itself count against the window.
   */
  isPaused(provider: string): boolean {
    const state = this.states.get(provider);
    if (!state?.pausedUntilMs) return false;
    if (this.now() >= state.pausedUntilMs) {
      delete state.pausedUntilMs;
      delete state.pauseReason;
      return false;
    }
    return true;
  }

  /** Inspect the current state for observability / debugging. */
  stats(provider: string): {
    recentStarts: number;
    paused: boolean;
    pausedUntilMs?: number;
    pauseReason?: string;
  } {
    const state = this.states.get(provider);
    if (!state) return { recentStarts: 0, paused: false };
    const cutoff = this.now() - this.windowMs;
    const recent = state.starts.filter(t => t >= cutoff).length;
    return {
      recentStarts: recent,
      paused: this.isPaused(provider),
      pausedUntilMs: state.pausedUntilMs,
      pauseReason: state.pauseReason,
    };
  }

  /** Manually pause a provider (e.g. via an admin endpoint). */
  pause(provider: string, reason: string, ttlMs?: number): void {
    const state = this._getOrCreate(provider);
    state.pausedUntilMs = this.now() + (ttlMs ?? this.pauseMs);
    state.pauseReason = reason;
    this._emitPause({
      provider,
      startCount: state.starts.length,
      windowMs: this.windowMs,
      pausedUntilMs: state.pausedUntilMs,
    });
  }

  /**
   * Manually clear a pause — both auto and manual. Also resets the sliding
   * window so the next recordDeployStart() doesn't immediately re-trip on
   * stale timestamps from the previous trip. Operator intent: "this is
   * fine now, start fresh".
   */
  clear(provider: string): void {
    const state = this.states.get(provider);
    if (!state) return;
    delete state.pausedUntilMs;
    delete state.pauseReason;
    state.starts = [];
  }

  /** Reset all state (tests). */
  reset(): void {
    this.states.clear();
  }

  private _getOrCreate(provider: string): ProviderState {
    let state = this.states.get(provider);
    if (!state) {
      state = { starts: [] };
      this.states.set(provider, state);
    }
    return state;
  }

  private _emitPause(e: RunawayPauseEvent): void {
    for (const l of this.listeners) {
      try { l(e); } catch { /* listener errors must not break recording */ }
    }
  }
}

/** Process-wide singleton for simple callers. */
let _globalDetector: RunawayDetector | null = null;
export function getGlobalRunawayDetector(): RunawayDetector {
  if (!_globalDetector) _globalDetector = new RunawayDetector();
  return _globalDetector;
}

/** Reset the singleton (tests only). */
export function _resetGlobalRunawayDetector(): void {
  _globalDetector = null;
}
