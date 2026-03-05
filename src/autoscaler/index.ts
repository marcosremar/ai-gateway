// Barrel file for @parle/ai-gateway/autoscaler

// ── Config Loader ─────────────────────────────────────────────────────────
export { loadAutoscalerConfig } from './config-loader';

// ── Health ────────────────────────────────────────────────────────────────
export { probeGpuHealth, probeGpuHealthSsh } from './health';
export { probeAllTiers, processHealthResults } from './health-checker';

// ── Engine ────────────────────────────────────────────────────────────────
export { MAX_BOOT_FAILURES, BOOT_COOLDOWN_BASE_MS, BOOT_COOLDOWN_MAX_MS } from './engine';
export type { AutoscalerEngineOptions } from './engine';

// ── Decision Builder ──────────────────────────────────────────────────────
export { buildDecision } from './decision-builder';

// ── Boot Timeout ──────────────────────────────────────────────────────────
export { handleBootTimeout } from './boot-timeout';

// ── Latency Tracker ───────────────────────────────────────────────────────
export { LATENCY_BREACH_COUNT, computeP95, countRecentBreaches } from './latency-tracker';

// ── Watchdog ──────────────────────────────────────────────────────────────
export { runWatchdogCycle, startBackgroundTicker } from './watchdog';

// ── State Persistence ─────────────────────────────────────────────────────
export { StatePersistence } from './state-persistence';

// ── Cost Monitor ──────────────────────────────────────────────────────────
export { runCostMonitorCycle, startCostMonitorTicker, _resetStaleTracking } from './cost-monitor';
export type {
  ProviderAccount,
  OrphanedInstance,
  CostMonitorReport,
  CostMonitorDeps,
  WasteType,
} from './cost-monitor';

// ── Lifecycle Logger ──────────────────────────────────────────────────────
export { noopLifecycleLogger } from './lifecycle-logger';
export type { GpuLifecycleLogger, GpuLifecycleLogEntry } from './lifecycle-logger';

// ── Tier Lifecycle ────────────────────────────────────────────────────────
export type { TierActionResult, TierDetail } from './tier-lifecycle';

// ── Load Balancer ─────────────────────────────────────────────────────────
export { LoadBalancer } from './load-balancer';
export type { 
  LoadBalanceStrategy, 
  RequestPriority,
  TierLatencyMetrics,
  TierConnectionMetrics,
  TokenBucketConfig,
  TokenBucketState,
  PriorityQueueConfig,
} from './load-balancer';

// ── Predictive Warmup ─────────────────────────────────────────────────────
export {
  recordUsageForPrediction,
  shouldPreWarm,
  runPredictiveWarmupForUser,
  startPredictiveWarmupTicker,
} from './predictive-warmup';
export type { PredictiveWarmupConfig, PredictiveWarmupDeps } from './predictive-warmup';
