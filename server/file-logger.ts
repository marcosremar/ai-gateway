/**
 * Persistent File Logger — writes all GPU events, lifecycle, and console output
 * to JSONL files in ~/.babelcast/logs/ for post-mortem debugging.
 *
 * Three log files:
 *   events.jsonl  — GPU lifecycle events (deploy, stop, destroy, health, idle)
 *   gpu.jsonl     — GPU event log (mirrors Prisma gpuEvent table)
 *   server.log    — All console output (stdout + stderr)
 *
 * Files rotate at 50MB (keeps 3 rotated copies).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GpuLifecycleLogger, GpuLifecycleLogEntry } from '../src/autoscaler/lifecycle-logger';

// ── Config ──────────────────────────────────────────────────────────────────

const LOG_DIR = process.env.LOG_DIR || path.join(
  process.env.HOME || '/tmp',
  '.babelcast', 'logs',
);
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_ROTATIONS = 3;

// Ensure log directory exists
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

// ── Rotating file writer ────────────────────────────────────────────────────

function rotateIfNeeded(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_FILE_SIZE) return;

    // Rotate: .3 → delete, .2 → .3, .1 → .2, current → .1
    for (let i = MAX_ROTATIONS; i >= 1; i--) {
      const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
      const dst = `${filePath}.${i}`;
      try {
        if (i === MAX_ROTATIONS) fs.unlinkSync(dst);
        fs.renameSync(src, dst);
      } catch {}
    }
  } catch {}
}

function appendLine(filePath: string, line: string): void {
  try {
    rotateIfNeeded(filePath);
    fs.appendFileSync(filePath, line + '\n');
  } catch (err) {
    // Silently fail — don't crash the server for logging issues
    process.stderr.write(`[file-logger] write failed: ${err}\n`);
  }
}

// ── Event file paths ────────────────────────────────────────────────────────

const EVENTS_FILE = path.join(LOG_DIR, 'events.jsonl');
const GPU_FILE = path.join(LOG_DIR, 'gpu.jsonl');
const SERVER_FILE = path.join(LOG_DIR, 'server.log');

// ── GPU Lifecycle Logger (implements GpuLifecycleLogger interface) ──────────

export const fileLifecycleLogger: GpuLifecycleLogger = {
  log(entry: GpuLifecycleLogEntry): void {
    const record = {
      ts: new Date().toISOString(),
      ...entry,
    };
    appendLine(EVENTS_FILE, JSON.stringify(record));
  },
};

// ── GPU Event Logger (file-based, alongside Prisma) ─────────────────────────

export function logGpuEventToFile(
  event: string,
  provider: string,
  success: boolean,
  opts?: {
    durationMs?: number;
    cooldownMs?: number;
    failCount?: number;
    error?: string;
    metadata?: Record<string, unknown>;
  },
): void {
  const record = {
    ts: new Date().toISOString(),
    event,
    provider,
    success,
    ...(opts?.durationMs != null ? { durationMs: opts.durationMs } : {}),
    ...(opts?.cooldownMs != null ? { cooldownMs: opts.cooldownMs } : {}),
    ...(opts?.failCount != null ? { failCount: opts.failCount } : {}),
    ...(opts?.error ? { error: opts.error } : {}),
    ...(opts?.metadata ? { metadata: opts.metadata } : {}),
  };
  appendLine(GPU_FILE, JSON.stringify(record));
}

// ── Console capture — intercept console.log/warn/error ──────────────────────

const _origLog = console.log;
const _origWarn = console.warn;
const _origError = console.error;

function formatArgs(args: unknown[]): string {
  return args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
}

function capturedLog(level: string, origFn: (...args: unknown[]) => void, ...args: unknown[]): void {
  // Write to original console
  origFn.apply(console, args);
  // Write to file
  const line = `${new Date().toISOString()} [${level}] ${formatArgs(args)}`;
  appendLine(SERVER_FILE, line);
}

/**
 * Install console capture — all console.log/warn/error go to server.log.
 * Call once at startup.
 */
export function installConsoleCapture(): void {
  console.log = (...args: unknown[]) => capturedLog('INFO', _origLog, ...args);
  console.warn = (...args: unknown[]) => capturedLog('WARN', _origWarn, ...args);
  console.error = (...args: unknown[]) => capturedLog('ERROR', _origError, ...args);
  console.log(`[file-logger] Console capture installed — writing to ${SERVER_FILE}`);
  console.log(`[file-logger] Events: ${EVENTS_FILE}`);
  console.log(`[file-logger] GPU events: ${GPU_FILE}`);
}

// ── Utility: read recent log entries ────────────────────────────────────────

export function readRecentEvents(lines = 100): string[] {
  try {
    const content = fs.readFileSync(EVENTS_FILE, 'utf-8');
    return content.trim().split('\n').slice(-lines);
  } catch { return []; }
}

export function readRecentGpuEvents(lines = 100): string[] {
  try {
    const content = fs.readFileSync(GPU_FILE, 'utf-8');
    return content.trim().split('\n').slice(-lines);
  } catch { return []; }
}

export function readRecentServerLogs(lines = 200): string[] {
  try {
    const content = fs.readFileSync(SERVER_FILE, 'utf-8');
    return content.trim().split('\n').slice(-lines);
  } catch { return []; }
}

export { LOG_DIR, EVENTS_FILE, GPU_FILE, SERVER_FILE };
