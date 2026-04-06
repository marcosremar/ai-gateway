/**
 * DbWorkloadDriver — manages PostgreSQL (Neon) as a workload.
 *
 * "Deploy" = verify connection & fetch project info from Neon API.
 * "Stop"   = suspend the Neon compute endpoint (serverless auto-suspends anyway).
 * "Start"  = wake endpoint by issuing a connection.
 * "Terminate" = disconnect (does NOT delete the Neon project).
 */

import type { Workload, WorkloadConfig, WorkloadDriver, DbWorkloadConfig } from './types';
import { WorkloadRegistry } from './registry';
import { NeonManagementClient } from '../database/neon-management';

export class DbWorkloadDriver implements WorkloadDriver {
  readonly type = 'db' as const;

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async deploy(name: string, config: WorkloadConfig): Promise<Workload> {
    const cfg = config as DbWorkloadConfig;
    const apiKey = cfg.apiKey || process.env.NEON_API_KEY || '';
    const projectId = cfg.projectId || process.env.NEON_PROJECT_ID || '';

    if (!apiKey || !projectId) {
      throw new Error('NEON_API_KEY and NEON_PROJECT_ID required for database workload');
    }

    const neon = new NeonManagementClient(apiKey, projectId);
    const project = await neon.getProject();
    const endpoints = await neon.listEndpoints();
    const rwEndpoint = endpoints.find((e) => e.type === 'read_write');

    const now = Date.now();
    return {
      id: WorkloadRegistry.newId(),
      type: 'db',
      name,
      status: 'running',
      provider: 'neon',
      endpoint: rwEndpoint ? `postgresql://${rwEndpoint.host}` : cfg.connectionString || '',
      costPerHr: 0, // Neon free tier / serverless billing
      instanceId: projectId,
      metadata: {
        projectId,
        projectName: project.name,
        regionId: project.regionId,
        endpointId: rwEndpoint?.id || '',
        endpointHost: rwEndpoint?.host || '',
        branchId: rwEndpoint?.branchId || '',
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  async stop(workload: Workload): Promise<Workload> {
    // Neon auto-suspends after idle — this is a no-op marker
    return {
      ...workload,
      status: 'stopped',
      updatedAt: Date.now(),
    };
  }

  async start(workload: Workload): Promise<Workload> {
    // Neon wakes on connection — just verify we can reach it
    const apiKey = process.env.NEON_API_KEY || '';
    const projectId = workload.metadata.projectId as string;

    if (apiKey && projectId) {
      const neon = new NeonManagementClient(apiKey, projectId);
      const endpoints = await neon.listEndpoints();
      const rwEndpoint = endpoints.find((e) => e.type === 'read_write');
      return {
        ...workload,
        status: 'running',
        endpoint: rwEndpoint ? `postgresql://${rwEndpoint.host}` : workload.endpoint,
        updatedAt: Date.now(),
      };
    }

    return { ...workload, status: 'running', updatedAt: Date.now() };
  }

  async terminate(workload: Workload): Promise<void> {
    // We do NOT delete the Neon project — just remove the workload tracking.
    // The DB continues to exist independently.
    console.log(`[workloads:db] Removed DB workload "${workload.name}" (project ${workload.metadata.projectId})`);
  }

  async status(workload: Workload): Promise<Workload> {
    const apiKey = process.env.NEON_API_KEY || '';
    const projectId = workload.metadata.projectId as string;

    if (!apiKey || !projectId) {
      return { ...workload, updatedAt: Date.now() };
    }

    try {
      const neon = new NeonManagementClient(apiKey, projectId);
      const project = await neon.getProject();
      const endpoints = await neon.listEndpoints();
      const rwEndpoint = endpoints.find((e) => e.type === 'read_write');

      return {
        ...workload,
        status: 'running',
        endpoint: rwEndpoint ? `postgresql://${rwEndpoint.host}` : workload.endpoint,
        updatedAt: Date.now(),
        metadata: {
          ...workload.metadata,
          projectName: project.name,
          endpointId: rwEndpoint?.id || workload.metadata.endpointId,
          endpointHost: rwEndpoint?.host || workload.metadata.endpointHost,
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
