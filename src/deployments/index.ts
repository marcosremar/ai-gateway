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
import { AppRegistry, FileAppStore } from './apps';
import { AppFallbackService, OpenRouterKeyProvisioner } from './app-fallback';
import { KNOWN_ZONES, ScalewayClient } from '../cpu-providers/scaleway-client';
import { startJanitor, type JanitorCloud } from './janitor';

export { DeploymentController, DeploymentError } from './controller';
export { createDeploymentRoutes, HttpReplicaProbe } from './http';
export { planReplicas, desiredReplicas } from './planner';
export { BUILTIN_PROFILES } from './profiles';
export { replicaCloudInit } from './cloud-init';
export { buildSpec, SpecError } from './spec';
export { ScalewayDeploymentBackend } from './scaleway-backend';
export { FileDeploymentStore, MemoryDeploymentStore } from './store';
export { DeclaredDeploymentReconciler, DECLARED_DEPLOYMENTS, declaredBody, declaredImage } from './declared';
export type { DeclaredDeployment, DeclaredStatus } from './declared';
export { AppRegistry, FileAppStore, MemoryAppStore } from './apps';
export { AppFallbackService, OpenRouterKeyProvisioner, fallbackRoutes } from './app-fallback';
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

function onRailway(env: Record<string, string | undefined>): boolean {
  return Boolean(env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);
}

export interface DeploymentsFromEnv {
  controller: DeploymentController;
  /** Stops the in-process janitor (janitor.ts); absent when it is off. */
  stopJanitor?: () => void;
  apps: AppRegistry;
  handler: ReturnType<typeof createDeploymentRoutes>;
}

/**
 * Builds the deployments service from env, or `null` when Scaleway is not configured.
 *
 *   SCW_SECRET_KEY | SCALEWAY_SECRET_KEY   required
 *   SCW_DEFAULT_PROJECT_ID | SCW_PROJECT_ID | SCALEWAY_PROJECT_ID   optional (default: the key's default project)
 *   DEPLOYMENTS_STATE_DIR    where specs/profiles persist (mount a volume here on Railway); default ~/.ai-gateway
 *   DEPLOYMENTS_NAMESPACE    machine tag namespace, one gateway per namespace; default "default" ON RAILWAY ONLY —
 *                            elsewhere it is required (machines of the namespace unknown here are released as orphans)
 *   DEPLOYMENTS_MAX_REPLICAS replica cap across all deployments; default 6
 *   DEPLOYMENTS_ADMIN_USERS  comma list of userIds (from GATEWAY_API_KEYS "key:user") allowed to manage; empty = all
 *   Direct fallback (`GET /v1/apps/:app/fallback`, app-fallback.ts): OPENROUTER_PROVISIONING_KEY (mint per-app keys),
 *   APP_FALLBACK_KEY_LIMIT_USD (5), APP_FALLBACK_KEY_ROTATE_DAYS (7), APP_FALLBACK_PLAN_TTL_SECONDS (3600),
 *   APP_FALLBACK_SHARE_KEY=0 (do not hand out the gateway's own keys)
 */
/** DEPLOYMENTS_PINNED_IDLE_MAX_MINUTES (default 60, 0 = off): how long a `minReplicas` pin may sit unused. */
export const PINNED_IDLE_MAX_MINUTES = 60;
export function pinnedIdleMaxMs(env: Record<string, string | undefined>): number {
  const raw = env.DEPLOYMENTS_PINNED_IDLE_MAX_MINUTES?.trim();
  const minutes = raw === undefined || raw === '' ? PINNED_IDLE_MAX_MINUTES : Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
}

export function deploymentsFromEnv(
  env: Record<string, string | undefined>,
  opts: {
    userOf: (req: IncomingMessage) => string | null;
    /** userIds that may always manage (e.g. the SANDBOX_TOKEN user), on top of DEPLOYMENTS_ADMIN_USERS. */
    alwaysAdmin?: string[];
    log?: (msg: string, data?: Record<string, unknown>) => void;
    /** Declared deployments' status, added to `GET /v1/deployments` as `declared`. */
    declaredStatus?: () => unknown;
    /** An app replaced its routes: the caller re-mounts the providers. */
    onRoutesChange?: () => void;
  },
): DeploymentsFromEnv | null {
  if (env.DEPLOYMENTS_ENABLED === '0') return null;
  const secret = env.SCW_SECRET_KEY || env.SCALEWAY_SECRET_KEY;
  if (!secret) return null;
  // Every machine tagged with this namespace that belongs to no deployment known HERE is released as an orphan.
  // Off Railway (a dev box that got the real SCW key from the palco), an implicit "default" namespace would reap
  // the production replicas — so outside Railway the namespace must be set explicitly.
  if (!env.DEPLOYMENTS_NAMESPACE?.trim() && !onRailway(env)) {
    opts.log?.('Deployments disabled: set DEPLOYMENTS_NAMESPACE (use your own, e.g. "dev-<name>") when running outside Railway');
    return null;
  }
  const projectId = env.SCW_DEFAULT_PROJECT_ID || env.SCW_PROJECT_ID || env.SCALEWAY_PROJECT_ID || undefined;
  const maxTotal = Number(env.DEPLOYMENTS_MAX_REPLICAS ?? 6);
  const stateDir = env.DEPLOYMENTS_STATE_DIR || join(homedir(), '.ai-gateway');
  const apps = new AppRegistry(FileAppStore.inDir(stateDir));
  const controller = new DeploymentController({
    backend: new ScalewayDeploymentBackend(secret, { projectId }),
    store: FileDeploymentStore.inDir(stateDir),
    probe: new HttpReplicaProbe(),
    namespace: env.DEPLOYMENTS_NAMESPACE || 'default',
    maxTotalReplicas: Number.isFinite(maxTotal) && maxTotal > 0 ? maxTotal : 6,
    pinnedIdleMaxMs: pinnedIdleMaxMs(env),
    log: opts.log,
  });
  const admins = (env.DEPLOYMENTS_ADMIN_USERS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const handler = createDeploymentRoutes({
    controller,
    apps,
    userOf: opts.userOf,
    ...(opts.onRoutesChange ? { onRoutesChange: opts.onRoutesChange } : {}),
    fallback: new AppFallbackService({
      env, store: apps, log: opts.log,
      provisioner: new OpenRouterKeyProvisioner(() => env.OPENROUTER_PROVISIONING_KEY),
    }),
    isAdmin: admins.length ? (req) => [...admins, ...(opts.alwaysAdmin ?? [])].includes(opts.userOf(req) ?? '') : undefined,
    declaredStatus: opts.declaredStatus,
  });
  // In-process janitor (build machines and detached volumes that no deployment owns). On by default on Railway, where
  // the gateway is the one owner of the project's leftovers; elsewhere opt in with DEPLOYMENTS_JANITOR=1.
  const janitorOn = env.DEPLOYMENTS_JANITOR === '1' || (env.DEPLOYMENTS_JANITOR !== '0' && onRailway(env));
  const stopJanitor = janitorOn ? startJanitor({ cloud: scalewayJanitorCloud(secret, projectId), log: opts.log }) : undefined;
  return { controller, apps, handler, ...(stopJanitor ? { stopJanitor } : {}) };
}

/** The janitor's view of Scaleway: build servers by tag and the project's SBS volumes, in every known zone. */
export function scalewayJanitorCloud(secret: string, projectId: string | undefined): JanitorCloud {
  const client = new ScalewayClient();
  const credentials = { apiKey: secret };
  return {
    async listServersByTag(tag) {
      const found = await client.listInstancesByTag(tag, credentials, projectId ? { projectId } : {});
      return found.map(inst => {
        const meta = (inst.providerMeta ?? {}) as Record<string, unknown>;
        return {
          id: inst.instanceId, zone: String(meta.zone ?? ''), name: inst.instanceName ?? inst.instanceId,
          tags: (meta.tags as string[] | undefined) ?? [], createdAt: Date.parse(String(meta.createdAt ?? '')) || Date.now(),
        };
      });
    },
    async listVolumes() {
      const lists = await Promise.all(KNOWN_ZONES.map(zone => client.listBlockVolumes(zone, credentials, projectId ? { projectId } : {})));
      return lists.flat();
    },
    deleteServer: (server) => client.releaseInstance(server.id, credentials, { awaitVolumes: false }),
    deleteVolume: (volume) => client.deleteBlockVolume(volume.zone, volume.id, credentials),
  };
}
