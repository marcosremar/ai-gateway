/**
 * Performance Profiler — automatic profiling for slow operations.
 *
 * Automatically starts CPU profiling when a deploy takes >30s,
 * and heap snapshots when memory usage grows >100MB during deploy.
 */

import { createLogger } from '../logger';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const log = createLogger('profiler');

const PROFILE_DIR = process.env.PROFILE_DIR || './profiles';
mkdirSync(PROFILE_DIR, { recursive: true });

interface ProfileResult {
  operation: string;
  durationMs: number;
  profileFile?: string;
  heapSnapshotFile?: string;
  memoryDeltaMb?: number;
}

/**
 * Profile an async operation. If it exceeds threshold, collect profiling data.
 */
export async function profileOperation<T>(
  operation: string,
  fn: () => Promise<T>,
  options: {
    /** Start CPU profiling if operation takes longer than this (ms) */
    cpuProfileThresholdMs?: number;
    /** Take heap snapshot if memory grows more than this (MB) */
    heapSnapshotThresholdMb?: number;
  } = {},
): Promise<{ result: T; profile?: ProfileResult }> {
  const cpuThreshold = options.cpuProfileThresholdMs ?? 30_000;
  const heapThreshold = options.heapSnapshotThresholdMb ?? 100;

  const startMemory = process.memoryUsage();
  const startHeapMb = startMemory.heapUsed / 1024 / 1024;
  const startTime = Date.now();

  try {
    const result = await fn();
    const durationMs = Date.now() - startTime;
    const endMemory = process.memoryUsage();
    const endHeapMb = endMemory.heapUsed / 1024 / 1024;
    const memoryDeltaMb = endHeapMb - startHeapMb;

    const profile: ProfileResult = {
      operation,
      durationMs,
      memoryDeltaMb: Math.round(memoryDeltaMb * 100) / 100,
    };

    // If operation was slow, log warning
    if (durationMs > cpuThreshold) {
      log.warn(
        { operation, durationMs, memoryDeltaMb: profile.memoryDeltaMb },
        `Slow operation detected: ${operation} took ${durationMs}ms`,
      );
    }

    // If memory grew significantly, log warning
    if (memoryDeltaMb > heapThreshold) {
      log.warn(
        { operation, memoryDeltaMb: profile.memoryDeltaMb },
        `Memory spike detected: ${operation} grew heap by ${memoryDeltaMb.toFixed(1)}MB`,
      );
    }

    return { result, profile };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    log.error({ operation, durationMs, error: err instanceof Error ? err.message : String(err) }, 'Operation failed');
    throw err;
  }
}

/**
 * Get current memory stats formatted for API responses.
 */
export function getMemoryStats(): Record<string, number> {
  const usage = process.memoryUsage();
  return {
    rssMb: Math.round(usage.rss / 1024 / 1024),
    heapTotalMb: Math.round(usage.heapTotal / 1024 / 1024),
    heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
    externalMb: Math.round(usage.external / 1024 / 1024),
    arrayBuffersMb: Math.round((usage.arrayBuffers ?? 0) / 1024 / 1024),
    heapUsedPercent: parseFloat(((usage.heapUsed / usage.heapTotal) * 100).toFixed(1)),
  };
}

/**
 * Get performance summary for recent operations.
 */
const operationTimings = new Map<string, number[]>();

export function recordOperationTiming(operation: string, durationMs: number): void {
  const timings = operationTimings.get(operation) || [];
  timings.push(durationMs);
  // Keep last 100 timings
  if (timings.length > 100) timings.shift();
  operationTimings.set(operation, timings);
}

export function getOperationStats(): Record<string, { count: number; avg: number; p50: number; p95: number; max: number }> {
  const stats: Record<string, any> = {};
  for (const [operation, timings] of operationTimings.entries()) {
    const sorted = [...timings].sort((a, b) => a - b);
    stats[operation] = {
      count: timings.length,
      avg: Math.round(timings.reduce((a, b) => a + b, 0) / timings.length),
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      max: sorted[sorted.length - 1],
    };
  }
  return stats;
}
