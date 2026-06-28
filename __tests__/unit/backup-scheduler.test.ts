// ── Backup Scheduler — unit suite ────────────────────────────────────────────
// Validates createBackupScheduler: file collection, gzip compression, rotation,
// re-entrancy guard, callbacks, start/stop lifecycle, and inaccessible paths.
// All filesystem I/O uses a throwaway temp directory — no production state touched.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createBackupScheduler } from '../../src/modules/backup-scheduler';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'ai-gw-backup-test-'));
}

/** Seed a source directory with a single file to ensure backup finds something. */
function seedDir(dir: string, filename = 'config.json', content = '{"key":"value"}'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, 'utf-8');
}

/** Count .backup-temp-* directories inside a given backup dir. */
async function countBackupDirs(backupDir: string): Promise<number> {
  if (!existsSync(backupDir)) return 0;
  const entries = await readdir(backupDir, { withFileTypes: true });
  return entries.filter(e => e.isDirectory() && e.name.startsWith('.backup-temp-')).length;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createBackupScheduler', () => {
  let root: string;
  let backupDir: string;
  let srcDir: string;

  beforeEach(() => {
    root = makeTmp();
    backupDir = join(root, 'backups');
    srcDir = join(root, 'src');
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
  });

  // ── Basic backup execution ─────────────────────────────────────────────────

  it('returns null when all backup paths are inaccessible', async () => {
    const scheduler = createBackupScheduler({
      backupDir,
      backupPaths: [join(root, 'nonexistent')],
    });
    const result = await scheduler.runManualBackup();
    expect(result).toBeNull();
  });

  it('returns null when backup paths exist but have no files', async () => {
    mkdirSync(srcDir, { recursive: true }); // directory exists but empty
    const scheduler = createBackupScheduler({
      backupDir,
      backupPaths: [srcDir],
    });
    const result = await scheduler.runManualBackup();
    expect(result).toBeNull();
  });

  it('returns a BackupResult when source files exist', async () => {
    seedDir(srcDir, 'settings.json', '{"mode":"prod"}');
    const scheduler = createBackupScheduler({
      backupDir,
      backupPaths: [srcDir],
    });
    const result = await scheduler.runManualBackup();
    expect(result).not.toBeNull();
    expect(result!.filesCount).toBe(1);
    expect(result!.sizeBytes).toBeGreaterThan(0);
    expect(result!.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result!.path).toBe('string');
    expect(result!.path).toContain('.backup-temp-');
  });

  it('compresses multiple files from a source directory', async () => {
    seedDir(srcDir, 'a.json', '{}');
    writeFileSync(join(srcDir, 'b.json'), '{"x":1}', 'utf-8');
    writeFileSync(join(srcDir, 'c.txt'), 'hello world', 'utf-8');
    const scheduler = createBackupScheduler({
      backupDir,
      backupPaths: [srcDir],
    });
    const result = await scheduler.runManualBackup();
    expect(result!.filesCount).toBe(3);
    expect(result!.sizeBytes).toBeGreaterThan(0);
  });

  it('skips inaccessible paths but still backs up accessible ones', async () => {
    seedDir(srcDir, 'good.json', '{"ok":true}');
    const missingDir = join(root, 'missing');
    const scheduler = createBackupScheduler({
      backupDir,
      backupPaths: [missingDir, srcDir],
    });
    const result = await scheduler.runManualBackup();
    expect(result).not.toBeNull();
    expect(result!.filesCount).toBe(1);
  });

  it('collects files from multiple source directories', async () => {
    const srcA = join(root, 'a');
    const srcB = join(root, 'b');
    seedDir(srcA, 'file1.json', '{}');
    seedDir(srcB, 'file2.json', '{}');
    seedDir(srcB, 'file3.json', '{}'); // srcB gets two files total
    writeFileSync(join(srcB, 'file3.json'), '{}', 'utf-8'); // ensure it's there

    const scheduler = createBackupScheduler({
      backupDir,
      backupPaths: [srcA, srcB],
    });
    const result = await scheduler.runManualBackup();
    // srcA has 1, srcB has 2 (file2 + file3)
    expect(result!.filesCount).toBe(3);
  });

  // ── onComplete / onError callbacks ─────────────────────────────────────────

  it('calls onComplete with path and sizeBytes on success', async () => {
    seedDir(srcDir, 'data.json', '{"k":"v"}');
    const onComplete = vi.fn();
    const scheduler = createBackupScheduler({
      backupDir,
      backupPaths: [srcDir],
      onComplete,
    });
    await scheduler.runManualBackup();
    expect(onComplete).toHaveBeenCalledOnce();
    const [path, sizeBytes] = onComplete.mock.calls[0];
    expect(typeof path).toBe('string');
    expect(path).toContain('.backup-temp-');
    expect(typeof sizeBytes).toBe('number');
    expect(sizeBytes).toBeGreaterThan(0);
  });

  it('does not call onComplete when there are no files to back up', async () => {
    const onComplete = vi.fn();
    const scheduler = createBackupScheduler({
      backupDir,
      backupPaths: [join(root, 'nope')],
      onComplete,
    });
    await scheduler.runManualBackup();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('calls onError and returns null when an unexpected error occurs', async () => {
    const onError = vi.fn();
    // Force mkdir to fail by using a file path as the backupDir parent
    const fileAsDir = join(root, 'file.txt');
    writeFileSync(fileAsDir, 'I am a file, not a dir');
    const badBackupDir = join(fileAsDir, 'cannot_mkdir_here');

    seedDir(srcDir, 'x.json', '{}');
    const scheduler = createBackupScheduler({
      backupDir: badBackupDir,
      backupPaths: [srcDir],
      onError,
    });
    const result = await scheduler.runManualBackup();
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  // ── Re-entrancy guard ──────────────────────────────────────────────────────

  it('returns null for the second concurrent call (re-entrancy guard)', async () => {
    seedDir(srcDir, 'cfg.json', '{"a":1}');
    const scheduler = createBackupScheduler({
      backupDir,
      backupPaths: [srcDir],
    });
    // Start two concurrent backups
    const [r1, r2] = await Promise.all([
      scheduler.runManualBackup(),
      scheduler.runManualBackup(),
    ]);
    // Exactly one should succeed and one should be null
    const successes = [r1, r2].filter(r => r !== null);
    const skipped = [r1, r2].filter(r => r === null);
    expect(successes).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });

  // ── Backup rotation (cleanupOldBackups) ────────────────────────────────────

  it('keeps only maxBackups directories when limit is exceeded', async () => {
    seedDir(srcDir, 'f.json', '{}');
    const maxBackups = 3;
    const scheduler = createBackupScheduler({
      backupDir,
      backupPaths: [srcDir],
      maxBackups,
    });
    // Run 5 backups sequentially (one per call to avoid re-entrancy guard)
    for (let i = 0; i < 5; i++) {
      await scheduler.runManualBackup();
      // Small delay so ISO timestamps differ
      await new Promise(r => setTimeout(r, 5));
    }
    const count = await countBackupDirs(backupDir);
    expect(count).toBeLessThanOrEqual(maxBackups);
  });

  it('does not rotate when backup count is within limit', async () => {
    seedDir(srcDir, 'f.json', '{}');
    const maxBackups = 5;
    const scheduler = createBackupScheduler({
      backupDir,
      backupPaths: [srcDir],
      maxBackups,
    });
    for (let i = 0; i < 3; i++) {
      await scheduler.runManualBackup();
      await new Promise(r => setTimeout(r, 5));
    }
    const count = await countBackupDirs(backupDir);
    expect(count).toBe(3);
  });

  // ── getStatus ──────────────────────────────────────────────────────────────

  it('getStatus returns not-running before start() is called', () => {
    const scheduler = createBackupScheduler({
      backupDir,
      backupPaths: [srcDir],
      intervalHours: 12,
    });
    const status = scheduler.getStatus();
    expect(status.running).toBe(false);
    expect(status.intervalHours).toBe(12);
    expect(status.backupDir).toBe(backupDir);
  });

  it('getStatus returns running=true (interval active) after start(), false after stop()', async () => {
    // Use 1h interval (fits in 32-bit int) with a path that has no files so
    // the immediate backup returns quickly. We wait for it to finish before stop().
    const done = new Promise<void>(resolve => {
      // onComplete fires after success; we need both success and null paths.
      // Poll with a short delay to let the async background backup settle.
      setTimeout(resolve, 50);
    });
    const scheduler = createBackupScheduler({
      backupDir,
      backupPaths: [join(root, 'nope')], // no files — immediate noop
      intervalHours: 1,
    });
    scheduler.start();
    await done; // let the initial backup (which returns null) finish
    expect(scheduler.getStatus().running).toBe(true); // interval still active
    scheduler.stop();
    expect(scheduler.getStatus().running).toBe(false);
  });

  // ── start / stop lifecycle ─────────────────────────────────────────────────

  it('calling start() twice does not create duplicate intervals', async () => {
    const scheduler = createBackupScheduler({
      backupDir,
      backupPaths: [join(root, 'nope')],
      intervalHours: 1,
    });
    scheduler.start();
    scheduler.start(); // second call should be a no-op (logs a warning)
    await new Promise(r => setTimeout(r, 50)); // let initial backup settle
    expect(scheduler.getStatus().running).toBe(true);
    scheduler.stop();
    expect(scheduler.getStatus().running).toBe(false);
  });

  it('stop() is idempotent — calling it twice does not throw', async () => {
    const scheduler = createBackupScheduler({
      backupDir,
      backupPaths: [join(root, 'nope')],
      intervalHours: 1,
    });
    scheduler.start();
    await new Promise(r => setTimeout(r, 50)); // let initial backup settle
    scheduler.stop();
    expect(() => scheduler.stop()).not.toThrow();
    expect(scheduler.getStatus().running).toBe(false);
  });

  // ── Default config ─────────────────────────────────────────────────────────

  it('uses sensible defaults when called with no config', () => {
    const scheduler = createBackupScheduler();
    const status = scheduler.getStatus();
    expect(status.intervalHours).toBe(24);
    expect(status.backupDir).toBe('./backups');
    // Status is not running — we never called start()
    expect(status.running).toBe(false);
  });
});
