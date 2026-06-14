// ── GPU Idle Manager ─────────────────────────────────────────────────────────
// Handles auto-stop (pause) of idle pods. Stop preserves disk for fast resume.

import type { GpuProviderClient, ProviderCredentials } from '../src/gpu-providers/types';
import { pauseInstanceForIdle } from '../src/gateway/providers/gpu/idle-pause';
import { createLogger } from '../src/logger';
import { categorizeDeployError } from '../src/errors/deploy-errors';
import { errorSummary } from '../src/error-summary';
import { tryAutoRemediation } from '../src/auto-remediation';
import {
  deployState, setDeployState, deployApiKey, deployVastApiKey,
  deployTensordockApiKey, deployTensordockAuthId, deployModalApiKey, deployHyperstackApiKey,
  activeProvider, deploymentSM,
} from './state';
import { updateActivePipeline, runpod, vast, tensordock, modal, hyperstack } from './providers';
import { logGpuEvent } from './metrics';
import { broadcastProviderStatus } from './ws-state';
import { emitGatewayEvent } from './event-bus';
import { stopGpuMonitoring, IDLE_TIMEOUT_MS, IDLE_DESTROY_MS } from './gpu-monitor-loop';
import { stopWarmthMonitor } from './gpu-warmth-monitor';
import { scheduleAutoDestroy } from './gpu-destroy-timer';
import type { DeleteReason } from './gpu-destroy-timer';
import { autoTerminateGpu } from './gpu-terminate';

const log = createLogger('gpu-deploy');

/**
 * #207 — decide whether a stopped/idle pod should be *terminated* (destroying
 * its disk and forcing a future cold boot) versus *left stopped* when the
 * provider client/credentials are unavailable.
 *
 * Terminating on a transient credential gap is wasteful: the disk is gone and
 * the next session pays the full cold-boot tax. We only terminate when the
 * credentials are *permanently* gone (the operator removed them); a transient
 * outage should leave the pod stopped (it keeps disk, no hourly billing) and
 * alert instead.
 *
 * Pure + exported for unit testing; callers thread the result into the
 * stop/terminate branch.
 */
export function shouldTerminateOnMissingClient(opts: {
  /** A client was resolved for the provider. */
  hasClient: boolean;
  /** Credentials are configured but the failure looks transient (network/timeout). */
  credsTransientlyUnavailable?: boolean;
}): { action: 'terminate' | 'leave-stopped' } {
  if (opts.hasClient) return { action: 'terminate' }; // caller had a client; not our case
  // No client. If creds are merely transiently unavailable, prefer leaving the
  // pod stopped (recoverable) rather than destroying it.
  return { action: opts.credsTransientlyUnavailable ? 'leave-stopped' : 'terminate' };
}

/**
 * Automatically stop (pause) the active GPU pod when idle or on a trigger.
 *
 * Preserves disk/data — the pod can be resumed quickly (~19s on Vast.ai)
 * instead of a full cold boot (~288s). No hourly charges while stopped.
 * After stopping, schedules an auto-destroy timer (IDLE_DESTROY_MS) to
 * permanently terminate the pod if not resumed.
 *
 * For Hyperstack, a plain stop still bills 100% (SHUTOFF is not free). When
 * the caller sets `opts.allowHibernate`, we call `hibernate()` instead so
 * billing drops to ~10–15% of the running rate. The resume path reads the
 * persisted `pausedMode` to dispatch between `startInstance` and
 * `hibernateRestore`.
 *
 * Falls back to `autoTerminateGpu` if stop fails or no credentials are available.
 *
 * @param reason - Why the stop was triggered (e.g. 'idle_timeout', 'budget_exceeded')
 * @param opts   - Provider-aware flags (hibernate opt-in)
 */
export async function autoStopGpu(
  reason: DeleteReason = 'idle_timeout',
  opts: { allowHibernate?: boolean } = {},
) {
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
  } else if (provider === 'hyperstack' && deployHyperstackApiKey) {
    client = hyperstack; credentials.apiKey = deployHyperstackApiKey;
  }

  if (!client) {
    log.warn(`[gpu] autoStopGpu: no client for ${provider} — falling back to terminate`);
    await autoTerminateGpu(reason);
    return;
  }

  let pausedMode: 'stop' | 'hibernate' = 'stop';
  try {
    pausedMode = await pauseInstanceForIdle(provider, podId, credentials, client, {
      allowHibernate: opts.allowHibernate === true,
    });
    const modeLabel = pausedMode === 'hibernate'
      ? 'hibernated (billing paused — IP+disk only)'
      : 'stopped (paused) — disk preserved';
    log.log(`[gpu] Pod ${podId} ${modeLabel} on ${provider}`);
    logGpuEvent(
      pausedMode === 'hibernate' ? 'instance_hibernated' : 'instance_stopped',
      provider,
      true,
      { metadata: { podId, reason, pausedMode } },
    );
    emitGatewayEvent('gpu.stopped', { deployId: deployState.deployId, podId, provider, reason, pausedMode });
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

  const isDev = deployState.devMode === true;
  const destroyMsg = isDev
    ? 'Will stay stopped until resumed (dev mode — auto-destroy disabled).'
    : `Will be destroyed in ${Math.round(IDLE_DESTROY_MS / 60_000)} min if not resumed.`;
  broadcastProviderStatus('offline', 'cloud', `GPU idle → stopped (paused). ${destroyMsg}`);
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
  const stoppedMsg = pausedMode === 'hibernate'
    ? `Pod hibernated (idle ${Math.round(IDLE_TIMEOUT_MS / 60_000)} min — billing paused). ${destroyMsg}`
    : `Pod stopped (idle ${Math.round(IDLE_TIMEOUT_MS / 60_000)} min). ${destroyMsg}`;
  setDeployState({
    status: 'stopped',
    message: stoppedMsg,
    podId,
    provider,
    pausedMode,
  });

  // Schedule auto-destroy unless this is a dev deploy (user explicitly opted out)
  if (isDev) {
    log.log(`[gpu] Auto-destroy skipped for dev pod ${podId} — will remain stopped until manually resumed or terminated`);
  } else {
    scheduleAutoDestroy(IDLE_DESTROY_MS);
  }
}
