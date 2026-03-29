import type { AutoscalerDeps, SettingsStore } from './deps';
import type { AutoScalerConfig, AutoScaleDecision, GpuTierState } from './types';
import type { GatewayHooks } from './hooks';
import type { LoadBalanceStrategy, TierLatencyMetrics } from './autoscaler/load-balancer';
import type { SpendTracker } from './tracking/spend-tracker';
import type { PredictiveWarmupConfig } from './autoscaler/predictive-warmup';
import type { GpuLifecycleLogger } from './autoscaler/lifecycle-logger';
import { noopLifecycleLogger } from './autoscaler/lifecycle-logger';
import type { TierActionResult, TierDetail } from './autoscaler/tier-lifecycle';
import * as tierLifecycle from './autoscaler/tier-lifecycle';
import { BenchmarkTracker } from './tracking/benchmark-tracker';
import type { BootBenchmark, InferenceBenchmark, BenchmarkSummary, BenchmarkTrend } from './tracking/benchmark-tracker';
import { GpuProviderRegistry } from './gpu-providers/registry';
import { RunpodClient } from './gpu-providers/runpod-client';
import { TensordockClient } from './gpu-providers/tensordock-client';
import { VastClient } from './gpu-providers/vast-client';
import { ModalClient } from './gpu-providers/modal-client';
import { LatencyTracker } from './autoscaler/latency-tracker';
import { SessionTracker } from './autoscaler/session-tracker';
import { StatePersistence } from './autoscaler/state-persistence';
import { AutoscalerEngine } from './autoscaler/engine';
import { probeGpuHealth } from './autoscaler/health';
import { cleanupProviderInstance } from './autoscaler/cleanup';
import { loadAutoscalerConfig } from './autoscaler/config-loader';

/** Average cold-start time (seconds) by provider — static for backward compat */
export const PROVIDER_BOOT_SECS: Record<string, number> = {
  tensordock: 1200,
  runpod: 1200,
  vast: 900,
  modal: 60,
};
import { LoadBalancer } from './autoscaler/load-balancer';
import { runWatchdogCycle, scheduleWatchdog, startBackgroundTicker } from './autoscaler/watchdog';
import { scheduleReconcile } from './autoscaler/reconcile';
import { recordUsageForPrediction, startPredictiveWarmupTicker } from './autoscaler/predictive-warmup';

/** The public API returned by createAutoscaler() */
export interface Autoscaler {
  // Engine
  getAutoScaleDecision(userId: string, config: AutoScalerConfig, options?: { dryRun?: boolean }): Promise<AutoScaleDecision>;
  triggerGpuBoot(tierConfig: import('./types').GpuTierConfig, tierIndex: number, userId: string): Promise<{ ok: boolean; activeGpuType?: string; reason?: string }>;
  resetGpuState(userId: string): void;
  forceGpuReady(userId: string, endpoint: string): void;
  forceTierReady(userId: string, tierIndex: number, endpoint: string): void;
  getReadyEndpoints(userId: string): string[];
  getPoolStatus(userId: string): GpuTierState[];
  initTierStatesFromDb(userId: string, tiers: import('./types').GpuTierConfig[]): Promise<GpuTierState[]>;

  // Session tracking
  reportSessionHeartbeat(userId: string, sessionKey: string): Promise<void>;
  removeSessionHeartbeat(userId: string, sessionKey: string): Promise<void>;
  countActiveSessions(userId: string, windowMinutes: number): Promise<number>;

  // Latency tracking
  reportLatency(userId: string, totalMs: number): Promise<void>;
  getLatencyStats(userId: string, maxLatencyMs?: number): Promise<{ p95: number | null; samples: number[]; breaches: number }>;

  // Load balancing
  reportTierLatency(userId: string, tierIndex: number, latencyMs: number): Promise<void>;

  // Spend tracking
  spendTracker?: SpendTracker;

  // Predictive warmup
  recordUsageForPrediction(userId: string): Promise<void>;
  startPredictiveWarmupTicker(intervalMs?: number): () => void;

  // Watchdog
  runWatchdogCycle(): Promise<void>;
  scheduleWatchdog(userId: string, config: AutoScalerConfig): void;
  startBackgroundTicker(intervalMs?: number): () => void;

  // Reconcile
  scheduleReconcile(userId: string): void;

  // State persistence
  findUsersWithActiveGpus(): Promise<string[]>;

  // Tier lifecycle management
  stopTier(userId: string, tierIndex: number): Promise<TierActionResult>;
  startTier(userId: string, tierIndex: number): Promise<TierActionResult>;
  deleteTier(userId: string, tierIndex: number): Promise<TierActionResult>;
  restartTier(userId: string, tierIndex: number): Promise<TierActionResult>;
  deployTier(userId: string, tierIndex: number): Promise<TierActionResult>;
  getTierDetail(userId: string, tierIndex: number): Promise<TierDetail | null>;
  getAllTierDetails(userId: string): Promise<TierDetail[]>;

  // Benchmark tracking
  benchmarkTracker?: BenchmarkTracker;
  reportInferenceBenchmark(record: InferenceBenchmark): Promise<void>;
  getBenchmarkSummary(userId: string, date?: string): Promise<BenchmarkSummary>;
  getBenchmarkTrend(userId: string, days?: number): Promise<BenchmarkTrend>;

  // Internals (for advanced use)
  readonly registry: GpuProviderRegistry;
  readonly engine: AutoscalerEngine;
  readonly loadBalancer: LoadBalancer;
  readonly PROVIDER_BOOT_SECS: Record<string, number>;
}

export interface CreateAutoscalerOptions extends AutoscalerDeps {
  /** Load autoscaler config for a given userId. Defaults to the built-in loadAutoscalerConfig. */
  loadConfig?: (userId: string) => Promise<AutoScalerConfig | null>;
  /** Persistent GPU lifecycle logger. If not provided, lifecycle events are not persisted. */
  lifecycleLogger?: GpuLifecycleLogger;
}

/**
 * Create a fully wired Autoscaler instance.
 * The host application provides all external dependencies (Prisma, Redis, etc.)
 * via the deps parameter.
 */
export function createAutoscaler(opts: CreateAutoscalerOptions): Autoscaler {
  const { settingsStore, stateStore, sessionResolver, hooks } = opts;
  const lifecycleLogger = opts.lifecycleLogger ?? noopLifecycleLogger;
  const loadConfig = opts.loadConfig ?? ((userId: string) => loadAutoscalerConfig(userId, settingsStore));

  // Build instance-persist callback that delegates to settingsStore
  const onInstancePersist = async (userId: string, machineKey: string, data: Record<string, unknown>) => {
    const settings = await settingsStore.get(userId);
    // Stamp persistedAt so reconcile can skip recently-saved entries during boot
    data.persistedAt = Date.now();

    // Fixed-slot keys (backward compat for first 2 instances per provider)
    const fixedSlots: Record<string, string> = {
      runpodPod: 'runpodPod2',
      tensordockInstance: 'tensordockInstance2',
      vastInstance: 'vastInstance2',
    };

    if (machineKey in fixedSlots) {
      const secondKey = fixedSlots[machineKey]!;
      if (!settings[machineKey]) {
        await settingsStore.patch(userId, { [machineKey]: data });
        return;
      }
      if (!settings[secondKey]) {
        await settingsStore.patch(userId, { [secondKey]: data });
        return;
      }
      // Both fixed slots occupied — append to dynamic array
    }

    // Dynamic storage: append to autoscaler.dynamicInstances array
    const autoscaler = (settings.autoscaler ?? {}) as Record<string, unknown>;
    const existing = Array.isArray(autoscaler.dynamicInstances) ? autoscaler.dynamicInstances as Record<string, unknown>[] : [];
    const provider = data.provider ?? (
      machineKey.startsWith('runpod') ? 'runpod'
      : machineKey.startsWith('vast') ? 'vast'
      : 'tensordock'
    );
    existing.push({ ...data, provider });
    await settingsStore.patch(userId, {
      autoscaler: { ...autoscaler, dynamicInstances: existing },
    });
  };

  // Registry — pass hooks to providers for error emission
  const registry = new GpuProviderRegistry();
  registry.register(new RunpodClient({ onInstancePersist, hooks }));
  registry.register(new TensordockClient({ onInstancePersist, hooks }));
  registry.register(new ModalClient({ hooks }));
  registry.register(new VastClient({ onInstancePersist, hooks }));

  // Core modules
  const latencyTracker = new LatencyTracker(stateStore);
  const sessionTracker = new SessionTracker(stateStore, sessionResolver);
  const persistence = new StatePersistence(stateStore);
  const loadBalancer = new LoadBalancer(stateStore);
  const engine = new AutoscalerEngine({
    registry, sessionTracker, latencyTracker, persistence,
    probeHealth: probeGpuHealth, cleanupInstance: cleanupProviderInstance,
    hooks, onInstancePersist, lifecycleLogger,
  });

  // Reconcile deps
  const reconcileDeps = { settingsStore, registry, hooks };

  // Benchmark tracker
  const benchmarkTracker = new BenchmarkTracker(stateStore);

  // Wrap lifecycle logger to auto-record boot benchmarks
  const wrappedLogger: GpuLifecycleLogger = {
    log(entry) {
      void lifecycleLogger.log(entry);
      if (entry.eventType === 'boot_ok' && entry.durationMs) {
        void benchmarkTracker.recordBoot({
          userId: entry.userId,
          provider: entry.provider,
          tierIndex: entry.tierIndex,
          durationMs: entry.durationMs,
          wasDiscovered: !!entry.instanceId,
          instanceId: entry.instanceId,
          timestamp: Date.now(),
        }).catch(e => console.warn('[bench] dispatch record failed:', e instanceof Error ? e.message : e));
      }
    },
  };

  // Re-assign wrapped logger to engine (so boot_ok events auto-record benchmarks)
  // The engine already has lifecycleLogger from construction, but we can intercept
  // via the watchdog deps since those forward to the same logger instance.
  // For the engine itself, boot_ok events from boot-poller use the logger passed at construction.
  // We'll update watchdog deps to use the wrapped logger.

  // Tier lifecycle deps
  const tierLifecycleDeps: tierLifecycle.TierLifecycleDeps = {
    engine, registry, lifecycleLogger: wrappedLogger, loadConfig,
  };

  // Rate-limit maps (instance-scoped, not global)
  const lastWatchdogMap = new Map<string, number>();
  const lastReconcileMap = new Map<string, number>();

  // Periodic cleanup of rate-limit maps to prevent unbounded growth
  const _rateLimitCleanup = setInterval(() => {
    const now = Date.now();
    for (const [uid, ts] of lastWatchdogMap) {
      if (now - ts > 10 * 60_000) lastWatchdogMap.delete(uid);
    }
    for (const [uid, ts] of lastReconcileMap) {
      if (now - ts > 30 * 60_000) lastReconcileMap.delete(uid);
    }
  }, 10 * 60_000);
  if (_rateLimitCleanup.unref) _rateLimitCleanup.unref();

  // Update watchdog deps to use wrapped logger
  const watchdogDeps = { engine, sessionTracker, persistence, registry, loadConfig, hooks, lifecycleLogger: wrappedLogger };

  return {
    // Engine
    getAutoScaleDecision: (userId, config, options) => engine.getAutoScaleDecision(userId, config, options),
    triggerGpuBoot: (tierConfig, tierIndex, userId) => engine.triggerGpuBoot(tierConfig, tierIndex, userId),
    resetGpuState: (userId) => engine.resetGpuState(userId),
    forceGpuReady: (userId, endpoint) => engine.forceGpuReady(userId, endpoint),
    forceTierReady: (userId, tierIndex, endpoint) => engine.forceTierReady(userId, tierIndex, endpoint),
    getReadyEndpoints: (userId) => engine.getReadyEndpoints(userId),
    getPoolStatus: (userId) => engine.getPoolStatus(userId),
    initTierStatesFromDb: (userId, tiers) => engine.initTierStatesFromDb(userId, tiers),

    // Session tracking
    reportSessionHeartbeat: (userId, sessionKey) => sessionTracker.reportSessionHeartbeat(userId, sessionKey),
    removeSessionHeartbeat: (userId, sessionKey) => sessionTracker.removeSessionHeartbeat(userId, sessionKey),
    countActiveSessions: (userId, windowMinutes) => sessionTracker.countActiveSessions(userId, windowMinutes),

    // Latency tracking
    reportLatency: (userId, totalMs) => latencyTracker.reportLatency(userId, totalMs),
    getLatencyStats: (userId, maxLatencyMs) => latencyTracker.getLatencyStats(userId, maxLatencyMs),

    // Load balancing
    reportTierLatency: (userId, tierIndex, latencyMs) => loadBalancer.reportTierLatency(userId, tierIndex, latencyMs),

    // Predictive warmup
    recordUsageForPrediction: (userId) => recordUsageForPrediction(stateStore, userId),
    startPredictiveWarmupTicker: (intervalMs) => startPredictiveWarmupTicker({
      stateStore,
      triggerBoot: async (userId) => {
        const config = await loadConfig(userId);
        if (!config?.enabled || !config.tiers?.length) return false;
        const tierConfig = config.tiers[0];
        if (!tierConfig) return false;
        const result = await engine.triggerGpuBoot(tierConfig, 0, userId);
        return result.ok;
      },
      listWarmupUsers: async () => {
        const userIds = await persistence.findUsersWithActiveGpus();
        const results: Array<{ userId: string; config: import('./autoscaler/predictive-warmup').PredictiveWarmupConfig; autoscalerConfig: import('./types').AutoScalerConfig }> = [];
        for (const uid of userIds) {
          const cfg = await loadConfig(uid);
          if (cfg?.predictiveWarmup?.enabled) {
            results.push({ userId: uid, config: cfg.predictiveWarmup, autoscalerConfig: cfg });
          }
        }
        return results;
      },
    }, intervalMs),

    // Watchdog
    runWatchdogCycle: () => runWatchdogCycle(watchdogDeps),
    scheduleWatchdog: (userId, config) => scheduleWatchdog(watchdogDeps, userId, config, lastWatchdogMap),
    startBackgroundTicker: (intervalMs) => startBackgroundTicker(watchdogDeps, intervalMs),

    // Reconcile
    scheduleReconcile: (userId) => scheduleReconcile(reconcileDeps, userId, lastReconcileMap),

    // State persistence
    findUsersWithActiveGpus: () => persistence.findUsersWithActiveGpus(),

    // Tier lifecycle management
    stopTier: (userId, tierIndex) => tierLifecycle.stopTier(tierLifecycleDeps, userId, tierIndex),
    startTier: (userId, tierIndex) => tierLifecycle.startTier(tierLifecycleDeps, userId, tierIndex),
    deleteTier: (userId, tierIndex) => tierLifecycle.deleteTier(tierLifecycleDeps, userId, tierIndex),
    restartTier: (userId, tierIndex) => tierLifecycle.restartTier(tierLifecycleDeps, userId, tierIndex),
    deployTier: (userId, tierIndex) => tierLifecycle.deployTier(tierLifecycleDeps, userId, tierIndex),
    getTierDetail: (userId, tierIndex) => tierLifecycle.getTierDetail(tierLifecycleDeps, userId, tierIndex),
    getAllTierDetails: (userId) => tierLifecycle.getAllTierDetails(tierLifecycleDeps, userId),

    // Benchmark tracking
    benchmarkTracker,
    reportInferenceBenchmark: (record) => benchmarkTracker.recordInference(record),
    getBenchmarkSummary: (userId, date) => benchmarkTracker.getDailySummary(userId, date),
    getBenchmarkTrend: (userId, days) => benchmarkTracker.getTrend(userId, days),

    // Internals
    registry,
    engine,
    loadBalancer,
    PROVIDER_BOOT_SECS,
  };
}
