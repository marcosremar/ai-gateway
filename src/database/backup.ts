/**
 * Backup and restore service.
 * - Neon: uses branch copy-on-write (instant snapshot)
 * - Local: uses pg_dump / psql
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { randomUUID, createHash } from 'crypto';
import type { DatabaseConfig, BackupInfo, BackupOptions, BackupResult, RestoreOptions } from './types';
import { DatabaseError } from './types';
import type { NeonManagementClient } from './neon-management';

const execFileAsync = promisify(execFile);

// ── Pure helpers (unit-testable without a DB / child process) ──────────────────

/** Prefix that marks a Neon branch as an automated backup (#793). */
export const BACKUP_BRANCH_PREFIX = 'backup-';

/**
 * SHA-256 of the (decoded) backup contents (#795). Stored alongside the backup
 * so a corrupted dump is caught at *verify* time rather than failing opaquely
 * during restore. Pure.
 */
export function computeBackupChecksum(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Verify a backup's recorded checksum against its actual contents (#795).
 * Returns true when no checksum was recorded (back-compat) so old backups still
 * restore. Pure.
 */
export function verifyBackupChecksum(backup: Pick<BackupInfo, 'data' | 'metadata'>): boolean {
  const recorded = backup.metadata?.checksumSha256;
  if (typeof recorded !== 'string' || recorded.length === 0) return true; // no checksum → cannot fail
  return computeBackupChecksum(backup.data) === recorded;
}

/**
 * Build psql restore CLI args (#796). Always includes `--single-transaction`
 * (alias `-1`) so a failure mid-restore rolls the whole thing back instead of
 * leaving the DB half-applied. Pure → unit-testable; the spawn site just spreads
 * the result.
 */
export function buildPsqlRestoreArgs(parsed: {
  host?: string; port?: string; user?: string; database?: string;
}, isLocal: boolean): string[] {
  const args = ['--no-password', '--single-transaction'];
  if (!isLocal && parsed.host) args.push(`--host=${parsed.host}`);
  if (!isLocal && parsed.port) args.push(`--port=${parsed.port}`);
  if (parsed.user) args.push(`--username=${parsed.user}`);
  if (parsed.database) args.push(parsed.database);
  return args;
}

/**
 * Choose which backup branches to delete to honor a retention cap (#793).
 *
 * Each `branchBackup` creates a new Neon branch and never pruned old ones, so
 * branches (and their storage/compute cost) accrued indefinitely. Given all
 * branches and a `maxKeep`, this returns the IDs of the OLDEST backup-prefixed
 * branches beyond the cap (newest are kept). Non-backup branches are never
 * touched. Pure → unit-testable.
 */
export function selectBranchesToPrune(
  branches: Array<{ id: string; name: string; createdAt: string }>,
  maxKeep: number,
  prefix = BACKUP_BRANCH_PREFIX,
): string[] {
  if (maxKeep < 0) maxKeep = 0;
  const backups = branches
    .filter((b) => b.name.startsWith(prefix))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // newest first
  return backups.slice(maxKeep).map((b) => b.id);
}

export class BackupService {
  constructor(
    private config: DatabaseConfig,
    private management?: NeonManagementClient,
  ) {}

  async backup(options?: BackupOptions): Promise<BackupResult> {
    if (this.config.environment === 'neon') {
      return this.branchBackup(options);
    }
    return this.dumpBackup(options);
  }

  async restore(backup: BackupInfo, options?: RestoreOptions): Promise<void> {
    if (backup.type === 'branch') {
      throw new DatabaseError(
        `Branch backup ${backup.id} cannot be restored automatically. ` +
          `Use the connection URI to point your app at the branch directly. ` +
          `URI can be retrieved via NeonManagementClient.getBranchConnectionUri()`,
        'BRANCH_RESTORE_UNSUPPORTED',
      );
    }
    // #795: refuse to restore a dump whose contents don't match its recorded
    // checksum — surface the corruption explicitly instead of feeding garbage
    // SQL to psql.
    if (!verifyBackupChecksum(backup)) {
      throw new DatabaseError(
        `Backup ${backup.id} failed checksum verification — contents are corrupted.`,
        'BACKUP_CHECKSUM_MISMATCH',
      );
    }
    await this.psqlRestore(backup.data, options);
  }

  // ── Neon branch backup ────────────────────────────────────────────────────

  private async branchBackup(options?: BackupOptions): Promise<BackupResult> {
    if (!this.management) {
      throw new DatabaseError(
        'NeonManagementClient is required for branch backups. Provide apiKey and projectId in config.',
        'MISSING_MANAGEMENT_CLIENT',
      );
    }

    const label = options?.label ?? `${BACKUP_BRANCH_PREFIX}${new Date().toISOString()}`;
    const branch = await this.management.createBranch(label);

    const backup: BackupInfo = {
      id: randomUUID(),
      type: 'branch',
      createdAt: new Date().toISOString(),
      data: branch.id,
      metadata: { branchName: branch.name, branchId: branch.id, label },
    };

    // #793: prune old backup branches so they don't accrue storage/compute cost
    // indefinitely. Best-effort — a pruning failure must not fail the backup.
    const maxKeep = parseInt(process.env.DB_BACKUP_MAX_BRANCHES || '7', 10);
    if (Number.isFinite(maxKeep) && maxKeep > 0) {
      try {
        const branches = await this.management.listBranches();
        const toPrune = selectBranchesToPrune(branches, maxKeep);
        for (const id of toPrune) {
          if (id === branch.id) continue; // never delete the one we just made
          await this.management.deleteBranch(id).catch(() => undefined);
        }
      } catch { /* best-effort branch retention */ }
    }

    return { backup, message: `Neon branch backup created: ${branch.name} (${branch.id})` };
  }

  // ── pg_dump backup ────────────────────────────────────────────────────────

  private async dumpBackup(options?: BackupOptions): Promise<BackupResult> {
    const connStr = options?.connectionString ?? this.config.databaseUrl;
    const parsed = parseConnectionString(connStr);

    const isLocal = !parsed.host || parsed.host === 'localhost' || parsed.host === '127.0.0.1';
    const env = buildPgEnv(parsed.password, isLocal);

    const args = ['--no-password', '--clean', '--if-exists', '--format=plain'];
    // For localhost, skip --host so pg_dump uses the Unix socket. Also unset
    // PGHOST/PGPORT in the env to prevent inherited values from overriding.
    if (!isLocal) args.push(`--host=${parsed.host}`);
    if (!isLocal && parsed.port) args.push(`--port=${parsed.port}`);
    if (parsed.user) args.push(`--username=${parsed.user}`);
    if (parsed.database) args.push(parsed.database);

    let stdout: string;
    // Allow operators with larger DBs to bump maxBuffer. Default 500MB
    // (was 100MB which threw ERR_CHILD_PROCESS_STDOUT_MAXBUFFER_EXCEEDED on
    // medium-sized prod DBs). For >500MB DBs, set DB_BACKUP_MAX_BUFFER_MB.
    const maxBufferMb = parseInt(process.env.DB_BACKUP_MAX_BUFFER_MB || '500', 10);
    const maxBufferBytes = (Number.isFinite(maxBufferMb) && maxBufferMb > 0 ? maxBufferMb : 500) * 1024 * 1024;
    try {
      ({ stdout } = await execFileAsync('pg_dump', args, { env, maxBuffer: maxBufferBytes }));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        throw new DatabaseError(
          'pg_dump not found. Install PostgreSQL client tools (e.g. apt install postgresql-client or brew install libpq).',
          'BINARY_NOT_FOUND',
        );
      }
      // Surface buffer exhaustion with actionable hint.
      if ((e as { code?: string }).code === 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER_EXCEEDED') {
        throw new DatabaseError(
          `pg_dump output exceeded ${maxBufferMb}MB. Set DB_BACKUP_MAX_BUFFER_MB env var to a larger value or stream-based backup.`,
          'BACKUP_TOO_LARGE',
        );
      }
      throw err;
    }

    const data = Buffer.from(stdout).toString('base64');
    const backup: BackupInfo = {
      id: randomUUID(),
      type: 'dump',
      createdAt: new Date().toISOString(),
      data,
      metadata: {
        label: options?.label ?? 'pg_dump',
        host: parsed.host,
        database: parsed.database,
        // #795: store a checksum so a corrupted dump is detectable before restore.
        checksumSha256: computeBackupChecksum(data),
      },
    };

    return { backup, message: `pg_dump backup created (${(stdout.length / 1024).toFixed(1)} KB)` };
  }

  // ── psql restore ──────────────────────────────────────────────────────────

  private async psqlRestore(base64Sql: string, options?: RestoreOptions): Promise<void> {
    const connStr = options?.connectionString ?? this.config.databaseUrl;
    const parsed = parseConnectionString(connStr);
    const sqlContent = Buffer.from(base64Sql, 'base64').toString('utf8');

    const isLocal = !parsed.host || parsed.host === 'localhost' || parsed.host === '127.0.0.1';
    const env = buildPgEnv(parsed.password, isLocal);

    // #796: all-or-nothing restore via --single-transaction (see helper).
    const args = buildPsqlRestoreArgs(parsed, isLocal);

    // execFile doesn't support piping stdin — use spawn to write SQL directly.
    await new Promise<void>((resolve, reject) => {
      const child = spawn('psql', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      const stderr: Buffer[] = [];

      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          reject(new DatabaseError(
            'psql not found. Install PostgreSQL client tools (e.g. apt install postgresql-client or brew install libpq).',
            'BINARY_NOT_FOUND',
          ));
        } else {
          reject(err);
        }
      });
      child.on('close', (code) => {
        if (code !== 0) {
          const msg = Buffer.concat(stderr).toString('utf8').trim();
          reject(new DatabaseError(`psql restore failed (exit ${code}): ${msg}`, 'RESTORE_FAILED'));
        } else {
          resolve();
        }
      });

      child.stdin?.write(sqlContent);
      child.stdin?.end();
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a clean process env for pg_dump / psql.
 * For local connections we strip all PG* env vars so that inherited values
 * (e.g. PGHOST pointing at a remote Neon host) don't override the socket path.
 */
function buildPgEnv(password: string | undefined, isLocal: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (isLocal) {
    // Remove all PostgreSQL connection env vars — let pg_dump discover the socket
    for (const key of ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGPASSFILE']) {
      delete env[key];
    }
  } else if (password) {
    env.PGPASSWORD = password;
  }
  return env;
}

export function parseConnectionString(url: string): {
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  database?: string;
} {
  try {
    const u = new URL(url);
    return {
      host: u.hostname || undefined,
      port: u.port || undefined,
      user: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      database: u.pathname.replace(/^\//, '') || undefined,
    };
  } catch {
    return {};
  }
}
