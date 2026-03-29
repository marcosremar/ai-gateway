/**
 * Integration tests for the database abstraction layer.
 *
 * Suites are auto-skipped when credentials are absent, so these can safely
 * run in CI — only test what is available in the current environment.
 *
 * Required env vars:
 *   HAS_LOCAL_PG  → DATABASE_URL pointing to local PostgreSQL
 *   HAS_NEON_DB   → DATABASE_URL pointing to Neon (HTTP queries)
 *   HAS_NEON_MGMT → NEON_API_KEY + NEON_PROJECT_ID (management API)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  detectEnvironment,
  buildConnectionConfig,
  DatabaseService,
  NeonManagementClient,
  DatabaseError,
} from '@ai-gateway/database/index';

// ── Load env files ─────────────────────────────────────────────────────────────

function loadEnvFile(filePath: string) {
  try {
    const content = readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !process.env[key]) process.env[key] = val;
    }
  } catch {
    // File not found — ignore
  }
}

const ROOT = join(__dirname, '..', '..', '..'); // workspace root
loadEnvFile(join(ROOT, '.env'));
loadEnvFile(join(ROOT, '.env.local'));
loadEnvFile(join(ROOT, '.env.vercel'));

// ── Capability flags ───────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const NEON_API_KEY = process.env.NEON_API_KEY ?? '';
const NEON_PROJECT_ID = process.env.NEON_PROJECT_ID ?? '';

const HAS_LOCAL_PG = !!DATABASE_URL && detectEnvironment(DATABASE_URL) === 'local';
const HAS_NEON_DB = !!DATABASE_URL && detectEnvironment(DATABASE_URL) === 'neon';
const HAS_NEON_MGMT = !!NEON_API_KEY && !!NEON_PROJECT_ID;

// ── Local PostgreSQL ───────────────────────────────────────────────────────────

describe.skipIf(!HAS_LOCAL_PG)('Local PostgreSQL — raw SQL', () => {
  let svc: DatabaseService;

  beforeAll(() => {
    svc = new DatabaseService();
  });

  afterAll(async () => {
    await svc.close();
  });

  it('executes a simple query', async () => {
    const result = await svc.query<{ val: string }>('SELECT 1::text AS val');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].val).toBe('1');
  });

  it('supports parameterized queries', async () => {
    const result = await svc.query<{ n: number }>(
      'SELECT $1::int AS n',
      [42],
    );
    expect(result.rows[0].n).toBe(42);
  });

  it('returns row count', async () => {
    const result = await svc.query('SELECT generate_series(1, 5)');
    expect(result.rowCount).toBe(5);
  });

  it('isNeon is false', () => {
    expect(svc.isNeon).toBe(false);
    expect(svc.environment).toBe('local');
  });
});

// ── Neon HTTP SQL ──────────────────────────────────────────────────────────────

describe.skipIf(!HAS_NEON_DB)('Neon — HTTP SQL queries', () => {
  let svc: DatabaseService;

  beforeAll(() => {
    svc = new DatabaseService();
  });

  afterAll(async () => {
    await svc.close();
  });

  it('executes a simple query over HTTP', async () => {
    const result = await svc.query<{ val: string }>('SELECT 1::text AS val');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].val).toBe('1');
  });

  it('isNeon is true', () => {
    expect(svc.isNeon).toBe(true);
    expect(svc.environment).toBe('neon');
  });

  it('handles errors gracefully', async () => {
    await expect(svc.query('SELECT * FROM nonexistent_table_xyz')).rejects.toThrow();
  });
});

// ── Neon Management API ────────────────────────────────────────────────────────

describe.skipIf(!HAS_NEON_MGMT)('Neon Management API', () => {
  const mgmt = new NeonManagementClient(NEON_API_KEY, NEON_PROJECT_ID);
  const testBranches: string[] = [];

  afterAll(async () => {
    // Clean up any test branches created during tests
    for (const branchId of testBranches) {
      try {
        await mgmt.deleteBranch(branchId);
      } catch {
        // Best-effort cleanup
      }
    }
  });

  it('fetches the project', async () => {
    const project = await mgmt.getProject();
    expect(project.id).toBe(NEON_PROJECT_ID);
    expect(project.name).toBeTruthy();
    expect(project.regionId).toBeTruthy();
  });

  it('lists existing branches', async () => {
    const branches = await mgmt.listBranches();
    expect(Array.isArray(branches)).toBe(true);
    expect(branches.length).toBeGreaterThan(0);

    const primary = branches.find((b) => b.primary);
    expect(primary).toBeDefined();
    expect(primary?.name).toBeTruthy();
  });

  it('lists endpoints', async () => {
    const endpoints = await mgmt.listEndpoints();
    expect(Array.isArray(endpoints)).toBe(true);
    expect(endpoints.length).toBeGreaterThan(0);
    expect(endpoints[0].host).toContain('neon.tech');
  });

  it('throws DatabaseError on invalid API key', async () => {
    const badClient = new NeonManagementClient('invalid-key', NEON_PROJECT_ID);
    await expect(badClient.getProject()).rejects.toThrow(DatabaseError);
  });
});

// ── Neon branch lifecycle ──────────────────────────────────────────────────────

describe.skipIf(!HAS_NEON_MGMT)('Neon branch lifecycle', () => {
  const mgmt = new NeonManagementClient(NEON_API_KEY, NEON_PROJECT_ID);
  let createdBranchId: string | undefined;

  afterAll(async () => {
    if (createdBranchId) {
      try {
        await mgmt.deleteBranch(createdBranchId);
      } catch {
        // Best-effort cleanup
      }
    }
  });

  it('creates a branch', async () => {
    const name = `test-branch-${Date.now()}`;
    const branch = await mgmt.createBranch(name);
    createdBranchId = branch.id;

    expect(branch.id).toBeTruthy();
    expect(branch.name).toBe(name);
    expect(branch.projectId).toBe(NEON_PROJECT_ID);
    expect(branch.primary).toBe(false);
  });

  it('lists databases on the new branch', async () => {
    if (!createdBranchId) return;
    const dbs = await mgmt.listDatabases(createdBranchId);
    expect(Array.isArray(dbs)).toBe(true);
    // Neon creates a default database on each branch
    expect(dbs.length).toBeGreaterThan(0);
  });

  it('deletes the branch', async () => {
    if (!createdBranchId) return;
    await expect(mgmt.deleteBranch(createdBranchId)).resolves.not.toThrow();
    createdBranchId = undefined;

    // Verify branch is gone
    const branches = await mgmt.listBranches();
    const found = branches.find((b) => b.name.startsWith('test-branch-'));
    expect(found).toBeUndefined();
  });
});

// ── DatabaseService management methods ───────────────────────────────────────

describe.skipIf(!HAS_NEON_MGMT)('DatabaseService — management via service', () => {
  let svc: DatabaseService;
  let createdBranchId: string | undefined;

  beforeAll(() => {
    svc = new DatabaseService({
      databaseUrl: DATABASE_URL,
      apiKey: NEON_API_KEY,
      projectId: NEON_PROJECT_ID,
    });
  });

  afterAll(async () => {
    if (createdBranchId) {
      try {
        await svc.deleteBranch(createdBranchId);
      } catch {
        // Best-effort cleanup
      }
    }
    await svc.close();
  });

  it('getProject works through the service', async () => {
    const project = await svc.getProject();
    expect(project.id).toBe(NEON_PROJECT_ID);
  });

  it('listBranches works through the service', async () => {
    const branches = await svc.listBranches();
    expect(branches.length).toBeGreaterThan(0);
  });

  it('createBranch and deleteBranch work through the service', async () => {
    const name = `svc-test-${Date.now()}`;
    const branch = await svc.createBranch(name);
    createdBranchId = branch.id;
    expect(branch.name).toBe(name);

    await svc.deleteBranch(branch.id);
    createdBranchId = undefined;

    const branches = await svc.listBranches();
    expect(branches.find((b) => b.id === branch.id)).toBeUndefined();
  });
});

// ── Neon branch backup ────────────────────────────────────────────────────────

describe.skipIf(!HAS_NEON_MGMT)('Neon branch backup', () => {
  let svc: DatabaseService;
  let backupBranchId: string | undefined;

  beforeAll(() => {
    svc = new DatabaseService({
      databaseUrl: DATABASE_URL,
      apiKey: NEON_API_KEY,
      projectId: NEON_PROJECT_ID,
    });
  });

  afterAll(async () => {
    if (backupBranchId) {
      try {
        await svc.deleteBranch(backupBranchId);
      } catch {
        // Best-effort cleanup
      }
    }
    await svc.close();
  });

  it('creates a branch backup', async () => {
    const result = await svc.backup({ label: `integration-test-backup-${Date.now()}` });
    backupBranchId = result.backup.data; // branch ID stored in data

    expect(result.backup.type).toBe('branch');
    expect(result.backup.id).toBeTruthy();
    expect(result.backup.data).toBeTruthy(); // branch ID
    expect(result.message).toContain('branch backup created');
  });

  it('restore from branch backup throws informative error', async () => {
    if (!backupBranchId) return;
    const result = await svc.backup({ label: `restore-test-${Date.now()}` });
    await expect(svc.restore(result.backup)).rejects.toThrow('cannot be restored automatically');
    // Cleanup this extra backup branch
    await svc.deleteBranch(result.backup.data).catch(() => {});
  });
});
