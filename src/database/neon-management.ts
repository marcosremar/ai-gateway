/**
 * Neon Management API client — create/list/delete projects, branches, databases, endpoints.
 * Docs: https://api-docs.neon.tech/reference/getting-started-with-neon-api
 */

import type { NeonProject, NeonBranch, NeonDatabase, NeonEndpoint, NeonProjectCreateOptions, NeonProjectCreateResult } from './types';
import { DatabaseError } from './types';

const NEON_API_BASE = 'https://console.neon.tech/api/v2';

export class NeonManagementClient {
  private apiKey: string;
  private projectId: string;

  /**
   * Construct a client. projectId is required for project-scoped operations
   * (branches, databases, endpoints) but can be empty for account-scoped
   * operations (createProject, listProjects).
   */
  constructor(apiKey: string, projectId: string = '') {
    this.apiKey = apiKey;
    this.projectId = projectId;
  }

  /** Returns a new client scoped to the given projectId, reusing the same API key. */
  forProject(projectId: string): NeonManagementClient {
    return new NeonManagementClient(this.apiKey, projectId);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${NEON_API_BASE}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new DatabaseError(
        `Neon API ${method} ${path} failed with ${res.status}: ${text}`,
        'NEON_API_ERROR',
      );
    }

    return res.json() as Promise<T>;
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  async listProjects(): Promise<NeonProject[]> {
    const data = await this.request<{ projects: RawProject[] }>('GET', '/projects');
    return data.projects.map(toProject);
  }

  async getProject(): Promise<NeonProject> {
    if (!this.projectId) {
      throw new DatabaseError('getProject() requires a projectId on the client', 'NEON_MISSING_PROJECT_ID');
    }
    const data = await this.request<{ project: RawProject }>('GET', `/projects/${this.projectId}`);
    return toProject(data.project);
  }

  /**
   * Create a new Neon project (the database).
   * Returns the project plus the connection_uri for the default database.
   *
   * Docs: https://api-docs.neon.tech/reference/createproject
   *
   * Defaults (when options omitted):
   * - pgVersion: Neon default (17 at time of writing)
   * - regionId: aws-us-east-1
   * - autoscaling: 0.25 → 2 CU
   * - suspendTimeoutSeconds: 0 (immediate suspend on idle — free tier friendly)
   */
  async createProject(options: NeonProjectCreateOptions = {}): Promise<NeonProjectCreateResult> {
    const projectSpec: Record<string, unknown> = {};
    if (options.name) projectSpec.name = options.name;
    if (options.regionId) projectSpec.region_id = options.regionId;
    if (options.pgVersion !== undefined) projectSpec.pg_version = options.pgVersion;

    // Autoscaling & suspend defaults tuned for free tier
    const endpointSettings: Record<string, unknown> = {};
    if (options.autoscalingMinCu !== undefined) endpointSettings.autoscaling_limit_min_cu = options.autoscalingMinCu;
    if (options.autoscalingMaxCu !== undefined) endpointSettings.autoscaling_limit_max_cu = options.autoscalingMaxCu;
    if (options.suspendTimeoutSeconds !== undefined) endpointSettings.suspend_timeout_seconds = options.suspendTimeoutSeconds;
    if (Object.keys(endpointSettings).length > 0) {
      projectSpec.default_endpoint_settings = endpointSettings;
    }

    const data = await this.request<{
      project: RawProject;
      connection_uris?: Array<{ connection_uri: string; connection_parameters?: Record<string, string> }>;
      roles?: Array<{ name: string; password?: string }>;
      databases?: RawDatabase[];
      endpoints?: RawEndpoint[];
      branch?: RawBranch;
    }>('POST', '/projects', { project: projectSpec });

    const project = toProject(data.project);
    const connectionUri = data.connection_uris?.[0]?.connection_uri ?? '';
    const roleName = data.roles?.[0]?.name ?? '';
    const rolePassword = data.roles?.[0]?.password ?? '';
    const databaseName = data.databases?.[0]?.name ?? 'neondb';
    const endpoint = data.endpoints?.[0] ? toEndpoint(data.endpoints[0]) : undefined;
    const branch = data.branch ? toBranch(data.branch) : undefined;

    return { project, connectionUri, roleName, rolePassword, databaseName, endpoint, branch };
  }

  /**
   * Permanently delete a Neon project. Irreversible.
   * Operates on a given projectId (does NOT require the client to be scoped to one).
   */
  async deleteProject(projectId: string): Promise<void> {
    await this.request('DELETE', `/projects/${projectId}`);
  }

  // ── Branches ──────────────────────────────────────────────────────────────

  async listBranches(): Promise<NeonBranch[]> {
    const data = await this.request<{ branches: RawBranch[] }>(
      'GET',
      `/projects/${this.projectId}/branches`,
    );
    return data.branches.map(toBranch);
  }

  async createBranch(name: string, parentId?: string): Promise<NeonBranch> {
    const branchSpec: Record<string, unknown> = { name };
    if (parentId) branchSpec.parent_id = parentId;
    // Include a read-write compute endpoint so the branch is immediately usable
    // (required for createDatabase, getBranchConnectionUri, and SQL connections)
    const body: Record<string, unknown> = {
      branch: branchSpec,
      endpoints: [{ type: 'read_write' }],
    };
    const data = await this.request<{ branch: RawBranch }>(
      'POST',
      `/projects/${this.projectId}/branches`,
      body,
    );
    return toBranch(data.branch);
  }

  async deleteBranch(branchId: string): Promise<void> {
    await this.request('DELETE', `/projects/${this.projectId}/branches/${branchId}`);
  }

  async getBranchConnectionUri(
    branchId: string,
    databaseName: string,
    roleName: string,
  ): Promise<string> {
    // Project-level endpoint: GET /projects/{id}/connection_uri?branch_id=...
    const data = await this.request<{ uri: string }>(
      'GET',
      `/projects/${this.projectId}/connection_uri?branch_id=${encodeURIComponent(branchId)}&database_name=${encodeURIComponent(databaseName)}&role_name=${encodeURIComponent(roleName)}`,
    );
    return data.uri;
  }

  // ── Databases ─────────────────────────────────────────────────────────────

  async listDatabases(branchId: string): Promise<NeonDatabase[]> {
    const data = await this.request<{ databases: RawDatabase[] }>(
      'GET',
      `/projects/${this.projectId}/branches/${branchId}/databases`,
    );
    return data.databases.map(toDatabase);
  }

  async createDatabase(branchId: string, name: string, ownerName: string): Promise<NeonDatabase> {
    const data = await this.request<{ database: RawDatabase }>(
      'POST',
      `/projects/${this.projectId}/branches/${branchId}/databases`,
      { database: { name, owner_name: ownerName } },
    );
    return toDatabase(data.database);
  }

  async deleteDatabase(branchId: string, databaseName: string): Promise<void> {
    await this.request(
      'DELETE',
      `/projects/${this.projectId}/branches/${branchId}/databases/${encodeURIComponent(databaseName)}`,
    );
  }

  // ── Endpoints ─────────────────────────────────────────────────────────────

  async listEndpoints(): Promise<NeonEndpoint[]> {
    const data = await this.request<{ endpoints: RawEndpoint[] }>(
      'GET',
      `/projects/${this.projectId}/endpoints`,
    );
    return data.endpoints.map(toEndpoint);
  }
}

// ── Raw API types (snake_case) ────────────────────────────────────────────────

interface RawProject {
  id: string;
  name: string;
  region_id: string;
  created_at: string;
  updated_at: string;
}

interface RawBranch {
  id: string;
  project_id: string;
  name: string;
  primary: boolean;
  created_at: string;
  updated_at: string;
  parent_id?: string;
  parent_timestamp?: string;
}

interface RawDatabase {
  id: number;
  branch_id: string;
  name: string;
  owner_name: string;
  created_at: string;
  updated_at: string;
}

interface RawEndpoint {
  id: string;
  project_id: string;
  branch_id: string;
  type: 'read_write' | 'read_only';
  host: string;
  created_at: string;
  updated_at: string;
}

// ── Mappers ──────────────────────────────────────────────────────────────────

function toProject(r: RawProject): NeonProject {
  return { id: r.id, name: r.name, regionId: r.region_id, createdAt: r.created_at, updatedAt: r.updated_at };
}

function toBranch(r: RawBranch): NeonBranch {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    primary: r.primary,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    parentId: r.parent_id,
    parentTimestamp: r.parent_timestamp,
  };
}

function toDatabase(r: RawDatabase): NeonDatabase {
  return {
    id: r.id,
    branchId: r.branch_id,
    name: r.name,
    ownerName: r.owner_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toEndpoint(r: RawEndpoint): NeonEndpoint {
  return {
    id: r.id,
    projectId: r.project_id,
    branchId: r.branch_id,
    type: r.type,
    host: r.host,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
