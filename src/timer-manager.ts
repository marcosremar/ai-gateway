/**
 * Timer Manager — Centralized timer management to prevent memory leaks
 * 
 * Replaces scattered setTimeout/setInterval calls with tracked,
 * named timers that can be properly cleaned up.
 */

import { createLogger } from './logger';

const log = createLogger('timer-manager');

export interface TimerInfo {
  id: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
  name: string;
  type: 'timeout' | 'interval';
  createdAt: number;
  maxDuration?: number;
  /** Map key for this timer — stored so cleanup is O(n), not O(n²) (#269). */
  key?: string;
}

export interface TimerStats {
  active: number;
  total: number;
  byName: Record<string, number>;
}

export class TimerManager {
  private timers = new Map<string, TimerInfo>();
  private id = 0;

  /**
   * Create a tracked timeout
   */
  setTimeout(
    name: string,
    callback: () => void,
    delay: number
  ): string {
    const timerId = ++this.id;
    const key = `${name}_${timerId}`;
    
    const id = setTimeout(() => {
      this.timers.delete(key);
      try {
        callback();
      } catch (err) {
        log.error(`[${name}] Timer callback failed:`, err);
      }
    }, delay);

    this.timers.set(key, {
      id,
      name,
      type: 'timeout',
      createdAt: Date.now(),
      maxDuration: delay,
      key,
    });

    log.debug(`[${name}] Timeout created (${delay}ms)`);
    return key;
  }

  /**
   * Create a tracked interval
   */
  setInterval(
    name: string,
    callback: () => void,
    interval: number
  ): string {
    const timerId = ++this.id;
    const key = `${name}_${timerId}`;
    
    const id = setInterval(() => {
      try {
        callback();
      } catch (err) {
        log.error(`[${name}] Interval callback failed:`, err);
      }
    }, interval);

    this.timers.set(key, {
      id,
      name,
      type: 'interval',
      createdAt: Date.now(),
      key,
    });

    log.debug(`[${name}] Interval created (${interval}ms)`);
    return key;
  }

  /**
   * Clear a specific timer by key
   */
  clear(key: string): boolean {
    const timer = this.timers.get(key);
    if (!timer) {
      return false;
    }

    if (timer.type === 'timeout') {
      clearTimeout(timer.id);
    } else {
      clearInterval(timer.id);
    }

    this.timers.delete(key);
    log.debug(`[${timer.name}] Timer cleared`);
    return true;
  }

  /**
   * Clear all timers matching a name pattern
   */
  clearByName(name: string): number {
    let cleared = 0;
    for (const [key, timer] of this.timers) {
      if (timer.name === name || timer.name.startsWith(`${name}:`)) {
        if (timer.type === 'timeout') {
          clearTimeout(timer.id);
        } else {
          clearInterval(timer.id);
        }
        this.timers.delete(key);
        cleared++;
      }
    }
    
    if (cleared > 0) {
      log.log(`[${name}] Cleared ${cleared} timers`);
    }
    return cleared;
  }

  /**
   * Clear all tracked timers
   */
  clearAll(): number {
    const count = this.timers.size;
    
    for (const [key, timer] of this.timers) {
      if (timer.type === 'timeout') {
        clearTimeout(timer.id);
      } else {
        clearInterval(timer.id);
      }
    }
    
    this.timers.clear();
    log.log(`Cleared all ${count} timers`);
    return count;
  }

  /**
   * Get statistics about active timers
   */
  getStats(): TimerStats {
    const byName: Record<string, number> = {};
    
    for (const timer of this.timers.values()) {
      byName[timer.name] = (byName[timer.name] || 0) + 1;
    }

    return {
      active: this.timers.size,
      total: this.id,
      byName,
    };
  }

  /**
   * Get active timers info
   */
  getActiveTimers(): TimerInfo[] {
    return Array.from(this.timers.values());
  }

  /**
   * Find potentially leaked timers (running longer than expected)
   */
  findLeakedTimers(maxAgeMs: number = 300000): TimerInfo[] {
    const now = Date.now();
    const leaked: TimerInfo[] = [];

    for (const timer of this.timers.values()) {
      const age = now - timer.createdAt;
      const maxDuration = timer.maxDuration || maxAgeMs;
      
      if (age > maxDuration * 2) {
        leaked.push(timer);
      }
    }

    return leaked;
  }

  /**
   * Auto-cleanup leaked timers
   */
  cleanupLeakedTimers(maxAgeMs: number = 300000): number {
    const leaked = this.findLeakedTimers(maxAgeMs);

    let cleaned = 0;
    for (const timer of leaked) {
      // #269: use the key stored on TimerInfo — O(1) per timer instead of
      // re-scanning the whole map (was O(n²) across all leaked timers).
      const key = timer.key;
      // Never reap the housekeeping sweep itself — it's a long-lived interval
      // and would otherwise look "leaked" to its own pass (#268).
      if (key && key === this.leakSweepKey) continue;
      if (key && this.timers.has(key)) {
        this.clear(key);
        cleaned++;
        log.warn(`[${timer.name}] Cleaned up leaked timer (age: ${Date.now() - timer.createdAt}ms)`);
      }
    }

    return cleaned;
  }

  /**
   * #268 — start a periodic self-sweep that reaps leaked timers. The sweep
   * timer is itself tracked (and unref'd, so it never pins the process on
   * shutdown). Idempotent: calling it again clears the previous sweep first.
   * Returns the sweep timer key.
   */
  private leakSweepKey: string | null = null;
  startLeakSweep(intervalMs: number = 300000, maxAgeMs: number = 300000): string {
    this.stopLeakSweep();
    const key = this.setInterval('timer-manager:leak-sweep', () => {
      this.cleanupLeakedTimers(maxAgeMs);
    }, intervalMs);
    // Don't let the housekeeping sweep keep the event loop alive.
    const info = this.timers.get(key);
    (info?.id as unknown as { unref?: () => void } | undefined)?.unref?.();
    this.leakSweepKey = key;
    return key;
  }

  /** Stop the periodic leak sweep started by {@link startLeakSweep}. */
  stopLeakSweep(): void {
    if (this.leakSweepKey) {
      this.clear(this.leakSweepKey);
      this.leakSweepKey = null;
    }
  }
}

// Singleton instance
export const timerManager = new TimerManager();

/**
 * Higher-order function to create a debounced version of a function
 * with automatic timer tracking
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  name: string,
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timerKey: string | null = null;

  return (...args: Parameters<T>) => {
    if (timerKey) {
      timerManager.clear(timerKey);
    }

    timerKey = timerManager.setTimeout(name, () => {
      timerKey = null;
      fn(...args);
    }, delay);
  };
}

/**
 * Higher-order function to create a throttled version of a function
 * with automatic timer tracking
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  name: string,
  fn: T,
  interval: number
): (...args: Parameters<T>) => void {
  let lastExecution = 0;
  let timerKey: string | null = null;

  return (...args: Parameters<T>) => {
    const now = Date.now();
    const timeSinceLast = now - lastExecution;

    if (timeSinceLast >= interval) {
      lastExecution = now;
      fn(...args);
    } else if (!timerKey) {
      timerKey = timerManager.setTimeout(name, () => {
        timerKey = null;
        lastExecution = Date.now();
        fn(...args);
      }, interval - timeSinceLast);
    }
  };
}

/**
 * Execute a function with a timeout
 */
export async function withTimeout<T>(
  name: string,
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timerKey = timerManager.setTimeout(name, () => {
      if (onTimeout) {
        onTimeout();
      }
      reject(new Error(`${name} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        timerManager.clear(timerKey);
        resolve(result);
      })
      .catch((err) => {
        timerManager.clear(timerKey);
        reject(err);
      });
  });
}
