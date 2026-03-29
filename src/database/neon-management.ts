/**
 * Neon Management API client — create/list/delete projects, branches, databases, endpoints.
 * Docs: https://api-docs.neon.tech/reference/getting-started-with-neon-api
 */

import type { NeonProject, NeonBranch, NeonDatabase, NeonEndpoint } from './types';
import { DatabaseError } from './types';

const NEON_API_BASE = 'https://console.neon.tech/api/v2';

export class NeonManagementClient {
  private apiKey: string;
  private projectId: string;

  constructor(apiKey: string, projectId: string) {
    this.apiKey = apiKey;
    this.projectId = projectId;
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
    const data = await this.request<{ project: RawProject }>('GET', `/projects/${this.projectId}`);
    return toProject(data.project);
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
    const body: Record<string, unknown> = { branch: { name } };
    if (parentId) body.branch = { ...(body.branch as object), parent_id: parentId };
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
    const data = await this.request<{ uri: string }>(
      'GET',
      `/projects/${this.projectId}/branches/${branchId}/connection_uri?database_name=${encodeURIComponent(databaseName)}&role_name=${encodeURIComponent(roleName)}`,
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
