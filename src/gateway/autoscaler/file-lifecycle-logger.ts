/**
 * File-based GPU Lifecycle Logger — persistent JSONL logging of ALL GPU
 * events to a local file. Works without Prisma, Redis, or any external DB.
 *
 * Every boot, stop, crash, orphan detection, ghost machine, health check,
 * cost alert, etc. gets appended as one JSON line to:
 *
 *   ~/.ai-gateway/gpu-lifecycle.jsonl
 *
 * The file is append-only, never truncated (rotate externally with logrotate
 * or manually). Each line is a valid JSON object with a timestamp, so it's
 * trivially grep-able and parseable:
 *
 *   grep '"eventType":"boot_failed"' ~/.ai-gateway/gpu-lifecycle.jsonl
 *   tail -100 ~/.ai-gateway/gpu-lifecycle.jsonl | jq .
 *
 * This logger also captures events that the cost-monitor and watchdog
 * detect about instances OUTSIDE the autoscaler's tracked state — e.g.,
 * the WiLoR pod that was deployed directly via VastClient and exited
 * without anyone knowing.
 *
 * Why file-based (not just console.log):
 *   - Console output is ephemeral — lost when the process restarts
 *   - DB-based logger (lifecycle-logger.ts) requires Prisma/host app setup
 *   - File-based is always available, zero config, searchable with grep
 *   - Can coexist with the Prisma logger — they're independent implementations
 *     of the same GpuLifecycleLogger interface
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { GpuLifecycleLogger, GpuLifecycleLogEntry } from './lifecycle-logger';

const CONFIG_DIR = process.env.AI_GATEWAY_CONFIG_DIR || path.join(os.homedir(), '.ai-gateway');
const LOG_FILE = path.join(CONFIG_DIR, 'gpu-lifecycle.jsonl');

/** Max file size before we rotate (default 50MB). */
const MAX_FILE_BYTES = parseInt(process.env.GPU_LOG_MAX_BYTES || String(50 * 1024 * 1024), 10);

/**
 * Ensure the config directory and log file exist.
 * Called once on first write, not on import (avoids side-effects on import).
 */
let initialized = false;
function ensureDir(): void {
  if (initialized) return;
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    initialized = true;
  } catch { /* ignore — write will fail with a clear error */ }
}

/**
 * Simple rotation: if the log file exceeds MAX_FILE_BYTES, rename it to
 * gpu-lifecycle.1.jsonl (overwriting any existing .1 file) and start fresh.
 * Only keeps ONE rotated copy to avoid unbounded disk growth.
 */
function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_FILE_BYTES) {
      const rotatedPath = LOG_FILE.replace('.jsonl', '.1.jsonl');
      fs.renameSync(LOG_FILE, rotatedPath);
    }
  } catch {
    // File doesn't exist yet or stat failed — both OK
  }
}

/**
 * Extended log entry with fields the lifecycle-logger interface doesn't have
 * but we want in the file for grep-ability.
 */
interface FileLogEntry extends GpuLifecycleLogEntry {
  /** ISO timestamp — always present */
  ts: string;
  /** Unix timestamp ms — for programmatic filtering */
  tsMs: number;
  /** Source module that emitted the event */
  source?: string;
  /** Price per hour at the time of event (if known) */
  pricePerHr?: number;
  /** GPU type name (if known) */
  gpuType?: string;
  /** Provider region / datacenter (if known) */
  region?: string;
  /** Free-form message for human-readable log tailing */
  msg?: string;
}

/**
 * Append a single JSON line to the log file. Synchronous to avoid interleaving
 * in concurrent contexts (Node's appendFileSync is atomic for small writes on
 * most filesystems).
 */
function appendLine(entry: FileLogEntry): void {
  ensureDir();
  rotateIfNeeded();
  try {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (err) {
    // Don't throw — logging must never crash the application
    console.warn(`[file-lifecycle-logger] Failed to write: ${err}`);
  }
}

// ── Public logger instance ──────────────────────────────────────────────────

/**
 * A GpuLifecycleLogger that writes to ~/.ai-gateway/gpu-lifecycle.jsonl.
 * Drop-in replacement for noopLifecycleLogger — pass it to the autoscaler,
 * cost-monitor, watchdog, etc.
 */
export const fileLifecycleLogger: GpuLifecycleLogger = {
  log(entry: GpuLifecycleLogEntry): void {
    const now = new Date();
    const fileEntry: FileLogEntry = {
      ...entry,
      ts: now.toISOString(),
      tsMs: now.getTime(),
      // Promote metadata fields to top-level for grep-ability
      gpuType: entry.metadata?.gpuType as string | undefined,
      pricePerHr: entry.metadata?.pricePerHr as number | undefined,
      region: entry.metadata?.region as string | undefined,
      source: entry.metadata?.source as string | undefined,
      msg: entry.metadata?.msg as string | undefined,
    };
    appendLine(fileEntry);
    // Also mirror to console for real-time observability
    const icon =
      entry.eventType.includes('boot') ? '🚀' :
      entry.eventType.includes('stop') || entry.eventType.includes('scale_down') ? '⏹️' :
      entry.eventType.includes('error') || entry.eventType.includes('failed') ? '❌' :
      entry.eventType.includes('health') ? '💚' :
      entry.eventType.includes('orphan') || entry.eventType.includes('zombie') ? '👻' :
      entry.eventType.includes('cost') ? '💰' :
      '📝';
    console.log(
      `${icon} [gpu-log] ${entry.eventType} | ${entry.provider || '?'} | ${entry.instanceId || '?'} | ${fileEntry.msg || entry.trigger || ''}`,
    );
  },
};

/**
 * Log a GPU event with extra convenience fields (msg, gpuType, etc.) that
 * are stuffed into metadata automatically so they appear in the JSONL and
 * are also accessible from the GpuLifecycleLogEntry.metadata consumers.
 */
export function logGpuEvent(
  base: GpuLifecycleLogEntry,
  extra?: {
    msg?: string;
    gpuType?: string;
    pricePerHr?: number;
    region?: string;
    source?: string;
  },
): void {
  if (extra) {
    base.metadata = { ...base.metadata, ...extra };
  }
  fileLifecycleLogger.log(base);
}

/**
 * Read the last N lines from the lifecycle log. Useful for the admin panel
 * or CLI tooling without needing to grep the file manually.
 */
export function readRecentLogs(lines = 100): GpuLifecycleLogEntry[] {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const allLines = content.trim().split('\n').filter(Boolean);
    const recent = allLines.slice(-lines);
    return recent.map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return { eventType: 'parse_error', error: line } as any;
      }
    });
  } catch {
    return [];
  }
}

/** Path to the log file (for display in CLI/admin tools). */
export const GPU_LIFECYCLE_LOG_PATH = LOG_FILE;
