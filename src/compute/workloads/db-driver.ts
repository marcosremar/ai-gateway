/**
 * DbWorkloadDriver — managed PostgreSQL (Neon) as a first-class workload.
 *
 * Two provisioning modes:
 *
 * 1. CREATE mode (default): deploy() calls Neon's createProject API to
 *    provision a brand-new database. terminate() deletes it permanently.
 *    This is the "Firestore-like" mode — a real product offered to users.
 *
 * 2. ADOPT mode: when DbWorkloadConfig.projectId is supplied, deploy() just
 *    tracks an existing Neon project. terminate() only removes local tracking;
 *    the DB continues to exist independently.
 *
 * Lifecycle:
 *   deploy()    → CREATE: provision new project | ADOPT: verify existing
 *   stop()      → suspend compute endpoint (Neon auto-suspends anyway)
 *   start()     → wake endpoint by listing it (connection causes wake)
 *   terminate() → CREATE: deleteProject | ADOPT: untrack only
 *   status()    → refresh endpoint info from Neon API
 */

import type { Workload, WorkloadConfig, WorkloadDriver, DbWorkloadConfig } from './types';
import { WorkloadRegistry } from './registry';
import { NeonManagementClient } from '../../database/neon-management';

/** Metadata fields persisted on the Workload record for DB workloads. */
interface DbWorkloadMetadata extends Record<string, unknown> {
  projectId: string;
  projectName: string;
  regionId: string;
  endpointId: string;
  endpointHost: string;
  branchId: string;
  databaseName: string;
  roleName: string;
  /** True when this gateway CREATED the project (so terminate deletes it). */
  ownedByGateway: boolean;
  /** ONLY present when ownedByGateway: default role password returned by Neon at creation time. */
  rolePassword?: string;
}

export class DbWorkloadDriver implements WorkloadDriver {
  readonly type = 'db' as const;

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async deploy(name: string, config: WorkloadConfig): Promise<Workload> {
    const cfg = config as DbWorkloadConfig;
    const apiKey = cfg.apiKey || process.env.NEON_API_KEY || '';

    if (!apiKey) {
      throw new Error('NEON_API_KEY required for database workload (env var or config.apiKey)');
    }

    // ADOPT mode — projectId provided: track an existing Neon project
    if (cfg.projectId) {
      return this.adoptExistingProject(name, apiKey, cfg.projectId, cfg.connectionString);
    }

    // CREATE mode — provision a new Neon project
    return this.createNewProject(name, apiKey, cfg);
  }

  private async createNewProject(
    name: string,
    apiKey: string,
    cfg: DbWorkloadConfig,
  ): Promise<Workload> {
    const neon = new NeonManagementClient(apiKey);

    const result = await neon.createProject({
      name: cfg.projectName || name,
      regionId: cfg.regionId,
      pgVersion: cfg.pgVersion,
      // Free-tier friendly defaults
      autoscalingMinCu: cfg.autoscalingMinCu ?? 0.25,
      autoscalingMaxCu: cfg.autoscalingMaxCu ?? 2,
      suspendTimeoutSeconds: cfg.suspendTimeoutSeconds ?? 0,
    });

    const now = Date.now();
    const metadata: DbWorkloadMetadata = {
      projectId: result.project.id,
      projectName: result.project.name,
      regionId: result.project.regionId,
      endpointId: result.endpoint?.id ?? '',
      endpointHost: result.endpoint?.host ?? '',
      branchId: result.branch?.id ?? '',
      databaseName: result.databaseName,
      roleName: result.roleName,
      ownedByGateway: true,
      rolePassword: result.rolePassword,
    };

    return {
      id: WorkloadRegistry.newId(),
      type: 'db',
      name,
      status: 'running',
      provider: 'neon',
      endpoint: result.connectionUri,
      costPerHr: 0,
      instanceId: result.project.id,
      metadata,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async adoptExistingProject(
    name: string,
    apiKey: string,
    projectId: string,
    connectionStringOverride?: string,
  ): Promise<Workload> {
    const neon = new NeonManagementClient(apiKey, projectId);
    const project = await neon.getProject();
    const endpoints = await neon.listEndpoints();
    const rwEndpoint = endpoints.find((e) => e.type === 'read_write');

    const now = Date.now();
    const metadata: DbWorkloadMetadata = {
      projectId,
      projectName: project.name,
      regionId: project.regionId,
      endpointId: rwEndpoint?.id ?? '',
      endpointHost: rwEndpoint?.host ?? '',
      branchId: rwEndpoint?.branchId ?? '',
      databaseName: 'neondb',
      roleName: '',
      ownedByGateway: false,
    };

    return {
      id: WorkloadRegistry.newId(),
      type: 'db',
      name,
      status: 'running',
      provider: 'neon',
      endpoint: rwEndpoint
        ? `postgresql://${rwEndpoint.host}`
        : connectionStringOverride ?? '',
      costPerHr: 0,
      instanceId: projectId,
      metadata,
      createdAt: now,
      updatedAt: now,
    };
  }

  async stop(workload: Workload): Promise<Workload> {
    // Neon auto-suspends after idle. There's no explicit "stop" API for the
    // serverless endpoint, so this is a state marker.
    return {
      ...workload,
      status: 'stopped',
      updatedAt: Date.now(),
    };
  }

  async start(workload: Workload): Promise<Workload> {
    // Neon wakes on connection — verify we can reach it by refreshing endpoint info.
    const apiKey = process.env.NEON_API_KEY || '';
    const meta = workload.metadata as DbWorkloadMetadata;

    if (!apiKey || !meta.projectId) {
      return { ...workload, status: 'running', updatedAt: Date.now() };
    }

    const neon = new NeonManagementClient(apiKey, meta.projectId);
    const endpoints = await neon.listEndpoints();
    const rwEndpoint = endpoints.find((e) => e.type === 'read_write');

    return {
      ...workload,
      status: 'running',
      endpoint: rwEndpoint ? `postgresql://${rwEndpoint.host}` : workload.endpoint,
      updatedAt: Date.now(),
    };
  }

  async terminate(workload: Workload): Promise<void> {
    const meta = workload.metadata as DbWorkloadMetadata;
    const apiKey = process.env.NEON_API_KEY || '';

    // ADOPT mode — only untrack. The DB continues to exist independently.
    if (!meta.ownedByGateway) {
      console.log(
        `[workloads:db] Untracked "${workload.name}" (project ${meta.projectId}) — Neon project preserved`,
      );
      return;
    }

    // CREATE mode — permanently delete the Neon project.
    if (!apiKey) {
      throw new Error(
        `Cannot delete owned project ${meta.projectId}: NEON_API_KEY not set`,
      );
    }

    const neon = new NeonManagementClient(apiKey);
    await neon.deleteProject(meta.projectId);
    console.log(
      `[workloads:db] Deleted Neon project ${meta.projectId} (${workload.name})`,
    );
  }

  async status(workload: Workload): Promise<Workload> {
    const apiKey = process.env.NEON_API_KEY || '';
    const meta = workload.metadata as DbWorkloadMetadata;

    if (!apiKey || !meta.projectId) {
      return { ...workload, updatedAt: Date.now() };
    }

    try {
      const neon = new NeonManagementClient(apiKey, meta.projectId);
      const project = await neon.getProject();
      const endpoints = await neon.listEndpoints();
      const rwEndpoint = endpoints.find((e) => e.type === 'read_write');

      return {
        ...workload,
        status: 'running',
        endpoint: rwEndpoint
          ? `postgresql://${rwEndpoint.host}`
          : workload.endpoint,
        updatedAt: Date.now(),
        metadata: {
          ...workload.metadata,
          projectName: project.name,
          endpointId: rwEndpoint?.id || meta.endpointId,
          endpointHost: rwEndpoint?.host || meta.endpointHost,
        },
      };
    } catch (err) {
      return {
        ...workload,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        updatedAt: Date.now(),
      };
    }
  }
}
