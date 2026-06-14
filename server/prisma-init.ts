/**
 * Prisma initializer — connects to PostgreSQL when DATABASE_URL is set.
 *
 * Uses require() instead of import() because Bun statically resolves import()
 * at parse time, causing crashes when @prisma packages aren't installed.
 * require() is resolved at runtime only, making Prisma truly optional.
 *
 * Called by ws-server.ts after Bun.serve() is already listening.
 */

import { createLogger } from '../src/logger';

const log = createLogger('prisma-init');

/**
 * Pool tuning options for the pg pool backing Prisma (#736).
 *
 * `new pg.Pool({ connectionString })` alone uses pg defaults (max 10, no
 * idleTimeout, no maxLifetime). Against Neon's pooler an idle connection that
 * is never closed pins a compute unit and racks up compute-hours. Reading the
 * limits from env lets operators bound the pool without code changes.
 */
export interface PgPoolOptions {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  maxLifetimeSeconds?: number;
  connectionTimeoutMillis?: number;
}

/**
 * Build pg.Pool options from environment, applying safe Neon-friendly bounds.
 * Pure (env-in, options-out) so it is unit-testable without a real pool.
 *
 * Env vars (all optional):
 *   DB_POOL_MAX                  — max connections (default 10, clamped 1..100)
 *   DB_POOL_IDLE_TIMEOUT_MS      — close idle conns after N ms (default 30000)
 *   DB_POOL_MAX_LIFETIME_S       — recycle a conn after N seconds (default 1800)
 *   DB_POOL_CONNECT_TIMEOUT_MS   — fail a new connection after N ms (default 10000)
 *
 * A non-numeric / non-positive value falls back to the default rather than
 * passing NaN to pg (which would disable the bound silently).
 */
export function buildPgPoolOptions(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
): PgPoolOptions {
  const num = (raw: string | undefined, def: number, min = 1, max = Number.MAX_SAFE_INTEGER): number => {
    const v = raw != null ? Number(raw) : NaN;
    if (!Number.isFinite(v) || v <= 0) return def;
    return Math.min(Math.max(Math.floor(v), min), max);
  };
  return {
    connectionString,
    max: num(env.DB_POOL_MAX, 10, 1, 100),
    idleTimeoutMillis: num(env.DB_POOL_IDLE_TIMEOUT_MS, 30_000),
    maxLifetimeSeconds: num(env.DB_POOL_MAX_LIFETIME_S, 1_800),
    connectionTimeoutMillis: num(env.DB_POOL_CONNECT_TIMEOUT_MS, 10_000),
  };
}

export async function initPrisma(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    log.warn('DATABASE_URL not set — running without DB');
    return;
  }
  try {
    const { PrismaClient } = require('@prisma/client');
    const { PrismaPg } = require('@prisma/adapter-pg');
    const pg = require('pg');
    const { setPrisma } = require('./state');

    // #736: bound the pool (max/idle/lifetime) so idle Neon connections don't
    // pin compute units indefinitely. Defaults are conservative; override via
    // DB_POOL_* env vars.
    const pool = new pg.Pool(buildPgPoolOptions(process.env.DATABASE_URL));
    const adapter = new PrismaPg(pool);
    setPrisma(new PrismaClient({ adapter }));
    log.log('Connected to PostgreSQL');
  } catch (e: any) {
    log.warn(`Unavailable: ${e.message?.slice(0, 100)} — running without DB`);
  }
}
