/**
 * Async file I/O utilities — replaces all sync fs calls.
 *
 * Fixes: #546-575 (sync I/O on hot path)
 *
 * Usage:
 * ```ts
 * import { readFile, writeFile, atomicWrite, ensureDir } from './async-fs';
 *
 * // Instead of: readFileSync(path)
 * const content = await readFile(path);
 *
 * // Instead of: writeFileSync(path, data)
 * await writeFile(path, data);
 *
 * // Instead of: mkdirSync + writeFileSync + renameSync
 * await atomicWrite(path, data);
 * ```
 */

import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  open as fsOpen,
  mkdir,
  rename,
  stat,
  access,
  constants,
} from 'fs/promises';
import { createHash } from 'crypto';
import { createLogger } from '../logger';

const log = createLogger('async-fs');

/**
 * Read a file asynchronously.
 * Returns null if file doesn't exist instead of throwing.
 */
export async function readFile(path: string): Promise<string | null> {
  try {
    await access(path, constants.F_OK);
    return await fsReadFile(path, 'utf-8');
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Read a file as JSON.
 */
export async function readJson<T = unknown>(path: string): Promise<T | null> {
  const content = await readFile(path);
  if (!content) return null;
  try {
    return JSON.parse(content) as T;
  } catch {
    log.warn({ path }, 'Failed to parse JSON file');
    return null;
  }
}

/**
 * Write a file asynchronously.
 */
export async function writeFile(path: string, data: string): Promise<void> {
  await fsWriteFile(path, data, 'utf-8');
}

/**
 * Write JSON file asynchronously.
 */
export async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2));
}

/**
 * Atomic write — writes to temp file then renames.
 * Safe against crashes during write.
 *
 * Fixes: #546, #547, #548, #561 (atomic writes for config/state)
 *
 * Durability (#705): `renameSync` is only crash-durable once the file's data
 * has been flushed to disk. With `fsync` enabled (default for state files) we
 * fsync the temp file's data before the rename and then fsync the containing
 * directory so the rename itself is durable on power loss. Set `fsync:false`
 * for caches/scratch where the extra syscall is not worth the latency.
 */
export async function atomicWrite(
  path: string,
  data: string,
  options: { fsync?: boolean } = {},
): Promise<void> {
  const fsyncEnabled = options.fsync !== false; // default ON for state durability
  const dir = path.substring(0, path.lastIndexOf('/'));
  const tempPath = `${path}.tmp.${Date.now()}`;

  // Ensure directory exists
  await ensureDir(dir);

  if (fsyncEnabled) {
    // Write + fsync the temp file via an explicit handle so the bytes are on
    // disk before the rename, then fsync the directory so the rename survives
    // a power loss.
    const handle = await fsOpen(tempPath, 'w');
    try {
      await handle.writeFile(data, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
    await fsyncDir(dir);
  } else {
    // Write to temp file
    await fsWriteFile(tempPath, data, 'utf-8');
    // Atomic rename
    await rename(tempPath, path);
  }
}

/**
 * fsync a directory entry so a preceding rename is durable. Best-effort: some
 * platforms (notably Windows) reject opening a directory for fsync — those
 * cases are swallowed because the rename itself is still atomic, just not
 * guaranteed durable across an immediate power loss.
 */
async function fsyncDir(dir: string): Promise<void> {
  if (!dir) return;
  let handle: Awaited<ReturnType<typeof fsOpen>> | null = null;
  try {
    handle = await fsOpen(dir, 'r');
    await handle.sync();
  } catch {
    /* best-effort: directory fsync unsupported on this platform */
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * Atomic JSON write.
 */
export async function atomicWriteJson(
  path: string,
  data: unknown,
  options: { fsync?: boolean } = {},
): Promise<void> {
  await atomicWrite(path, JSON.stringify(data, null, 2), options);
}

/**
 * Ensure a directory exists, creating it if necessary.
 */
export async function ensureDir(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'EEXIST') throw error;
  }
}

/**
 * Check if a file exists.
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get file stats.
 */
export async function getFileStats(path: string): Promise<{ size: number; mtime: Date } | null> {
  try {
    const stats = await stat(path);
    return { size: stats.size, mtime: stats.mtime };
  } catch {
    return null;
  }
}

/**
 * Read file with integrity check (SHA-256).
 *
 * @example
 * ```ts
 * const result = await readFileWithIntegrity(path, expectedChecksum);
 * if (!result.ok) {
 *   console.error('File tampered!');
 * }
 * ```
 */
export async function readFileWithIntegrity(
  path: string,
  expectedChecksum?: string,
): Promise<{ ok: boolean; content: string }> {
  const content = await readFile(path);
  if (!content) return { ok: false, content: '' };

  if (expectedChecksum) {
    const actualChecksum = createHash('sha256').update(content).digest('hex');
    if (actualChecksum !== expectedChecksum) {
      log.warn({ path, expected: expectedChecksum, actual: actualChecksum }, 'Integrity check failed');
      return { ok: false, content: '' };
    }
  }

  return { ok: true, content };
}

/**
 * Write file with checksum.
 */
export async function writeFileWithChecksum(path: string, data: string): Promise<string> {
  const checksum = createHash('sha256').update(data).digest('hex');
  await writeFile(path, data);
  return checksum;
}

/**
 * Buffered write — accumulates writes and flushes periodically.
 *
 * Fixes: #562, #563 (write coalescing for frequent writes)
 *
 * @example
 * ```ts
 * const buffer = createWriteBuffer('state.json', { flushIntervalMs: 5000 });
 * buffer.write({ status: 'running' });
 * buffer.write({ status: 'complete' });
 * // Flushes after 5s or on demand
 * await buffer.flush();
 * ```
 */
export function createWriteBuffer(
  path: string,
  options: { flushIntervalMs?: number; atomic?: boolean } = {},
) {
  const flushIntervalMs = options.flushIntervalMs ?? 5000;
  let pendingData: string | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleFlush = () => {
    if (flushTimer) return;
    // #718: the timer fires fire-and-forget, so swallow nothing — catch inside
    // so a rejected write is logged (and the data restored for the next flush)
    // instead of vanishing with an unhandled rejection.
    flushTimer = setTimeout(() => {
      void flush().catch((err) => {
        log.warn({ path, err: err instanceof Error ? err.message : String(err) }, 'Buffered flush failed');
      });
    }, flushIntervalMs);
    // #719: don't keep the event loop alive for a buffer that may never be
    // written again — mirrors pull-history-persistence.ts.
    if (typeof (flushTimer as unknown as { unref?: () => void }).unref === 'function') {
      (flushTimer as unknown as { unref: () => void }).unref();
    }
  };

  const flush = async () => {
    flushTimer = null;
    if (pendingData) {
      const data = pendingData;
      pendingData = null;
      try {
        if (options.atomic) {
          await atomicWrite(path, data);
        } else {
          await writeFile(path, data);
        }
      } catch (err) {
        // Restore the data so a later flush can retry rather than silently
        // dropping it. Keep only the freshest write if one arrived meanwhile.
        if (pendingData === null) pendingData = data;
        throw err;
      }
    }
  };

  return {
    /** Queue data for writing — coalesces with pending writes */
    write(data: string): void {
      pendingData = data;
      scheduleFlush();
    },

    /** Force immediate flush */
    flush,

    /** Stop the buffer and flush pending writes */
    async close(): Promise<void> {
      if (flushTimer) clearTimeout(flushTimer);
      await flush();
    },

    /** Get pending data without flushing */
    get pending(): string | null {
      return pendingData;
    },
  };
}
