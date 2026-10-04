/**
 * Deployments: register a Docker image, get an autoscaled endpoint on Scaleway machines.
 * See `http.ts` for the API and `planner.ts` for the scaling rules.
 */

import { homedir } from 'os';
import { join } from 'path';
import type { IncomingMessage } from 'http';
import { DeploymentController } from './controller';
import { createDeploymentRoutes, HttpReplicaProbe } from './http';
import { ScalewayDeploymentBackend } from './scaleway-backend';
import { FileDeploymentStore } from './store';

export { DeploymentController, DeploymentError } from './controller';
export { createDeploymentRoutes, HttpReplicaProbe } from './http';
export { planReplicas, desiredReplicas } from './planner';
export { BUILTIN_PROFILES } from './profiles';
export { replicaCloudInit } from './cloud-init';
export { buildSpec, SpecError } from './spec';
export { ScalewayDeploymentBackend } from './scaleway-backend';
export { FileDeploymentStore, MemoryDeploymentStore } from './store';
export type * from './types';

/**
 * Idle limit for the proxy socket when deployments are on. A request waiting through a cold start transfers nothing
 * for minutes; under Bun, `server.setTimeout` is a hard idle cut that a per-socket `setTimeout(0)` cannot lift
 * (measured 2026-10-04: the default 60 s killed a real Scaleway cold start). 15 min = Railway's own ceiling for a
 * request with data flowing and above `coldStartWaitSeconds` (≤ 840 s). An explicit PROXY_TOTAL_TIMEOUT_MS wins.
 */
export const DEPLOYMENTS_PROXY_IDLE_MS = 15 * 60_000;

export function proxyIdleTimeoutMs(env: Record<string, string | undefined>, deploymentsEnabled: boolean): string | null {
  if (env.PROXY_TOTAL_TIMEOUT_MS?.trim()) return env.PROXY_TOTAL_TIMEOUT_MS.trim();
  return deploymentsEnabled ? String(DEPLOYMENTS_PROXY_IDLE_MS) : null;
}

export interface DeploymentsFromEnv {
  controller: DeploymentController;
  handler: ReturnType<typeof createDeploymentRoutes>;
}

/**
 * Builds the deployments service from env, or `null` when Scaleway is not configured.
 *
 *   SCW_SECRET_KEY | SCALEWAY_SECRET_KEY   required
 *   SCW_DEFAULT_PROJECT_ID | SCW_PROJECT_ID | SCALEWAY_PROJECT_ID   optional (default: the key's default project)
 *   DEPLOYMENTS_STATE_DIR    where specs/profiles persist (mount a volume here on Railway); default ~/.ai-gateway
 *   DEPLOYMENTS_NAMESPACE    machine tag namespace, one gateway per namespace; default "default"
 *   DEPLOYMENTS_MAX_REPLICAS replica cap across all deployments; default 6
 *   DEPLOYMENTS_ADMIN_USERS  comma list of userIds (from GATEWAY_API_KEYS "key:user") allowed to manage; empty = all
 */
export function deploymentsFromEnv(
  env: Record<string, string | undefined>,
  opts: {
    userOf: (req: IncomingMessage) => string | null;
    /** userIds that may always manage (e.g. the SANDBOX_TOKEN user), on top of DEPLOYMENTS_ADMIN_USERS. */
    alwaysAdmin?: string[];
    log?: (msg: string, data?: Record<string, unknown>) => void;
  },
): DeploymentsFromEnv | null {
  if (env.DEPLOYMENTS_ENABLED === '0') return null;
  const secret = env.SCW_SECRET_KEY || env.SCALEWAY_SECRET_KEY;
  if (!secret) return null;
  const projectId = env.SCW_DEFAULT_PROJECT_ID || env.SCW_PROJECT_ID || env.SCALEWAY_PROJECT_ID || undefined;
  const maxTotal = Number(env.DEPLOYMENTS_MAX_REPLICAS ?? 6);
  const controller = new DeploymentController({
    backend: new ScalewayDeploymentBackend(secret, { projectId }),
    store: FileDeploymentStore.inDir(env.DEPLOYMENTS_STATE_DIR || join(homedir(), '.ai-gateway')),
    probe: new HttpReplicaProbe(),
    namespace: env.DEPLOYMENTS_NAMESPACE || 'default',
    maxTotalReplicas: Number.isFinite(maxTotal) && maxTotal > 0 ? maxTotal : 6,
    log: opts.log,
  });
  const admins = (env.DEPLOYMENTS_ADMIN_USERS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const handler = createDeploymentRoutes({
    controller,
    isAdmin: admins.length ? (req) => [...admins, ...(opts.alwaysAdmin ?? [])].includes(opts.userOf(req) ?? '') : undefined,
  });
  return { controller, handler };
}
