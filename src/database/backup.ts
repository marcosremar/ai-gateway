/**
 * Backup and restore service.
 * - Neon: uses branch copy-on-write (instant snapshot)
 * - Local: uses pg_dump / psql
 */

import { execFile } from 'child_process';
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

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (parsed.password) env.PGPASSWORD = parsed.password;

    const args = ['--no-password', '--clean', '--if-exists', '--format=plain'];
    if (parsed.host) args.push(`--host=${parsed.host}`);
    if (parsed.port) args.push(`--port=${parsed.port}`);
    if (parsed.user) args.push(`--username=${parsed.user}`);
    if (parsed.database) args.push(parsed.database);

    const { stdout } = await execFileAsync('pg_dump', args, { env, maxBuffer: 100 * 1024 * 1024 });

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

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (parsed.password) env.PGPASSWORD = parsed.password;

    const args = ['--no-password'];
    if (parsed.host) args.push(`--host=${parsed.host}`);
    if (parsed.port) args.push(`--port=${parsed.port}`);
    if (parsed.user) args.push(`--username=${parsed.user}`);
    if (parsed.database) args.push(parsed.database);

    await execFileAsync('psql', args, {
      env,
      input: sqlContent,
      maxBuffer: 100 * 1024 * 1024,
    } as Parameters<typeof execFileAsync>[2]);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseConnectionString(url: string): {
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
