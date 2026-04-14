/**
 * Tests for src/database/neon-management.ts
 * Covers: NeonManagementClient CRUD operations (projects, branches, databases, endpoints).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NeonManagementClient } from '../src/database/neon-management';
import { DatabaseError } from '../src/database/types';

afterEach(() => vi.unstubAllGlobals());

// ── Helper ────────────────────────────────────────────────────────────────────

function makeClient(): NeonManagementClient {
  return new NeonManagementClient('api-key-123', 'proj-abc');
}

function mockFetch(body: unknown, ok = true, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    statusText: ok ? 'OK' : 'Error',
  })));
}

// ── listProjects ──────────────────────────────────────────────────────────────

describe('listProjects()', () => {
  it('returns mapped project list', async () => {
    mockFetch({
      projects: [
        { id: 'p1', name: 'My Project', region_id: 'us-east-2', created_at: '2024-01-01', updated_at: '2024-01-02' },
      ],
    });

    const client = makeClient();
    const projects = await client.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toEqual({
      id: 'p1',
      name: 'My Project',
      regionId: 'us-east-2',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-02',
    });
  });

  it('returns empty array when no projects', async () => {
    mockFetch({ projects: [] });
    const client = makeClient();
    const projects = await client.listProjects();
    expect(projects).toEqual([]);
  });

  it('throws DatabaseError on non-ok response', async () => {
    mockFetch({ message: 'Unauthorized' }, false, 401);
    const client = makeClient();
    await expect(client.listProjects()).rejects.toThrow(DatabaseError);
  });

  it('sends Authorization header', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ projects: [] }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = makeClient();
    await client.listProjects();
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer api-key-123');
  });
});

// ── getProject ────────────────────────────────────────────────────────────────

describe('getProject()', () => {
  it('returns the project for the configured projectId', async () => {
    mockFetch({
      project: { id: 'proj-abc', name: 'Test', region_id: 'eu-central-1', created_at: '2024-01-01', updated_at: '2024-01-02' },
    });

    const client = makeClient();
    const project = await client.getProject();
    expect(project.id).toBe('proj-abc');
    expect(project.regionId).toBe('eu-central-1');
  });

  it('includes projectId in URL', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ project: { id: 'proj-abc', name: 'T', region_id: 'r', created_at: '', updated_at: '' } }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = makeClient();
    await client.getProject();
    expect(fetchSpy.mock.calls[0][0]).toContain('proj-abc');
  });
});

// ── listBranches ──────────────────────────────────────────────────────────────

describe('listBranches()', () => {
  it('returns mapped branch list', async () => {
    mockFetch({
      branches: [
        { id: 'br-1', project_id: 'proj-abc', name: 'main', primary: true, created_at: '2024-01-01', updated_at: '2024-01-02' },
        { id: 'br-2', project_id: 'proj-abc', name: 'dev', primary: false, created_at: '2024-02-01', updated_at: '2024-02-02', parent_id: 'br-1' },
      ],
    });

    const client = makeClient();
    const branches = await client.listBranches();
    expect(branches).toHaveLength(2);
    expect(branches[0].name).toBe('main');
    expect(branches[0].primary).toBe(true);
    expect(branches[1].parentId).toBe('br-1');
  });

  it('maps parentTimestamp when present', async () => {
    mockFetch({
      branches: [
        { id: 'br-1', project_id: 'p', name: 'test', primary: false, created_at: '', updated_at: '', parent_id: 'br-0', parent_timestamp: '2024-01-01T00:00:00Z' },
      ],
    });
    const client = makeClient();
    const [branch] = await client.listBranches();
    expect(branch.parentTimestamp).toBe('2024-01-01T00:00:00Z');
  });
});

// ── createBranch ──────────────────────────────────────────────────────────────

describe('createBranch()', () => {
  it('returns created branch', async () => {
    mockFetch({
      branch: { id: 'br-new', project_id: 'proj-abc', name: 'feature', primary: false, created_at: '2024-03-01', updated_at: '2024-03-01' },
    });

    const client = makeClient();
    const branch = await client.createBranch('feature');
    expect(branch.id).toBe('br-new');
    expect(branch.name).toBe('feature');
  });

  it('includes parent_id in request body when provided', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ branch: { id: 'br-new', project_id: 'p', name: 'n', primary: false, created_at: '', updated_at: '' } }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = makeClient();
    await client.createBranch('feature', 'br-parent');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.branch.parent_id).toBe('br-parent');
  });

  it('includes read_write endpoint in request body', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ branch: { id: 'b', project_id: 'p', name: 'n', primary: false, created_at: '', updated_at: '' } }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = makeClient();
    await client.createBranch('test');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.endpoints).toEqual([{ type: 'read_write' }]);
  });

  it('throws DatabaseError on failure', async () => {
    mockFetch({ message: 'Branch limit exceeded' }, false, 422);
    const client = makeClient();
    await expect(client.createBranch('too-many')).rejects.toThrow(DatabaseError);
  });
});

// ── deleteBranch ──────────────────────────────────────────────────────────────

describe('deleteBranch()', () => {
  it('calls DELETE on the correct endpoint', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = makeClient();
    await client.deleteBranch('br-to-delete');
    expect(fetchSpy.mock.calls[0][0]).toContain('br-to-delete');
    expect(fetchSpy.mock.calls[0][1].method).toBe('DELETE');
  });

  it('throws on error', async () => {
    mockFetch({ message: 'Not found' }, false, 404);
    const client = makeClient();
    await expect(client.deleteBranch('no-such-branch')).rejects.toThrow(DatabaseError);
  });
});

// ── getBranchConnectionUri ────────────────────────────────────────────────────

describe('getBranchConnectionUri()', () => {
  it('returns the connection URI', async () => {
    mockFetch({ uri: 'postgresql://user:pass@host/db' });
    const client = makeClient();
    const uri = await client.getBranchConnectionUri('br-1', 'mydb', 'myrole');
    expect(uri).toBe('postgresql://user:pass@host/db');
  });

  it('encodes parameters in URL', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ uri: 'postgresql://host/db' }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = makeClient();
    await client.getBranchConnectionUri('br-1', 'my db', 'my role');
    expect(fetchSpy.mock.calls[0][0]).toContain('my%20db');
    expect(fetchSpy.mock.calls[0][0]).toContain('my%20role');
  });
});

// ── listDatabases ─────────────────────────────────────────────────────────────

describe('listDatabases()', () => {
  it('returns mapped database list', async () => {
    mockFetch({
      databases: [
        { id: 1, branch_id: 'br-1', name: 'mydb', owner_name: 'admin', created_at: '2024-01-01', updated_at: '2024-01-02' },
      ],
    });
    const client = makeClient();
    const dbs = await client.listDatabases('br-1');
    expect(dbs).toHaveLength(1);
    expect(dbs[0]).toEqual({
      id: 1,
      branchId: 'br-1',
      name: 'mydb',
      ownerName: 'admin',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-02',
    });
  });
});

// ── createDatabase ────────────────────────────────────────────────────────────

describe('createDatabase()', () => {
  it('returns created database', async () => {
    mockFetch({
      database: { id: 2, branch_id: 'br-1', name: 'newdb', owner_name: 'dev', created_at: '2024-03-01', updated_at: '2024-03-01' },
    });
    const client = makeClient();
    const db = await client.createDatabase('br-1', 'newdb', 'dev');
    expect(db.name).toBe('newdb');
    expect(db.ownerName).toBe('dev');
  });

  it('sends correct body', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ database: { id: 1, branch_id: 'b', name: 'n', owner_name: 'o', created_at: '', updated_at: '' } }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = makeClient();
    await client.createDatabase('br-1', 'testdb', 'testowner');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.database).toEqual({ name: 'testdb', owner_name: 'testowner' });
  });
});

// ── deleteDatabase ────────────────────────────────────────────────────────────

describe('deleteDatabase()', () => {
  it('sends DELETE request with encoded name', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = makeClient();
    await client.deleteDatabase('br-1', 'my db');
    expect(fetchSpy.mock.calls[0][0]).toContain('my%20db');
    expect(fetchSpy.mock.calls[0][1].method).toBe('DELETE');
  });
});

// ── listEndpoints ─────────────────────────────────────────────────────────────

describe('listEndpoints()', () => {
  it('returns mapped endpoints', async () => {
    mockFetch({
      endpoints: [
        { id: 'ep-1', project_id: 'proj-abc', branch_id: 'br-1', type: 'read_write', host: 'host.neon.tech', created_at: '2024-01-01', updated_at: '2024-01-02' },
        { id: 'ep-2', project_id: 'proj-abc', branch_id: 'br-1', type: 'read_only', host: 'ro.neon.tech', created_at: '2024-01-01', updated_at: '2024-01-02' },
      ],
    });
    const client = makeClient();
    const endpoints = await client.listEndpoints();
    expect(endpoints).toHaveLength(2);
    expect(endpoints[0].type).toBe('read_write');
    expect(endpoints[1].type).toBe('read_only');
    expect(endpoints[0].host).toBe('host.neon.tech');
  });

  it('returns empty array when no endpoints', async () => {
    mockFetch({ endpoints: [] });
    const client = makeClient();
    const endpoints = await client.listEndpoints();
    expect(endpoints).toEqual([]);
  });
});

// ── error handling ────────────────────────────────────────────────────────────

describe('error handling', () => {
  it('DatabaseError has NEON_API_ERROR code', async () => {
    mockFetch('Internal Server Error', false, 500);
    const client = makeClient();
    try {
      await client.listProjects();
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DatabaseError);
      expect((e as DatabaseError).code).toBe('NEON_API_ERROR');
    }
  });

  it('error message includes HTTP status', async () => {
    mockFetch('Bad Request', false, 400);
    const client = makeClient();
    try {
      await client.listProjects();
    } catch (e) {
      expect((e as Error).message).toContain('400');
    }
  });
});
