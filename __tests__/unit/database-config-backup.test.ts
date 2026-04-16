import { describe, it, expect, afterEach } from 'vitest';
import { parseConnectionString } from '../src/database/backup';
import { detectEnvironment, isPooledUrl, buildPrismaUrl, getUnpooledUrl, getPooledUrl } from '../src/database/config';
import type { DatabaseConfig } from '../src/database/types';
import { DatabaseError } from '../src/database/types';

describe('database/backup', () => {
  describe('parseConnectionString', () => {
    it('parses standard PostgreSQL URL', () => {
      const result = parseConnectionString('postgresql://user:pass@localhost:5432/mydb');
      expect(result.host).toBe('localhost');
      expect(result.port).toBe('5432');
      expect(result.user).toBe('user');
      expect(result.password).toBe('pass');
      expect(result.database).toBe('mydb');
    });

    it('parses Neon URL', () => {
      const result = parseConnectionString('postgresql://neondb:password@ep-cool-name-12345.us-east-2.aws.neon.tech/app?sslmode=require');
      expect(result.host).toBe('ep-cool-name-12345.us-east-2.aws.neon.tech');
      expect(result.user).toBe('neondb');
      expect(result.database).toBe('app');
    });

    it('handles URL without password', () => {
      const result = parseConnectionString('postgresql://user@localhost/mydb');
      expect(result.user).toBe('user');
      expect(result.password).toBeUndefined();
    });

    it('handles URL-encoded credentials', () => {
      const result = parseConnectionString('postgresql://user%40name:p%40ss@localhost/db');
      expect(result.user).toBe('user@name');
      expect(result.password).toBe('p@ss');
    });

    it('returns empty object for invalid URL', () => {
      const result = parseConnectionString('not-a-url');
      expect(result).toEqual({});
    });

    it('handles URL without port', () => {
      const result = parseConnectionString('postgresql://user@host/db');
      expect(result.port).toBeUndefined();
      expect(result.host).toBe('host');
    });
  });
});

describe('database/config', () => {
  describe('detectEnvironment', () => {
    it('detects neon from .neon.tech URL', () => {
      expect(detectEnvironment('postgresql://user@ep-xyz.us-east-2.aws.neon.tech/db')).toBe('neon');
    });

    it('detects local for localhost', () => {
      expect(detectEnvironment('postgresql://user@localhost:5432/db')).toBe('local');
    });

    it('detects local for IP address', () => {
      expect(detectEnvironment('postgresql://user@192.168.1.1/db')).toBe('local');
    });
  });

  describe('isPooledUrl', () => {
    it('detects pooled URL', () => {
      expect(isPooledUrl('postgresql://user@ep-xyz-pooler.us-east-2.aws.neon.tech/db')).toBe(true);
    });

    it('detects non-pooled URL', () => {
      expect(isPooledUrl('postgresql://user@ep-xyz.us-east-2.aws.neon.tech/db')).toBe(false);
    });
  });

  describe('buildPrismaUrl', () => {
    it('appends pool params to URL without query string', () => {
      const config: DatabaseConfig = {
        databaseUrl: 'postgresql://user@localhost/db',
        environment: 'local',
        connectionLimit: 10,
        poolTimeout: 30,
      };
      const url = buildPrismaUrl(config);
      expect(url).toContain('connection_limit=10');
      expect(url).toContain('pool_timeout=30');
      expect(url).toContain('max_lifetime=300');
    });

    it('appends pool params to URL with existing query string', () => {
      const config: DatabaseConfig = {
        databaseUrl: 'postgresql://user@localhost/db?sslmode=require',
        environment: 'local',
      };
      const url = buildPrismaUrl(config);
      expect(url).toContain('&connection_limit=');
    });

    it('uses defaults when not specified', () => {
      const config: DatabaseConfig = {
        databaseUrl: 'postgresql://user@localhost/db',
        environment: 'local',
      };
      const url = buildPrismaUrl(config);
      expect(url).toContain('connection_limit=20');
      expect(url).toContain('pool_timeout=20');
    });
  });

  describe('getUnpooledUrl', () => {
    const origEnv = process.env;
    afterEach(() => { process.env = origEnv; });

    it('prefers POSTGRES_URL_NON_POOLING', () => {
      process.env = { ...origEnv, POSTGRES_URL_NON_POOLING: 'unpooled', DATABASE_URL_UNPOOLED: 'unpooled2', DATABASE_URL: 'default' };
      expect(getUnpooledUrl()).toBe('unpooled');
    });

    it('falls back to DATABASE_URL_UNPOOLED', () => {
      process.env = { ...origEnv, DATABASE_URL_UNPOOLED: 'unpooled2', DATABASE_URL: 'default' };
      expect(getUnpooledUrl()).toBe('unpooled2');
    });

    it('falls back to DATABASE_URL', () => {
      process.env = { ...origEnv, DATABASE_URL: 'default' };
      expect(getUnpooledUrl()).toBe('default');
    });

    it('returns empty when nothing set', () => {
      process.env = { ...origEnv };
      delete process.env.POSTGRES_URL_NON_POOLING;
      delete process.env.DATABASE_URL_UNPOOLED;
      delete process.env.DATABASE_URL;
      expect(getUnpooledUrl()).toBe('');
    });
  });

  describe('getPooledUrl', () => {
    const origEnv = process.env;
    afterEach(() => { process.env = origEnv; });

    it('prefers POSTGRES_PRISMA_URL', () => {
      process.env = { ...origEnv, POSTGRES_PRISMA_URL: 'prisma', POSTGRES_URL: 'postgres', DATABASE_URL: 'default' };
      expect(getPooledUrl()).toBe('prisma');
    });
  });
});

describe('DatabaseError', () => {
  it('has correct name and code', () => {
    const err = new DatabaseError('test error', 'TEST_CODE');
    expect(err.name).toBe('DatabaseError');
    expect(err.code).toBe('TEST_CODE');
    expect(err.message).toBe('test error');
  });

  it('uses default code', () => {
    const err = new DatabaseError('test');
    expect(err.code).toBe('DATABASE_ERROR');
  });
});
