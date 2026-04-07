import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseService, getDatabase } from '../src/database/service';

describe('DatabaseService', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/testdb';
  });
  it('constructs with config', () => {
    const db = new DatabaseService({ databaseUrl: 'postgresql://u:p@h/db' });
    expect(db.environment).toBe('local');
    expect(db.isNeon).toBe(false);
  });
  it('detects neon environment', () => {
    const db = new DatabaseService({
      databaseUrl: 'postgresql://user:pass@ep-abc.us-east-2.aws.neon.tech:5432/neondb',
    });
    expect(db.environment).toBe('neon');
    expect(db.isNeon).toBe(true);
  });
  it('close resolves even without prisma', async () => {
    const db = new DatabaseService({ databaseUrl: 'postgresql://u:p@h/db' });
    await expect(db.close()).resolves.toBeUndefined();
  });
});
describe('getDatabase singleton', () => {
  it('returns same instance', () => {
    const g = globalThis as Record<string, unknown>;
    const key = '__aiGatewayDb__';
    delete g[key];
    const db1 = getDatabase();
    const db2 = getDatabase();
    expect(db2).toBe(db1);
    delete g[key];
  });
});
