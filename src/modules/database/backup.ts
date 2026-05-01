/**
 * Backup and restore service.
 * - Neon: uses branch copy-on-write (instant snapshot)
 * - Local: uses pg_dump / psql
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import type { DatabaseConfig, BackupInfo, BackupOptions, BackupResult, RestoreOptions } from './types';
import { DatabaseError } from './types';
import type { NeonManagementClient } from './neon-management';

const execFileAsync = promisify(execFile);

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

    const label = options?.label ?? `backup-${new Date().toISOString()}`;
    const branch = await this.management.createBranch(label);

    const backup: BackupInfo = {
      id: randomUUID(),
      type: 'branch',
      createdAt: new Date().toISOString(),
      data: branch.id,
      metadata: { branchName: branch.name, branchId: branch.id, label },
    };

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
    try {
      ({ stdout } = await execFileAsync('pg_dump', args, { env, maxBuffer: 100 * 1024 * 1024 }));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        throw new DatabaseError(
          'pg_dump not found. Install PostgreSQL client tools (e.g. apt install postgresql-client or brew install libpq).',
          'BINARY_NOT_FOUND',
        );
      }
      throw err;
    }

    const backup: BackupInfo = {
      id: randomUUID(),
      type: 'dump',
      createdAt: new Date().toISOString(),
      data: Buffer.from(stdout).toString('base64'),
      metadata: { label: options?.label ?? 'pg_dump', host: parsed.host, database: parsed.database },
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

    const args = ['--no-password'];
    if (!isLocal) args.push(`--host=${parsed.host}`);
    if (!isLocal && parsed.port) args.push(`--port=${parsed.port}`);
    if (parsed.user) args.push(`--username=${parsed.user}`);
    if (parsed.database) args.push(parsed.database);

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
