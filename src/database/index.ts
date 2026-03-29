// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  DatabaseEnvironment,
  DatabaseConfig,
  NeonProject,
  NeonBranch,
  NeonDatabase,
  NeonEndpoint,
  BackupType,
  BackupInfo,
  BackupOptions,
  BackupResult,
  RestoreOptions,
  QueryResult,
} from './types';
export { DatabaseError } from './types';

// ── Config ─────────────────────────────────────────────────────────────────────
export {
  detectEnvironment,
  isPooledUrl,
  buildConnectionConfig,
  buildPrismaUrl,
  getUnpooledUrl,
  getPooledUrl,
} from './config';

// ── SQL driver ─────────────────────────────────────────────────────────────────
export type { SqlDriver } from './pg-driver';
export { createSqlDriver, createNeonDriver, createPgDriver } from './pg-driver';

// ── Neon Management ────────────────────────────────────────────────────────────
export { NeonManagementClient } from './neon-management';

// ── Backup ─────────────────────────────────────────────────────────────────────
export { BackupService, parseConnectionString } from './backup';

// ── Service (main entry point) ─────────────────────────────────────────────────
export { DatabaseService, createDatabaseService, getDatabase } from './service';
