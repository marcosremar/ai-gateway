// ── BabelCast Gateway — GPU Deploy Orchestration ─────────────────────────────
// Core deploy loop, tier config, health polling, canary.
// Extracted modules:
//   gpu-health-monitor.ts — monitoring, idle, budget, auto-stop/terminate
//   gpu-orphan-cleanup.ts — orphan sweep, cleanupAllPods
//   gpu-type-cache.ts     — GPU type cache refresh + validation
//   gpu-auto-select.ts    — cheapest GPU selection/ranking
//   gpu-deploy-race.ts    — hedged (race) deploy
//   gpu-auto-recovery.ts  — startup recovery, auto-recovery, logs, verified types

import { homedir } from 'os';
import { join } from 'path';
import type { GpuProviderClient, GpuOffer, ProviderCredentials } from '../src/gpu-providers/types';
import { RunpodClient } from '../src/gpu-providers/runpod-client';
import { ProviderCooldownTracker, cleanupProviderInstances, PROVIDER_LABELS, DEFAULT_STORAGE_GB } from '../src/gpu-providers/deploy-orchestrator';
import type { ProviderName, GpuTier } from '../src/gpu-providers/deploy-orchestrator';
import { probeGpuHealth } from '../src/autoscaler/health';
import { categorizeDeployError } from '../src/errors/deploy-errors';
import { errorSummary } from '../src/error-summary';
import { tryAutoRemediation } from '../src/auto-remediation';
import { runPreFlightChecks } from '../src/preflight-checks';
import {
  prisma,
  deployState, setDeployState, deployCancelled, setDeployApiKey, setDeployVastApiKey,
  setDeployTensordockApiKey, setDeployTensordockAuthId, setDeployModalApiKey,
  activeProvider, setActiveProvider, setGpuHealthy, gpuHealthy, setLastRequestTime,
  monitorInterval, setMonitorInterval, deployApiKey, deployVastApiKey,
  deployTensordockApiKey, deployTensordockAuthId, deployModalApiKey,
  resetDeployState, lastRequestTime, lastModelRequestTime, setLastModelRequestTime,
  DAILY_BUDGET_USD, dailyGpuSpendUsd, setDailyGpuSpendUsd, dailySpendResetDate, setDailySpendResetDate,
  deploymentSM,
  loadPersistedDeploy, clearPersistedDeploy, setDeployCancelled,
  updateGpuModelWarmth, isStageWarm,
  isGpuReadyForProduction, getPerStageP95, setGpuReadyForProduction, setServiceReadiness,
  perStageLatencyRing,
} from './state';
import {
  translationDefaults, updateActivePipeline, runpod, vast, tensordock, modal, snapgpu, markGpuHealthy, markGpuUnhealthy,
  markGpuShadowMode, markGpuWarmupFailed, _startReadinessCheck,
} from './providers';
import { isReadinessCheckInProgress } from './gpu-readiness';
import {
  getSttTargetLatencyMs, getLlmTargetLatencyMs, getTtsTargetLatencyMs,
  getP95DemotionMultiplier, getP95IdleWindowSec,
} from '../src/gpu-providers/deploy-settings';
import { logGpuEvent, startDeploySession, updateDeploySession, upsertHostReputation, loadReputations, loadReputationsByGpuType, deriveHostKey, recordHostCrash, updateHostLatency } from './metrics';
import { createLogger } from '../src/logger';
import { createCanaryDeploy, type CanaryConfig } from '../src/canary';
import { profileOperation, recordOperationTiming } from '../src/performance-profiler';

const log = createLogger('gpu-deploy');
import { getBestLatencyByGpuModel } from './latency-db';
import { getGpuSortBy, getDeployTimeoutMin, getDeployTimeoutMinForProvider, getGpuPriorityList, DEFAULT_GPU_PRIORITY, getAutoRecoveryEnabled, getAutoRecoveryMaxRetries } from '../src/gpu-providers/deploy-settings';
import {
  BLACKWELL_TO_STANDARD, STANDARD_TO_BLACKWELL,
  PROVIDER_CHAIN,
} from './config';
import { BILLING_URLS } from '../src/providers/errors';
import { broadcastProviderStatus, broadcastWs } from './ws-state';
import { emitGatewayEvent } from './event-bus';

// ── Re-exports from extracted modules ────────────────────────────────────────
export { GPU_TYPE_CACHE_TTL_MS, gpuTypeCacheRefreshTimer, refreshGpuTypeCache, validateGpuTypesFromCache, startGpuTypeCacheRefresh } from './gpu-type-cache';
export { POD_NAME_PREFIX, activeRaceInstanceIds, cleanupAllPods, cleanupVastInstances, cleanupTensordockInstances, cleanupModalApps, sweepOrphanInstances, startOrphanSweep, stopOrphanSweep } from './gpu-orphan-cleanup';
export { GPU_MONITOR_INTERVAL_MS, IDLE_TIMEOUT_MS, setIdleTimeoutMs, IDLE_DESTROY_MS, setIdleDestroyMs, resetIdleState, startGpuMonitoring, scheduleNextMonitorProbe, stopGpuMonitoring, clearAutoDestroyTimer, autoStopGpu, resumeOrDeploy, autoTerminateGpu, startBackgroundWarmthMonitor } from './gpu-health-monitor';
export type { DeleteReason } from './gpu-health-monitor';
export { autoSelectCheapestGpu } from './gpu-auto-select';
export { startDeployRace } from './gpu-deploy-race';
export { fetchGpuLogs, getVerifiedGpuTypes, tryRecoverActiveDeploy, startAutoRecoveryDeploy } from './gpu-auto-recovery';
export { pollHealthUntilReady, type PollHealthResult } from './gpu-poll-health';
import { pollHealthUntilReady } from './gpu-poll-health';
import type { PollHealthResult } from './gpu-poll-health';

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_DEPLOY_RETRIES = 2;
export const HEALTH_POLL_INTERVAL_MS = 10_000;
export const DEPLOY_TIMEOUT_MS = 45 * 60_000; // 45 min — large images (52GB) + models (70B) can take 30-40 min

// ── Canary deployment helper ────────────────────────────────────────────────

/**
 * Start canary deployment cycle after a successful deploy.
 * Called from each deploy success path. Evaluates canary health every 60s
 * and promotes/rollbacks based on error rate and latency thresholds.
 */
export function startCanaryIfEnabled(
  deployConfig: { canary?: boolean; canaryInitialTraffic?: number; canaryMaxErrorRate?: number; canaryTrafficStep?: number },
  dockerImage: string,
  gpuType: string,
): void {
  const canaryEnabled = process.env.CANARY_DEPLOY === '1' || deployConfig.canary === true;
  if (!canaryEnabled) return;

  const canaryConfig: CanaryConfig = {
    currentVersion: `stable-${dockerImage}`,
    canaryVersion: `canary-${dockerImage}`,
    initialTrafficPercentage: deployConfig.canaryInitialTraffic || 5,
    maxErrorRate: deployConfig.canaryMaxErrorRate || 0.05,
    trafficStep: deployConfig.canaryTrafficStep || 10,
  };

  const canary = createCanaryDeploy(canaryConfig);

  // Store canary controller in deploy state for monitoring
  setDeployState({ canary, canaryEvalTimer: null });

  log.log({ canaryConfig }, 'Canary deployment started');

  // Set up periodic evaluation
  const evalInterval = setInterval(async () => {
    const decision = canary.evaluate();
    if (decision.action === 'promote') {
      await canary.promote();
      log.log('Canary promoted to 100%');
      clearInterval(evalInterval);
      setDeployState({ canaryEvalTimer: null });
    } else if (decision.action === 'rollback') {
      await canary.rollback();
      log.error('Canary rolled back — errors exceeded threshold');
      clearInterval(evalInterval);
      setDeployState({ canaryEvalTimer: null });
    }
  }, 60_000); // Evaluate every minute

  setDeployState({ canaryEvalTimer: evalInterval });
}

/**
 * Clear canary evaluation timer and reset canary state.
 */
export function stopCanary(): void {
  if (deployState.canaryEvalTimer) {
    clearInterval(deployState.canaryEvalTimer as ReturnType<typeof setInterval>);
    setDeployState({ canaryEvalTimer: null });
  }
}

// ── Deploy loop ─────────────────────────────────────────────────────────────

export interface DeployExtra { region?: string; storageGb?: number; hfToken?: string; env?: Record<string, string>; interruptible?: boolean; dockerStartCmd?: string; onstart?: string; containerDiskInGb?: number; volumeId?: string; autoRecovery?: boolean; templateHashId?: string; forceSshTunnel?: boolean; snapgpuPreloadApp?: string; snapgpuAutoSnapshot?: boolean; snapgpuBackend?: 'vast' | 'runpod'; canary?: boolean; canaryInitialTraffic?: number; canaryMaxErrorRate?: number; canaryTrafficStep?: number; }


export async function startDeployLoop(
  providerClient: GpuProviderClient,
  providerName: ProviderName,
  apiKey: string,
  dockerImage: string,
  gpuTypes: string[],
  authId?: string,
  extra: DeployExtra = {},
) {
  // Import from extracted modules
  const { startGpuMonitoring, startBackgroundWarmthMonitor } = await import('./gpu-health-monitor');

  setDeployCancelled(false); // reset cancel flag from previous deploy
  setActiveProvider(providerName);
  const credentials: ProviderCredentials = { apiKey, authId };
  const startedAt = Date.now();
  const label = PROVIDER_LABELS[providerName];
  setDeployState({
    status: 'searching', startedAt, retryCount: 0, podId: '', endpoint: '', gpuType: '',
    message: `Searching for GPU on ${label}...`, step: 'searching_offers', stepDetail: gpuTypes.join(', '), provider: providerName,
    dockerImage,
  });
  broadcastWs({ type: 'gpu:deploy', phase: 'searching', deployId: deployState.deployId, provider: providerName, gpuTypes });

  // TensorDock: try to discover and resume a stopped instance first (fast restart)
  if (providerName === 'tensordock') {
    try {
      log.log(`[gpu] TensorDock: checking for existing instances to resume...`);
      const existing = await providerClient.discoverInstance(credentials, gpuTypes);
      if (existing && existing.instanceId) {
        log.log(`[gpu] TensorDock: found instance ${existing.instanceId} (status=${existing.status}, endpoint=${existing.endpoint || 'none'})`);
        const isStopped = ['stopped', 'paused', 'suspended'].includes(existing.status?.toLowerCase() ?? '');
        const isRunning = ['running', 'active'].includes(existing.status?.toLowerCase() ?? '');
        if (isStopped) {
          log.log(`[gpu] TensorDock: found stopped instance ${existing.instanceId} — resuming`);
          setDeployState({ message: `Resuming stopped TensorDock instance...`, step: 'creating_pod' });
          logGpuEvent('instance_resumed', 'tensordock', true, { metadata: { instanceId: existing.instanceId } });
          await providerClient.startInstance(existing.instanceId, credentials);
          // Resolve endpoint after start
          let endpoint = existing.endpoint || '';
          if (!endpoint) {
            const resolved = await providerClient.resolveInstanceEndpoint(existing.instanceId, credentials);
            if (resolved) endpoint = resolved;
          }
          setDeployState({
            status: 'booting', podId: existing.instanceId, endpoint,
            gpuType: existing.gpuType || '', step: 'waiting_health',
            message: `TensorDock instance resumed, waiting for /health...`,
          });
          deploymentSM.startBooting(existing.instanceId);
          const { result: res1, pullTimeS: pt1 } = await pollHealthUntilReady(providerClient, providerName, apiKey, existing.instanceId, endpoint, startedAt, dockerImage, existing.providerMeta as Record<string, unknown>);
          if (res1 === 'ready') {
            const durationMs = Date.now() - deployState.startedAt;
            setGpuHealthy(true);
            setLastRequestTime(Date.now());
            setDeployState({ status: 'ready', message: `GPU ready (${label}): ${deployState.endpoint}`, step: 'ready', stepDetail: '', deployDurationMs: durationMs });
            broadcastProviderStatus('booting', 'cloud', `GPU deployed — warming up models`);
            deploymentSM.markReady(deployState.podId, deployState.endpoint, deployState.gpuType, deployState.costPerHr);
            log.log(`[gpu] Deploy completed in ${(durationMs / 1000).toFixed(1)}s (pull=${pt1 ?? '?'}s, ${label})`);
            if (pt1 != null) {
              const { recordPullTime, deriveHostKey: dk } = await import('../src/gpu-providers/pull-time-estimator');
              dk(providerName, existing.providerMeta as Record<string, unknown>);
              recordPullTime(dockerImage, pt1, undefined, dk(providerName, existing.providerMeta as Record<string, unknown>), Math.round(durationMs / 1000));
            }
            startGpuMonitoring();
            startBackgroundWarmthMonitor(deployState.endpoint);
            startCanaryIfEnabled(extra, dockerImage, deployState.gpuType);
            return;
          }
          if (res1 === 'cancelled') { setDeployState({ status: 'error', message: 'Deploy cancelled' }); deploymentSM.markError('Deploy cancelled'); return; }
          log.log(`[gpu] Resumed TensorDock instance failed health check — creating new`);
        } else if (isRunning && existing.endpoint) {
          log.log(`[gpu] TensorDock: found running instance ${existing.instanceId} at ${existing.endpoint}`);
          setDeployState({
            status: 'booting', podId: existing.instanceId, endpoint: existing.endpoint,
            gpuType: existing.gpuType || '', step: 'waiting_health',
            message: `TensorDock instance already running, checking health...`,
          });
          deploymentSM.startBooting(existing.instanceId);
          const { result: res2, pullTimeS: pt2 } = await pollHealthUntilReady(providerClient, providerName, apiKey, existing.instanceId, existing.endpoint, startedAt, dockerImage, existing.providerMeta as Record<string, unknown>);
          if (res2 === 'ready') {
            const durationMs = Date.now() - deployState.startedAt;
            setGpuHealthy(true);
            setLastRequestTime(Date.now());
            setDeployState({ status: 'ready', message: `GPU ready (${label}): ${deployState.endpoint}`, step: 'ready', stepDetail: '', deployDurationMs: durationMs });
            broadcastProviderStatus('booting', 'cloud', `GPU deployed — warming up models`);
            deploymentSM.markReady(deployState.podId, deployState.endpoint, deployState.gpuType, deployState.costPerHr);
            log.log(`[gpu] Deploy completed in ${(durationMs / 1000).toFixed(1)}s (pull=${pt2 ?? '?'}s, ${label})`);
            if (pt2 != null) {
              const { recordPullTime, deriveHostKey: dk } = await import('../src/gpu-providers/pull-time-estimator');
              recordPullTime(dockerImage, pt2, undefined, dk(providerName, existing.providerMeta as Record<string, unknown>), Math.round(durationMs / 1000));
            }
            startGpuMonitoring();
            startBackgroundWarmthMonitor(deployState.endpoint);
            startCanaryIfEnabled(extra, dockerImage, deployState.gpuType);
            return;
          }
          if (res2 === 'cancelled') { setDeployState({ status: 'error', message: 'Deploy cancelled' }); deploymentSM.markError('Deploy cancelled'); return; }
          log.log(`[gpu] Running TensorDock instance not healthy — creating new`);
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(`[gpu] TensorDock discover/resume failed: ${errMsg} (will create new instance)`);
    }
  }

  for (let attempt = 0; attempt <= MAX_DEPLOY_RETRIES; attempt++) {
    if (deployCancelled) return;

    if (attempt > 0) {
      setDeployState({ retryCount: attempt, message: `Retry ${attempt + 1}/${MAX_DEPLOY_RETRIES + 1}: creating new ${label} instance...` });
      await new Promise(r => setTimeout(r, 5_000));
      if (deployCancelled) return;
    }

    try {
      // Transition: searching → creating (found offers, now creating instance)
      setDeployState({ status: 'creating', step: 'creating_pod', message: `Creating ${label} instance...` });
      broadcastWs({ type: 'gpu:deploy', phase: 'creating', deployId: deployState.deployId, provider: providerName });

      const defaultStorage = DEFAULT_STORAGE_GB[providerName];
      const storageGb = Math.max(extra.storageGb || defaultStorage, defaultStorage);
      const instance = await providerClient.createInstance(
        { gpuTypes, dockerImage, storageGb, region: extra.region, hfToken: extra.hfToken, env: extra.env, bareMetal: providerName === 'tensordock', interruptible: extra.interruptible,
          // IMPORTANT: RunPod must ALWAYS use SECURE cloud — NEVER COMMUNITY (unreliable third-party machines)
          ...(providerName === 'runpod' ? { cloudType: 'SECURE' as const } : {}),
          ...(extra.dockerStartCmd ? { dockerStartCmd: extra.dockerStartCmd } : {}),
          ...(extra.containerDiskInGb ? { containerDiskInGb: extra.containerDiskInGb } : {}),
          ...(extra.volumeId ? { volumeId: extra.volumeId } : {}),
          // Vast.ai-specific options (ignored by other providers)
          ...(extra.onstart ? { onstart: extra.onstart } : {}),
          ...(extra.templateHashId ? { templateHashId: extra.templateHashId } : {}),
          ...(extra.forceSshTunnel ? { forceSshTunnel: extra.forceSshTunnel } : {}),
          // SnapGPU / CRIU options (only used when providerName === 'snapgpu')
          ...(extra.snapgpuPreloadApp ? { snapgpuPreloadApp: extra.snapgpuPreloadApp } : {}),
          ...(extra.snapgpuAutoSnapshot !== undefined ? { autoSnapshot: extra.snapgpuAutoSnapshot } : {}),
          ...(extra.snapgpuBackend ? { snapgpuBackend: extra.snapgpuBackend } : {}),
        },
        credentials,
      );
      if (deployCancelled) {
        try { await providerClient.deleteInstance(instance.instanceId, credentials); }
        catch (err) { log.warn(`[gpu] Failed to clean up cancelled instance ${instance.instanceId}: ${err}`); }
        return;
      }
      const instanceCostPerHr = (instance.providerMeta?.dphTotal as number)
        || (instance.providerMeta?.costPerHr as number)
        || (instance.providerMeta?.pricePerHr as number)
        || 0;
      setDeployState({
        status: 'booting',
        podId: instance.instanceId,
        endpoint: instance.endpoint,
        gpuType: instance.gpuType || '',
        dockerImage,
        message: `Instance created (${instance.instanceId.slice(0, 8)}), pulling image...`,
        step: 'pulling_image',
        stepDetail: dockerImage,
        sshHost: instance.sshHost || '',
        sshPort: instance.sshPort || 0,
        costPerHr: instanceCostPerHr,
        providerMeta: { ...instance.providerMeta, gpuType: instance.gpuType || '' },
      });
      deploymentSM.startBooting(instance.instanceId);

      const pollResult = await pollHealthUntilReady(providerClient, providerName, apiKey, instance.instanceId, instance.endpoint, startedAt, dockerImage, instance.providerMeta);
      const { result, pullTimeS } = pollResult;
      if (result === 'ready') {
        const durationMs = Date.now() - deployState.startedAt;
        setGpuHealthy(true);
        setLastRequestTime(Date.now());
        setDeployState({ status: 'ready', message: `GPU ready (${label}): ${deployState.endpoint}`, step: 'ready', stepDetail: '', deployDurationMs: durationMs });
            broadcastProviderStatus('booting', 'cloud', `GPU deployed — warming up models`);
        deploymentSM.markReady(deployState.podId, deployState.endpoint, deployState.gpuType, deployState.costPerHr);
        log.log(`[gpu] Deploy completed in ${(durationMs / 1000).toFixed(1)}s (pull=${pullTimeS ?? '?'}s, ${label})`);
        // Record pull time for adaptive timeout learning
        if (pullTimeS != null) {
          const { recordPullTime, deriveHostKey: dk } = await import('../src/gpu-providers/pull-time-estimator');
          const inetDown = (instance.providerMeta?.inetDown as number) || (instance.providerMeta?.inet_down as number);
          const hk = dk(providerName, instance.providerMeta);
          const bootTimeS = Math.round(durationMs / 1000);
          recordPullTime(dockerImage, pullTimeS, inetDown, hk, bootTimeS);
        }
        startGpuMonitoring();
        startBackgroundWarmthMonitor(deployState.endpoint);
        startCanaryIfEnabled(extra, dockerImage, deployState.gpuType);
        return;
      }

      if (result === 'cancelled') { setDeployState({ status: 'error', message: 'Deploy cancelled' }); deploymentSM.markError('Deploy cancelled'); return; }
      // instance crashed, timed out, or app reported error — fetch logs
      // before cleanup. App-error is a special case: the container itself
      // is healthy and SSH-accessible, we just know the model failed to
      // load. The remote logs (with full traceback) are GOLD here, and
      // recurringly retrying the same image won't help — fail the whole
      // deploy after this one attempt, no retries.
      log.log(`[gpu] Instance ${instance.instanceId} failed (${result}), fetching remote logs before cleanup...`);
      let remoteLogsCaptured = '';
      try {
        const { fetchGpuLogs } = await import('./gpu-auto-recovery');
        remoteLogsCaptured = await fetchGpuLogs(instance.sshHost, instance.sshPort, instance.endpoint);
        log.log(`[gpu] ── Remote GPU Logs (${instance.instanceId}) ──\n${remoteLogsCaptured}\n── End GPU Logs ──`);
      } catch (logErr) {
        log.warn(`[gpu] Could not fetch remote logs: ${logErr}`);
      }
      // Persist the full diagnostic bundle to disk so the operator can
      // review it later via /v1/gpu/deploy-history (added in a follow-up
      // commit). Always best-effort — never let logging failures abort
      // the cleanup path.
      try {
        const { persistDeployDiagnostics } = await import('./deploy-diagnostics');
        await persistDeployDiagnostics({
          instanceId: instance.instanceId,
          provider: providerName,
          dockerImage,
          sshHost: instance.sshHost,
          sshPort: instance.sshPort,
          endpoint: instance.endpoint,
          result,
          appError: pollResult.appError,
          remoteLogs: remoteLogsCaptured,
          startedAt,
        });
      } catch (e) {
        log.warn(`[gpu] Failed to persist deploy diagnostics: ${e instanceof Error ? e.message : e}`);
      }
      log.log(`[gpu] Cleaning up crashed instance ${instance.instanceId}...`);
      try { await providerClient.deleteInstance(instance.instanceId, credentials); }
      catch (cleanupErr) {
        // If cleanup fails, don't continue creating new instances — the orphan will keep billing
        const errMsg = `Failed to clean up crashed instance ${instance.instanceId} on ${providerName}: ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`;
        log.error(`[gpu] ${errMsg}`);
        setDeployState({ status: 'error', message: errMsg, podId: instance.instanceId });
        deploymentSM.markError(errMsg);
        return; // Stop deploy — orphan sweep will attempt cleanup later
      }

      // App-error is non-retryable: the model itself failed to load, so
      // retrying on a different host will hit the exact same failure
      // (HuggingFace 404, missing weights, unsupported CUDA, etc.). Fail
      // the whole deploy immediately with the captured error message.
      if (result === 'app_error') {
        const appErr = pollResult.appError;
        const errMsg = `App load failed (non-retryable): ${appErr?.message ?? 'unknown'}`;
        log.error(`[gpu] ${errMsg}`);
        setDeployState({ status: 'error', message: errMsg, step: 'app_error' });
        deploymentSM.markError(errMsg);
        return;
      }

      continue;
    } catch (err) {
      const deployErr = categorizeDeployError(err, {
        deployId: deployState.deployId,
        provider: providerName,
        gpuType: deployState.gpuType || gpuTypes[0],
        imageName: dockerImage,
      });
      errorSummary.record(deployErr, deployState.deployId);
      const remediation = await tryAutoRemediation(deployErr);
      if (remediation) {
        log.warn({ action: remediation.action, suggestions: remediation.suggestions }, 'Auto-remediation attempted');
      }
      log.error({ code: deployErr.code, category: deployErr.category }, `${label} create attempt ${attempt + 1}/${MAX_DEPLOY_RETRIES + 1} failed: ${deployErr.message}`);
      setDeployState({ message: `${label} create failed (attempt ${attempt + 1}): ${deployErr.message}` });

      // Non-retryable errors — fail immediately without wasting retries
      const lowerMsg = deployErr.message.toLowerCase();
      const isBilling = lowerMsg.includes('balance') || lowerMsg.includes('funds') || lowerMsg.includes('insufficient');
      const isAuth = lowerMsg.includes('authentication') || lowerMsg.includes('unauthorized')
        || lowerMsg.includes('forbidden') || lowerMsg.includes('api key') || lowerMsg.includes('invalid key');
      const isNoOffers = lowerMsg.includes('no gpus available') || lowerMsg.includes('0 offers') || lowerMsg.includes('no offers');
      if (isNoOffers) {
        setDeployState({ step: 'no_offers', message: `${label}: no GPUs available — trying next provider` });
        broadcastWs({ type: 'gpu:deploy', phase: 'no_offers', deployId: deployState.deployId, provider: providerName, gpuTypes });
      }
      const nonRetryable = isBilling || isAuth || isNoOffers;
      if (nonRetryable || attempt >= MAX_DEPLOY_RETRIES) {
        let errMsg: string;
        if (isBilling) {
          errMsg = `${label}: account balance too low — add funds and retry`;
        } else if (isAuth) {
          errMsg = `${label}: authentication failed — check API key in .env`;
        } else {
          errMsg = `${label} failed after ${MAX_DEPLOY_RETRIES + 1} attempts: ${deployErr.message}`;
        }
        log.error({ code: deployErr.code, category: deployErr.category }, `${label} deploy failed (non_retryable=${nonRetryable}, attempt=${attempt + 1}): ${deployErr.message}`);
        setDeployState({ status: 'error', message: errMsg });
        deploymentSM.markError(errMsg);
        return;
      }
    }
  }

  const exhaustedMsg = `${label} deploy failed: max retries exceeded`;
  setDeployState({ status: 'error', message: exhaustedMsg });
  deploymentSM.markError(exhaustedMsg);
}

// ── GPU Tier Configuration ──────────────────────────────────────────────────
// Tiers are tried in order (like ai-gateway autoscaler). If tier 0 fails,
// tier 1 is attempted automatically.

// ── Provider Cooldown (persisted to ~/.babelcast/cooldowns.json) ─────────────
export const cooldownTracker = new ProviderCooldownTracker();
void cooldownTracker.loadFromFile(join(homedir(), '.babelcast', 'cooldowns.json'));
{
  const active = cooldownTracker.getActiveCooldowns();
  const names = Object.keys(active);
  if (names.length > 0) {
    log.log(`[gateway] Restored cooldowns: ${names.map(n => `${n} (${active[n].remainSec}s left)`).join(', ')}`);
  }
}

/** Map of provider name → client instance for tier building. */
export const providerClients: Record<ProviderName, GpuProviderClient> = { runpod, vast, tensordock, modal, snapgpu };

export function buildGpuTiers(runpodApiKey: string, vastApiKey?: string, tensordockOpts?: { apiKey: string; authId: string }, modalApiKey?: string): GpuTier[] {
  // Build a map of available providers
  const available: Record<string, GpuTier | null> = {
    runpod: runpodApiKey ? { client: runpod, name: 'runpod', label: PROVIDER_LABELS.runpod, apiKey: runpodApiKey } : null,
    tensordock: tensordockOpts ? { client: tensordock, name: 'tensordock', label: PROVIDER_LABELS.tensordock, apiKey: tensordockOpts.apiKey, authId: tensordockOpts.authId } : null,
    vast: vastApiKey ? { client: vast, name: 'vast', label: PROVIDER_LABELS.vast, apiKey: vastApiKey } : null,
    modal: modalApiKey ? { client: modal, name: 'modal', label: PROVIDER_LABELS.modal, apiKey: modalApiKey } : null,
  };

  // Respect PROVIDER_CHAIN order for GPU providers
  const tiers: GpuTier[] = [];
  const added = new Set<string>();
  const gpuInChain = PROVIDER_CHAIN.filter(p => p === 'runpod' || p === 'tensordock' || p === 'vast' || p === 'modal');

  // If chain has individual GPU providers, use their order
  if (gpuInChain.length > 0) {
    for (const name of gpuInChain) {
      const tier = available[name];
      if (tier && !added.has(name)) {
        tiers.push(tier);
        added.add(name);
      }
    }
  }

  // Add any providers not yet added (legacy "gpu" mode or providers not in chain)
  for (const [name, tier] of Object.entries(available)) {
    if (tier && !added.has(name)) {
      tiers.push(tier);
      added.add(name);
    }
  }

  return tiers;
}

/**
 * Classify a deploy failure into categories.
 *
 * Host-attributable (penalizes reputation):
 *   timeout, crashed, network, unknown
 *
 * Non-host (does NOT penalize reputation):
 *   billing, api_error, docker_image, cancelled
 */
function categorizeDeployFailure(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('balance') || m.includes('funds') || m.includes('insufficient') || m.includes('need at least')) return 'billing';
  if (m.includes('image') && (m.includes('pull') || m.includes('not found') || m.includes('manifest') || m.includes('registry'))) return 'docker_image';
  if (m.includes('docker') && (m.includes('error') || m.includes('failed'))) return 'docker_image';
  if (m.includes('cancelled') || m.includes('canceled')) return 'cancelled';
  if (m.includes('timed out') || m.includes('timeout')) return 'timeout';
  if (m.includes('crashed') || m.includes('exited') || m.includes('terminated')) return 'crashed';
  if (message.includes('API') || message.includes('401') || message.includes('403') || message.includes('500')) return 'api_error';
  if (m.includes('network') || m.includes('econnrefused') || m.includes('etimedout') || m.includes('fetch failed')) return 'network';
  return 'unknown';
}

// ── startDeployWithTiers ──────────────────────────────────────────���─────────

export async function startDeployWithTiers(tiers: GpuTier[], dockerImage: string, gpuTypes: string[], extra: DeployExtra = {}, gpuTypesByProvider?: Record<string, string[]>) {
  const deployId = `deploy-${Date.now()}`;
  const { result, profile } = await profileOperation(
    deployId,
    async () => {
      return await _executeDeploy(tiers, dockerImage, gpuTypes, extra, gpuTypesByProvider);
    },
    { cpuProfileThresholdMs: 60_000, heapSnapshotThresholdMb: 200 },
  );

  if (profile) {
    recordOperationTiming(profile.operation, profile.durationMs);
  }

  return result;
}

async function _executeDeploy(tiers: GpuTier[], dockerImage: string, gpuTypes: string[], extra: DeployExtra = {}, gpuTypesByProvider?: Record<string, string[]>) {
  // ── Pre-flight checks ───────────────────────────────────────────────────
  // Validate image, DNS, CUDA compatibility, and cost BEFORE attempting any
  // provider deploy. Catches common failure scenarios early (Fixes #6, #13,
  // #15, #17, #19, #24, #25, #27).
  for (const tier of tiers) {
    const preflightResult = await runPreFlightChecks({
      imageName: dockerImage,
      provider: tier.name,
      apiKey: tier.apiKey,
      gpuTypes,
      dockerhubUser: process.env.DOCKERHUB_USERNAME,
      dockerhubToken: process.env.DOCKERHUB_TOKEN,
      templateId: deployState.templateHashId,
    });

    if (!preflightResult.ok) {
      log.error({ provider: tier.name, errors: preflightResult.errors }, 'Pre-flight checks failed');
      logGpuEvent('preflight_failed', tier.name, false, {
        metadata: { errors: preflightResult.errors, warnings: preflightResult.warnings },
      });
      throw new Error(`Pre-flight checks failed for ${PROVIDER_LABELS[tier.name] ?? tier.name}: ${preflightResult.errors.join(', ')}`);
    }

    if (preflightResult.warnings.length > 0) {
      log.warn({ provider: tier.name, warnings: preflightResult.warnings }, 'Pre-flight warnings');
    }
  }

  // ── Budget cap enforcement (P0-1) ───────────────────────────────────────
  {
    const { canAffordDeploy } = await import('./state');
    const decision = canAffordDeploy(2);
    if (!decision.allowed) {
      const msg = `[budget] Deploy refused: ${decision.reason} (spend=$${decision.currentSpend.toFixed(2)}, projected=$${decision.projected.toFixed(2)}, cap=$${decision.cap.toFixed(2)})`;
      log.error(msg);
      logGpuEvent('deploy_rejected', tiers[0]?.name ?? 'unknown', false, {
        metadata: {
          reason: decision.reason,
          currentSpend: decision.currentSpend,
          projected: decision.projected,
          cap: decision.cap,
        },
      });
      broadcastWs({
        type: 'gpu:budget',
        action: 'deploy-refused',
        spend: decision.currentSpend,
        projected: decision.projected,
        budget: decision.cap,
        reason: decision.reason,
      });
      return;
    }
  }

  // ── Runaway detector (P0-2) ─────────────────────────────────────────────
  {
    const { getGlobalRunawayDetector } = await import('../src/autoscaler/runaway-detector');
    const detector = getGlobalRunawayDetector();
    const providerName = tiers[0]?.name ?? 'unknown';
    const allowed = detector.recordDeployStart(providerName);
    if (!allowed) {
      const stats = detector.stats(providerName);
      const msg = `[runaway] Deploy refused: ${providerName} has ${stats.recentStarts} recent starts (pause until ${stats.pausedUntilMs ? new Date(stats.pausedUntilMs).toISOString() : 'unknown'})`;
      log.error(msg);
      logGpuEvent('runaway_pause', providerName, false, {
        metadata: {
          recentStarts: stats.recentStarts,
          reason: stats.pauseReason,
          pausedUntilMs: stats.pausedUntilMs,
        },
      });
      broadcastWs({
        type: 'gpu:runaway',
        provider: providerName,
        recentStarts: stats.recentStarts,
        pausedUntilMs: stats.pausedUntilMs,
      });
      return;
    }
  }

  // Filter out providers in cooldown
  let availableTiers = tiers.filter(t => {
    if (cooldownTracker.isCoolingDown(t.name)) {
      const remainSec = cooldownTracker.getRemainingSeconds(t.name);
      log.log(`[gpu] Skipping ${t.label} (cooldown, ${remainSec}s remaining)`);
      logGpuEvent('cooldown_skip', t.name, false, {
        failCount: cooldownTracker.getFailCount(t.name),
        metadata: { remainSec },
      });
      return false;
    }
    return true;
  });

  if (availableTiers.length === 0 && tiers.length > 0) {
    const earliestName = cooldownTracker.pickEarliestExpiry(tiers.map(t => t.name));
    const earliest = tiers.find(t => t.name === earliestName) ?? tiers[0];
    log.log(`[gpu] All providers in cooldown, trying ${earliest.label} anyway (forced=${tiers.length === 1}, tiers=${tiers.map(t => t.name).join(',')})`);
    availableTiers = [earliest];
  }

  // Probe all providers in parallel (20s timeout) to check availability before committing
  if (availableTiers.length > 1) {
    const probeResults = await Promise.allSettled(
      availableTiers.map(async (tier) => {
        const start = Date.now();
        try {
          if (!tier.client.listOffers) return { tier, available: true, ms: 0, offerCount: 0 };
          const offers = await Promise.race([
            tier.client.listOffers({ limit: 3 }, { apiKey: tier.apiKey, authId: tier.authId }),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 20_000)),
          ]);
          return { tier, available: offers.length > 0, offerCount: offers.length, ms: Date.now() - start };
        } catch {
          return { tier, available: false, offerCount: 0, ms: Date.now() - start };
        }
      }),
    );

    // Reorder tiers: available first, then by response time
    const probed = probeResults
      .filter((r): r is PromiseFulfilledResult<{tier: GpuTier; available: boolean; ms: number; offerCount: number}> => r.status === 'fulfilled')
      .map(r => r.value)
      .sort((a, b) => (b.available ? 1 : 0) - (a.available ? 1 : 0) || a.ms - b.ms);

    const reorderedTiers = probed.map(p => p.tier);
    if (reorderedTiers.length > 0) {
      log.log(`[gpu] Provider probe: ${probed.map(p => `${p.tier.label}(${p.available ? p.offerCount + ' offers' : 'unavailable'}, ${p.ms}ms)`).join(', ')}`);
      availableTiers = reorderedTiers;
    }
  }

  for (let i = 0; i < availableTiers.length; i++) {
    const tier = availableTiers[i];
    if (deployCancelled) return;

    // Track active credentials
    if (tier.name === 'runpod') setDeployApiKey(tier.apiKey);
    else if (tier.name === 'vast') setDeployVastApiKey(tier.apiKey);
    else if (tier.name === 'tensordock') { setDeployTensordockApiKey(tier.apiKey); setDeployTensordockAuthId(tier.authId ?? ''); }
    else if (tier.name === 'modal') setDeployModalApiKey(tier.apiKey);

    const tierStartedAt = Date.now();
    logGpuEvent('deploy_started', tier.name, true);
    startDeploySession(tier.name, dockerImage, gpuTypes[0] ?? '');

    try {
      // Modal uses a deploy script, not a Docker image — resolve to absolute path
      const tierDockerImage = tier.name === 'modal'
        ? `${import.meta.dir}/../../docker/modal/babelcast.py`
        : dockerImage;
      const tierGpuTypes = gpuTypesByProvider?.[tier.name] ?? gpuTypes;
      log.log(`[gpu] Starting ${tier.label} deploy loop (tier ${i + 1}/${availableTiers.length}, GPUs: ${tierGpuTypes.slice(0,3).map(g=>g.replace('NVIDIA ','').replace('GeForce ','')).join(', ')}...)`);
      await startDeployLoop(tier.client, tier.name, tier.apiKey, tierDockerImage, tierGpuTypes, tier.authId, extra);
      const durationMs = Date.now() - tierStartedAt;
      if (deployState.status === 'ready') {
        log.log(`[gpu] ✓ ${tier.label} deploy succeeded in ${Math.round(durationMs / 1000)}s`);
        logGpuEvent('deploy_ready', tier.name, true, { durationMs, metadata: { endpoint: deployState.endpoint, gpuType: deployState.gpuType } });
        updateDeploySession({
          status: 'ready',
          podId: deployState.podId,
          endpoint: deployState.endpoint,
          gpuType: deployState.gpuType,
          region: deployState.sshHost ? 'ssh' : '',
          costPerHr: deployState.costPerHr,
          provisionTimeS: Math.round(durationMs / 1000),
        });
        // Record successful deploy in host reputation
        upsertHostReputation({
          provider: tier.name,
          gpuType: deployState.gpuType,
          providerMeta: deployState.providerMeta,
          success: true,
          bootTimeS: Math.round(durationMs / 1000),
          dockerImage,
          costUsd: deployState.costPerHr > 0 ? deployState.costPerHr * (durationMs / 1000 / 3600) : undefined,
        });
        if (await cooldownTracker.recordSuccess(tier.name)) {
          logGpuEvent('cooldown_cleared', tier.name, true, { durationMs });
        }
        emitGatewayEvent('gpu.deployed', {
          deployId: deployState.deployId,
          provider: tier.name,
          gpuType: deployState.gpuType,
          endpoint: deployState.endpoint,
          costPerHr: deployState.costPerHr,
          durationMs,
        });
        return;
      }
      // Deploy loop returned without reaching 'ready' or 'error' — treat as failure
      if (deployState.status !== 'error') {
        const msg = `${tier.label} deploy ended without reaching ready (status=${deployState.status}, elapsed=${Math.round(durationMs / 1000)}s)`;
        log.warn(`[gpu] ${msg}`);
        setDeployState({ status: 'error', message: msg });
      }
    } catch (err) {
      const durationMs = Date.now() - tierStartedAt;
      const deployErr = categorizeDeployError(err, {
        deployId: deployState.deployId,
        provider: tier.name,
        gpuType: deployState.gpuType,
        imageName: deployState.dockerImage,
      });
      errorSummary.record(deployErr, deployState.deployId);
      const remediation = await tryAutoRemediation(deployErr);
      if (remediation) {
        log.warn({ action: remediation.action, suggestions: remediation.suggestions }, 'Auto-remediation attempted');
      }
      log.error({ code: deployErr.code, category: deployErr.category }, `${tier.label} deploy failed after ${Math.round(durationMs / 1000)}s: ${deployErr.message}`);
      if (deployState.status !== 'error') {
        setDeployState({ status: 'error', message: `${tier.label} deploy failed: ${deployErr.message}` });
      }
    }

    // Detect silent failures: deploy returned to idle without error or ready
    if (deployState.status === 'idle') {
      const msg = `${tier.label} deploy returned to idle unexpectedly — possible silent failure`;
      log.error(`[gpu] ${msg}`);
      setDeployState({ status: 'error', message: msg });
    }

    if (deployState.status === 'error') {
      const durationMs = Date.now() - tierStartedAt;
      const failureCategory = categorizeDeployFailure(deployState.message ?? '');
      logGpuEvent('deploy_failed', tier.name, false, { durationMs, error: deployState.message, metadata: { failureCategory } });
      updateDeploySession({ status: 'failed', errorMessage: deployState.message ?? '' });
      emitGatewayEvent('gpu.failed', {
        deployId: deployState.deployId,
        provider: tier.name,
        error: deployState.message,
        durationMs,
        failureCategory,
      });
      // Record failed deploy in host reputation
      upsertHostReputation({
        provider: tier.name,
        gpuType: deployState.gpuType,
        providerMeta: deployState.providerMeta,
        success: false,
        bootTimeS: Math.round(durationMs / 1000),
        dockerImage,
        failureCategory,
      });
      if (failureCategory === 'billing') {
        await cooldownTracker.recordBillingFailure(tier.name);
        log.log(`[gpu] ${tier.name} billing cooldown set: ${cooldownTracker.getRemainingSeconds(tier.name)}s — add funds to resume`);
      } else {
        await cooldownTracker.recordFailure(tier.name);
        log.log(`[gpu] ${tier.name} cooldown set: ${cooldownTracker.getRemainingSeconds(tier.name)}s (fail #${cooldownTracker.getFailCount(tier.name)})`);
      }
    }

    // If this tier failed and there's a next tier, set fallback alert
    if (i < availableTiers.length - 1 && deployState.status === 'error') {
      const next = availableTiers[i + 1];
      const alertMsg = `${tier.label} indisponível — usando ${next.label} como fallback.`;
      log.warn(`[gpu] ⚠️ ${alertMsg}`);
      setDeployState({
        status: 'creating', provider: next.name, step: 'creating_pod',
        message: `${tier.label} indisponível. Tentando ${next.label}...`,
        alert: alertMsg,
      });
    }
  }

  // Final guard: if all tiers were tried and deploy isn't ready, ensure error state
  if (deployState.status !== 'ready' && deployState.status !== 'error') {
    const labels = availableTiers.map(t => t.label).join(', ');
    const lastMsg = deployState.message || 'unknown';
    const msg = `All ${availableTiers.length} provider(s) failed (${labels}). Last error: ${lastMsg}`;
    log.error(`[gpu] Deploy exhausted: ${msg}`);
    setDeployState({ status: 'error', message: msg });
    deploymentSM.markError(msg);
  }

  // If deploy failed and only one tier was provided (forced provider), append context
  if (deployState.status === 'error' && tiers.length === 1) {
    const originalMsg = deployState.message || 'unknown error';
    setDeployState({
      message: `${originalMsg} (no fallback — provider was forced)`,
    });
  }
}

// pollHealthUntilReady is now in ./gpu-poll-health.ts (re-exported above)
