/**
 * Database abstraction types — works with Neon (production) or local PostgreSQL (development).
 */

export type DatabaseEnvironment = 'neon' | 'local';

export interface DatabaseConfig {
  databaseUrl: string;
  environment: DatabaseEnvironment;
  projectId?: string;
  apiKey?: string;
  connectionLimit?: number;
  poolTimeout?: number;
}

// ── Neon Management API types ────────────────────────────────────────────────

export interface NeonProject {
  id: string;
  name: string;
  regionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface NeonBranch {
  id: string;
  projectId: string;
  name: string;
  primary: boolean;
  createdAt: string;
  updatedAt: string;
  parentId?: string;
  parentTimestamp?: string;
}

export interface NeonDatabase {
  id: number;
  branchId: string;
  name: string;
  ownerName: string;
  createdAt: string;
  updatedAt: string;
}

export interface NeonEndpoint {
  id: string;
  projectId: string;
  branchId: string;
  type: 'read_write' | 'read_only';
  host: string;
  createdAt: string;
  updatedAt: string;
}

// ── Backup / Restore ─────────────────────────────────────────────────────────

export type BackupType = 'branch' | 'dump';

export interface BackupInfo {
  id: string;
  type: BackupType;
  createdAt: string;
  /** For branch backups: the branch ID in Neon. For dump backups: base64-encoded SQL. */
  data: string;
  metadata?: Record<string, unknown>;
}

export interface BackupOptions {
  /** Optional label for the backup */
  label?: string;
  /** For dump backups: connection string override */
  connectionString?: string;
}

export interface BackupResult {
  backup: BackupInfo;
  /** Human-readable message */
  message: string;
}

export interface RestoreOptions {
  /** Connection string to restore into (dump backups only) */
  connectionString?: string;
}

// ── Query result ─────────────────────────────────────────────────────────────

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
  fields?: Array<{ name: string; dataTypeID?: number }>;
}

// ── Error ────────────────────────────────────────────────────────────────────

export class DatabaseError extends Error {
  readonly code: string;
  constructor(message: string, code = 'DATABASE_ERROR') {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
  }
}
