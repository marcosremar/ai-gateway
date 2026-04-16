// ── GPU Idle Manager ─────────────────────────────────────────────────────────
// Handles auto-stop (pause) of idle pods. Stop preserves disk for fast resume.

import type { GpuProviderClient, ProviderCredentials } from '../src/gpu-providers/types';
import { createLogger } from '../src/logger';
import { categorizeDeployError } from '../src/errors/deploy-errors';
import { errorSummary } from '../src/error-summary';
import { tryAutoRemediation } from '../src/auto-remediation';
import {
  deployState, setDeployState, deployApiKey, deployVastApiKey,
  deployTensordockApiKey, deployTensordockAuthId, deployModalApiKey,
  activeProvider, deploymentSM,
} from './state';
import { updateActivePipeline, runpod, vast, tensordock, modal } from './providers';
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
  setDeployState({
    status: 'stopped',
    message: `Pod stopped (idle ${Math.round(IDLE_TIMEOUT_MS / 60_000)} min). ${destroyMsg}`,
    podId,
    provider,
  });

  // Schedule auto-destroy unless this is a dev deploy (user explicitly opted out)
  if (isDev) {
    log.log(`[gpu] Auto-destroy skipped for dev pod ${podId} — will remain stopped until manually resumed or terminated`);
  } else {
    scheduleAutoDestroy(IDLE_DESTROY_MS);
  }
}
