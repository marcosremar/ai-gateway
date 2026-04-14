/**
 * Timer Tracker — centralized tracking of all setTimeout/setInterval calls.
 *
 * Fixes Gap #13: 230+ timer leaks where setTimeout/setInterval are called
 * without corresponding clearTimeout/clearInterval.
 *
 * Usage:
 * ```typescript
 * import { trackedTimeout, trackedInterval, clearAllTimers } from './timer-tracker';
 *
 * // Instead of:
 * const timer = setTimeout(fn, 1000);
 * // Use:
 * const timerId = trackedTimeout(fn, 1000, 'module-name');
 *
 * // To clear:
 * clearTimeout(timerId);  // Or use clearTimer()
 *
 * // To clear all (on shutdown):
 * await clearAllTimers();
 * ```
 */

import { createLogger } from '../logger';

const log = createLogger('timer-tracker');

interface TimerInfo {
  id: ReturnType<typeof setTimeout>;
  type: 'timeout' | 'interval';
  module: string;
  createdAt: number;
}

const activeTimers = new Map<ReturnType<typeof setTimeout>, TimerInfo>();

/**
 * Create a tracked timeout. Use this instead of setTimeout.
 */
export function trackedTimeout(
  fn: () => void,
  delay: number,
  moduleName: string = 'unknown',
): ReturnType<typeof setTimeout> {
  const id = setTimeout(() => {
    activeTimers.delete(id);
    fn();
  }, delay);

  activeTimers.set(id, {
    id,
    type: 'timeout',
    module: moduleName,
    createdAt: Date.now(),
  });

  return id;
}

/**
 * Create a tracked interval. Use this instead of setInterval.
 */
export function trackedInterval(
  fn: () => void,
  delay: number,
  moduleName: string = 'unknown',
): ReturnType<typeof setInterval> {
  const id = setInterval(fn, delay);

  activeTimers.set(id, {
    id,
    type: 'interval',
    module: moduleName,
    createdAt: Date.now(),
  });

  return id;
}

/**
 * Clear a tracked timer.
 */
export function clearTimer(id: ReturnType<typeof setTimeout>): void {
  const timer = activeTimers.get(id);
  if (timer) {
    activeTimers.delete(id);
    if (timer.type === 'interval') {
      clearInterval(id);
    } else {
      clearTimeout(id);
    }
  } else {
    // Not tracked — clear anyway
    clearTimeout(id);
  }
}

/**
 * Clear all active timers. Call this on shutdown.
 */
export async function clearAllTimers(): Promise<void> {
  const count = activeTimers.size;
  log.log({ count }, 'Clearing all active timers');

  for (const [id, timer] of activeTimers.entries()) {
    if (timer.type === 'interval') {
      clearInterval(id);
    } else {
      clearTimeout(id);
    }
    activeTimers.delete(id);
  }

  log.log({ count }, 'All timers cleared');
}

/**
 * Get active timer stats.
 */
export function getTimerStats(): {
  total: number;
  timeouts: number;
  intervals: number;
  byModule: Record<string, number>;
} {
  const stats = {
    total: activeTimers.size,
    timeouts: 0,
    intervals: 0,
    byModule: {} as Record<string, number>,
  };

  for (const timer of activeTimers.values()) {
    if (timer.type === 'timeout') stats.timeouts++;
    else stats.intervals++;
    stats.byModule[timer.module] = (stats.byModule[timer.module] || 0) + 1;
  }

  return stats;
}
