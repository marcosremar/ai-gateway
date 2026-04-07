import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  detectEnvironment,
  isPooledUrl,
  buildConnectionConfig,
  buildPrismaUrl,
  getUnpooledUrl,
  getPooledUrl,
} from '../src/database/config';

describe('detectEnvironment', () => {
  it('detects neon from URL', () => {
    expect(detectEnvironment('postgresql://u@ep-abc.neon.tech/db')).toBe('neon');
  });
  it('detects local for non-neon URL', () => {
    expect(detectEnvironment('postgresql://u@localhost/db')).toBe('local');
  });
  it('detects local for empty URL', () => {
    expect(detectEnvironment('')).toBe('local');
  });
});
describe('isPooledUrl', () => {
  it('detects pooled URL', () => {
    expect(isPooledUrl('postgresql://u@ep-abc-pooler.neon.tech/db')).toBe(true);
  });
  it('non-pooled URL returns false', () => {
    expect(isPooledUrl('postgresql://u@ep-abc.neon.tech/db')).toBe(false);
  });
});
describe('buildConnectionConfig', () => {
  it('throws when DATABASE_URL not not set', () => {
    delete process.env.DATABASE_URL;
    expect(() => buildConnectionConfig()).toThrow('DATABASE_URL');
  });
  it('uses provided overrides', () => {
    const cfg = buildConnectionConfig({
      databaseUrl: 'postgresql://u@ep-x.neon.tech/db',
      environment: 'neon',
      apiKey: 'key',
      projectId: 'proj',
    });
    expect(cfg.environment).toBe('neon');
    expect(cfg.apiKey).toBe('key');
    expect(cfg.projectId).toBe('proj');
  });
  it('defaults connectionLimit and poolTimeout', () => {
    const cfg = buildConnectionConfig({
      databaseUrl: 'postgresql://u@localhost/db',
    });
    expect(cfg.connectionLimit).toBe(20);
    expect(cfg.poolTimeout).toBe(20);
  });
});
describe('buildPrismaUrl', () => {
  it('appends connection params', () => {
    const url = buildPrismaUrl({
      databaseUrl: 'postgresql://u@h/db',
      connectionLimit: 10,
      poolTimeout: 5,
    });
    expect(url).toContain('connection_limit=10');
    expect(url).toContain('pool_timeout=5');
    expect(url).toContain('max_lifetime=300');
  });
  it('uses & for URL with existing query params', () => {
    const url = buildPrismaUrl({
      databaseUrl: 'postgresql://u@h/db?sslmode=require',
      connectionLimit: 5,
      poolTimeout: 10,
    });
    expect(url).toContain('&connection_limit=5');
  });
});
describe('getUnpooledUrl', () => {
  it('prefers POSTGRES_URL_NON_POOLING', () => {
    process.env.POSTGRES_URL_NON_POOLING = 'unpooled';
    process.env.DATABASE_URL_UNPOOLED = 'unpooled2';
    process.env.DATABASE_URL = 'default';
    expect(getUnpooledUrl()).toBe('unpooled');
    delete process.env.POSTGRES_URL_NON_POOLING;
    delete process.env.DATABASE_URL_UNPOOLED;
  });
});
describe('getPooledUrl', () => {
  it('prefers POSTGRES_PRISMA_URL', () => {
    process.env.POSTGRES_PRISMA_URL = 'prisma';
    process.env.POSTGRES_URL = 'postgres';
    process.env.DATABASE_URL = 'default';
    expect(getPooledUrl()).toBe('prisma');
    delete process.env.POSTGRES_PRISMA_URL;
    delete process.env.POSTGRES_URL;
  });
});
