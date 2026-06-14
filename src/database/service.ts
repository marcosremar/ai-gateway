/**
 * DatabaseService — unified database abstraction.
 *
 * The app never imports Prisma, pg, or @neondatabase/serverless directly.
 * Everything goes through getDatabase() which returns a DatabaseService.
 *
 *   import { getDatabase } from '@ai-gateway/database';
 *   const db = getDatabase();
 *   const result = await db.query('SELECT 1');
 *   const prisma = db.prisma;  // PrismaClient instance
 */

import { buildConnectionConfig, buildPrismaUrl } from './config';
import { NeonManagementClient } from './neon-management';
import { BackupService } from './backup';
import { createSqlDriver } from './pg-driver';
import { DatabaseError } from './types';
import type { DatabaseConfig, QueryResult, BackupInfo, BackupOptions, BackupResult, RestoreOptions, NeonProject, NeonBranch, NeonDatabase, NeonEndpoint } from './types';
import type { SqlDriver } from './pg-driver';
import { createLogger } from '../logger';

const log = createLogger('database');

/**
 * Redact credentials from a database URL for safe logging (#786).
 *
 * Pure → unit-testable. Parses the URL and masks the password entirely and the
 * username down to a 3-char prefix; the naive `/:[^@]+@/` regex would leak the
 * password if it contained a literal `@`. Returns `<unparseable>` for malformed
 * input so we never accidentally log a raw connection string. Output is capped
 * to 100 chars.
 */
export function redactDatabaseUrl(url: string | undefined): string {
  try {
    const u = new URL(url ?? '');
    if (u.password) u.password = '***';
    if (u.username) u.username = u.username.slice(0, 3) + '***';
    return u.toString().slice(0, 100);
  } catch {
    return '<unparseable>';
  }
}

// ── Dynamic Prisma loader (no hard dep on @prisma/client) ───────────────────

function loadPrisma(config: DatabaseConfig): unknown {
  let PrismaClient: new (opts: unknown) => unknown;
  try {
    const mod = require('@prisma/client') as { PrismaClient: new (opts: unknown) => unknown };
    PrismaClient = mod.PrismaClient;
  } catch {
    throw new DatabaseError(
      '@prisma/client is not installed. Run: bun add @prisma/client',
      'MISSING_DEPENDENCY',
    );
  }

  // Use Neon HTTP adapter (port 443) instead of TCP (port 5432) for Neon environments.
  // This avoids firewall/network issues with the standard PostgreSQL port.
  // Robust redaction via URL parsing — naive `/:[^@]+@/` regex leaks the
  // password if it contains literal `@` (the regex stops at first `@`,
  // exposing the rest of the password).
  // #786: route through the structured logger (gated by level) instead of a raw
  // console.log that fired on every init regardless of configured log level.
  const redactedUrl = redactDatabaseUrl(config.databaseUrl);
  log.debug({ env: config.environment, url: redactedUrl }, 'loadPrisma');
  if (config.environment === 'neon') {
    try {
      // Use PrismaNeonHTTP (HTTP/fetch via port 443) to avoid TCP port 5432 firewall issues.
      // PrismaNeon (WebSocket/Pool) causes an instanceof mismatch when there are multiple
      // copies of @neondatabase/serverless in node_modules. PrismaNeonHTTP uses the neon()
      // fetch function and has no such coupling issue.
      const { neon, types } = require('@neondatabase/serverless') as {
        neon: (connectionString: string) => unknown;
        types: { setTypeParser: (oid: number, parser: (val: string) => unknown) => void };
      };
      // Return timestamps as raw strings so Prisma's WASM engine (driverAdapters) receives
      // the ISO/PostgreSQL string it expects. @neondatabase/serverless v1.0 converts timestamps
      // to Date objects by default, but those get serialized as {} at the WASM boundary.
      types.setTypeParser(1082, (val: string) => val); // DATE
      types.setTypeParser(1114, (val: string) => val); // TIMESTAMP
      types.setTypeParser(1184, (val: string) => val); // TIMESTAMPTZ
      const { PrismaNeonHTTP } = require('@prisma/adapter-neon') as {
        PrismaNeonHTTP: new (sql: unknown) => unknown;
      };
      const sql = neon(config.databaseUrl);
      const adapter = new PrismaNeonHTTP(sql);
      return new PrismaClient({
        adapter,
        log: process.env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'],
      });
    } catch (adapterErr) {
      console.error('[database] Neon adapter failed, falling back to TCP:', adapterErr);
    }
  }

  return new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'],
    datasources: { db: { url: buildPrismaUrl(config) } },
  });
}

// ── DatabaseService ──────────────────────────────────────────────────────────

export class DatabaseService {
  private config: DatabaseConfig;
  private _prisma?: unknown;
  private _driver?: SqlDriver;
  private _management?: NeonManagementClient;
  private _backup?: BackupService;

  constructor(config?: Partial<DatabaseConfig>) {
    this.config = buildConnectionConfig(config);
  }

  // ── Prisma (lazy) ──────────────────────────────────────────────────────────

  get prisma(): unknown {
    if (!this._prisma) {
      this._prisma = loadPrisma(this.config);
    }
    return this._prisma;
  }

  // ── Raw SQL ────────────────────────────────────────────────────────────────

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const driver = await this.driver();
    return driver.query<T>(sql, params);
  }

  // ── Management (Neon only) ─────────────────────────────────────────────────

  async getProject(): Promise<NeonProject> {
    return this.mgmt().getProject();
  }

  async listBranches(): Promise<NeonBranch[]> {
    return this.mgmt().listBranches();
  }

  async createBranch(name: string, parentId?: string): Promise<NeonBranch> {
    return this.mgmt().createBranch(name, parentId);
  }

  async deleteBranch(branchId: string): Promise<void> {
    return this.mgmt().deleteBranch(branchId);
  }

  async getBranchConnectionUri(branchId: string, databaseName: string, roleName: string): Promise<string> {
    return this.mgmt().getBranchConnectionUri(branchId, databaseName, roleName);
  }

  async listDatabases(branchId: string): Promise<NeonDatabase[]> {
    return this.mgmt().listDatabases(branchId);
  }

  async createDatabase(branchId: string, name: string, ownerName: string): Promise<NeonDatabase> {
    return this.mgmt().createDatabase(branchId, name, ownerName);
  }

  async deleteDatabase(branchId: string, databaseName: string): Promise<void> {
    return this.mgmt().deleteDatabase(branchId, databaseName);
  }

  async listEndpoints(): Promise<NeonEndpoint[]> {
    return this.mgmt().listEndpoints();
  }

  // ── Backup / Restore ───────────────────────────────────────────────────────

  async backup(options?: BackupOptions): Promise<BackupResult> {
    return this.backupSvc().backup(options);
  }

  async restore(backup: BackupInfo, options?: RestoreOptions): Promise<void> {
    return this.backupSvc().restore(backup, options);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this._prisma) {
      try {
        await (this._prisma as { $disconnect(): Promise<void> }).$disconnect();
      } catch (err) {
        console.warn('[database] Prisma disconnect error:', err);
      }
      this._prisma = undefined;
    }
    if (this._driver) {
      try {
        await this._driver.close();
      } catch (err) {
        console.warn('[database] Driver close error:', err);
      }
      this._driver = undefined;
    }
    // Management client has no close method - just clear reference
    this._management = undefined;
    // Backup service has no close method - just clear reference
    this._backup = undefined;
  }

  // ── Environment info ──────────────────────────────────────────────────────

  get environment() {
    return this.config.environment;
  }

  get isNeon() {
    return this.config.environment === 'neon';
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async driver(): Promise<SqlDriver> {
    if (!this._driver) {
      this._driver = await createSqlDriver(this.config);
    }
    return this._driver;
  }

  private mgmt(): NeonManagementClient {
    if (!this._management) {
      if (!this.config.apiKey || !this.config.projectId) {
        throw new DatabaseError(
          'NEON_API_KEY and NEON_PROJECT_ID are required for management operations',
          'MISSING_CREDENTIALS',
        );
      }
      this._management = new NeonManagementClient(this.config.apiKey, this.config.projectId);
    }
    return this._management;
  }

  private backupSvc(): BackupService {
    if (!this._backup) {
      this._backup = new BackupService(this.config, this.config.apiKey ? this.mgmt() : undefined);
    }
    return this._backup;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createDatabaseService(config?: Partial<DatabaseConfig>): DatabaseService {
  return new DatabaseService(config);
}

// ── Singleton ─────────────────────────────────────────────────────────────────

const GLOBAL_KEY = '__aiGatewayDb__';
type DbGlobal = { [GLOBAL_KEY]?: DatabaseService };

export function getDatabase(): DatabaseService {
  const g = globalThis as DbGlobal;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new DatabaseService();
  }
  return g[GLOBAL_KEY]!;
}
