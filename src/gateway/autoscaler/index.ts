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
export {
  noopLifecycleLogger,
  bootStartedEvent,
  bootOkEvent,
  bootFailedEvent,
  deployRejectedEvent,
  runawayPauseEvent,
} from './lifecycle-logger';
export type {
  GpuLifecycleLogger,
  GpuLifecycleLogEntry,
  LifecycleEventType,
} from './lifecycle-logger';

// ── File-based Lifecycle Logger (persistent JSONL — default) ─────────────
export {
  fileLifecycleLogger,
  logGpuEvent,
  readRecentLogs,
  GPU_LIFECYCLE_LOG_PATH,
} from './file-lifecycle-logger';

// ── GPU Sweep (discover ALL instances across ALL providers) ──────────────
export { sweepAllProviders, printSweepReport } from './gpu-sweep';
export type { SweepInstance, SweepReport } from './gpu-sweep';

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

// ── SnapGPU Policy & Metrics ─────────────────────────────────────────────
export {
  shouldUseSnapshot,
  PRIVILEGED_PROVIDERS,
  UNPRIVILEGED_PROVIDERS,
} from './snapgpu-policy';
export type {
  PersistedSnapshot,
  SnapshotPolicyInput,
  SnapshotPolicyDecision,
} from './snapgpu-policy';

export { SnapgpuMetrics, buildWorkloadKey } from './snapgpu-metrics';
export type {
  SnapgpuMetricsOptions,
  BootPath,
  DisableEvent,
} from './snapgpu-metrics';
