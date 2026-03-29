/**
 * SQL driver factory — selects @neondatabase/serverless (HTTP) for Neon or pg (TCP) for local.
 */

import type { DatabaseConfig, QueryResult } from './types';
import { DatabaseError } from './types';

export interface SqlDriver {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  close(): Promise<void>;
}

// ── Neon HTTP driver ──────────────────────────────────────────────────────────

export async function createNeonDriver(connectionString: string): Promise<SqlDriver> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let neonFn: (conn: string) => any;

  try {
    const mod = await import('@neondatabase/serverless');
    neonFn = mod.neon;
    if (!neonFn) throw new Error('neon export not found');
  } catch {
    throw new DatabaseError(
      'Package @neondatabase/serverless is not installed. Run: bun add @neondatabase/serverless',
      'MISSING_DEPENDENCY',
    );
  }

  const sql = neonFn(connectionString);

  return {
    async query<T>(sqlStr: string, params: unknown[] = []): Promise<QueryResult<T>> {
      // Use tagged template literal syntax via Function constructor to pass params safely
      const rows = (await (sql as Function)(sqlStr, ...params)) as T[];
      return { rows, rowCount: rows.length };
    },
    async close() {
      // HTTP driver — no persistent connection to close
    },
  };
}

// ── pg TCP driver ─────────────────────────────────────────────────────────────

export async function createPgDriver(connectionString: string): Promise<SqlDriver> {
  let PgClient: new (opts: { connectionString: string }) => {
    connect(): Promise<void>;
    query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number; fields: Array<{ name: string; dataTypeID: number }> }>;
    end(): Promise<void>;
  };

  try {
    const mod = await import('pg');
    PgClient = mod.Client ?? mod.default?.Client;
    if (!PgClient) throw new Error('Client export not found');
  } catch (err) {
    if ((err as { code?: string }).code === 'MODULE_NOT_FOUND' || err instanceof DatabaseError) {
      throw new DatabaseError(
        'Package pg is not installed. Run: bun add pg',
        'MISSING_DEPENDENCY',
      );
    }
    throw err;
  }

  const client = new PgClient({ connectionString });
  await client.connect();

  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const result = await client.query<T>(sql, params);
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length, fields: result.fields };
    },
    async close() {
      await client.end();
    },
  };
}

// ── Factory ───────────────────────────────────────────────────────────────────

export async function createSqlDriver(config: DatabaseConfig): Promise<SqlDriver> {
  if (config.environment === 'neon') {
    return createNeonDriver(config.databaseUrl);
  }
  return createPgDriver(config.databaseUrl);
}
