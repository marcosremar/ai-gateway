/**
 * createGateway() — the single entry point for host apps.
 *
 * Accepts a GatewayStorage + optional overrides and returns a fully wired
 * Gateway facade. Replaces ~300 LOC of adapter classes + HandlerDeps + singleton
 * boilerplate on the host side.
 */

import type { GatewayStorage } from './storage';
import type { Gateway } from './gateway-api';
import { createLogger } from './logger';

const log = createLogger('create-gateway');
import type { StateStore } from './deps';
import type { GatewayHooks } from './hooks';
import type { AutoScalerConfig } from './types';
import type { GpuLifecycleLogger, GpuLifecycleLogEntry } from './autoscaler/lifecycle-logger';
import { createAutoscaler, type Autoscaler } from './factory';
import { createCredentialResolver } from './handlers/credential-resolver';
import { handleAutoscalerGet, handleAutoscalerAction } from './handlers/autoscaler-handler';
import { handleModalApps, handleModalStop } from './handlers/modal-handler';
import { loadAutoscalerConfig } from './autoscaler/config-loader';
import { signGpuToken, verifyGpuToken } from './auth/gpu-token';
import { runHealthCheck, runSSEBench } from './benchmarking/bench';
import { InMemoryStateAdapter } from './adapters/in-memory-state';
import { StatePersistence } from './autoscaler/state-persistence';
import { startCostMonitorTicker } from './autoscaler/cost-monitor';
import type { ProviderAccount } from './autoscaler/cost-monitor';

import type { HandlerDeps } from './handlers/types';

export interface GatewayConfig {
  /** Required: persistence adapter. */
  storage: GatewayStorage;

  /** Optional: Redis-backed state store. Falls back to InMemoryStateAdapter. */
  stateStore?: StateStore;

  /** Optional: observability hooks. */
  hooks?: GatewayHooks;

  /** Optional: override config loader (defaults to loadAutoscalerConfig). */
  loadConfig?: (userId: string) => Promise<AutoScalerConfig | null>;
}

function getEnvModalApiKey(): string | null {
  if (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) {
    return `${process.env.MODAL_TOKEN_ID}:${process.env.MODAL_TOKEN_SECRET}`;
  }
  const modalApiKey = process.env.MODAL_API_KEY;
  return modalApiKey?.includes(':') ? modalApiKey : null;
}

async function collectTrackedProviderIds(
  persistence: StatePersistence,
  loadConfig: (userId: string) => Promise<AutoScalerConfig | null>,
): Promise<Map<string, Set<string>>> {
  const trackedByProvider = new Map<string, Set<string>>();
  const userIds = await persistence.findUsersWithActiveGpus();
  for (const userId of userIds) {
    const cfg = await loadConfig(userId);
    for (const tier of cfg?.tiers ?? []) {
      if (!tier.provider || !tier.instanceId) continue;
      let ids = trackedByProvider.get(tier.provider);
      if (!ids) {
        ids = new Set<string>();
        trackedByProvider.set(tier.provider, ids);
      }
      ids.add(tier.instanceId);
    }
  }
  return trackedByProvider;
}

function mergeProviderAccounts(accounts: ProviderAccount[]): ProviderAccount[] {
  const merged = new Map<string, ProviderAccount>();
  for (const account of accounts) {
    const key = `${account.provider}::${account.credentials.apiKey}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...account, trackedInstanceIds: [...account.trackedInstanceIds] });
      continue;
    }
    for (const id of account.trackedInstanceIds) {
      if (!existing.trackedInstanceIds.includes(id)) existing.trackedInstanceIds.push(id);
    }
  }
  return [...merged.values()];
}

async function buildCostMonitorAccounts(
  loadStoredAccounts: (() => Promise<ProviderAccount[]>) | undefined,
  persistence: StatePersistence,
  loadConfig: (userId: string) => Promise<AutoScalerConfig | null>,
): Promise<ProviderAccount[]> {
  const accounts = loadStoredAccounts ? await loadStoredAccounts() : [];
  const modalApiKey = getEnvModalApiKey();
  if (!modalApiKey) return accounts;

  const trackedByProvider = await collectTrackedProviderIds(persistence, loadConfig);
  accounts.push({
    userId: 'env',
    provider: 'modal',
    credentials: { apiKey: modalApiKey },
    trackedInstanceIds: [...(trackedByProvider.get('modal') ?? new Set<string>())],
  });
  return mergeProviderAccounts(accounts);
}

/**
 * Create a new AI Gateway instance.
 *
 * This is the main entry point for programmatic gateway usage.
 * It configures the autoscaler, providers, and event handling, wiring
 * together all internal components (credential resolver, lifecycle logger,
 * cost monitor, health checker) into a single cohesive facade.
 *
 * The host app should call this once at startup and reuse the returned
 * object for all route handlers and background tasks.
 *
 * @param config - Gateway configuration including storage adapter,
 *                 optional state store, hooks, and config loader override
 * @returns Fully configured gateway instance with route handlers,
 *          autoscaler methods, utilities, and background ticker management
 *
 * @example
 * ```typescript
 * import { createGateway } from '@ai-gateway/create-gateway';
 *
 * const gateway = createGateway({
 *   storage: myPrismaStorage,
 *   stateStore: redisStateStore,
 *   hooks: {
 *     onScaleUp: (event) => console.log('Scaling up:', event),
 *     onError: (event) => reportError(event),
 *   },
 * });
 *
 * // Start background watchdog
 * gateway.startWatchdog();
 * gateway.startCostMonitor();
 * ```
 */
export function createGateway(config: GatewayConfig): Gateway {
  const { storage, hooks } = config;
  const stateStore = config.stateStore ?? new InMemoryStateAdapter();

  // ── Bridge GatewayStorage → DI interfaces ────────────────────────────────

  const settingsStore = {
    get: (userId: string) => storage.getSettings(userId),
    patch: (userId: string, partial: Record<string, unknown>) => storage.patchSettings(userId, partial),
  };

  const sessionResolver = {
    countDbSessions: (userId: string, windowMinutes: number) => storage.countSessions(userId, windowMinutes),
    resolveTeacher: (studentId: string) => storage.resolveTeacher(studentId),
  };

  const lifecycleLogger: GpuLifecycleLogger = storage.logLifecycleEvent
    ? { log: (entry: GpuLifecycleLogEntry) => storage.logLifecycleEvent!(entry) }
    : { log: () => {} };

  const credentialStore = storage.resolveCredentials
    ? { resolve: (userId: string, provider: string) => storage.resolveCredentials!(userId, provider) }
    : createCredentialResolver(settingsStore);

  const lifecycleLogStore = storage.queryLifecycleLogs
    ? { query: storage.queryLifecycleLogs.bind(storage) }
    : undefined;

  const userRoleResolver = storage.resolveVisibleUserIds
    ? { resolveVisibleUserIds: storage.resolveVisibleUserIds.bind(storage) }
    : undefined;

  const benchmarkStore = storage.createBenchmark && storage.queryBenchmarks
    ? { create: storage.createBenchmark.bind(storage), query: storage.queryBenchmarks.bind(storage) }
    : undefined;

  const deploySessionStore = storage.createDeploySession && storage.updateDeploySession && storage.queryDeploySessions
    ? {
        create: storage.createDeploySession.bind(storage),
        update: storage.updateDeploySession.bind(storage),
        query: storage.queryDeploySessions.bind(storage),
      }
    : undefined;

  // ── Config loader ────────────────────────────────────────────────────────

  const loadConfig = config.loadConfig ?? ((userId: string) => loadAutoscalerConfig(userId, settingsStore));

  // ── Create autoscaler ────────────────────────────────────────────────────

  const autoscaler: Autoscaler = createAutoscaler({
    settingsStore,
    stateStore,
    sessionResolver,
    hooks,
    lifecycleLogger,
    loadConfig,
  });

  // ── Build HandlerDeps ────────────────────────────────────────────────────

  const handlerDeps: HandlerDeps = {
    autoscaler,
    settingsStore,
    credentialStore,
    lifecycleLogStore,
    userRoleResolver,
    benchmarkStore,
    deploySessionStore,
    signGpuToken: (userId: string) => {
      try {
        return signGpuToken(userId);
      } catch {
        return undefined;
      }
    },
  };

  // ── Stop functions for background tickers ────────────────────────────────

  const stopFns: Array<() => void> = [];

  // ── Build Gateway facade ─────────────────────────────────────────────────

  const gateway: Gateway = {
    // Route Handlers
    handleGet: (userId, opts) =>
      handleAutoscalerGet(handlerDeps, userId, loadConfig, opts?.readOwnConfig),
    handleAction: (userId, action, body) =>
      handleAutoscalerAction(handlerDeps, userId, action, body, loadConfig),
    handleModalApps: (tokenId, tokenSecret) =>
      handleModalApps(tokenId, tokenSecret),
    handleModalStop: (appId, tokenId, tokenSecret) =>
      handleModalStop(appId, tokenId, tokenSecret),

    // Autoscaler convenience
    getDecision: async (userId, opts) => {
      const cfg = await loadConfig(userId);
      if (!cfg) return null;
      return autoscaler.getAutoScaleDecision(userId, cfg, opts);
    },
    reportSession: (userId, sessionKey) =>
      autoscaler.reportSessionHeartbeat(userId, sessionKey),
    removeSession: (userId, sessionKey) =>
      autoscaler.removeSessionHeartbeat(userId, sessionKey),
    reportLatency: (userId, totalMs) =>
      autoscaler.reportLatency(userId, totalMs),
    getLatencyStats: (userId, maxLatencyMs) =>
      autoscaler.getLatencyStats(userId, maxLatencyMs),
    getPoolStatus: (userId) =>
      autoscaler.getPoolStatus(userId),
    getReadyEndpoints: (userId) =>
      autoscaler.getReadyEndpoints(userId),
    loadConfig,
    scheduleReconcile: (userId) =>
      autoscaler.scheduleReconcile(userId),
    scheduleWatchdog: (userId, cfg) =>
      autoscaler.scheduleWatchdog(userId, cfg),
    runWatchdogCycle: () =>
      autoscaler.runWatchdogCycle(),
    resetGpuState: (userId) =>
      autoscaler.resetGpuState(userId),
    triggerGpuBoot: (tierConfig, tierIndex, userId) =>
      autoscaler.triggerGpuBoot(tierConfig, tierIndex, userId),
    forceTierReady: (userId, tierIndex, endpoint) =>
      autoscaler.forceTierReady(userId, tierIndex, endpoint),
    initTierStatesFromDb: (userId, tiers) =>
      autoscaler.initTierStatesFromDb(userId, tiers),

    // Utilities
    signGpuToken: (userId) => {
      try { return signGpuToken(userId); } catch { return undefined; }
    },
    verifyGpuToken,
    runHealthCheck,
    runSSEBench,

    // Background tickers
    startWatchdog: (intervalMs) => {
      const stop = autoscaler.startBackgroundTicker(intervalMs);
      stopFns.push(stop);
      return stop;
    },
    startCostMonitor: (intervalMs) => {
      if (!storage.loadAllAccounts && !getEnvModalApiKey()) {
        log.warn('Cannot start cost monitor: storage.loadAllAccounts not implemented and no Modal env credentials found');
        return () => {};
      }
      const persistence = new StatePersistence(stateStore);
      const loadAllAccounts = () => buildCostMonitorAccounts(storage.loadAllAccounts?.bind(storage), persistence, loadConfig);
      const stop = startCostMonitorTicker({
        registry: autoscaler.registry,
        persistence,
        loadAllAccounts,
        autoStop: true,
        autoDelete: true,
        probeHealth: true,
        staleGraceMinutes: 20,
        hooks,
        lifecycleLogger,
        onOrphanDetected: async (orphan) => {
          const type = orphan.isZombieStopped ? 'ZOMBIE STOPPED' : orphan.isStaleRunning ? 'STALE' : 'ORPHAN';
          const action = orphan.actionTaken === 'deleted' ? 'AUTO-DELETING' :
            orphan.actionTaken === 'stopped' ? 'AUTO-STOPPING' : 'REPORT-ONLY';
          log.warn(
            `[cost-monitor] ${type}: ${orphan.provider} ${orphan.instance.instanceId}` +
            (orphan.instance.instanceName ? ` (${orphan.instance.instanceName})` : '') +
            ` — user: ${orphan.userId} — ${action}`,
          );
        },
      }, intervalMs);
      stopFns.push(stop);
      return stop;
    },

    // Internals
    autoscaler,
    registry: autoscaler.registry,
    destroy: () => {
      for (const stop of stopFns) {
        try { stop(); } catch { /* ignore */ }
      }
      stopFns.length = 0;
    },
  };

  return gateway;
}
