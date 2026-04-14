/**
 * DB Workload — end-to-end provisioning tests (CREATE and ADOPT modes).
 *
 * Uses a mocked fetch to stand in for the Neon Management API so we can
 * exercise the full lifecycle: create → status → stop → start → terminate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DbWorkloadDriver } from '../src/workloads/db-driver';
import type { DbWorkloadConfig } from '../src/workloads/types';

type FetchMock = ReturnType<typeof vi.fn>;

function mockNeonFetch(): FetchMock {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    // POST /projects — createProject
    if (method === 'POST' && url === 'https://console.neon.tech/api/v2/projects') {
      return new Response(
        JSON.stringify({
          project: {
            id: 'prj_new_abc123',
            name: 'test-db',
            region_id: 'aws-us-east-1',
            created_at: '2026-04-14T00:00:00Z',
            updated_at: '2026-04-14T00:00:00Z',
          },
          connection_uris: [
            {
              connection_uri:
                'postgresql://neondb_owner:secret@ep-foo-123.us-east-1.aws.neon.tech/neondb?sslmode=require',
            },
          ],
          roles: [{ name: 'neondb_owner', password: 'secret' }],
          databases: [
            {
              id: 1,
              branch_id: 'br_main_xyz',
              name: 'neondb',
              owner_name: 'neondb_owner',
              created_at: '2026-04-14T00:00:00Z',
              updated_at: '2026-04-14T00:00:00Z',
            },
          ],
          endpoints: [
            {
              id: 'ep-foo-123',
              project_id: 'prj_new_abc123',
              branch_id: 'br_main_xyz',
              type: 'read_write',
              host: 'ep-foo-123.us-east-1.aws.neon.tech',
              created_at: '2026-04-14T00:00:00Z',
              updated_at: '2026-04-14T00:00:00Z',
            },
          ],
          branch: {
            id: 'br_main_xyz',
            project_id: 'prj_new_abc123',
            name: 'main',
            primary: true,
            created_at: '2026-04-14T00:00:00Z',
            updated_at: '2026-04-14T00:00:00Z',
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // DELETE /projects/:id — deleteProject
    if (method === 'DELETE' && /\/projects\/prj_[a-zA-Z0-9_]+$/.test(url)) {
      return new Response(JSON.stringify({ project: { id: 'prj_new_abc123' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /projects/:id — getProject (for adopt mode)
    if (method === 'GET' && /\/projects\/prj_existing_xyz$/.test(url)) {
      return new Response(
        JSON.stringify({
          project: {
            id: 'prj_existing_xyz',
            name: 'legacy-db',
            region_id: 'aws-eu-central-1',
            created_at: '2025-01-01T00:00:00Z',
            updated_at: '2025-01-01T00:00:00Z',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // GET /projects/:id/endpoints — listEndpoints
    if (method === 'GET' && /\/projects\/[a-zA-Z0-9_]+\/endpoints$/.test(url)) {
      return new Response(
        JSON.stringify({
          endpoints: [
            {
              id: 'ep-foo-123',
              project_id: url.match(/projects\/([^/]+)/)![1],
              branch_id: 'br_main_xyz',
              type: 'read_write',
              host: 'ep-foo-123.us-east-1.aws.neon.tech',
              created_at: '2026-04-14T00:00:00Z',
              updated_at: '2026-04-14T00:00:00Z',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    throw new Error(`Unmocked Neon API call: ${method} ${url}`);
  });
}

describe('DbWorkloadDriver — CREATE mode (provisions new Neon project)', () => {
  const driver = new DbWorkloadDriver();
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = mockNeonFetch();
    vi.stubGlobal('fetch', fetchMock);
    process.env.NEON_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a new Neon project when projectId is not provided', async () => {
    const config: DbWorkloadConfig = {
      type: 'db',
      projectName: 'test-db',
      regionId: 'aws-us-east-1',
    };

    const workload = await driver.deploy('test-db', config);

    expect(workload.type).toBe('db');
    expect(workload.status).toBe('running');
    expect(workload.provider).toBe('neon');
    expect(workload.instanceId).toBe('prj_new_abc123');
    expect(workload.endpoint).toContain('postgresql://');
    expect(workload.endpoint).toContain('neondb');

    const meta = workload.metadata as Record<string, unknown>;
    expect(meta.ownedByGateway).toBe(true);
    expect(meta.projectId).toBe('prj_new_abc123');
    expect(meta.databaseName).toBe('neondb');
    expect(meta.roleName).toBe('neondb_owner');
    expect(meta.rolePassword).toBe('secret');
  });

  it('applies free-tier defaults (0.25-2 CU, suspendTimeout=0)', async () => {
    await driver.deploy('test-db', { type: 'db', projectName: 'x' });

    const createCall = fetchMock.mock.calls.find(
      ([u, init]) => init?.method === 'POST' && String(u).endsWith('/projects'),
    );
    expect(createCall).toBeDefined();
    const body = JSON.parse(createCall![1]!.body as string);
    expect(body.project.default_endpoint_settings).toMatchObject({
      autoscaling_limit_min_cu: 0.25,
      autoscaling_limit_max_cu: 2,
      suspend_timeout_seconds: 0,
    });
  });

  it('terminate() deletes the Neon project when ownedByGateway=true', async () => {
    const workload = await driver.deploy('test-db', { type: 'db' });
    await driver.terminate(workload);

    const deleteCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'DELETE',
    );
    expect(deleteCall).toBeDefined();
    expect(String(deleteCall![0])).toContain('/projects/prj_new_abc123');
  });

  it('throws without NEON_API_KEY', async () => {
    delete process.env.NEON_API_KEY;
    await expect(driver.deploy('test-db', { type: 'db' })).rejects.toThrow('NEON_API_KEY');
  });
});

describe('DbWorkloadDriver — ADOPT mode (tracks existing Neon project)', () => {
  const driver = new DbWorkloadDriver();
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = mockNeonFetch();
    vi.stubGlobal('fetch', fetchMock);
    process.env.NEON_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adopts an existing project when projectId is provided (no createProject call)', async () => {
    const workload = await driver.deploy('legacy-db', {
      type: 'db',
      projectId: 'prj_existing_xyz',
    });

    expect(workload.status).toBe('running');
    expect(workload.instanceId).toBe('prj_existing_xyz');

    const meta = workload.metadata as Record<string, unknown>;
    expect(meta.ownedByGateway).toBe(false);
    expect(meta.projectName).toBe('legacy-db');

    // Must NOT have called POST /projects
    const createCall = fetchMock.mock.calls.find(
      ([u, init]) =>
        init?.method === 'POST' && String(u).endsWith('/projects'),
    );
    expect(createCall).toBeUndefined();
  });

  it('terminate() does NOT delete the Neon project when ownedByGateway=false', async () => {
    const workload = await driver.deploy('legacy-db', {
      type: 'db',
      projectId: 'prj_existing_xyz',
    });

    fetchMock.mockClear();
    await driver.terminate(workload);

    const deleteCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'DELETE',
    );
    expect(deleteCall).toBeUndefined();
  });
});
