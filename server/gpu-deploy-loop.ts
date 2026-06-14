// ── GPU Deploy Loop ─────────────────────────────────────────────────────────
// Core per-provider deploy cycle: create instance → poll health → retry on fail.
// Called for each tier in startDeployWithTiers and for hedged (race) deploys.

import type { GpuProviderClient, ProviderCredentials } from '../src/gpu-providers/types';
import type { DockerCapability } from '../src/gateway/providers/gpu/docker-manifest';
import { PROVIDER_LABELS, DEFAULT_STORAGE_GB } from '../src/gpu-providers/deploy-orchestrator';
import type { ProviderName } from '../src/gpu-providers/deploy-orchestrator';
import { categorizeDeployError } from '../src/errors/deploy-errors';
import { errorSummary } from '../src/error-summary';
import { tryAutoRemediation } from '../src/auto-remediation';
import { createLogger } from '../src/logger';
import {
  deployState, setDeployState, deployCancelled, setDeployCancelled,
  setActiveProvider, setGpuHealthy, setLastRequestTime,
  deploymentSM,
} from './state';
import { logGpuEvent } from './metrics';
import { broadcastProviderStatus, broadcastWs } from './ws-state';
import { pollHealthUntilReady } from './gpu-poll-health';
import { startCanaryIfEnabled } from './gpu-deploy-canary';
import { recordTierLatency } from './tier-ranking';

const log = createLogger('gpu-deploy');

/** Best-effort tier-ranking recorder — never throws, logs on failure. */
function recordTierLatencySafe(
  providerName: ProviderName,
  totalMs: number,
  pullTimeS: number | undefined | null,
): void {
  try {
    const pullMs = pullTimeS != null ? pullTimeS * 1000 : undefined;
    recordTierLatency(providerName, {
      totalMs,
      pullMs,
      // bootMs/modelLoadMs would require deeper hooks in pollHealthUntilReady.
      // Total is the primary signal the plan calls for; breakdown is optional.
      recordedAt: Date.now(),
    });
  } catch (err) {
    log.warn(`[gpu] recordTierLatency failed for ${providerName}: ${err instanceof Error ? err.message : err}`);
  }
}

export const MAX_DEPLOY_RETRIES = 2;
export const HEALTH_POLL_INTERVAL_MS = 10_000;
export const DEPLOY_TIMEOUT_MS = 45 * 60_000; // 45 min — large images (52GB) + models (70B) can take 30-40 min

/**
 * Per-provider deploy-timeout floor in minutes (#200).
 *
 * `getDeployTimeoutMinForProvider` currently returns one global value for every
 * provider, but slow providers (TensorDock) legitimately need longer windows
 * while fast/reliable ones (RunPod SECURE) can fail faster. This pure helper
 * gives a sensible per-provider default that a caller can clamp the configured
 * timeout against. Unknown providers fall back to the supplied global default.
 */
const PROVIDER_TIMEOUT_MIN: Record<string, number> = {
  runpod: 15,     // SECURE pods boot fast and pre-baked images pull quickly
  vast: 30,       // marketplace hosts vary; mid window
  'vast-vm': 30,
  tensordock: 45, // historically the slowest to provision
  modal: 20,
  hyperstack: 30,
  snapgpu: 30,
};

export function deployTimeoutMinForProvider(provider: string, globalDefaultMin: number): number {
  const perProvider = PROVIDER_TIMEOUT_MIN[provider];
  // Use the larger of the per-provider floor and the configured global so an
  // operator who raises the global timeout is never silently lowered.
  return Math.max(perProvider ?? globalDefaultMin, globalDefaultMin);
}

/** Convenience: the same per-provider timeout expressed in milliseconds. */
export function deployTimeoutMsForProvider(provider: string, globalDefaultMin: number): number {
  return deployTimeoutMinForProvider(provider, globalDefaultMin) * 60_000;
}

export interface DeployExtra {
  region?: string;
  storageGb?: number;
  hfToken?: string;
  env?: Record<string, string>;
  interruptible?: boolean;
  dockerStartCmd?: string;
  onstart?: string;
  containerDiskInGb?: number;
  volumeId?: string;
  autoRecovery?: boolean;
  templateHashId?: string;
  forceSshTunnel?: boolean;
  snapgpuPreloadApp?: string;
  snapgpuAutoSnapshot?: boolean;
  snapgpuBackend?: 'vast' | 'runpod';
  canary?: boolean;
  canaryInitialTraffic?: number;
  canaryMaxErrorRate?: number;
  canaryTrafficStep?: number;
  /** Human-readable instance label/name propagated to provider consoles. */
  label?: string;
  /** Use only high-confidence hosts/offers for fast-boot sensitive deploys. */
  strictFastBoot?: boolean;
  /** Vast.ai opt-in for unverified/deverified offers. Defaults to verified-only. */
  allowUnverified?: boolean;
  expectedApiPaths?: string[];
  expectedCapabilities?: DockerCapability[];
  requireDockerManifest?: boolean;
  runSmokeTests?: boolean;
  /** Explicit race count from caller — when 1, suppress in-loop retry. */
  raceCount?: number;
  /** When true, single-tier deploy: no fallback to next provider. */
  noTierCascade?: boolean;
  /** Minimum inet_down (Mbps) the host must have. Forwarded to the Vast offer search. */
  minInetDownMbps?: number;
  /** Maximum total cost (USD) for this deploy. Threaded so race/monitor cost
   *  accounting can trim slots or auto-stop when cumulative cost would exceed it. */
  maxCostUsd?: number;
  /** Vast.ai offer search mode: 'full' widens the host pool (skips the strict
   *  fast-boot reliability tier). Forwarded to the provider client's offer search. */
  searchMode?: 'full' | 'fast';
  /** Require at least one direct (non-SSH) port on the host. Forwarded to Vast. */
  requireDirectPort?: boolean;
}

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
          const { result: res1, pullTimeS: pt1 } = await pollHealthUntilReady(providerClient, providerName, apiKey, existing.instanceId, endpoint, startedAt, dockerImage, existing.providerMeta as Record<string, unknown>, extra.expectedApiPaths, extra.expectedCapabilities, extra.requireDockerManifest, extra.runSmokeTests);
          if (res1 === 'ready') {
            const durationMs = Date.now() - deployState.startedAt;
            setGpuHealthy(true);
            setLastRequestTime(Date.now());
            setDeployState({ status: 'ready', message: `GPU ready (${label}): ${deployState.endpoint}`, step: 'ready', stepDetail: '', deployDurationMs: durationMs, alert: '', alertLevel: 'info' });
            broadcastProviderStatus('booting', 'cloud', `GPU deployed — warming up models`);
            deploymentSM.markReady(deployState.podId, deployState.endpoint, deployState.gpuType, deployState.costPerHr);
            log.log(`[gpu] Deploy completed in ${(durationMs / 1000).toFixed(1)}s (pull=${pt1 ?? '?'}s, ${label})`);
            if (pt1 != null) {
              const { recordPullTime, deriveHostKey: dk } = await import('../src/gpu-providers/pull-time-estimator');
              dk(providerName, existing.providerMeta as Record<string, unknown>);
              recordPullTime(dockerImage, pt1, undefined, dk(providerName, existing.providerMeta as Record<string, unknown>), Math.round(durationMs / 1000));
            }
            // Record cold-start latency for dynamic tier reordering (A2).
            recordTierLatencySafe(providerName, durationMs, pt1);
            startGpuMonitoring();
            startBackgroundWarmthMonitor(deployState.endpoint);
            startCanaryIfEnabled(extra, dockerImage, deployState.gpuType);
            return;
          }
          if (res1 === 'cancelled') {
            // Don't leave the just-resumed instance billing — terminate before
            // returning. Without this, cancel mid-poll-health left the
            // resumed pod running until orphan sweep.
            try { await providerClient.deleteInstance(existing.instanceId, { apiKey }); }
            catch (e) { log.warn(`[gpu] Cleanup of cancelled-resume failed: ${e instanceof Error ? e.message : e}`); }
            setDeployState({ status: 'error', message: 'Deploy cancelled' }); deploymentSM.markError('Deploy cancelled'); return;
          }
          log.log(`[gpu] Resumed TensorDock instance failed health check — terminating before creating new`);
          // Health-fail path also leaked the resumed instance — kill it now,
          // otherwise we end up with TWO billable pods (resumed + new).
          try { await providerClient.deleteInstance(existing.instanceId, { apiKey }); }
          catch (e) { log.warn(`[gpu] Cleanup of unhealthy-resume failed: ${e instanceof Error ? e.message : e}`); }
        } else if (isRunning && existing.endpoint) {
          log.log(`[gpu] TensorDock: found running instance ${existing.instanceId} at ${existing.endpoint}`);
          setDeployState({
            status: 'booting', podId: existing.instanceId, endpoint: existing.endpoint,
            gpuType: existing.gpuType || '', step: 'waiting_health',
            message: `TensorDock instance already running, checking health...`,
          });
          deploymentSM.startBooting(existing.instanceId);
          const { result: res2, pullTimeS: pt2 } = await pollHealthUntilReady(providerClient, providerName, apiKey, existing.instanceId, existing.endpoint, startedAt, dockerImage, existing.providerMeta as Record<string, unknown>, extra.expectedApiPaths, extra.expectedCapabilities, extra.requireDockerManifest, extra.runSmokeTests);
          if (res2 === 'ready') {
            const durationMs = Date.now() - deployState.startedAt;
            setGpuHealthy(true);
            setLastRequestTime(Date.now());
            setDeployState({ status: 'ready', message: `GPU ready (${label}): ${deployState.endpoint}`, step: 'ready', stepDetail: '', deployDurationMs: durationMs, alert: '', alertLevel: 'info' });
            broadcastProviderStatus('booting', 'cloud', `GPU deployed — warming up models`);
            deploymentSM.markReady(deployState.podId, deployState.endpoint, deployState.gpuType, deployState.costPerHr);
            log.log(`[gpu] Deploy completed in ${(durationMs / 1000).toFixed(1)}s (pull=${pt2 ?? '?'}s, ${label})`);
            if (pt2 != null) {
              const { recordPullTime, deriveHostKey: dk } = await import('../src/gpu-providers/pull-time-estimator');
              recordPullTime(dockerImage, pt2, undefined, dk(providerName, existing.providerMeta as Record<string, unknown>), Math.round(durationMs / 1000));
            }
            // Record cold-start latency for dynamic tier reordering (A2).
            recordTierLatencySafe(providerName, durationMs, pt2);
            startGpuMonitoring();
            startBackgroundWarmthMonitor(deployState.endpoint);
            startCanaryIfEnabled(extra, dockerImage, deployState.gpuType);
            return;
          }
          if (res2 === 'cancelled') {
            try { await providerClient.deleteInstance(existing.instanceId, { apiKey }); }
            catch (e) { log.warn(`[gpu] Cleanup of cancelled-running failed: ${e instanceof Error ? e.message : e}`); }
            setDeployState({ status: 'error', message: 'Deploy cancelled' }); deploymentSM.markError('Deploy cancelled'); return;
          }
          log.log(`[gpu] Running TensorDock instance not healthy — terminating before creating new`);
          try { await providerClient.deleteInstance(existing.instanceId, { apiKey }); }
          catch (e) { log.warn(`[gpu] Cleanup of unhealthy-running failed: ${e instanceof Error ? e.message : e}`); }
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
      // Explicit body.storageGb wins over the provider default — the
      // previous Math.max(...,defaultStorage) clamp always forced the
      // floor to defaultStorage (100 GB on Vast), which excluded every
      // small-disk offer (most A100 PCIe in the marketplace ship 48-94 GB).
      // Honour the caller's value verbatim when set; only fall back to the
      // provider default when none was provided.
      const storageGb = (typeof extra.storageGb === 'number' && extra.storageGb > 0)
        ? extra.storageGb
        : defaultStorage;

      // Progress callback: broadcast every poll update so CLI shows "Creating... 45s"
      const onPollProgress = (info: { elapsedS: number; status: string; instanceId: string; ip: string; sshHost?: string; sshPort?: number }) => {
        const sshInfo = info.sshHost ? ` (ssh ${info.sshHost}:${info.sshPort})` : '';
        setDeployState({ message: `Creating ${label} instance... ${info.elapsedS}s (${info.status})${sshInfo}` });
        broadcastWs({ type: 'gpu:deploy', phase: 'creating', deployId: deployState.deployId, provider: providerName, message: `Creating ${label} instance... ${info.elapsedS}s (${info.status})` });
      };

      const instance = await providerClient.createInstance(
        { gpuTypes, dockerImage, storageGb, region: extra.region, hfToken: extra.hfToken, env: extra.env, bareMetal: providerName === 'tensordock', interruptible: extra.interruptible,
          // IMPORTANT: RunPod must ALWAYS use SECURE cloud — NEVER COMMUNITY (unreliable third-party machines)
          ...(providerName === 'runpod' ? { cloudType: 'SECURE' as const } : {}),
          // Forward Vast-only opt-in flags (see canonical comment in
          // gpu-deploy-race.ts) so the verified-host filter and the
          // strict-fast-boot tier are actually controllable from the API.
          ...(extra.allowUnverified ? { allowUnverified: extra.allowUnverified } : {}),
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
          onPollProgress,
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

      // ── Snapshot restore path (Phase B2) ──────────────────────────────
      // Only vast-vm / hyperstack are snapshot-eligible; everything else
      // falls through to the cold path immediately. Failure is transparent
      // and the metric tracks for auto-disable (ADR-005).
      if (providerName === 'vast-vm' || providerName === 'hyperstack') {
        try {
          const { maybeRestoreSnapshot, modelsFromDeployState } = await import('./gpu-snapshot');
          if (instance.sshHost && instance.sshPort) {
            const restore = await maybeRestoreSnapshot({
              provider: providerName,
              ssh: { host: instance.sshHost, port: instance.sshPort },
              imageRef: dockerImage,
              // Use the same model list the capture side hashes (#175). Passing
              // a hardcoded [] here produced a different modelHash than capture,
              // so a captured snapshot was never matched — silently disabling fast boot.
              models: modelsFromDeployState(),
            });
            if (restore.restored) {
              // Quick health probe — if ready, short-circuit to ready.
              const endpoint = instance.endpoint;
              if (endpoint) {
                try {
                  const probe = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5_000) });
                  if (probe.ok) {
                    const durationMs = Date.now() - deployState.startedAt;
                    setGpuHealthy(true);
                    setLastRequestTime(Date.now());
                    setDeployState({
                      status: 'ready',
                      message: `GPU ready via snapshot restore (${label}): ${endpoint} — ${restore.durationMs}ms`,
                      step: 'ready',
                      stepDetail: `snapshot:${restore.entry?.r2Key ?? '?'}`,
                      deployDurationMs: durationMs,
                      alert: '',
                      alertLevel: 'info',
                    });
                    broadcastProviderStatus('booting', 'cloud', `GPU deployed via snapshot (${restore.durationMs}ms)`);
                    deploymentSM.markReady(deployState.podId, endpoint, deployState.gpuType, deployState.costPerHr);
                    log.log(`[gpu] Snapshot restore succeeded in ${restore.durationMs}ms (${label})`);
                    startGpuMonitoring();
                    startBackgroundWarmthMonitor(endpoint);
                    startCanaryIfEnabled(extra, dockerImage, deployState.gpuType);
                    return;
                  }
                } catch (probeErr) {
                  log.warn(`[gpu] Snapshot restored but health probe failed: ${probeErr instanceof Error ? probeErr.message : probeErr}`);
                }
              }
            } else if (restore.reason && restore.reason !== 'no matching snapshot' && restore.reason !== 'provider not snapshot-eligible' && restore.reason !== 'no snapshot bucket configured') {
              log.warn(`[gpu] Snapshot restore not used: ${restore.reason}`);
            }
          }
        } catch (err) {
          // Never let snapshot restore failure abort the cold path.
          log.warn(`[gpu] Snapshot restore threw, falling back to cold path: ${err instanceof Error ? err.message : err}`);
        }
      }

      const pollResult = await pollHealthUntilReady(providerClient, providerName, apiKey, instance.instanceId, instance.endpoint, startedAt, dockerImage, instance.providerMeta, extra.expectedApiPaths, extra.expectedCapabilities, extra.requireDockerManifest, extra.runSmokeTests);
      const { result, pullTimeS } = pollResult;
      if (result === 'ready') {
        const durationMs = Date.now() - deployState.startedAt;
        setGpuHealthy(true);
        setLastRequestTime(Date.now());
        setDeployState({ status: 'ready', message: `GPU ready (${label}): ${deployState.endpoint}`, step: 'ready', stepDetail: '', deployDurationMs: durationMs, alert: '', alertLevel: 'info' });
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
        // Record cold-start latency for dynamic tier reordering (A2).
        recordTierLatencySafe(providerName, durationMs, pullTimeS);
        startGpuMonitoring();
        startBackgroundWarmthMonitor(deployState.endpoint);
        startCanaryIfEnabled(extra, dockerImage, deployState.gpuType);
        return;
      }

      if (result === 'cancelled') {
        // Cancellation arrived after createInstance succeeded — terminate the
        // billable pod before returning. Without this cleanup, cancelled
        // deploys leaked instances that orphan-sweep might skip because
        // status flipped to 'error' immediately.
        try {
          await providerClient.deleteInstance(instance.instanceId, { apiKey });
          log.log(`[gpu] Cancelled deploy: terminated ${instance.instanceId}`);
        } catch (e) {
          log.warn(`[gpu] Failed to terminate cancelled instance ${instance.instanceId}: ${e instanceof Error ? e.message : e}`);
        }
        setDeployState({ status: 'error', message: 'Deploy cancelled' }); deploymentSM.markError('Deploy cancelled'); return;
      }
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
