// ── BabelCast Gateway — GPU Deploy Orchestration (re-export hub) ─────────────
// Split into focused modules to keep each file small and testable.
// Extracted modules:
//   gpu-health-monitor.ts     — re-export hub for monitoring subsystem:
//     gpu-health-metrics.ts   — parse /health payload
//     gpu-warmth-monitor.ts   — staged boot polling
//     gpu-monitor-loop.ts     — periodic probe loop
//     gpu-destroy-timer.ts    — scheduled destroy after auto-stop
//     gpu-idle-manager.ts     — autoStopGpu
//     gpu-resume-manager.ts   — resumeOrDeploy
//     gpu-terminate.ts        — autoTerminateGpu
//   gpu-orphan-cleanup.ts     — orphan sweep, cleanupAllPods
//   gpu-type-cache.ts         — GPU type cache refresh + validation
//   gpu-auto-select.ts        — cheapest GPU selection/ranking
//   gpu-deploy-race.ts        — hedged (race) deploy
//   gpu-auto-recovery.ts      — startup recovery, auto-recovery, logs
//   gpu-deploy-canary.ts      — canary deployment evaluator
//   gpu-deploy-loop.ts        — per-provider deploy cycle (startDeployLoop)
//   gpu-deploy-tiers.ts       — cooldown tracker, buildGpuTiers, failure classifier
//   gpu-deploy-with-tiers.ts  — startDeployWithTiers (orchestrated cascade)
//   gpu-poll-health.ts        — pollHealthUntilReady

// ── Re-exports from monitoring hub ───────────────────────────────────────────
export {
  GPU_MONITOR_INTERVAL_MS, IDLE_TIMEOUT_MS, setIdleTimeoutMs,
  IDLE_DESTROY_MS, setIdleDestroyMs, resetIdleState,
  startGpuMonitoring, scheduleNextMonitorProbe, stopGpuMonitoring,
  clearAutoDestroyTimer, autoStopGpu, resumeOrDeploy, autoTerminateGpu,
  startBackgroundWarmthMonitor,
} from './gpu-health-monitor';
export type { DeleteReason } from './gpu-health-monitor';

// ── Re-exports from specialized modules ──────────────────────────────────────
export { GPU_TYPE_CACHE_TTL_MS, gpuTypeCacheRefreshTimer, refreshGpuTypeCache, validateGpuTypesFromCache, startGpuTypeCacheRefresh } from './gpu-type-cache';
export { POD_NAME_PREFIX, activeRaceInstanceIds, cleanupAllPods, cleanupVastInstances, cleanupTensordockInstances, cleanupModalApps, sweepOrphanInstances, startOrphanSweep, stopOrphanSweep } from './gpu-orphan-cleanup';
export { autoSelectCheapestGpu } from './gpu-auto-select';
export { startDeployRace } from './gpu-deploy-race';
export { fetchGpuLogs, getVerifiedGpuTypes, tryRecoverActiveDeploy, startAutoRecoveryDeploy } from './gpu-auto-recovery';
export { pollHealthUntilReady, type PollHealthResult } from './gpu-poll-health';

// ── Canary deployment ────────────────────────────────────────────────────────
export { startCanaryIfEnabled, stopCanary } from './gpu-deploy-canary';

// ── Deploy loop + constants + types ──────────────────────────────────────────
export {
  MAX_DEPLOY_RETRIES, HEALTH_POLL_INTERVAL_MS, DEPLOY_TIMEOUT_MS,
  startDeployLoop,
} from './gpu-deploy-loop';
export type { DeployExtra } from './gpu-deploy-loop';

// ── Tier configuration + cooldown ────────────────────────────────────────────
export { cooldownTracker, providerClients, buildGpuTiers } from './gpu-deploy-tiers';

// ── Tier-orchestrated deploy ─────────────────────────────────────────────────
export { startDeployWithTiers } from './gpu-deploy-with-tiers';
