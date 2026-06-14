/**
 * SQL driver factory — selects @neondatabase/serverless (HTTP) for Neon or pg (TCP) for local.
 */

import type { DatabaseConfig, QueryResult } from './types';
import { DatabaseError } from './types';
import { safeClose } from '../safe-catch';

export interface SqlDriver {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  close(): Promise<void>;
}

interface PgClientLike {
  connect(): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{
    rows: T[];
    rowCount: number | null;
    fields: Array<{ name: string; dataTypeID: number }>;
  }>;
  end(): Promise<void>;
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
      // @neondatabase/serverless accepts two call forms:
      //   1. tagged template: sql`SELECT ... WHERE id = ${id}`
      //   2. positional:      sql.query('SELECT ... WHERE id = $1', [id])
      // We always go through .query() so $N placeholders bind correctly. The
      // previous code passed (sqlStr, ...params) directly — neon would either
      // throw (expecting TemplateStringsArray as first arg) or silently
      // misinterpret, dropping parameter binding.
      const sqlObj = sql as { query?: (s: string, p?: unknown[]) => Promise<T[] | { rows: T[] }> };
      if (typeof sqlObj.query !== 'function') {
        throw new DatabaseError('neon driver: .query() method missing — incompatible package version', 'NEON_INCOMPATIBLE');
      }
      const result = await sqlObj.query(sqlStr, params);
      const rows = (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
      return { rows, rowCount: rows.length };
    },
    async close() {
      // HTTP driver — no persistent connection to close
    },
  };
}

// ── pg TCP driver ─────────────────────────────────────────────────────────────

export async function createPgDriver(connectionString: string): Promise<SqlDriver> {
  let PgClient: new (opts: { connectionString: string }) => PgClientLike;

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

  let client = new PgClient({ connectionString });
  try {
    await client.connect();
  } catch (err) {
          await safeClose(client, 'pg-query-reconnect');
    throw err;
  }

  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      try {
        const result = await client.query<T>(sql, params);
        return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length, fields: result.fields };
      } catch (err) {
        // #733: on a transient disconnect the old code closed the client and
        // rethrew — but kept the dead client, so the *next* query failed too.
        // Reconnect with a fresh client and retry the query ONCE; only surface
        // the error if the retry also fails (or the error isn't transient).
        if (isTransientDisconnect(err)) {
          await safeClose(client, 'pg-connect-fallback');
          try {
            client = new PgClient({ connectionString });
            await client.connect();
            const result = await client.query<T>(sql, params);
            return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length, fields: result.fields };
          } catch (retryErr) {
            throw retryErr;
          }
        }
        throw err;
      }
    },
    async close() {
      await client.end();
    },
  };
}

/** True for connection-level errors that a single reconnect can recover (#733). */
export function isTransientDisconnect(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ECONNRESET' || code === 'ENOTCONN' || code === 'ECONNREFUSED' || code === 'EPIPE';
}

// ── Factory ───────────────────────────────────────────────────────────────────

export async function createSqlDriver(config: DatabaseConfig): Promise<SqlDriver> {
  if (config.environment === 'neon') {
    return createNeonDriver(config.databaseUrl);
  }
  return createPgDriver(config.databaseUrl);
}
