// ── GPU Health Monitor — probing, idle detection, budget, auto-stop/terminate ─

import type { GpuProviderClient, ProviderCredentials } from '../src/gpu-providers/types';
import type { ProviderName } from '../src/gpu-providers/deploy-orchestrator';
import { RunpodClient } from '../src/gpu-providers/runpod-client';
import { probeGpuHealth } from '../src/autoscaler/health';
import { categorizeDeployError } from '../src/errors/deploy-errors';
import { errorSummary } from '../src/error-summary';
import { tryAutoRemediation } from '../src/auto-remediation';
import { createLogger } from '../src/logger';
import {
  getSttTargetLatencyMs, getLlmTargetLatencyMs, getTtsTargetLatencyMs,
  getP95DemotionMultiplier, getP95IdleWindowSec,
  getAutoRecoveryEnabled, getAutoRecoveryMaxRetries,
} from '../src/gpu-providers/deploy-settings';
import { BILLING_URLS } from '../src/providers/errors';
import {
  deployState, setDeployState, deployApiKey, deployVastApiKey,
  deployTensordockApiKey, deployTensordockAuthId, deployModalApiKey,
  activeProvider, setActiveProvider,
  setGpuHealthy, gpuHealthy, setLastRequestTime,
  monitorInterval, setMonitorInterval,
  resetDeployState, lastRequestTime, lastModelRequestTime, setLastModelRequestTime,
  DAILY_BUDGET_USD, dailyGpuSpendUsd, setDailyGpuSpendUsd, dailySpendResetDate, setDailySpendResetDate,
  deploymentSM,
  updateGpuModelWarmth, isStageWarm,
  isGpuReadyForProduction, getPerStageP95, setGpuReadyForProduction, setServiceReadiness,
  perStageLatencyRing,
} from './state';
import {
  translationDefaults, updateActivePipeline, runpod, vast, tensordock, modal,
  markGpuHealthy, markGpuUnhealthy, _startReadinessCheck,
} from './providers';
import { isReadinessCheckInProgress } from './gpu-readiness';
import { logGpuEvent, updateDeploySession, recordHostCrash } from './metrics';
import { broadcastProviderStatus, broadcastWs } from './ws-state';
import { emitGatewayEvent } from './event-bus';
import { cleanupAllPods, cleanupVastInstances, cleanupTensordockInstances, cleanupModalApps } from './gpu-orphan-cleanup';

const log = createLogger('gpu-deploy');

export const GPU_MONITOR_INTERVAL_MS = 30_000; // health check every 30s
export let IDLE_TIMEOUT_MS = 15 * 60_000;    // auto-STOP (pause) after 15 min idle (configurable via API)
export function setIdleTimeoutMs(ms: number) { IDLE_TIMEOUT_MS = ms; }
export let IDLE_DESTROY_MS = 2 * 60 * 60_000; // auto-DESTROY 2 hours after stop (configurable)
export function setIdleDestroyMs(ms: number) { IDLE_DESTROY_MS = ms; }

// ── GPU Health Metrics Parsing ─────────────────────────────────────────────

/** Track consecutive zero-utilization probes to detect idle GPU (5+ min at 0% = warning). */
let consecutiveZeroUtilProbes = 0;
const ZERO_UTIL_WARNING_THRESHOLD = 10; // 10 probes * 30s = 5 min

/**
 * Parse GPU hardware metrics from the /health response and store in deployState.
 * Logs warnings for thermal throttling (>85C), idle GPU (0% util for 5+ min),
 * and near-OOM memory usage (>95%).
 */
function parseAndStoreGpuMetrics(data: Record<string, unknown>): void {
  const temp = typeof data.gpu_temp_c === 'number' ? data.gpu_temp_c
    : typeof data.gpu_temperature === 'number' ? data.gpu_temperature
    : typeof data.temperature === 'number' ? data.temperature : 0;

  const util = typeof data.gpu_util_pct === 'number' ? data.gpu_util_pct
    : typeof data.gpu_utilization === 'number' ? data.gpu_utilization
    : typeof data.utilization === 'number' ? data.utilization : -1;

  const memUsed = typeof data.gpu_mem_used_gb === 'number' ? data.gpu_mem_used_gb
    : typeof data.gpu_memory_used === 'number' ? data.gpu_memory_used
    : typeof data.vram_used_gb === 'number' ? data.vram_used_gb : 0;

  const memTotal = typeof data.gpu_mem_total_gb === 'number' ? data.gpu_mem_total_gb
    : typeof data.gpu_memory_total === 'number' ? data.gpu_memory_total
    : typeof data.vram_total_gb === 'number' ? data.vram_total_gb : 0;

  // Only update state if we got at least one metric
  if (temp > 0 || util >= 0 || memUsed > 0 || memTotal > 0) {
    setDeployState({
      gpuTemp: temp,
      gpuUtil: util,
      gpuMemUsed: memUsed,
      gpuMemTotal: memTotal,
    });
  }

  // Thermal warning: >85C indicates throttling risk
  if (temp > 85) {
    log.warn(`[gpu] HIGH TEMPERATURE: ${temp}C — GPU may be thermal throttling`);
    setDeployState({ alert: `GPU temperature high: ${temp}C (throttling risk above 85C)` });
  }

  // Idle GPU warning: 0% utilization for 5+ minutes (10 consecutive probes at 30s interval)
  if (util === 0) {
    consecutiveZeroUtilProbes++;
    if (consecutiveZeroUtilProbes === ZERO_UTIL_WARNING_THRESHOLD) {
      log.warn(`[gpu] GPU utilization 0% for ~${Math.round(ZERO_UTIL_WARNING_THRESHOLD * GPU_MONITOR_INTERVAL_MS / 60_000)}min — GPU idle (wasting compute)`);
    }
  } else if (util > 0) {
    consecutiveZeroUtilProbes = 0;
  }

  // Near-OOM warning: memory usage >95%
  if (memTotal > 0 && memUsed > 0) {
    const memPct = (memUsed / memTotal) * 100;
    if (memPct > 95) {
      log.warn(`[gpu] HIGH MEMORY: ${memUsed.toFixed(1)}/${memTotal.toFixed(1)}GB (${memPct.toFixed(0)}%) — OOM risk`);
      setDeployState({ alert: `GPU memory critical: ${memUsed.toFixed(1)}/${memTotal.toFixed(1)}GB (${memPct.toFixed(0)}%)` });
    }
  }
}

// ── GPU Monitoring ───────────────────────────────────────────────────────────

let monitorRunning = false;
let monitorConsecFails = 0;
let monitorDelayMs = GPU_MONITOR_INTERVAL_MS;
let monitorBackoffMaxAlerted = false;

// P95 demotion: require N consecutive violations before demoting (avoids transient spike false positives)
const P95_DEMOTION_CONSECUTIVE_VIOLATIONS = 3;
let p95ViolationCount: Record<string, number> = { stt: 0, llm: 0, tts: 0 };

// Budget enforcement: soft warn once per day, hard terminate at 100%
let budgetSoftWarned = false;
let budgetWarned50 = false;
let lastBudgetCalcTime = 0;

// Crash auto-recovery: redeploy on different provider after crash (max 2 attempts)
let monitorCrashRecoveryAttempts = 0;
const MAX_MONITOR_CRASH_RECOVERY = 2;

// Idle warning: warn once before auto-terminate, reset on activity
let idleWarned = false;
// NOTE: monitorCrashRecoveryAttempts is intentionally NOT reset by resetIdleState —
// resetting it on every model request would bypass the crash-loop protection (max 2
// auto-recovery attempts), allowing infinite crash → request → reset → crash cycles.
// It is only reset when startGpuMonitoring() is called (fresh deploy or recovery).
export function resetIdleState() { idleWarned = false; monitorDelayMs = GPU_MONITOR_INTERVAL_MS; }

// ── Staged Warmth Monitor ────────────────────────────────────────────────────
// After initial deploy, TTS loads first and pod becomes healthy ("degraded").
// STT + LLM load in the background (~2-5min). We activate the full GPU pipeline
// only when both STT + LLM are warm, so cloud fallbacks handle STT/LLM until ready.

let warmthMonitorTimer: ReturnType<typeof setTimeout> | null = null;

function stopWarmthMonitor() {
  if (warmthMonitorTimer) { clearTimeout(warmthMonitorTimer); warmthMonitorTimer = null; }
}

export function startBackgroundWarmthMonitor(endpoint: string) {
  stopWarmthMonitor();
  // If already fully warm, run readiness benchmark before activating
  if (isStageWarm('stt') && isStageWarm('llm')) {
    _startReadinessCheck(endpoint);
    return;
  }
  log.log('[gpu] Staged boot: TTS warm — polling until STT + LLM ready before activating full pipeline');

  let warmthPollCount = 0;
  let consecutiveFailures = 0;

  const poll = async () => {
    if (deployState.status !== 'ready' || deployState.endpoint !== endpoint) {
      log.log('[gpu] Warmth monitor: pod changed or offline — stopping');
      stopWarmthMonitor(); // clear timer properly instead of just nulling
      return;
    }
    try {
      // FIX #10: Increased health probe timeout from 6s to 60s
      // Large models (70B+) can take minutes to load, and /health may be unresponsive
      // during model initialization. 60s gives enough time for model loading.
      const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(60_000) });
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>;
        updateGpuModelWarmth(data);
        consecutiveFailures = 0; // reset on success
        // Populate GPU hardware info from /health if not already known (e.g. Modal)
        if (!deployState.gpuType && data.gpu_type) {
          setDeployState({ gpuType: String(data.gpu_type) });
        }
        if (data.gpu_vram_gb && !deployState.providerMeta?.gpuVramGb) {
          setDeployState({ providerMeta: { ...deployState.providerMeta, gpuVramGb: Number(data.gpu_vram_gb) } });
        }
        const sttWarm = isStageWarm('stt');
        const llmWarm = isStageWarm('llm');
        const svc = (data.services ?? {}) as Record<string, string>;
        log.log(`[gpu] Warmth poll: stt=${svc.whisper ?? '?'} llm=${svc.llama_cpp ?? '?'} tts=${svc.tts ?? '?'} → STT=${sttWarm} LLM=${llmWarm}`);
        if (sttWarm && llmWarm) {
          log.log('[gpu] STT + LLM warm — running readiness benchmark');
          setDeployState({ stepDetail: '' });
          warmthMonitorTimer = null;
          _startReadinessCheck(endpoint);
          return; // done — regular monitoring loop takes over
        }
        const loading = [!sttWarm && 'STT', !llmWarm && 'LLM'].filter(Boolean).join(', ');
        setDeployState({ stepDetail: `Loading: ${loading} — using cloud fallback` });
        broadcastWs({ type: 'gpu:services', loaded: [sttWarm && 'stt', llmWarm && 'llm'].filter(Boolean), loading: [!sttWarm && 'stt', !llmWarm && 'llm'].filter(Boolean) });
      }
    } catch (err) {
      log.debug(`[gpu] Warmth poll failed: ${err instanceof Error ? err.message : err}`);
      consecutiveFailures++;
      if (consecutiveFailures >= 10) {
        log.warn('Health check failed 10 consecutive times — marking unhealthy');
        updateGpuModelWarmth({ stt_ready: false, llm_ready: false });
      }
    }
    warmthPollCount++;
    // Adaptive warmth polling: 10s for first 5 checks, then 20s
    const nextDelayMs = warmthPollCount <= 5 ? 10_000 : 20_000;
    warmthMonitorTimer = setTimeout(poll, nextDelayMs);
  };

  warmthMonitorTimer = setTimeout(poll, 5_000); // first check after 5s (not 20s)
}

export function startGpuMonitoring() {
  stopGpuMonitoring();
  monitorConsecFails = 0;
  monitorDelayMs = GPU_MONITOR_INTERVAL_MS;
  monitorBackoffMaxAlerted = false;
  monitorCrashRecoveryAttempts = 0;
  // Reset idle clock so the timer starts fresh from GPU-ready, not from last session's request.
  // Without this, a pod that boots 12 min after the previous session's last request immediately
  // hits the 10-min idle timeout and self-terminates.
  setLastModelRequestTime(Date.now());
  scheduleNextMonitorProbe();
}

export function scheduleNextMonitorProbe() {
  setMonitorInterval(setTimeout(async () => {
    if (monitorRunning) { scheduleNextMonitorProbe(); return; }
    // If status is 'error' but a pod exists, clean up the orphaned pod
    if (deployState.status === 'error' && deployState.podId) {
      log.warn(`[gpu] Monitor: deploy in error state but pod ${deployState.podId} exists on ${deployState.provider} — cleaning up orphaned pod`);
      try { await autoTerminateGpu('orphan_cleanup'); } catch (e) { log.warn('[gpu] Orphan cleanup failed:', e); }
      return; // Don't reschedule — pod is gone
    }
    if (deployState.status !== 'ready' || !deployState.endpoint) { scheduleNextMonitorProbe(); return; }
    monitorRunning = true;
    try {
      // Pod status check — detect EXITED pods proactively (RunPod spending limits, crashes, etc.)
      if (activeProvider === 'runpod' && deployApiKey && deployState.podId) {
        try {
          const detail = await (runpod as RunpodClient).getInstanceDetail(deployState.podId, { apiKey: deployApiKey });
          if (detail?.desiredStatus === 'EXITED') {
            log.warn(`[gpu] RunPod pod ${deployState.podId} EXITED — attempting auto-restart...`);
            try {
              await runpod.startInstance(deployState.podId, { apiKey: deployApiKey });
              log.log(`[gpu] Pod ${deployState.podId} auto-restart initiated`);
              setDeployState({ alert: `Pod exited unexpectedly — auto-restart initiated` });
              monitorDelayMs = 30_000; // Give it time to boot
            } catch (restartErr) {
              log.error(`[gpu] Auto-restart failed: ${restartErr instanceof Error ? restartErr.message : restartErr}`);
              setDeployState({ status: 'error', message: `Pod exited and auto-restart failed: ${restartErr instanceof Error ? restartErr.message : restartErr}` });
            }
            monitorRunning = false;
            scheduleNextMonitorProbe();
            return;
          }
        } catch { /* best-effort pod status check */ }
      }

      // Health probe — returnData: true to also extract warmth info
      const probeResult = await probeGpuHealth(deployState.endpoint, true);
      const healthy = probeResult.ok;
      if (healthy && probeResult.data) {
        updateGpuModelWarmth(probeResult.data);
        // Populate GPU hardware info from /health if not already known (e.g. Modal)
        if (!deployState.gpuType && probeResult.data.gpu_type) {
          setDeployState({ gpuType: String(probeResult.data.gpu_type) });
        }
        if (probeResult.data.gpu_vram_gb && !deployState.providerMeta?.gpuVramGb) {
          setDeployState({ providerMeta: { ...deployState.providerMeta, gpuVramGb: Number(probeResult.data.gpu_vram_gb) } });
        }

        // ── GPU hardware metrics parsing (temperature, utilization, memory) ──
        parseAndStoreGpuMetrics(probeResult.data);

        // Activate full GPU pipeline when STT + LLM become warm (staged boot)
        if (isStageWarm('stt') && isStageWarm('llm') && !translationDefaults.gpuEndpoint && !isReadinessCheckInProgress() && deployState.endpoint) {
          log.log('[gpu] STT + LLM warm — running readiness benchmark via monitor');
          stopWarmthMonitor();
          const ep = deployState.endpoint;
          _startReadinessCheck(ep);
        }
      }
      if (healthy) {
        markGpuHealthy();
        monitorConsecFails = 0;
        monitorDelayMs = GPU_MONITOR_INTERVAL_MS;
        monitorBackoffMaxAlerted = false;
        // If health data indicates active training/work, treat as "not idle"
        // (prevents idle timeout from killing fine-tuning or long-running jobs)
        // Also: model_loaded=false means the pod is actively initializing (e.g. downloading
        // a 28GB model from HuggingFace) — keep the idle timer fresh so it doesn't get
        // auto-stopped before it can serve requests.
        if (probeResult.data && (
          (probeResult.data as Record<string, unknown>).training ||
          (probeResult.data as Record<string, unknown>).model_loaded === false
        )) {
          setLastRequestTime(Date.now());
        }
      } else {
        monitorConsecFails++;
        // Only mark unhealthy after 2+ consecutive failures to tolerate
        // transient timeouts when GPU is under heavy load (e.g. benchmark)
        if (monitorConsecFails >= 2) {
          markGpuUnhealthy('health probe failed');
        } else {
          log.log(`[gpu] Health probe failed (1st), will retry before marking unhealthy`);
        }
        if (monitorConsecFails >= 3) {
          monitorDelayMs = Math.min(monitorDelayMs * 2, 120_000);
          log.log(`[gpu] Health probe failed ${monitorConsecFails}x, backing off to ${monitorDelayMs / 1000}s`);
          if (monitorDelayMs >= 120_000 && !monitorBackoffMaxAlerted) {
            monitorBackoffMaxAlerted = true;
            log.warn('[gpu] WARNING: GPU health probe has backed off to maximum interval (120s). Pod may be unreachable.');
          }
          // Record crash in host reputation at threshold (5 consecutive failures = likely crash)
          if (monitorConsecFails === 5 && deployState.provider) {
            recordHostCrash(deployState.provider, deployState.gpuType, deployState.providerMeta);
          }
          // Auto-restart: attempt to restart the pod before declaring it dead
          if (monitorConsecFails === 5 && deployState.podId) {
            const restartProvider = activeProvider === 'runpod' ? runpod : activeProvider === 'vast' ? vast : null;
            if (restartProvider && (deployApiKey || deployVastApiKey)) {
              const restartKey = activeProvider === 'runpod' ? deployApiKey : deployVastApiKey;
              try {
                log.log(`[gpu] Auto-restart attempt for ${activeProvider} pod ${deployState.podId}...`);
                await restartProvider.startInstance(deployState.podId, { apiKey: restartKey });
                log.log(`[gpu] Auto-restart initiated for pod ${deployState.podId} — resetting health counter`);
                monitorConsecFails = 0;
                monitorDelayMs = 30_000; // Give it time to boot
                setDeployState({ alert: `Pod auto-restarted after 5 health failures` });
              } catch (restartErr) {
                log.error(`[gpu] Auto-restart failed for pod ${deployState.podId}: ${restartErr instanceof Error ? restartErr.message : restartErr}`);
              }
            }
          }

          // Auto-redeploy on crash with different provider: after 10 consecutive failures
          // (restart at 5 didn't help), try redeploying on a different provider
          if (monitorConsecFails === 10 && getAutoRecoveryEnabled()) {
            const maxRetries = getAutoRecoveryMaxRetries() || MAX_MONITOR_CRASH_RECOVERY;
            if (monitorCrashRecoveryAttempts < maxRetries) {
              const crashedProvider = deployState.provider;
              monitorCrashRecoveryAttempts++;
              log.warn(`[gpu] Auto-recovery: redeploying on different provider after crash on ${crashedProvider} (attempt ${monitorCrashRecoveryAttempts}/${maxRetries})`);
              broadcastWs({
                type: 'gpu:deploy', phase: 'crash_recovery',
                deployId: deployState.deployId,
                crashedProvider,
                attempt: monitorCrashRecoveryAttempts,
                maxAttempts: maxRetries,
              });

              // Terminate the crashed pod and redeploy via the existing auto-recovery flow
              try {
                await autoTerminateGpu('crash_recovery');
                const { startAutoRecoveryDeploy } = await import('./gpu-auto-recovery');
                await startAutoRecoveryDeploy();
                log.log(`[gpu] Auto-recovery deploy initiated (attempt ${monitorCrashRecoveryAttempts}) — crashed provider: ${crashedProvider}`);
              } catch (recoveryErr) {
                log.error(`[gpu] Auto-recovery deploy failed: ${recoveryErr instanceof Error ? recoveryErr.message : recoveryErr}`);
                broadcastWs({ type: 'gpu:deploy', phase: 'crash_recovery_failed', deployId: deployState.deployId, error: recoveryErr instanceof Error ? recoveryErr.message : 'unknown' });
              }
              monitorRunning = false;
              return; // Stop monitoring — the new deploy will start its own monitor
            } else {
              log.error(`[gpu] Auto-recovery exhausted (${monitorCrashRecoveryAttempts}/${maxRetries} attempts) — giving up`);
              broadcastWs({ type: 'gpu:deploy', phase: 'crash_recovery_exhausted', deployId: deployState.deployId, attempts: monitorCrashRecoveryAttempts });
            }
          }
        }
        // Balance check for RunPod — low balance causes pods to be auto-terminated
        if (activeProvider === 'runpod' && deployApiKey && monitorConsecFails >= 2) {
          try {
            const bal = await runpod.checkBalance({ apiKey: deployApiKey });
            if (bal) {
              const hoursLeft = deployState.costPerHr > 0 ? bal.balance / deployState.costPerHr : 999;
              if (bal.balance < 2.0 || hoursLeft < 2) {
                const msg = `RunPod balance low: $${bal.balance.toFixed(2)} (~${hoursLeft.toFixed(1)}h left) — pod may be auto-stopped. Add funds: https://${BILLING_URLS.runpod}`;
                log.warn(`[gpu] ${msg}`);
                setDeployState({ alert: msg });
              }
            }
          } catch { /* balance check is best-effort */ }
        }
        // If TensorDock, check balance — low balance causes VMs to be reclaimed
        if (activeProvider === 'tensordock' && deployTensordockApiKey && deployTensordockAuthId) {
          try {
            const bal = await tensordock.checkBalance({ apiKey: deployTensordockApiKey, authId: deployTensordockAuthId });
            if (bal) {
              log.log(`[gpu] TensorDock balance: $${bal.balance.toFixed(2)} (hourly: $${bal.hourlyCost.toFixed(3)})`);
              if (bal.balance < 1.0) {
                const msg = `TensorDock balance low: $${bal.balance.toFixed(2)} — VM may have been reclaimed. Add funds: https://${BILLING_URLS.tensordock}`;
                log.warn(`[gpu] ${msg}`);
                setDeployState({ alert: msg });
              }
            }
          } catch { /* balance check is best-effort */ }
        }
      }

      // Budget tracking: accumulate GPU spend with enforcement
      if (deployState.costPerHr > 0) {
        const today = new Date().toISOString().slice(0, 10);
        if (today !== dailySpendResetDate) { setDailyGpuSpendUsd(0); setDailySpendResetDate(today); budgetSoftWarned = false; budgetWarned50 = false; }
        // Use actual elapsed time since last probe instead of assuming monitorDelayMs
        const actualElapsedMs = lastBudgetCalcTime > 0 ? Date.now() - lastBudgetCalcTime : monitorDelayMs;
        lastBudgetCalcTime = Date.now();
        setDailyGpuSpendUsd(dailyGpuSpendUsd + deployState.costPerHr * (actualElapsedMs / 1000 / 3600));
        if (DAILY_BUDGET_USD > 0) {
          const pct = dailyGpuSpendUsd / DAILY_BUDGET_USD;
          const forecast = dailyGpuSpendUsd + (deployState.costPerHr * (24 - new Date().getUTCHours()));
          if (pct >= 1.0) {
            // HARD BUDGET: auto-terminate to prevent overspend
            log.error(`[budget] HARD LIMIT: $${dailyGpuSpendUsd.toFixed(2)} >= $${DAILY_BUDGET_USD.toFixed(2)} — auto-terminating GPU`);
            broadcastWs({ type: 'gpu:budget', action: 'hard-limit', spend: dailyGpuSpendUsd, budget: DAILY_BUDGET_USD });
            emitGatewayEvent('budget.exceeded', { spend: +dailyGpuSpendUsd.toFixed(2), budget: DAILY_BUDGET_USD });
            await autoTerminateGpu('budget_exceeded');
            return;
          } else if (pct >= 0.8 && !budgetSoftWarned) {
            // SOFT BUDGET: warn + block new deploys
            budgetSoftWarned = true;
            log.warn(`[budget] SOFT LIMIT: $${dailyGpuSpendUsd.toFixed(2)} (${Math.round(pct * 100)}% of $${DAILY_BUDGET_USD.toFixed(2)}) — new deploys blocked`);
            broadcastWs({ type: 'gpu:budget', action: 'soft-limit', spend: dailyGpuSpendUsd, budget: DAILY_BUDGET_USD, forecast });
            emitGatewayEvent('budget.critical', { pct: 80, spend: +dailyGpuSpendUsd.toFixed(2), budget: DAILY_BUDGET_USD });
          } else if (pct >= 0.5 && !budgetWarned50) {
            // 50% warning: informational alert
            budgetWarned50 = true;
            emitGatewayEvent('budget.warning', { pct: 50, spend: +dailyGpuSpendUsd.toFixed(2), budget: DAILY_BUDGET_USD });
          }

          // Continuous spend forecast: warn early when projected EOD spend will exceed budget
          const hoursRemainingToday = 24 - new Date().getUTCHours() - (new Date().getUTCMinutes() / 60);
          const forecastEod = dailyGpuSpendUsd + (deployState.costPerHr * hoursRemainingToday);
          const forecastPct = forecastEod / DAILY_BUDGET_USD;
          if (forecastPct > 0.8 && pct < 0.5) {
            log.warn(`[budget] Forecast: $${forecastEod.toFixed(2)} by EOD (budget: $${DAILY_BUDGET_USD.toFixed(2)}) — current spend only ${Math.round(pct * 100)}%`);
            broadcastWs({
              type: 'gpu:budget_forecast',
              forecastEod: Math.round(forecastEod * 100) / 100,
              budget: DAILY_BUDGET_USD,
              pct: Math.round(forecastPct * 100),
              currentSpend: Math.round(dailyGpuSpendUsd * 100) / 100,
            });
          }
        }
      }

      // Latency trend prediction: detect degradation slope before P95 threshold is hit
      const TREND_WINDOW = 5;
      for (const stage of ['stt', 'llm', 'tts'] as const) {
        const ring = perStageLatencyRing[stage];
        if (ring.length >= TREND_WINDOW) {
          const recent = ring.slice(-TREND_WINDOW);
          const older = ring.slice(-TREND_WINDOW * 2, -TREND_WINDOW);
          if (older.length >= TREND_WINDOW) {
            const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
            const olderAvg = older.reduce((s, v) => s + v, 0) / older.length;
            const trend = (recentAvg - olderAvg) / olderAvg;
            if (trend > 0.2) { // 20%+ increase
              log.warn(`[gpu] Latency trend warning: ${stage} increasing ${Math.round(trend * 100)}% (${Math.round(olderAvg)}ms → ${Math.round(recentAvg)}ms)`);
              broadcastWs({ type: 'gpu:latency-trend', stage, trend: Math.round(trend * 100), oldAvg: Math.round(olderAvg), newAvg: Math.round(recentAvg) });
            }
          }
        }
      }

      // P95 demotion check — only when GPU is in production and recently idle
      // Requires 3 consecutive violations before demoting (avoids false positives from transient spikes)
      if (isGpuReadyForProduction() && !isReadinessCheckInProgress()) {
        const idleSec = lastModelRequestTime > 0 ? (Date.now() - lastModelRequestTime) / 1000 : 0;
        if (lastModelRequestTime > 0 && idleSec > getP95IdleWindowSec()) {
          const targets = { stt: getSttTargetLatencyMs(), llm: getLlmTargetLatencyMs(), tts: getTtsTargetLatencyMs() };
          const multiplier = getP95DemotionMultiplier();
          for (const stage of ['stt', 'llm', 'tts'] as const) {
            const p95 = getPerStageP95(stage);
            const threshold = targets[stage] * multiplier;
            if (p95 !== null && p95 > threshold) {
              p95ViolationCount[stage] = (p95ViolationCount[stage] || 0) + 1;
              if (p95ViolationCount[stage] >= P95_DEMOTION_CONSECUTIVE_VIOLATIONS) {
                log.warn(`[gpu] P95 degraded: ${stage} ${p95}ms > ${threshold}ms (${p95ViolationCount[stage]} consecutive) — demoting`);
                setServiceReadiness(stage, { phase: 'degraded' });
                broadcastWs({ type: 'gpu:readiness', stage, phase: 'degraded', p95Ms: p95, thresholdMs: threshold });
                broadcastProviderStatus('booting', 'cloud', `GPU ${stage} P95 degraded — re-benchmarking`);
                setGpuReadyForProduction(false);
                p95ViolationCount = { stt: 0, llm: 0, tts: 0 };
                _startReadinessCheck(deployState.endpoint);
                break;
              } else {
                log.log(`[gpu] P95 warning: ${stage} ${p95}ms > ${threshold}ms (${p95ViolationCount[stage]}/${P95_DEMOTION_CONSECUTIVE_VIOLATIONS})`);
              }
            } else {
              // Reset violation counter for this stage when P95 is within threshold
              p95ViolationCount[stage] = 0;
            }
          }
        }
      }

      // Idle check — only model requests (STT/LLM/TTS/pipeline) count, not status polls
      const _idleBase = lastModelRequestTime > 0 ? lastModelRequestTime : lastRequestTime;
      if (_idleBase > 0) {
        const idleMs = Date.now() - _idleBase;
        if (idleMs >= IDLE_TIMEOUT_MS) {
          const idleMin = Math.round(idleMs / 60_000);
          log.log(`[gpu] Idle ${idleMin} min (no model requests) — auto-stopping (pausing) to save costs`);
          broadcastWs({ type: 'gpu:idle', deployId: deployState.deployId, idleMs, timeoutMs: IDLE_TIMEOUT_MS, action: 'stop' });
          await autoStopGpu();
          return;
        }
        // Warn at 75% of idle timeout (gives user chance to send a request)
        if (idleMs >= IDLE_TIMEOUT_MS * 0.75 && !idleWarned) {
          idleWarned = true;
          const remainingSec = Math.round((IDLE_TIMEOUT_MS - idleMs) / 1000);
          log.log(`[gpu] Idle warning: ${remainingSec}s until auto-terminate`);
          broadcastWs({ type: 'gpu:idle', deployId: deployState.deployId, idleMs, timeoutMs: IDLE_TIMEOUT_MS, action: 'warning', remainingSec });
        }
        // Adaptive monitor frequency during idle: slow down polling to save overhead
        if (idleMs > 60_000 && monitorDelayMs < 60_000) {
          monitorDelayMs = 60_000; // idle > 1min → check every 60s instead of 30s
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[gpu] Monitor probe failed (provider=${activeProvider}, pod=${deployState.podId}): ${msg}`);
    } finally {
      monitorRunning = false;
      scheduleNextMonitorProbe(); // always reschedule, even after errors
    }
  }, monitorDelayMs) as unknown as Timer);
}

export function stopGpuMonitoring() {
  if (monitorInterval) { clearTimeout(monitorInterval as unknown as ReturnType<typeof setTimeout>); setMonitorInterval(null); }
  monitorConsecFails = 0;
  monitorDelayMs = GPU_MONITOR_INTERVAL_MS;
  setGpuHealthy(false);
}

// ── Destroy timer — deletes pod N hours after auto-stop ─────────────────────
let destroyTimer: Timer | null = null;

function scheduleAutoDestroy(delayMs: number) {
  clearAutoDestroyTimer();
  const provider = activeProvider;
  const podId = deployState.podId;
  log.log(`[gpu] Auto-destroy scheduled in ${Math.round(delayMs / 60_000)} min for ${provider} pod ${podId}`);
  destroyTimer = setTimeout(async () => {
    log.log(`[gpu] Auto-destroy triggered — deleting stopped pod ${podId} (${provider})`);
    broadcastWs({ type: 'gpu:idle', action: 'destroy', deployId: deployState.deployId, provider, podId });
    await autoTerminateGpu('auto_destroy');
  }, delayMs) as unknown as Timer;
}

export function clearAutoDestroyTimer() {
  if (destroyTimer) { clearTimeout(destroyTimer as unknown as ReturnType<typeof setTimeout>); destroyTimer = null; }
}

/** Reason why a GPU instance was stopped or terminated. */
export type DeleteReason =
  | 'idle_timeout'
  | 'manual_stop'
  | 'manual_terminate'
  | 'health_failed'
  | 'budget_exceeded'
  | 'crash_recovery'
  | 'race_loser'
  | 'deploy_cancelled'
  | 'orphan_cleanup'
  | 'auto_destroy';

/**
 * Automatically stop (pause) the active GPU pod when idle or on a trigger.
 *
 * Preserves disk/data — the pod can be resumed quickly (~19s on Vast.ai)
 * instead of a full cold boot (~288s). No hourly charges while stopped.
 * After stopping, schedules an auto-destroy timer (IDLE_DESTROY_MS) to
 * permanently terminate the pod if not resumed.
 *
 * Falls back to `autoTerminateGpu` if stop fails or no credentials are available.
 *
 * @param reason - Why the stop was triggered (e.g. 'idle_timeout', 'budget_exceeded')
 */
export async function autoStopGpu(reason: DeleteReason = 'idle_timeout') {
  const provider = activeProvider;
  const podId = deployState.podId;

  if (!podId || !provider) {
    log.warn('[gpu] autoStopGpu: no active pod to stop');
    await autoTerminateGpu(reason);
    return;
  }

  // Resolve credentials (apiKey is overwritten below based on provider)
  const credentials: ProviderCredentials = { apiKey: '' };
  let client: GpuProviderClient | null = null;
  if (provider === 'runpod' && deployApiKey) {
    client = runpod; credentials.apiKey = deployApiKey;
  } else if (provider === 'vast' && deployVastApiKey) {
    client = vast; credentials.apiKey = deployVastApiKey;
  } else if (provider === 'tensordock' && deployTensordockApiKey) {
    client = tensordock; credentials.apiKey = deployTensordockApiKey; credentials.authId = deployTensordockAuthId;
  } else if (provider === 'modal' && deployModalApiKey) {
    client = modal; credentials.apiKey = deployModalApiKey;
  }

  if (!client) {
    log.warn(`[gpu] autoStopGpu: no client for ${provider} — falling back to terminate`);
    await autoTerminateGpu(reason);
    return;
  }

  try {
    await client.stopInstance(podId, credentials);
    log.log(`[gpu] Pod ${podId} stopped (paused) on ${provider} — disk preserved, no charges`);
    logGpuEvent('instance_stopped', provider, true, { metadata: { podId, reason } });
    emitGatewayEvent('gpu.stopped', { deployId: deployState.deployId, podId, provider, reason });
  } catch (err) {
    const deployErr = categorizeDeployError(err, {
      deployId: deployState.deployId,
      provider,
      gpuType: deployState.gpuType,
      imageName: deployState.dockerImage,
    });
    errorSummary.record(deployErr, deployState.deployId);
    const remediation = await tryAutoRemediation(deployErr);
    if (remediation) {
      log.warn({ action: remediation.action, suggestions: remediation.suggestions }, 'Auto-remediation attempted');
    }
    log.error({ code: deployErr.code, category: deployErr.category }, deployErr.message);
    await autoTerminateGpu(reason);
    return;
  }

  broadcastProviderStatus('offline', 'cloud', `GPU idle → stopped (paused). Auto-destroy in ${Math.round(IDLE_DESTROY_MS / 60_000)} min.`);
  stopGpuMonitoring();
  stopWarmthMonitor();
  updateActivePipeline({ gpuEndpoint: undefined }, 'idleStop');

  // Transition to 'stopped' — preserves pod info for fast resume (19s vs 288s cold boot).
  // The stopped state is distinct from 'idle' so the status API, auto-resume trigger,
  // and UI can distinguish "never deployed" from "paused and resumable".
  const gpuType = deployState.gpuType;
  const costPerHr = deployState.costPerHr;
  const dockerImage = deployState.dockerImage;
  deploymentSM.markStopped(podId, provider, gpuType, costPerHr, dockerImage);
  setDeployState({
    status: 'stopped',
    message: `Pod stopped (idle ${Math.round(IDLE_TIMEOUT_MS / 60_000)} min). Will be destroyed in ${Math.round(IDLE_DESTROY_MS / 60_000)} min if not resumed.`,
    podId,
    provider,
  });

  // Schedule auto-destroy
  scheduleAutoDestroy(IDLE_DESTROY_MS);
}

/**
 * Resume a stopped pod, or fall back to a fresh deploy if resume fails.
 *
 * This is the core cold-boot optimization: a stopped pod resumes in ~19s
 * (validated on Vast.ai, 2026-04-08). If the host was reclaimed, the pod
 * was GC'd, or any other error occurs, we transparently fall back to a
 * standard deploy via the existing tier cascade + hedged deploy flow.
 *
 * Callers get `method: 'resumed' | 'fresh_deploy'` in the return value
 * so they can log/display which path was taken.
 */
export async function resumeOrDeploy(opts: {
  reason: 'autoscaler' | 'manual';
  requestId?: string;
}): Promise<{ method: 'resumed' | 'fresh_deploy'; podId: string; provider: string }> {
  const podId = deployState.podId;
  const provider = deployState.provider as ProviderName;
  const dockerImage = deployState.dockerImage;

  if (!podId || !provider) {
    throw new Error('No stopped pod to resume (podId or provider missing)');
  }

  // Resolve provider client + credentials (same pattern as autoStopGpu)
  const credentials: ProviderCredentials = { apiKey: '' };
  let client: GpuProviderClient | null = null;
  if (provider === 'runpod' && deployApiKey) {
    client = runpod; credentials.apiKey = deployApiKey;
  } else if (provider === 'vast' && deployVastApiKey) {
    client = vast; credentials.apiKey = deployVastApiKey;
  } else if (provider === 'tensordock' && deployTensordockApiKey) {
    client = tensordock; credentials.apiKey = deployTensordockApiKey; credentials.authId = deployTensordockAuthId;
  } else if (provider === 'modal' && deployModalApiKey) {
    client = modal; credentials.apiKey = deployModalApiKey;
  }

  if (!client) {
    throw new Error(`No credentials for provider ${provider} — cannot resume`);
  }

  // ── Attempt resume ──────────────────────────────────────────────────────
  clearAutoDestroyTimer();
  broadcastWs({ type: 'gpu:resume', action: 'attempting', deployId: deployState.deployId, podId, provider, reason: opts.reason });
  log.log(`[gpu] resumeOrDeploy: attempting resume of ${provider} pod ${podId} (reason=${opts.reason})`);

  try {
    await client.startInstance(podId, credentials);
    log.log(`[gpu] Resume succeeded: ${provider} pod ${podId}`);

    // Resolve endpoint
    let endpoint = '';
    try {
      const info = await (client as any).resolveInstanceEndpoint?.(podId, credentials);
      if (info?.endpoint) endpoint = info.endpoint;
    } catch { /* best-effort: cleanup or optional side-effect */ }
    if (!endpoint) endpoint = deployState.endpoint; // fallback to last known

    // Transition to booting
    setDeployState({
      status: 'booting',
      podId,
      endpoint,
      provider,
      message: 'Pod resumed — waiting for health check',
      startedAt: Date.now(),
    });
    deploymentSM.startBooting(podId);
    startGpuMonitoring();
    logGpuEvent('instance_resumed', provider, true, { metadata: { podId, reason: opts.reason } });
    broadcastWs({ type: 'gpu:resume', action: 'success', deployId: deployState.deployId, podId, provider });

    return { method: 'resumed', podId, provider };
  } catch (resumeErr) {
    const deployErr = categorizeDeployError(resumeErr, {
      deployId: deployState.deployId,
      provider,
      gpuType: deployState.gpuType,
      imageName: dockerImage,
    });
    errorSummary.record(deployErr, deployState.deployId);
    const remediation = await tryAutoRemediation(deployErr);
    if (remediation) {
      log.warn({ action: remediation.action, suggestions: remediation.suggestions }, 'Auto-remediation attempted');
    }
    log.error({ code: deployErr.code, category: deployErr.category }, deployErr.message);
    logGpuEvent('resume_failed', provider, false, { metadata: { podId, reason: opts.reason, error: deployErr.message } });
    broadcastWs({ type: 'gpu:resume', action: 'fallback', deployId: deployState.deployId, podId, provider, error: deployErr.message });

    // ── Clean up the orphaned stopped pod ──────────────────────────────
    try {
      await client.deleteInstance(podId, credentials);
      log.log(`[gpu] Cleaned up orphaned pod ${podId} on ${provider}`);
    } catch (cleanupErr) {
      // Non-fatal — pod may already be gone (which is why resume failed)
      const cleanupDeployErr = categorizeDeployError(cleanupErr, {
        deployId: deployState.deployId,
        provider,
        gpuType: deployState.gpuType,
      });
      errorSummary.record(cleanupDeployErr, deployState.deployId);
      const remediation = await tryAutoRemediation(cleanupDeployErr);
      if (remediation) {
        log.warn({ action: remediation.action, suggestions: remediation.suggestions }, 'Auto-remediation attempted');
      }
      log.error({ code: cleanupDeployErr.code, category: cleanupDeployErr.category }, cleanupDeployErr.message);
    }

    // ── Fall back to fresh deploy ─────────────────────────────────────
    const { buildGpuTiers, startDeployWithTiers } = await import('./gpu-deploy');
    const { getGpuPriorityList } = await import('../src/gpu-providers/deploy-settings');
    const {
      setDeployApiKey: _setDeployApiKey, setDeployVastApiKey: _setDeployVastApiKey,
      setDeployTensordockApiKey: _setDeployTensordockApiKey, setDeployTensordockAuthId: _setDeployTensordockAuthId,
      setDeployModalApiKey: _setDeployModalApiKey,
    } = await import('./state');

    // Save API keys BEFORE reset (resetDeployState clears them)
    const savedKeys = {
      runpod: deployApiKey,
      vast: deployVastApiKey,
      tensordock: deployTensordockApiKey ? { apiKey: deployTensordockApiKey, authId: deployTensordockAuthId } : undefined,
      modal: deployModalApiKey,
    };

    resetDeployState();

    // Restore API keys after reset
    if (savedKeys.runpod) _setDeployApiKey(savedKeys.runpod);
    if (savedKeys.vast) _setDeployVastApiKey(savedKeys.vast);
    if (savedKeys.tensordock) {
      _setDeployTensordockApiKey(savedKeys.tensordock.apiKey);
      _setDeployTensordockAuthId(savedKeys.tensordock.authId);
    }
    if (savedKeys.modal) _setDeployModalApiKey(savedKeys.modal);

    // Build tiers from saved credentials
    const tiers = buildGpuTiers(
      savedKeys.runpod,
      savedKeys.vast || undefined,
      savedKeys.tensordock,
      savedKeys.modal || undefined,
    );

    if (tiers.length === 0) {
      throw new Error('Resume failed and no provider tiers available for fresh deploy');
    }

    const image = dockerImage || 'marcosremar/babelcast-subtitle:latest';
    const gpuTypes = getGpuPriorityList();

    log.log(`[gpu] Starting fresh deploy as fallback (image=${image}, tiers=${tiers.length})`);
    await startDeployWithTiers(tiers, image, gpuTypes, {});

    return {
      method: 'fresh_deploy',
      podId: deployState.podId,
      provider: deployState.provider,
    };
  }
}

/**
 * Permanently terminate the active GPU instance across all providers.
 *
 * Stops monitoring, closes SSH tunnels, resets deploy state, and cleans up
 * provider resources (RunPod pods, Vast.ai instances, TensorDock instances,
 * Modal apps). Broadcasts the termination event and updates the deploy session.
 *
 * Unlike `autoStopGpu`, this destroys the instance permanently — data is lost
 * and a full cold boot is required to restart.
 *
 * @param reason - Why the termination was triggered (e.g. 'idle_timeout', 'budget_exceeded', 'manual')
 */
export async function autoTerminateGpu(reason: DeleteReason = 'idle_timeout') {
  clearAutoDestroyTimer();
  const rpKey = deployApiKey;
  const vastKey = deployVastApiKey;
  const tdKey = deployTensordockApiKey;
  const tdAuthId = deployTensordockAuthId;
  const modalKey = deployModalApiKey;
  const provider = activeProvider;
  const podId = deployState.podId;
  broadcastProviderStatus('offline', 'cloud', `GPU terminated (${reason})`);
  stopGpuMonitoring();
  // Close all SSH tunnels to prevent orphaned ssh processes
  try { const { closeAllTunnels } = await import('./ssh-tunnel'); closeAllTunnels(); } catch { /* best-effort: cleanup or optional side-effect */ }
  stopWarmthMonitor();
  resetDeployState();
  updateActivePipeline({ gpuEndpoint: undefined }, reason);
  if (provider === 'modal' && modalKey && podId) {
    log.log(`[gpu] Modal ${reason} → stopping app ${podId}`);
    try {
      await modal.stopInstance(podId, { apiKey: modalKey });
      log.log(`[gpu] Modal app ${podId} stopped`);
      logGpuEvent('instance_stopped', 'modal', true, { metadata: { podId, reason } });
    } catch (err) {
      const deployErr = categorizeDeployError(err, {
        deployId: deployState.deployId,
        provider: 'modal',
        gpuType: deployState.gpuType,
      });
      errorSummary.record(deployErr, deployState.deployId);
      const remediation = await tryAutoRemediation(deployErr);
      if (remediation) {
        log.warn({ action: remediation.action, suggestions: remediation.suggestions }, 'Auto-remediation attempted');
      }
      log.error({ code: deployErr.code, category: deployErr.category }, deployErr.message);
      await cleanupModalApps(modalKey);
    }
  } else if (provider === 'tensordock' && tdKey && podId) {
    // TensorDock: STOP (pause) instead of delete — preserves disk, fast restart
    log.log(`[gpu] TensorDock ${reason} → stopping (pausing) instance ${podId}`);
    try {
      await tensordock.stopInstance(podId, { apiKey: tdKey, authId: tdAuthId });
      log.log(`[gpu] TensorDock instance ${podId} stopped (paused, disk preserved)`);
      logGpuEvent('instance_stopped', 'tensordock', true, { metadata: { podId, reason } });
    } catch (err) {
      const deployErr = categorizeDeployError(err, {
        deployId: deployState.deployId,
        provider: 'tensordock',
        gpuType: deployState.gpuType,
      });
      errorSummary.record(deployErr, deployState.deployId);
      const remediation = await tryAutoRemediation(deployErr);
      if (remediation) {
        log.warn({ action: remediation.action, suggestions: remediation.suggestions }, 'Auto-remediation attempted');
      }
      log.error({ code: deployErr.code, category: deployErr.category }, deployErr.message);
      await cleanupTensordockInstances(tdKey, tdAuthId);
    }
  } else if (provider === 'vast' && vastKey) {
    await cleanupVastInstances(vastKey);
    logGpuEvent('instance_stopped', 'vast', true, { metadata: { reason } });
  } else if (rpKey) {
    await cleanupAllPods(rpKey);
    logGpuEvent('instance_stopped', 'runpod', true, { metadata: { podId, reason } });
  }
  emitGatewayEvent('gpu.terminated', { deployId: deployState.deployId, podId, provider, reason });
  updateDeploySession({ status: 'stopped', stoppedAt: new Date() });
}
