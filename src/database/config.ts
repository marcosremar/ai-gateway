/**
 * Database configuration helpers — detect environment and build connection URLs.
 */

import type { DatabaseConfig, DatabaseEnvironment } from './types';

export function detectEnvironment(url: string): DatabaseEnvironment {
  return url.includes('.neon.tech') ? 'neon' : 'local';
}

export function isPooledUrl(url: string): boolean {
  return url.includes('-pooler.');
}

/**
 * Build the full database config from environment variables.
 * Priority for URL: DATABASE_URL (required).
 */
export function buildConnectionConfig(overrides?: Partial<DatabaseConfig>): DatabaseConfig {
  const databaseUrl = overrides?.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  const environment = overrides?.environment ?? detectEnvironment(databaseUrl);
  const projectId = overrides?.projectId ?? process.env.NEON_PROJECT_ID;
  const apiKey = overrides?.apiKey ?? process.env.NEON_API_KEY;
  const connectionLimit = overrides?.connectionLimit ?? Number(process.env.DB_CONNECTION_LIMIT ?? '20');
  const poolTimeout = overrides?.poolTimeout ?? Number(process.env.DB_POOL_TIMEOUT ?? '20');

  return { databaseUrl, environment, projectId, apiKey, connectionLimit, poolTimeout };
}

/**
 * Build a Prisma-compatible connection URL with pool parameters appended.
 */
export function buildPrismaUrl(config: DatabaseConfig): string {
  const base = config.databaseUrl;
  const sep = base.includes('?') ? '&' : '?';
  const limit = config.connectionLimit ?? 20;
  const timeout = config.poolTimeout ?? 20;
  return `${base}${sep}connection_limit=${limit}&pool_timeout=${timeout}&max_lifetime=300`;
}

/**
 * Get the unpooled connection URL for direct connections (migrations, backups).
 * Priority: POSTGRES_URL_NON_POOLING → DATABASE_URL_UNPOOLED → DATABASE_URL
 */
export function getUnpooledUrl(): string {
  return (
    process.env.POSTGRES_URL_NON_POOLING ??
    process.env.DATABASE_URL_UNPOOLED ??
    process.env.DATABASE_URL ??
    ''
  );
}

/**
 * Get the pooled connection URL for regular queries.
 * Priority: POSTGRES_PRISMA_URL → POSTGRES_URL → DATABASE_URL
 */
export function getPooledUrl(): string {
  return (
    process.env.POSTGRES_PRISMA_URL ??
    process.env.POSTGRES_URL ??
    process.env.DATABASE_URL ??
    ''
  );
}
