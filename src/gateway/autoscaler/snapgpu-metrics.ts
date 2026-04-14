/**
 * SnapGPU Metrics — rolling window tracker that compares cold-boot vs
 * CRIU-restore latency per workload and auto-disables snapshots when the
 * restore path is consistently slower.
 *
 * Why this exists:
 *   The SnapGPU optimistic assumption — "if we have a snapshot, use it" —
 *   fails catastrophically in three known scenarios:
 *     1. Snapshot is stale (model file changed under it on disk)
 *     2. Workload is unsuitable for CRIU (GGUF mmap, fast cold starts)
 *     3. Host network / disk is degraded, slowing the S3 download of the
 *        snapshot more than a fresh image pull would cost
 *
 *   Without a kill switch, any of these turns a fast-path into a slow-path
 *   and stays there until a human notices. This tracker closes the loop:
 *   it compares the two paths at equal weight and flips a disable bit when
 *   restore is losing.
 *
 * Design:
 *   - One rolling window per (userId, workloadKey) pair. workloadKey is
 *     typically `{image}:{appName}` so the same image across users shares
 *     data but a user flipping images gets a fresh window.
 *   - Window holds up to WINDOW_SIZE recent deploy observations tagged as
 *     'cold' or 'restore' with their duration_ms.
 *   - Auto-disable triggers when: the rolling averages are both populated
 *     AND average_restore > average_cold × DISABLE_RATIO (default 0.7 =
 *     "restore must be at least 30% faster to be worth the risk"; set to
 *     1.0 for "strictly faster"). The threshold intentionally favors cold
 *     boot because cold is the safer default.
 *   - Disable is sticky for DISABLE_TTL_MS; after the TTL the next deploy
 *     re-enables and re-measures to detect transient degradation recovery.
 *   - Observations are kept in memory only. Intended to be long-lived in
 *     a single gateway process; persistence across restarts is out of
 *     scope for v1 (deploy cadence is slow enough that in-memory is fine).
 */

export type BootPath = 'cold' | 'restore';

interface Observation {
  path: BootPath;
  durationMs: number;
  ts: number;
}

interface WindowState {
  observations: Observation[];
  /** Wall-clock time after which auto-disable expires and re-measurement starts. */
  disabledUntilMs?: number;
  /** Reason auto-disable was triggered, for lifecycle logging. */
  disableReason?: string;
}

export interface SnapgpuMetricsOptions {
  /** Number of most recent observations to keep in the rolling window. */
  windowSize?: number;
  /** Auto-disable when avg_restore > avg_cold * disableRatio. Lower = more
   *  willing to disable. Default 0.7 (restore must be ≥30% faster). */
  disableRatio?: number;
  /** Minimum number of samples of EACH kind before auto-disable can trigger.
   *  Prevents flapping on the first restore-after-cold comparison. */
  minSamples?: number;
  /** How long auto-disable stays sticky before re-measurement. Default 24h. */
  disableTtlMs?: number;
  /** Clock function — injected for tests. */
  now?: () => number;
}

const DEFAULT_WINDOW_SIZE = 20;
const DEFAULT_DISABLE_RATIO = 0.7;
const DEFAULT_MIN_SAMPLES = 3;
const DEFAULT_DISABLE_TTL_MS = 24 * 60 * 60 * 1000;

export interface DisableEvent {
  userId: string;
  workloadKey: string;
  avgColdMs: number;
  avgRestoreMs: number;
  reason: string;
  disabledUntilMs: number;
}

export class SnapgpuMetrics {
  private readonly windows = new Map<string, WindowState>();
  private readonly windowSize: number;
  private readonly disableRatio: number;
  private readonly minSamples: number;
  private readonly disableTtlMs: number;
  private readonly now: () => number;
  private readonly disableListeners: Array<(e: DisableEvent) => void> = [];

  constructor(opts: SnapgpuMetricsOptions = {}) {
    this.windowSize = opts.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.disableRatio = opts.disableRatio ?? DEFAULT_DISABLE_RATIO;
    this.minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
    this.disableTtlMs = opts.disableTtlMs ?? DEFAULT_DISABLE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Register a listener that fires whenever a workload is auto-disabled. */
  onDisable(listener: (e: DisableEvent) => void): void {
    this.disableListeners.push(listener);
  }

  /**
   * Record a completed deploy's wall-clock duration, tagged by the path
   * that was taken. Must be called once per successful boot to keep the
   * window meaningful.
   */
  record(userId: string, workloadKey: string, path: BootPath, durationMs: number): void {
    if (!workloadKey || durationMs <= 0) return;
    const key = this._key(userId, workloadKey);
    const state = this.windows.get(key) ?? { observations: [] };
    state.observations.push({ path, durationMs, ts: this.now() });
    if (state.observations.length > this.windowSize) {
      state.observations.splice(0, state.observations.length - this.windowSize);
    }
    this.windows.set(key, state);
    this._maybeAutoDisable(userId, workloadKey, state);
  }

  /**
   * Returns true if snapshot restore is currently auto-disabled for this
   * workload. Callers should use this as the autoDisabled input to
   * shouldUseSnapshot(). Expired disables are cleared on read.
   */
  isDisabled(userId: string, workloadKey: string): boolean {
    const key = this._key(userId, workloadKey);
    const state = this.windows.get(key);
    if (!state?.disabledUntilMs) return false;
    if (this.now() >= state.disabledUntilMs) {
      delete state.disabledUntilMs;
      delete state.disableReason;
      return false;
    }
    return true;
  }

  /**
   * Inspect the rolling averages for observability / debugging.
   * Returns null if no observations recorded.
   */
  stats(userId: string, workloadKey: string): {
    coldAvgMs: number | null;
    restoreAvgMs: number | null;
    coldCount: number;
    restoreCount: number;
    disabled: boolean;
    disableReason?: string;
  } | null {
    const key = this._key(userId, workloadKey);
    const state = this.windows.get(key);
    if (!state) return null;
    const cold = state.observations.filter(o => o.path === 'cold');
    const restore = state.observations.filter(o => o.path === 'restore');
    return {
      coldAvgMs: cold.length ? Math.round(avg(cold.map(o => o.durationMs))) : null,
      restoreAvgMs: restore.length ? Math.round(avg(restore.map(o => o.durationMs))) : null,
      coldCount: cold.length,
      restoreCount: restore.length,
      disabled: this.isDisabled(userId, workloadKey),
      disableReason: state.disableReason,
    };
  }

  /**
   * Manually disable snapshot restore for a workload. Used when the
   * runtime health probe reports CRIU isn't actually available on the
   * current host (no CAP_SYS_ADMIN) — there's no point in measuring.
   */
  disable(userId: string, workloadKey: string, reason: string, ttlMs?: number): void {
    const key = this._key(userId, workloadKey);
    const state = this.windows.get(key) ?? { observations: [] };
    state.disabledUntilMs = this.now() + (ttlMs ?? this.disableTtlMs);
    state.disableReason = reason;
    this.windows.set(key, state);
    this._emitDisable({
      userId,
      workloadKey,
      avgColdMs: 0,
      avgRestoreMs: 0,
      reason,
      disabledUntilMs: state.disabledUntilMs,
    });
  }

  /** Clear all state. Intended for tests. */
  reset(): void {
    this.windows.clear();
  }

  private _maybeAutoDisable(userId: string, workloadKey: string, state: WindowState): void {
    // Already disabled — don't re-evaluate until TTL expires
    if (state.disabledUntilMs && this.now() < state.disabledUntilMs) return;

    const cold = state.observations.filter(o => o.path === 'cold');
    const restore = state.observations.filter(o => o.path === 'restore');
    if (cold.length < this.minSamples || restore.length < this.minSamples) return;

    const coldAvg = avg(cold.map(o => o.durationMs));
    const restoreAvg = avg(restore.map(o => o.durationMs));

    // Disable when restore isn't winning by enough margin. The ratio encodes
    // "restore must be faster than cold * ratio"; a ratio of 0.7 means
    // restore has to be at least 30% faster than cold to stay enabled.
    if (restoreAvg > coldAvg * this.disableRatio) {
      const reason = `restore_avg=${Math.round(restoreAvg)}ms > cold_avg=${Math.round(coldAvg)}ms × ${this.disableRatio}`;
      state.disabledUntilMs = this.now() + this.disableTtlMs;
      state.disableReason = reason;
      this._emitDisable({
        userId,
        workloadKey,
        avgColdMs: Math.round(coldAvg),
        avgRestoreMs: Math.round(restoreAvg),
        reason,
        disabledUntilMs: state.disabledUntilMs,
      });
    }
  }

  private _emitDisable(e: DisableEvent): void {
    for (const l of this.disableListeners) {
      try { l(e); } catch { /* listener errors must not break recording */ }
    }
  }

  private _key(userId: string, workloadKey: string): string {
    return `${userId}::${workloadKey}`;
  }
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * Build the workload key used as the tracker's secondary index. Stable
 * across deploys of the same image+app but flips when either changes,
 * which is exactly the invalidation semantics we want.
 */
export function buildWorkloadKey(dockerImage: string | undefined, appName: string | undefined): string {
  return `${dockerImage ?? 'unknown-image'}::${appName ?? 'default'}`;
}
