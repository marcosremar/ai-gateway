// ── GPU Health Monitor — re-export hub ───────────────────────────────────────
// Split into focused modules for maintainability:
//   gpu-health-metrics.ts   — parse /health payload (temp, util, memory)
//   gpu-warmth-monitor.ts   — staged boot polling (TTS warm → STT+LLM warm)
//   gpu-monitor-loop.ts     — periodic probe loop (health, budget, P95, idle)
//   gpu-destroy-timer.ts    — scheduled destroy after auto-stop
//   gpu-idle-manager.ts     — autoStopGpu (pause pod, preserve disk)
//   gpu-resume-manager.ts   — resumeOrDeploy (stopped → ready, with fallback)
//   gpu-terminate.ts        — autoTerminateGpu (permanent destroy)

export {
  GPU_MONITOR_INTERVAL_MS,
  IDLE_TIMEOUT_MS, setIdleTimeoutMs,
  IDLE_DESTROY_MS, setIdleDestroyMs,
  resetIdleState,
  startGpuMonitoring, scheduleNextMonitorProbe, stopGpuMonitoring,
} from './gpu-monitor-loop';

export { startBackgroundWarmthMonitor } from './gpu-warmth-monitor';
export { clearAutoDestroyTimer } from './gpu-destroy-timer';
export type { DeleteReason } from './gpu-destroy-timer';
export { autoStopGpu } from './gpu-idle-manager';
export { resumeOrDeploy } from './gpu-resume-manager';
export { autoTerminateGpu } from './gpu-terminate';
