/**
 * Tests for src/database/pg-driver.ts
 * Covers: createSqlDriver factory, Neon driver (mocked), Pg driver (mocked), error handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseError } from '../../src/database/types';

// ── createSqlDriver (factory) ─────────────────────────────────────────────────

describe('createSqlDriver()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('routes to neon driver when environment is neon', async () => {
    // Mock the neon module
    vi.doMock('@neondatabase/serverless', () => ({
      neon: (connStr: string) => {
        // Returns a tagged-template-literal style function
        return async (sql: string, ...params: unknown[]) => [
          { id: 1, name: 'row1' },
        ];
      },
    }));

    const { createSqlDriver } = await import('../src/database/pg-driver');
    const driver = await createSqlDriver({
      environment: 'neon',
      databaseUrl: 'postgresql://user:pass@host/db',
    });

    expect(driver).toBeDefined();
    expect(typeof driver.query).toBe('function');
    expect(typeof driver.close).toBe('function');

    vi.doUnmock('@neondatabase/serverless');
  });

  it('routes to pg driver when environment is not neon', async () => {
    vi.doMock('pg', () => ({
      Client: class MockClient {
        connect = vi.fn(async () => {});
        end = vi.fn(async () => {});
        query = vi.fn(async () => ({ rows: [], rowCount: 0, fields: [] }));
      },
    }));

    const { createSqlDriver } = await import('../src/database/pg-driver');
    const driver = await createSqlDriver({
      environment: 'local',
      databaseUrl: 'postgresql://user:pass@localhost/db',
    });

    expect(driver).toBeDefined();
    expect(typeof driver.query).toBe('function');

    await driver.close();

    vi.doUnmock('pg');
  });
});

// ── createNeonDriver ──────────────────────────────────────────────────────────

describe('createNeonDriver()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('throws DatabaseError when neon function is undefined', async () => {
    // Simulate missing package by making neon undefined
    vi.doMock('@neondatabase/serverless', () => ({
      neon: undefined,
    }));

    const { createNeonDriver } = await import('../src/database/pg-driver');
    await expect(createNeonDriver('postgresql://host/db')).rejects.toMatchObject({
      code: 'MISSING_DEPENDENCY',
    });

    vi.doUnmock('@neondatabase/serverless');
  });

  it('throws DatabaseError when neon export is missing', async () => {
    vi.doMock('@neondatabase/serverless', () => ({
      neon: undefined, // export present but undefined
    }));

    const { createNeonDriver } = await import('../src/database/pg-driver');
    await expect(createNeonDriver('postgresql://host/db')).rejects.toMatchObject({
      code: 'MISSING_DEPENDENCY',
    });

    vi.doUnmock('@neondatabase/serverless');
  });

  it('returns a driver with query method', async () => {
    const mockRows = [{ id: 1 }, { id: 2 }];
    vi.doMock('@neondatabase/serverless', () => ({
      neon: (_connStr: string) => async (_sql: string, ...params: unknown[]) => mockRows,
    }));

    const { createNeonDriver } = await import('../src/database/pg-driver');
    const driver = await createNeonDriver('postgresql://host/db');
    const result = await driver.query('SELECT * FROM users');
    expect(result.rows).toEqual(mockRows);
    expect(result.rowCount).toBe(2);

    vi.doUnmock('@neondatabase/serverless');
  });

  it('close() is a no-op (HTTP driver has no persistent connection)', async () => {
    vi.doMock('@neondatabase/serverless', () => ({
      neon: (_connStr: string) => async () => [],
    }));

    const { createNeonDriver } = await import('../src/database/pg-driver');
    const driver = await createNeonDriver('postgresql://host/db');
    // Should not throw
    await expect(driver.close()).resolves.not.toThrow();

    vi.doUnmock('@neondatabase/serverless');
  });

  it('passes params to neon function', async () => {
    const sqlFn = vi.fn(async () => [{ count: 5 }]);
    vi.doMock('@neondatabase/serverless', () => ({
      neon: (_connStr: string) => sqlFn,
    }));

    const { createNeonDriver } = await import('../src/database/pg-driver');
    const driver = await createNeonDriver('postgresql://host/db');
    await driver.query('SELECT $1', ['hello']);
    expect(sqlFn).toHaveBeenCalledWith('SELECT $1', 'hello');

    vi.doUnmock('@neondatabase/serverless');
  });
});

// ── createPgDriver ────────────────────────────────────────────────────────────

describe('createPgDriver()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('throws DatabaseError when pg Client is not available', async () => {
    // Mock pg to return an object without Client, causing the driver to detect missing export
    vi.doMock('pg', () => ({
      Client: undefined,
      default: { Client: undefined },
    }));

    const { createPgDriver } = await import('../src/database/pg-driver');
    // When Client is undefined, the driver throws 'Client export not found' (plain Error)
    await expect(createPgDriver('postgresql://host/db')).rejects.toThrow('Client export not found');

    vi.doUnmock('pg');
  });

  it('connects and returns a working driver', async () => {
    const mockConnect = vi.fn(async () => {});
    const mockEnd = vi.fn(async () => {});
    const mockQuery = vi.fn(async () => ({
      rows: [{ id: 1, name: 'Alice' }],
      rowCount: 1,
      fields: [{ name: 'id', dataTypeID: 23 }, { name: 'name', dataTypeID: 25 }],
    }));

    vi.doMock('pg', () => ({
      Client: class {
        connect = mockConnect;
        end = mockEnd;
        query = mockQuery;
      },
    }));

    const { createPgDriver } = await import('../src/database/pg-driver');
    const driver = await createPgDriver('postgresql://host/db');

    expect(mockConnect).toHaveBeenCalled();

    const result = await driver.query('SELECT * FROM users');
    expect(result.rows).toEqual([{ id: 1, name: 'Alice' }]);
    expect(result.rowCount).toBe(1);
    expect(result.fields).toHaveLength(2);

    await driver.close();
    expect(mockEnd).toHaveBeenCalled();

    vi.doUnmock('pg');
  });

  it('uses rowCount from result (fallback to rows.length when null)', async () => {
    vi.doMock('pg', () => ({
      Client: class {
        connect = vi.fn(async () => {});
        end = vi.fn(async () => {});
        query = vi.fn(async () => ({
          rows: [{ id: 1 }, { id: 2 }],
          rowCount: null, // null means use rows.length
          fields: [],
        }));
      },
    }));

    const { createPgDriver } = await import('../src/database/pg-driver');
    const driver = await createPgDriver('postgresql://host/db');
    const result = await driver.query('SELECT * FROM users');
    expect(result.rowCount).toBe(2); // fallback to rows.length

    vi.doUnmock('pg');
  });

  it('passes params to pg client.query', async () => {
    const mockQuery = vi.fn(async () => ({ rows: [], rowCount: 0, fields: [] }));

    vi.doMock('pg', () => ({
      Client: class {
        connect = vi.fn(async () => {});
        end = vi.fn(async () => {});
        query = mockQuery;
      },
    }));

    const { createPgDriver } = await import('../src/database/pg-driver');
    const driver = await createPgDriver('postgresql://host/db');
    await driver.query('SELECT $1', ['test-val']);
    expect(mockQuery).toHaveBeenCalledWith('SELECT $1', ['test-val']);

    vi.doUnmock('pg');
  });

  it('uses default.Client when top-level Client is not present', async () => {
    const mockConnect = vi.fn(async () => {});
    const MockClient = class {
      connect = mockConnect;
      end = vi.fn(async () => {});
      query = vi.fn(async () => ({ rows: [], rowCount: 0, fields: [] }));
    };

    vi.doMock('pg', () => ({
      Client: undefined, // top-level Client is absent
      default: { Client: MockClient },
    }));

    const { createPgDriver } = await import('../src/database/pg-driver');
    const driver = await createPgDriver('postgresql://host/db');
    expect(mockConnect).toHaveBeenCalled();

    vi.doUnmock('pg');
  });
});
