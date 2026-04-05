/**
 * Prisma initializer — connects to PostgreSQL when DATABASE_URL is set.
 *
 * Uses require() instead of import() because Bun statically resolves import()
 * at parse time, causing crashes when @prisma packages aren't installed.
 * require() is resolved at runtime only, making Prisma truly optional.
 *
 * Called by ws-server.ts after Bun.serve() is already listening.
 */

export async function initPrisma(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.warn('[prisma] DATABASE_URL not set — running without DB');
    return;
  }
  try {
    const { PrismaClient } = require('@prisma/client');
    const { PrismaPg } = require('@prisma/adapter-pg');
    const pg = require('pg');
    const { setPrisma } = require('./state');

    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const adapter = new PrismaPg(pool);
    setPrisma(new PrismaClient({ adapter }));
    console.log('[prisma] Connected to PostgreSQL');
  } catch (e: any) {
    console.warn(`[prisma] Unavailable: ${e.message?.slice(0, 100)} — running without DB`);
  }
}
