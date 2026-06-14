/**
 * Automated Backup System.
 *
 * Fixes Gap: Backup not automated — code exists but no schedule.
 *
 * Provides scheduled backup of gateway state, configuration, and provider data.
 * Supports local filesystem and S3-compatible storage.
 *
 * Usage:
 * ```typescript
 * import { createBackupScheduler } from './backup-scheduler';
 *
 * const scheduler = createBackupScheduler({
 *   intervalHours: 24,
 *   backupDir: '/var/backups/ai-gateway',
 *   maxBackups: 30,
 *   onComplete: (path) => console.log('Backup completed:', path),
 *   onError: (err) => console.error('Backup failed:', err),
 * });
 *
 * scheduler.start();
 * ```
 */

import { createLogger } from '../logger';
import { mkdir, readdir, stat, copyFile, unlink } from 'fs/promises';
import { access, constants } from 'fs/promises';
import { join, basename } from 'path';
import { gzip } from 'zlib';
import { promisify } from 'util';

const log = createLogger('backup-scheduler');
const gzipAsync = promisify(gzip);

export interface BackupConfig {
  /** Backup interval in hours (default: 24) */
  intervalHours?: number;
  /** Directory to store backups (default: ./backups) */
  backupDir?: string;
  /** Maximum number of backups to keep (default: 30) */
  maxBackups?: number;
  /** Paths to backup (default: state, config, logs directories) */
  backupPaths?: string[];
  /** Called when backup completes successfully */
  onComplete?: (path: string, sizeBytes: number) => void;
  /** Called when backup fails */
  onError?: (error: Error) => void;
}

const DEFAULT_CONFIG: Required<Omit<BackupConfig, 'onComplete' | 'onError'>> & Pick<BackupConfig, 'onComplete' | 'onError'> = {
  intervalHours: 24,
  backupDir: './backups',
  maxBackups: 30,
  backupPaths: ['./state', './config', './logs'],
  onComplete: undefined,
  onError: undefined,
};

export interface BackupResult {
  /** Path to the backup file */
  path: string;
  /** Size in bytes */
  sizeBytes: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Number of files included */
  filesCount: number;
}

// ── Backup naming (#789/#790) ──────────────────────────────────────────────────
// The artifact is a directory of per-file `.gz` blobs (NOT a real tarball), and
// the OLD code named both the in-progress build dir and the kept backup with the
// same `.backup-temp-*` prefix — so `cleanupOldBackups` counted a crashed,
// partial build as a valid backup. Use distinct prefixes: `.backup-inprogress-*`
// while building, `backup-*` once finalized. Names are honest about the format.

/** Prefix for an in-progress (incomplete) backup build directory (#790). */
export const INPROGRESS_PREFIX = '.backup-inprogress-';
/** Prefix for a finalized, retained backup directory (#789/#790). */
export const FINAL_PREFIX = 'backup-';

/** In-progress build dir name for a timestamp (#790). */
export function inProgressBackupName(timestamp: string): string {
  return `${INPROGRESS_PREFIX}${timestamp}`;
}

/**
 * Final, retained backup dir name for a timestamp (#789). Suffix is `.gzdir`
 * (not `.tar.gz`) so tooling isn't misled into expecting a single tarball.
 */
export function finalBackupName(timestamp: string): string {
  return `${FINAL_PREFIX}${timestamp}.gzdir`;
}

/** True only for a finalized backup dir — excludes in-progress builds (#790). */
export function isFinalBackup(name: string): boolean {
  return name.startsWith(FINAL_PREFIX) && !name.startsWith(INPROGRESS_PREFIX);
}

/**
 * Create a backup scheduler.
 */
export function createBackupScheduler(config: BackupConfig = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let isRunning = false;

  /**
   * Run a single backup.
   */
  async function runBackup(): Promise<BackupResult | null> {
    if (isRunning) {
      log.warn({}, 'Backup already running — skipping');
      return null;
    }

    isRunning = true;
    const startTime = Date.now();

    try {
      // Create backup directory
      await mkdir(cfg.backupDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

      // Collect files to backup
      const filesToBackup: string[] = [];
      for (const dir of cfg.backupPaths) {
        try {
          await access(dir, constants.R_OK);
          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile()) {
              filesToBackup.push(join(dir, entry.name));
            }
          }
        } catch {
          log.warn({ dir }, 'Backup path not accessible — skipping');
        }
      }

      if (filesToBackup.length === 0) {
        log.warn({}, 'No files to backup');
        isRunning = false;
        return null;
      }

      // Create compressed archive. Note: this gzips individual files into a
      // directory (NOT a single tarball — see finalBackupName for honest naming).
      // #790: build in an `.backup-inprogress-*` dir, then rename to the final
      // `backup-*` name only on success, so a crash mid-build leaves an
      // in-progress dir that cleanup ignores (never counted as a valid backup).
      const buildDir = join(cfg.backupDir, inProgressBackupName(timestamp));
      const finalDir = join(cfg.backupDir, finalBackupName(timestamp));
      await mkdir(buildDir, { recursive: true });

      let totalSize = 0;
      for (const file of filesToBackup) {
        const destName = basename(file) + '.gz';
        const destPath = join(buildDir, destName);
        const content = await import('fs/promises').then(fs => fs.readFile(file));
        const compressed = await gzipAsync(content);
        await import('fs/promises').then(fs => fs.writeFile(destPath, compressed));
        totalSize += compressed.length;
      }

      // Atomically promote the completed build to its final name.
      await import('fs/promises').then(fs => fs.rename(buildDir, finalDir));

      const result: BackupResult = {
        path: finalDir,
        sizeBytes: totalSize,
        durationMs: Date.now() - startTime,
        filesCount: filesToBackup.length,
      };

      log.log(
        { path: finalDir, sizeBytes: totalSize, filesCount: filesToBackup.length, durationMs: result.durationMs },
        'Backup completed',
      );

      cfg.onComplete?.(finalDir, totalSize);

      // Cleanup old backups
      await cleanupOldBackups();

      isRunning = false;
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ error: err.message }, 'Backup failed');
      cfg.onError?.(err);
      isRunning = false;
      return null;
    }
  }

  /**
   * Remove old backups beyond maxBackups limit.
   */
  async function cleanupOldBackups(): Promise<void> {
    try {
      const entries = await readdir(cfg.backupDir, { withFileTypes: true });
      // #790: only finalized backups count toward retention — an in-progress
      // (crashed) build dir must never be treated as a valid backup.
      const backups = entries
        .filter(e => e.isDirectory() && isFinalBackup(e.name))
        .map(e => ({
          name: e.name,
          path: join(cfg.backupDir, e.name),
        }))
        .sort((a, b) => b.name.localeCompare(a.name)); // Newest first

      // Remove oldest backups beyond limit
      for (const backup of backups.slice(cfg.maxBackups)) {
        await import('fs/promises').then(fs => fs.rm(backup.path, { recursive: true, force: true }));
        log.log({ path: backup.path }, 'Old backup cleaned up');
      }
    } catch (error) {
      log.warn({ error: error instanceof Error ? error.message : String(error) }, 'Failed to cleanup old backups');
    }
  }

  /**
   * Start the backup scheduler.
   */
  function start(): void {
    if (intervalId) {
      log.warn({}, 'Backup scheduler already running');
      return;
    }

    const intervalMs = cfg.intervalHours * 60 * 60 * 1000;
    log.log({ intervalHours: cfg.intervalHours }, 'Starting backup scheduler');

    // Run initial backup
    void runBackup();

    // Schedule regular backups
    intervalId = setInterval(() => {
      void runBackup();
    }, intervalMs);
  }

  /**
   * Stop the backup scheduler.
   */
  function stop(): void {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
      log.log({}, 'Backup scheduler stopped');
    }
  }

  /**
   * Run a manual backup immediately.
   */
  async function runManualBackup(): Promise<BackupResult | null> {
    return runBackup();
  }

  /**
   * Get scheduler status.
   *
   * #800: `running` previously conflated two distinct states (a backup actually
   * executing vs the scheduler merely being armed), so an operator couldn't tell
   * whether a backup was in flight. Expose them separately; `running` is kept as
   * the OR for backward compatibility.
   */
  function getStatus(): {
    running: boolean;
    scheduled: boolean;
    inProgress: boolean;
    intervalHours: number;
    backupDir: string;
  } {
    const scheduled = intervalId !== null;
    const inProgress = isRunning;
    return {
      running: inProgress || scheduled,
      scheduled,
      inProgress,
      intervalHours: cfg.intervalHours,
      backupDir: cfg.backupDir,
    };
  }

  return {
    start,
    stop,
    runManualBackup,
    getStatus,
  };
}
