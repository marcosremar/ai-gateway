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

// ── Dynamic Prisma loader (no hard dep on @prisma/client) ───────────────────

function loadPrisma(url: string): unknown {
  let PrismaClient: new (opts: unknown) => unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@prisma/client') as { PrismaClient: new (opts: unknown) => unknown };
    PrismaClient = mod.PrismaClient;
  } catch {
    throw new DatabaseError(
      '@prisma/client is not installed. Run: bun add @prisma/client',
      'MISSING_DEPENDENCY',
    );
  }

  return new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'],
    datasources: { db: { url } },
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
      this._prisma = loadPrisma(buildPrismaUrl(this.config));
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
      await (this._prisma as { $disconnect(): Promise<void> }).$disconnect();
      this._prisma = undefined;
    }
    if (this._driver) {
      await this._driver.close();
      this._driver = undefined;
    }
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
