/**
 * Performance profiling mode — collects CPU profiles and heap snapshots
 * for debugging performance issues.
 *
 * Enable with `--profile` flag or `PROFILE=1` env var.
 *
 * @example
 * ```bash
 * # Start with profiling
 * PROFILE=1 bun run serve.ts
 *
 * # Trigger CPU profile
 * curl http://localhost:4000/debug/profile?duration=10000
 *
 * # Take heap snapshot
 * curl http://localhost:4000/debug/heap
 * ```
 */

import { createLogger } from '../logger';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const log = createLogger('profiler');

export interface ProfilerConfig {
  /** Output directory for profiles (default: './profiles') */
  outputDir?: string;
  /** Enable CPU profiling (default: true) */
  enableCpu?: boolean;
  /** Enable heap snapshots (default: true) */
  enableHeap?: boolean;
  /** Profile duration in ms (default: 10000) */
  defaultDurationMs?: number;
}

const DEFAULT_CONFIG: Required<ProfilerConfig> = {
  outputDir: './profiles',
  enableCpu: true,
  enableHeap: true,
  defaultDurationMs: 10_000,
};

/**
 * Initialize the profiler — creates output directory and logs status.
 */
export function initProfiler(config: ProfilerConfig = {}): void {
  const cfg: Required<ProfilerConfig> = { ...DEFAULT_CONFIG, ...config };

  try {
    mkdirSync(cfg.outputDir, { recursive: true });
    log.log(
      { outputDir: cfg.outputDir, cpu: cfg.enableCpu, heap: cfg.enableHeap },
      'Profiler initialized',
    );
  } catch (err) {
    log.log(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to initialize profiler',
    );
  }
}

/**
 * Check if profiling is enabled via env var.
 */
export function isProfilingEnabled(): boolean {
  return process.env.PROFILE === '1' || process.env.NODE_PROFILE === '1';
}

/**
 * Collect CPU profile for a given duration.
 *
 * Note: This is a placeholder — real CPU profiling in Node.js requires
 * the `v8` and `inspector` modules. In production, use `--prof` flag:
 * `node --prof serve.ts` then `node --prof-process isolate-*.log`
 */
export async function collectCpuProfile(durationMs: number): Promise<string> {
  const filename = `cpu-${Date.now()}.json`;
  const path = join(DEFAULT_CONFIG.outputDir, filename);

  log.log({ durationMs, path }, 'CPU profile collection placeholder');

  // Real implementation would use:
  // 1. Start v8 profiler via inspector module
  // 2. Wait for durationMs
  // 3. Stop profiler and save profile
  // 4. Return file path

  writeFileSync(path, JSON.stringify({ placeholder: true, durationMs, timestamp: Date.now() }));
  return path;
}

/**
 * Take a heap snapshot.
 *
 * Uses v8.getHeapSnapshot() if available.
 */
export async function takeHeapSnapshot(): Promise<string> {
  const filename = `heap-${Date.now()}.heapsnapshot`;
  const path = join(DEFAULT_CONFIG.outputDir, filename);

  try {
    const v8 = await import('v8');
    const snapshot = v8.getHeapSnapshot();
    const stream = snapshot;

    // Write snapshot to file
    const { createWriteStream } = await import('fs');
    stream.pipe(createWriteStream(path));

    log.log({ path }, 'Heap snapshot saved');
    return path;
  } catch (err) {
    log.log(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to take heap snapshot',
    );
    throw err;
  }
}

/**
 * Get current memory usage stats.
 */
export function getMemoryStats(): Record<string, number> {
  const usage = process.memoryUsage();

  return {
    rss: Math.round(usage.rss / 1024 / 1024), // Resident Set Size (MB)
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // Total heap (MB)
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // Used heap (MB)
    external: Math.round(usage.external / 1024 / 1024), // External (MB)
    arrayBuffers: Math.round((usage.arrayBuffers ?? 0) / 1024 / 1024), // ArrayBuffer (MB)
    heapUsedPercent: parseFloat(((usage.heapUsed / usage.heapTotal) * 100).toFixed(1)),
  };
}

/**
 * Get CPU usage since last call.
 */
export function getCpuUsage() {
  const usage = process.cpuUsage();

  return {
    userMs: usage.user / 1000,
    systemMs: usage.system / 1000,
    totalMs: (usage.user + usage.system) / 1000,
  };
}

/**
 * Log current resource usage.
 */
export function logResourceUsage(): void {
  const memory = getMemoryStats();
  const cpu = getCpuUsage();

  log.log({ memory, cpu }, 'Resource usage');
}
