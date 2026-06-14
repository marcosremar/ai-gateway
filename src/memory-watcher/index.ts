/**
 * Memory leak detection and management.
 *
 * Monitors heap usage, triggers GC on idle, and alerts on potential leaks.
 *
 * @example
 * ```ts
 * import { startMemoryWatcher } from './memory-watcher';
 *
 * // Start monitoring in production
 * startMemoryWatcher({
 *   maxHeapMb: 512,
 *   checkIntervalMs: 60_000,
 *   onAlert: (stats) => console.warn('Memory alert:', stats),
 * });
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('memory-watcher');

export interface MemoryWatcherConfig {
  /** Max heap size in MB before alerting (default: 512) */
  maxHeapMb?: number;
  /** Check interval in ms (default: 60_000) */
  checkIntervalMs?: number;
  /** Trigger GC when idle (default: false) */
  gcOnIdle?: boolean;
  /** Idle threshold in ms before GC (default: 300_000) */
  idleThresholdMs?: number;
  /** Callback on memory alert */
  onAlert?: (stats: MemoryStats) => void;
}

export interface MemoryStats {
  /** Resident Set Size (MB) */
  rssMb: number;
  /** Total heap (MB) */
  heapTotalMb: number;
  /** Used heap (MB) */
  heapUsedMb: number;
  /** Heap usage percentage */
  heapUsedPercent: number;
  /** External memory (MB) */
  externalMb: number;
  /** Trend: is heap growing? */
  trend: 'stable' | 'growing' | 'shrinking';
}

const DEFAULT_CONFIG: Required<MemoryWatcherConfig> = {
  maxHeapMb: 512,
  checkIntervalMs: 60_000,
  gcOnIdle: false,
  idleThresholdMs: 300_000,
  onAlert: () => {},
};

/**
 * Collect current memory stats.
 */
export function getMemoryStats(): MemoryStats {
  const usage = process.memoryUsage();

  return {
    rssMb: Math.round(usage.rss / 1024 / 1024),
    heapTotalMb: Math.round(usage.heapTotal / 1024 / 1024),
    heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
    heapUsedPercent: parseFloat(((usage.heapUsed / usage.heapTotal) * 100).toFixed(1)),
    externalMb: Math.round(usage.external / 1024 / 1024),
    trend: 'stable', // Will be computed by watcher
  };
}

/**
 * Force garbage collection (if available).
 */
export function forceGC(): boolean {
  if (global.gc) {
    global.gc();
    log.log({}, 'Manual GC triggered');
    return true;
  }

  log.log({}, 'GC not available — start Node with --expose-gc to enable');
  return false;
}

/**
 * Start memory watcher with periodic checks.
 */
export function startMemoryWatcher(config: MemoryWatcherConfig = {}): {
  stop: () => void;
  getStats: () => MemoryStats;
} {
  const cfg: Required<MemoryWatcherConfig> = { ...DEFAULT_CONFIG, ...config };
  let running = true;
  let lastStats: MemoryStats | null = null;
  // Single activity timestamp: written by the setTimeout hook below and read by
  // the idle-GC check. Previously the GC check read a separate `lastRequestTime`
  // that nothing ever updated, so idle GC never fired (#267).
  let lastActivity = Date.now();

  const interval = setInterval(() => {
    if (!running) return;

    const stats = getMemoryStats();

    // Compute trend
    if (lastStats) {
      if (stats.heapUsedMb > lastStats.heapUsedMb * 1.05) {
        stats.trend = 'growing';
      } else if (stats.heapUsedMb < lastStats.heapUsedMb * 0.95) {
        stats.trend = 'shrinking';
      } else {
        stats.trend = 'stable';
      }
    }

    lastStats = stats;

    // Check thresholds
    if (stats.heapUsedMb > cfg.maxHeapMb) {
      log.log(
        { heapUsedMb: stats.heapUsedMb, maxHeapMb: cfg.maxHeapMb, trend: stats.trend },
        '⚠️ Memory alert: heap exceeds threshold',
      );
      cfg.onAlert(stats);
    }

    if (stats.trend === 'growing') {
      log.log(
        { heapUsedMb: stats.heapUsedMb, growth: '+5% since last check' },
        '⚠️ Memory trend: heap growing',
      );
    }

    // GC on idle
    if (cfg.gcOnIdle) {
      const idleMs = Date.now() - lastActivity;
      if (idleMs > cfg.idleThresholdMs) {
        log.log({ idleMs }, 'Idle detected — triggering GC');
        forceGC();
      }
    }

    // Log periodic stats
    log.log(
      {
        rssMb: stats.rssMb,
        heapUsedMb: stats.heapUsedMb,
        heapTotalMb: stats.heapTotalMb,
        heapUsedPercent: stats.heapUsedPercent,
        trend: stats.trend,
      },
      'Memory stats',
    );
  }, cfg.checkIntervalMs);

  interval.unref();

  // Track request activity for idle detection by wrapping global.setTimeout.
  // We keep the original so stop() can restore it — leaving the patch in place
  // leaks globally and stacks across repeated watcher starts (#266).
  const originalSetTimeout = global.setTimeout;
  const patchedSetTimeout = function patchedSetTimeout(
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) {
    lastActivity = Date.now();
    return originalSetTimeout(fn, ms, ...args);
  } as typeof global.setTimeout;
  global.setTimeout = patchedSetTimeout;

  return {
    stop: () => {
      running = false;
      clearInterval(interval);
      // Restore the original only if nobody else re-patched on top of ours;
      // overwriting a newer patch would clobber another watcher's hook.
      if (global.setTimeout === patchedSetTimeout) {
        global.setTimeout = originalSetTimeout;
      }
      log.log({}, 'Memory watcher stopped');
    },
    getStats: () => lastStats ?? getMemoryStats(),
  };
}
