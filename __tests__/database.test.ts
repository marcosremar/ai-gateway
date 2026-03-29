/**
 * Unit tests for the database abstraction layer.
 * All external calls (fetch, pg, @neondatabase/serverless) are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectEnvironment,
  isPooledUrl,
  buildConnectionConfig,
  buildPrismaUrl,
  getUnpooledUrl,
  getPooledUrl,
  DatabaseError,
  NeonManagementClient,
  DatabaseService,
  createDatabaseService,
  getDatabase,
  parseConnectionString,
} from '@ai-gateway/database/index';

// ── detectEnvironment ─────────────────────────────────────────────────────────

describe('detectEnvironment', () => {
  it('returns neon for Neon connection strings', () => {
    expect(detectEnvironment('postgresql://user:pass@ep-xyz.us-east-2.aws.neon.tech/dbname')).toBe('neon');
  });

  it('returns local for local PostgreSQL', () => {
    expect(detectEnvironment('postgresql://user:pass@localhost:5432/dbname')).toBe('local');
    expect(detectEnvironment('postgresql://maramosp@localhost:5432/dumonttalker')).toBe('local');
  });

  it('returns local for non-Neon remote hosts', () => {
    expect(detectEnvironment('postgresql://user:pass@db.example.com/dbname')).toBe('local');
  });
});

// ── isPooledUrl ───────────────────────────────────────────────────────────────

describe('isPooledUrl', () => {
  it('detects pooled Neon URL', () => {
    expect(isPooledUrl('postgresql://user:pass@ep-xyz-pooler.us-east-2.aws.neon.tech/db')).toBe(true);
  });

  it('returns false for unpooled URL', () => {
    expect(isPooledUrl('postgresql://user:pass@ep-xyz.us-east-2.aws.neon.tech/db')).toBe(false);
    expect(isPooledUrl('postgresql://user:pass@localhost:5432/db')).toBe(false);
  });
});

// ── buildConnectionConfig ──────────────────────────────────────────────────────

describe('buildConnectionConfig', () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it('throws when DATABASE_URL is not set', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(() => buildConnectionConfig()).toThrow('DATABASE_URL');
  });

  it('builds config from environment variables', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@ep-abc.neon.tech/db');
    vi.stubEnv('NEON_PROJECT_ID', 'proj-123');
    vi.stubEnv('NEON_API_KEY', 'neon_api_key_xyz');
    vi.stubEnv('DB_CONNECTION_LIMIT', '10');
    vi.stubEnv('DB_POOL_TIMEOUT', '30');

    const config = buildConnectionConfig();
    expect(config.databaseUrl).toBe('postgresql://user:pass@ep-abc.neon.tech/db');
    expect(config.environment).toBe('neon');
    expect(config.projectId).toBe('proj-123');
    expect(config.apiKey).toBe('neon_api_key_xyz');
    expect(config.connectionLimit).toBe(10);
    expect(config.poolTimeout).toBe(30);
  });

  it('uses local environment for non-Neon URL', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
    const config = buildConnectionConfig();
    expect(config.environment).toBe('local');
  });

  it('allows overrides', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
    const config = buildConnectionConfig({ connectionLimit: 5, poolTimeout: 10 });
    expect(config.connectionLimit).toBe(5);
    expect(config.poolTimeout).toBe(10);
  });

  it('uses default values for optional env vars', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
    const config = buildConnectionConfig();
    expect(config.connectionLimit).toBe(20);
    expect(config.poolTimeout).toBe(20);
  });
});

// ── buildPrismaUrl ─────────────────────────────────────────────────────────────

describe('buildPrismaUrl', () => {
  beforeEach(() => vi.unstubAllEnvs());

  it('appends pool params to a URL without query string', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
    const config = buildConnectionConfig({ connectionLimit: 15, poolTimeout: 25 });
    const url = buildPrismaUrl(config);
    expect(url).toContain('connection_limit=15');
    expect(url).toContain('pool_timeout=25');
    expect(url).toContain('max_lifetime=300');
    expect(url).toContain('?');
  });

  it('appends pool params using & when URL already has query params', () => {
    const config = buildConnectionConfig({
      databaseUrl: 'postgresql://user:pass@localhost:5432/db?sslmode=require',
      connectionLimit: 20,
      poolTimeout: 20,
    });
    const url = buildPrismaUrl(config);
    expect(url).toContain('sslmode=require&connection_limit=20');
  });
});

// ── URL helpers ────────────────────────────────────────────────────────────────

describe('getUnpooledUrl / getPooledUrl', () => {
  // These vars may be populated by the vault in test setup; save/restore around each test
  const UNPOOLED_KEYS = ['POSTGRES_URL_NON_POOLING', 'DATABASE_URL_UNPOOLED'];
  const POOLED_KEYS = ['POSTGRES_PRISMA_URL', 'POSTGRES_URL'];
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.unstubAllEnvs();
    saved = {};
    for (const k of [...UNPOOLED_KEYS, ...POOLED_KEYS]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('getUnpooledUrl prefers POSTGRES_URL_NON_POOLING', () => {
    vi.stubEnv('POSTGRES_URL_NON_POOLING', 'postgresql://unpooled');
    vi.stubEnv('DATABASE_URL', 'postgresql://fallback');
    expect(getUnpooledUrl()).toBe('postgresql://unpooled');
  });

  it('getUnpooledUrl falls back to DATABASE_URL', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://fallback');
    expect(getUnpooledUrl()).toBe('postgresql://fallback');
  });

  it('getPooledUrl prefers POSTGRES_PRISMA_URL', () => {
    vi.stubEnv('POSTGRES_PRISMA_URL', 'postgresql://prisma');
    vi.stubEnv('DATABASE_URL', 'postgresql://fallback');
    expect(getPooledUrl()).toBe('postgresql://prisma');
  });

  it('getPooledUrl falls back to DATABASE_URL', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://fallback');
    expect(getPooledUrl()).toBe('postgresql://fallback');
  });
});

// ── DatabaseError ──────────────────────────────────────────────────────────────

describe('DatabaseError', () => {
  it('sets name and code', () => {
    const err = new DatabaseError('something went wrong', 'CUSTOM_CODE');
    expect(err.name).toBe('DatabaseError');
    expect(err.code).toBe('CUSTOM_CODE');
    expect(err.message).toBe('something went wrong');
    expect(err instanceof Error).toBe(true);
  });

  it('defaults code to DATABASE_ERROR', () => {
    const err = new DatabaseError('oops');
    expect(err.code).toBe('DATABASE_ERROR');
  });
});

// ── NeonManagementClient ───────────────────────────────────────────────────────

describe('NeonManagementClient', () => {
  const mockFetch = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  function mockResponse(body: unknown, status = 200) {
    mockFetch.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }

  const client = new NeonManagementClient('test-api-key', 'proj-abc');

  it('listProjects makes GET /projects', async () => {
    mockResponse({
      projects: [
        { id: 'p1', name: 'My Project', region_id: 'us-east-2', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
      ],
    });

    const projects = await client.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe('p1');
    expect(projects[0].regionId).toBe('us-east-2');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://console.neon.tech/api/v2/projects',
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer test-api-key' }) }),
    );
  });

  it('createBranch makes POST /projects/:id/branches', async () => {
    mockResponse({
      branch: { id: 'br-1', project_id: 'proj-abc', name: 'test-branch', primary: false, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
    });

    const branch = await client.createBranch('test-branch');
    expect(branch.id).toBe('br-1');
    expect(branch.name).toBe('test-branch');
    expect(branch.primary).toBe(false);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://console.neon.tech/api/v2/projects/proj-abc/branches',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('deleteBranch makes DELETE /projects/:id/branches/:branchId', async () => {
    mockResponse({});
    await client.deleteBranch('br-1');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://console.neon.tech/api/v2/projects/proj-abc/branches/br-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('throws DatabaseError on non-OK response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not found'),
    });

    const err = await client.getProject().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseError);
    expect((err as DatabaseError).message).toContain('404');
    mockFetch.mockReset();
  });

  it('listDatabases maps snake_case to camelCase', async () => {
    mockResponse({
      databases: [
        { id: 1, branch_id: 'br-1', name: 'neondb', owner_name: 'neondb_owner', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
      ],
    });

    const dbs = await client.listDatabases('br-1');
    expect(dbs[0].branchId).toBe('br-1');
    expect(dbs[0].ownerName).toBe('neondb_owner');
  });
});

// ── DatabaseService ────────────────────────────────────────────────────────────

describe('DatabaseService', () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it('throws when DATABASE_URL is missing', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(() => new DatabaseService()).toThrow('DATABASE_URL');
  });

  it('exposes environment and isNeon correctly for Neon URL', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@ep-abc.neon.tech/db');
    const svc = new DatabaseService();
    expect(svc.environment).toBe('neon');
    expect(svc.isNeon).toBe(true);
  });

  it('exposes environment and isNeon correctly for local URL', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
    const svc = new DatabaseService();
    expect(svc.environment).toBe('local');
    expect(svc.isNeon).toBe(false);
  });

  it('DatabaseError has MISSING_DEPENDENCY code for missing packages', () => {
    // Directly test DatabaseError construction for this code path
    const err = new DatabaseError('@prisma/client is not installed', 'MISSING_DEPENDENCY');
    expect(err.code).toBe('MISSING_DEPENDENCY');
    expect(err.name).toBe('DatabaseError');
  });

  it('management methods throw DatabaseError when credentials are missing', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@ep-abc.neon.tech/db');
    vi.stubEnv('NEON_API_KEY', '');
    vi.stubEnv('NEON_PROJECT_ID', '');
    const svc = new DatabaseService();
    await expect(svc.listBranches()).rejects.toThrow(DatabaseError);
    await expect(svc.listBranches()).rejects.toThrow('NEON_API_KEY');
  });

  it('createDatabaseService factory creates a DatabaseService instance', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
    const svc = createDatabaseService();
    expect(svc).toBeInstanceOf(DatabaseService);
  });
});

// ── getDatabase singleton ──────────────────────────────────────────────────────

describe('getDatabase', () => {
  it('returns the same instance on repeated calls', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
    const a = getDatabase();
    const b = getDatabase();
    expect(a).toBe(b);
    vi.unstubAllEnvs();
  });

  it('clearing globalThis creates a fresh instance', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
    const first = getDatabase();
    // Simulate process restart / fresh module load
    (globalThis as Record<string, unknown>)['__aiGatewayDb__'] = undefined;
    const second = getDatabase();
    expect(second).not.toBe(first);
    vi.unstubAllEnvs();
  });
});

// ── parseConnectionString ──────────────────────────────────────────────────────

describe('parseConnectionString', () => {
  it('parses a full connection string', () => {
    const result = parseConnectionString('postgresql://alice:secret@db.example.com:5433/mydb');
    expect(result.host).toBe('db.example.com');
    expect(result.port).toBe('5433');
    expect(result.user).toBe('alice');
    expect(result.password).toBe('secret');
    expect(result.database).toBe('mydb');
  });

  it('parses a URL without password', () => {
    const result = parseConnectionString('postgresql://maramosp@localhost:5432/dumonttalker');
    expect(result.user).toBe('maramosp');
    expect(result.password).toBeUndefined();
    expect(result.host).toBe('localhost');
    expect(result.database).toBe('dumonttalker');
  });

  it('parses a Neon URL', () => {
    const result = parseConnectionString('postgresql://neondb_owner:npg_key@ep-floral-wind-pooler.neon.tech/neondb?sslmode=require');
    expect(result.host).toBe('ep-floral-wind-pooler.neon.tech');
    expect(result.user).toBe('neondb_owner');
    expect(result.database).toBe('neondb');
  });

  it('decodes URL-encoded special chars in password', () => {
    const result = parseConnectionString('postgresql://user:p%40ss%21@host/db');
    expect(result.password).toBe('p@ss!');
  });

  it('returns empty object for malformed URL', () => {
    const result = parseConnectionString('not-a-url');
    expect(result).toEqual({});
  });

  it('returns empty object for empty string', () => {
    const result = parseConnectionString('');
    expect(result).toEqual({});
  });
});

// ── DatabaseService.close() ────────────────────────────────────────────────────

describe('DatabaseService.close()', () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it('close() before any query does not throw', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
    const svc = new DatabaseService();
    await expect(svc.close()).resolves.not.toThrow();
  });

  it('multiple close() calls do not throw', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
    const svc = new DatabaseService();
    await svc.close();
    await expect(svc.close()).resolves.not.toThrow();
    await expect(svc.close()).resolves.not.toThrow();
  });
});

// ── DatabaseService.prisma getter ─────────────────────────────────────────────

describe('DatabaseService.prisma', () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it('returns the same instance on repeated accesses (lazy singleton)', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
    const svc = new DatabaseService();
    const p1 = svc.prisma;
    const p2 = svc.prisma;
    expect(p1).toBe(p2); // same reference
  });

  it('prisma instance has $disconnect method', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
    const svc = new DatabaseService();
    const p = svc.prisma as Record<string, unknown>;
    expect(typeof p['$disconnect']).toBe('function');
  });

  it('close() clears cached prisma instance (new access creates fresh one)', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
    const svc = new DatabaseService();
    const p1 = svc.prisma;
    await svc.close();
    const p2 = svc.prisma;
    // After close, a new instance is created
    expect(p2).not.toBe(p1);
  });
});

// ── NeonManagementClient — getBranchConnectionUri / createDatabase / deleteDatabase ──

describe('NeonManagementClient — untested methods', () => {
  const mockFetch = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  function mockResponse(body: unknown, status = 200) {
    mockFetch.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }

  const client = new NeonManagementClient('test-api-key', 'proj-abc');

  it('getBranchConnectionUri makes GET to project-level connection_uri endpoint', async () => {
    mockResponse({ uri: 'postgresql://role:pass@ep-test.neon.tech/mydb' });
    const uri = await client.getBranchConnectionUri('br-1', 'mydb', 'myrole');
    expect(uri).toBe('postgresql://role:pass@ep-test.neon.tech/mydb');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/connection_uri?branch_id=br-1'),
      expect.objectContaining({ method: 'GET' }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('database_name=mydb'),
      expect.anything(),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('role_name=myrole'),
      expect.anything(),
    );
  });

  it('getBranchConnectionUri URL-encodes database name', async () => {
    mockResponse({ uri: 'postgresql://role:pass@ep-test.neon.tech/my%20db' });
    await client.getBranchConnectionUri('br-1', 'my db', 'role');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('database_name=my%20db'),
      expect.anything(),
    );
  });

  it('createDatabase makes POST with name and owner_name', async () => {
    mockResponse({
      database: {
        id: 42,
        branch_id: 'br-1',
        name: 'newdb',
        owner_name: 'admin',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      },
    });
    const db = await client.createDatabase('br-1', 'newdb', 'admin');
    expect(db.name).toBe('newdb');
    expect(db.ownerName).toBe('admin');
    expect(db.branchId).toBe('br-1');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/branches/br-1/databases'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('deleteDatabase makes DELETE to correct URL', async () => {
    mockResponse({});
    await client.deleteDatabase('br-1', 'mydb');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/branches/br-1/databases/mydb'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('deleteDatabase URL-encodes database name with special chars', async () => {
    mockResponse({});
    await client.deleteDatabase('br-1', 'my db');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/databases/my%20db'),
      expect.anything(),
    );
  });
});
