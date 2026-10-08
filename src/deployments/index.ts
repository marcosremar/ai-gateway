/**
 * Deployments: register a Docker image, get an autoscaled endpoint on Scaleway machines.
 * See `http.ts` for the API and `planner.ts` for the scaling rules.
 */

import { homedir } from 'os';
import { join } from 'path';
import type { IncomingMessage } from 'http';
import { DeploymentController } from './controller';
import { DEFAULT_SCALING_MODE } from './scaling-spec';
import { probeLimitsFromEnv, spendLimitsFromEnv } from './spend-limits';
import { createDeploymentRoutes, HttpReplicaProbe } from './http';
import { ScalewayDeploymentBackend } from './scaleway-backend';
import { VastDeploymentBackend } from './vast-backend';
import type { DeploymentBackend, DeploymentProvider } from './types';
import { FileDeploymentStore } from './store';
import { AppRegistry, FileAppStore } from './apps';
import { AppFallbackService, OpenRouterKeyProvisioner } from './app-fallback';
import { ClientStabilityLog } from './stability';
import { KNOWN_ZONES, ScalewayClient } from '../cpu-providers/scaleway-client';
import { startJanitor, type JanitorCloud } from './janitor';
import { sessionsWanting } from '../realtime/external-load';

export { DeploymentController, DeploymentError } from './controller';
export { createDeploymentRoutes, HttpReplicaProbe } from './http';
export { planReplicas, desiredReplicas } from './planner';
export { BUILTIN_PROFILES } from './profiles';
export { replicaCloudInit } from './cloud-init';
export { buildSpec, SpecError } from './spec';
export { ScalewayDeploymentBackend } from './scaleway-backend';
export { VastDeploymentBackend } from './vast-backend';
export { rankOffers, rankCandidates, DEFAULT_NEAR } from './placements';
export { FileDeploymentStore, MemoryDeploymentStore } from './store';
export { DeclaredDeploymentReconciler, DECLARED_DEPLOYMENTS, declaredBody, declaredImage } from './declared';
export type { DeclaredDeployment, DeclaredStatus } from './declared';
export { AppRegistry, FileAppStore, MemoryAppStore } from './apps';
export { AppFallbackService, OpenRouterKeyProvisioner, fallbackRoutes } from './app-fallback';
export { ClientStabilityLog, cleanEvent } from './stability';
export type { ClientStabilityBatch, ClientInstabilityEvent } from './stability';
export type * from './types';

/**
 * Idle limit for the proxy socket when deployments are on. A request waiting through a cold start transfers nothing
 * for minutes; under Bun, `server.setTimeout` is a hard idle cut that a per-socket `setTimeout(0)` cannot lift
 * (measured 2026-10-04: the default 60 s killed a real Scaleway cold start). 15 min = Railway's own ceiling for a
 * request with data flowing and above `coldStartWaitSeconds` (≤ 840 s, waited at most DEPLOYMENTS_MAX_WAIT_SECONDS). An explicit PROXY_TOTAL_TIMEOUT_MS wins.
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
 * Builds the deployments service from env, or `null` when no provider is configured.
 *
 *   SCW_SECRET_KEY | SCALEWAY_SECRET_KEY   enables Scaleway replicas
 *   VAST_API_KEY             enables Vast replicas (boot-script mode only); at least one of the two is required
 *   SCW_DEFAULT_PROJECT_ID | SCW_PROJECT_ID | SCALEWAY_PROJECT_ID   optional (default: the key's default project)
 *   DEPLOYMENTS_STATE_DIR    where specs/profiles persist (mount a volume here on Railway); default ~/.ai-gateway
 *   DEPLOYMENTS_NAMESPACE    machine tag namespace, one gateway per namespace; default "default" ON RAILWAY ONLY —
 *                            elsewhere it is required (machines of the namespace unknown here are released as orphans)
 *   DEPLOYMENTS_MAX_REPLICAS replica cap across all deployments; default 6
 *   DEPLOYMENTS_MAX_STOPPED  parked (stopped) replica cap, apart from the running cap; default 8 (spend-limits.ts)
 *   DEPLOYMENTS_MAX_EUR_PER_HOUR  ceiling on the summed hourly price of all running replicas; default 6, 0 = off
 *   DEPLOYMENTS_PARKED_MAX_HOURS  a parked replica unused this long is deleted; default 72, 0 = off
 *   DEPLOYMENTS_ADMIN_USERS  comma list of userIds (from GATEWAY_API_KEYS "key:user") allowed to manage; empty = no
 *                            admin at all — never "every key" (fail closed, 06/10/2026)
 *   Direct fallback (`GET /v1/apps/:app/fallback`, app-fallback.ts): OPENROUTER_PROVISIONING_KEY (mint per-app keys),
 *   APP_FALLBACK_KEY_LIMIT_USD (5), APP_FALLBACK_KEY_ROTATE_DAYS (7), APP_FALLBACK_PLAN_TTL_SECONDS (3600),
 *   APP_FALLBACK_SHARE_KEY=1 (opt-in: hand out the gateway's own master keys when no key can be minted; off by default)
 *   Stability reports (`POST /v1/apps/:app/stability-report`, stability.ts): SDK clients post the instability events
 *   they buffered while the gateway was down; persisted to client-stability.jsonl in the state dir.
 */
/**
 * Admin userIds: DEPLOYMENTS_ADMIN_USERS plus `alwaysAdmin` (empty in production; the `sandbox` user only under the
 * transition flag ACCEPT_SANDBOX_TOKEN_AS_KEY=1). An empty list grants admin to NOBODY — until
 * 06/10/2026 it made every GATEWAY_API_KEYS key an admin (deployments, keys, `X-App` for any app's fallback plan).
 * The one source of the rule for deployments, `PUT /v1/admin/keys` and `/health?deep=1` (serve.ts).
 */
export function adminUsersFromEnv(env: Record<string, string | undefined>, alwaysAdmin: readonly string[] = []): ReadonlySet<string> {
  const listed = (env.DEPLOYMENTS_ADMIN_USERS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return new Set([...listed, ...alwaysAdmin.filter(Boolean)]);
}

/** Boot warning when DEPLOYMENTS_ADMIN_USERS is empty (null when it is set). */
export function adminListWarning(env: Record<string, string | undefined>, alwaysAdmin: readonly string[] = []): string | null {
  if ((env.DEPLOYMENTS_ADMIN_USERS ?? '').split(',').some(s => s.trim())) return null;
  const only = alwaysAdmin.filter(Boolean);
  return `DEPLOYMENTS_ADMIN_USERS is empty: no GATEWAY_API_KEYS key is an admin${only.length ? ` (only ${only.join(', ')})` : ''}`
    + ' — set DEPLOYMENTS_ADMIN_USERS=<userId,…> to grant admin to a key';
}

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
    /** userIds that may always manage, on top of DEPLOYMENTS_ADMIN_USERS (serve.ts: none, or `sandbox` under ACCEPT_SANDBOX_TOKEN_AS_KEY=1). */
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
  const vastKey = env.VAST_API_KEY?.trim();
  if (!secret && !vastKey) return null;
  // Every machine tagged with this namespace that belongs to no deployment known HERE is released as an orphan.
  // Off Railway (a dev box that got the real SCW key from the palco), an implicit "default" namespace would reap
  // the production replicas — so outside Railway the namespace must be set explicitly.
  if (!env.DEPLOYMENTS_NAMESPACE?.trim() && !onRailway(env)) {
    opts.log?.('Deployments disabled: set DEPLOYMENTS_NAMESPACE (use your own, e.g. "dev-<name>") when running outside Railway');
    return null;
  }
  const projectId = env.SCW_DEFAULT_PROJECT_ID || env.SCW_PROJECT_ID || env.SCALEWAY_PROJECT_ID || undefined;
  const maxTotal = Number(env.DEPLOYMENTS_MAX_REPLICAS ?? 6);
  const maxWait = Number(env.DEPLOYMENTS_MAX_WAIT_SECONDS);
  const stateDir = env.DEPLOYMENTS_STATE_DIR || join(homedir(), '.ai-gateway');
  const apps = new AppRegistry(FileAppStore.inDir(stateDir));
  const backends: Partial<Record<DeploymentProvider, DeploymentBackend>> = {
    ...(secret ? { scaleway: new ScalewayDeploymentBackend(secret, { projectId }) } : {}),
    ...(vastKey ? { vast: new VastDeploymentBackend(vastKey, { log: opts.log }) } : {}),
  };
  const { probeTimeoutMs, busyGraceMs, unhealthyStrikes } = probeLimitsFromEnv(env);
  const controller = new DeploymentController({
    backends,
    sessions: sessionsWanting,
    defaultScalingMode: DEFAULT_SCALING_MODE,
    store: FileDeploymentStore.inDir(stateDir),
    probe: new HttpReplicaProbe(probeTimeoutMs),
    busyGraceMs,
    unhealthyStrikes,
    namespace: env.DEPLOYMENTS_NAMESPACE || 'default',
    maxTotalReplicas: Number.isFinite(maxTotal) && maxTotal > 0 ? maxTotal : 6,
    ...spendLimitsFromEnv(env),
    pinnedIdleMaxMs: pinnedIdleMaxMs(env),
    ...(maxWait > 0 ? { maxColdStartWaitSeconds: maxWait } : {}),
    log: opts.log,
  });
  const admins = adminUsersFromEnv(env, opts.alwaysAdmin);
  const adminWarning = adminListWarning(env, opts.alwaysAdmin);
  if (adminWarning) opts.log?.(`WARNING: ${adminWarning}`);
  const handler = createDeploymentRoutes({
    controller,
    apps,
    userOf: opts.userOf,
    ...(opts.onRoutesChange ? { onRoutesChange: opts.onRoutesChange } : {}),
    fallback: new AppFallbackService({
      env, store: apps, log: opts.log,
      provisioner: new OpenRouterKeyProvisioner(() => env.OPENROUTER_PROVISIONING_KEY),
    }),
    // SDK instability reports persist next to the deployments state (client-stability.jsonl).
    stability: new ClientStabilityLog({ file: join(stateDir, 'client-stability.jsonl'), log: opts.log }),
    isAdmin: (req) => admins.has(opts.userOf(req) ?? ''),
    declaredStatus: opts.declaredStatus,
  });
  // In-process janitor (build machines and detached volumes that no deployment owns). On by default on Railway, where
  // the gateway is the one owner of the project's leftovers; elsewhere opt in with DEPLOYMENTS_JANITOR=1.
  const janitorOn = env.DEPLOYMENTS_JANITOR === '1' || (env.DEPLOYMENTS_JANITOR !== '0' && onRailway(env));
  // The janitor's leftovers (build servers, detached SBS volumes) exist only on Scaleway; a deleted Vast instance
  // takes its disk with it.
  const stopJanitor = janitorOn && secret ? startJanitor({ cloud: scalewayJanitorCloud(secret, projectId), log: opts.log }) : undefined;
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
