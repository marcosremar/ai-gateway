/**
 * Prisma loader — separate file to isolate @prisma imports.
 * Only imported when DATABASE_URL is set.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

export function createPrismaClient(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}
