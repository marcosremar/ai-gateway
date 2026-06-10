// ── GPU Resume Manager — stopped → ready, with fresh-deploy fallback ────────
// Core cold-boot optimization: a stopped pod resumes in ~19s (vs 288s cold boot).
// If the host was reclaimed or resume fails, we transparently fall back to a
// standard deploy via the existing tier cascade.

import type { GpuProviderClient, ProviderCredentials } from '../src/gpu-providers/types';
import type { ProviderName } from '../src/gpu-providers/deploy-orchestrator';
import { resumeInstanceFromIdle } from '../src/gateway/providers/gpu/idle-pause';
import { createLogger } from '../src/logger';
import { categorizeDeployError } from '../src/errors/deploy-errors';
import { errorSummary } from '../src/error-summary';
import { tryAutoRemediation } from '../src/auto-remediation';
import {
  deployState, setDeployState, deployApiKey, deployVastApiKey,
  deployTensordockApiKey, deployTensordockAuthId, deployModalApiKey, deployHyperstackApiKey,
  resetDeployState, deploymentSM,
  setGpuHealthy, setLastRequestTime,
} from './state';
import { runpod, vast, tensordock, modal, hyperstack } from './providers';
import { logGpuEvent } from './metrics';
import { broadcastWs, broadcastProviderStatus } from './ws-state';
import { startGpuMonitoring } from './gpu-monitor-loop';
import { clearAutoDestroyTimer } from './gpu-destroy-timer';
import { probeGpuHealth } from '../src/autoscaler/health';

const log = createLogger('gpu-deploy');

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
  } else if (provider === 'hyperstack' && deployHyperstackApiKey) {
    client = hyperstack; credentials.apiKey = deployHyperstackApiKey;
  }

  if (!client) {
    throw new Error(`No credentials for provider ${provider} — cannot resume`);
  }

  // ── Attempt resume ──────────────────────────────────────────────────────
  clearAutoDestroyTimer();
  broadcastWs({ type: 'gpu:resume', action: 'attempting', deployId: deployState.deployId, podId, provider, reason: opts.reason });
  log.log(`[gpu] resumeOrDeploy: attempting resume of ${provider} pod ${podId} (reason=${opts.reason})`);

  try {
    const pausedMode = deployState.pausedMode;
    await resumeInstanceFromIdle(provider, podId, credentials, client, pausedMode);
    log.log(
      `[gpu] Resume succeeded: ${provider} pod ${podId}` +
      (pausedMode === 'hibernate' ? ' (hibernate-restore)' : ''),
    );

    // Resolve endpoint
    let endpoint = '';
    try {
      const info = await (client as any).resolveInstanceEndpoint?.(podId, credentials);
      if (typeof info === 'string') endpoint = info;
      else if (info?.endpoint) endpoint = info.endpoint;
    } catch { /* best-effort: cleanup or optional side-effect */ }
    if (!endpoint) endpoint = deployState.endpoint; // fallback to last known

    // Transition to booting — clear pausedMode so subsequent pauses start fresh
    const resumeStartedAt = Date.now();
    setDeployState({
      status: 'booting',
      podId,
      endpoint,
      provider,
      message: 'Pod resumed — waiting for health check',
      startedAt: resumeStartedAt,
      pausedMode: undefined,
    });
    deploymentSM.startBooting(podId);
    logGpuEvent('instance_resumed', provider, true, { metadata: { podId, reason: opts.reason } });
    broadcastWs({ type: 'gpu:resume', action: 'success', deployId: deployState.deployId, podId, provider });

    // Poll health until ready. Lightweight containers come back in ~19s, but
    // ML workloads (MuseTalk, ultravox, etc.) reload several GB of weights on
    // restart and routinely take 2-5 min. Default raised to 5 min; override
    // via RESUME_TIMEOUT_MS env var if your image is even slower.
    const RESUME_TIMEOUT_MS = Number.parseInt(process.env.RESUME_TIMEOUT_MS ?? '300000', 10);
    const RESUME_POLL_INTERVAL_MS = 3_000;
    // Vast docs: after stop/start the instance is bound to specific GPU IDs;
    // if they were reassigned it sits in "scheduling" indefinitely and >30s
    // already means the GPU is likely gone. Abort early to the fresh-deploy
    // fallback instead of burning the full health timeout.
    const SCHEDULING_ABORT_MS = Number.parseInt(process.env.RESUME_SCHEDULING_ABORT_MS ?? '60000', 10);
    const STATUS_CHECK_INTERVAL_MS = 15_000;
    let schedulingSince = 0;
    let lastStatusCheckAt = 0;
    let healthy = false;
    while (Date.now() - resumeStartedAt < RESUME_TIMEOUT_MS) {
      const probe = await probeGpuHealth(endpoint, true);
      if (probe.ok) {
        healthy = true;
        break;
      }
      if (provider === 'vast' && Date.now() - lastStatusCheckAt >= STATUS_CHECK_INTERVAL_MS) {
        lastStatusCheckAt = Date.now();
        let detail: { actualStatus?: string; intendedStatus?: string; statusMsg?: string; statusMsgShort?: string } | null = null;
        try {
          detail = await (client as any).getInstanceStatusDetail?.(podId, credentials) ?? null;
        } catch { /* best-effort: status probe failure must not abort the resume */ }
        if (detail) {
          const msg = `${detail.statusMsg ?? ''} ${detail.statusMsgShort ?? ''}`.toLowerCase();
          const actual = detail.actualStatus ?? '';
          const waitingForGpu = msg.includes('schedul')
            || (detail.intendedStatus === 'running' && (actual === 'created' || actual === 'exited' || actual === ''));
          if (waitingForGpu) {
            if (!schedulingSince) schedulingSince = Date.now();
            const stuckS = Math.round((Date.now() - schedulingSince) / 1000);
            if (Date.now() - schedulingSince >= SCHEDULING_ABORT_MS) {
              throw new Error(`Vast instance stuck scheduling for ${stuckS}s — GPU likely reassigned to another renter`);
            }
            setDeployState({ message: `Pod resumed — waiting for GPU slot (scheduling ${stuckS}s)` });
          } else {
            schedulingSince = 0;
          }
        }
      }
      if (!schedulingSince) {
        const elapsedS = Math.round((Date.now() - resumeStartedAt) / 1000);
        setDeployState({ message: `Pod resumed — waiting for health (${elapsedS}s)` });
      }
      await new Promise(r => setTimeout(r, RESUME_POLL_INTERVAL_MS));
    }

    if (!healthy) {
      log.warn(`[gpu] Resume health timeout after ${Math.round(RESUME_TIMEOUT_MS / 1000)}s — falling back to fresh deploy`);
      throw new Error(`Resume health check timed out after ${Math.round(RESUME_TIMEOUT_MS / 1000)}s`);
    }

    // Transition to ready — idle timer starts NOW
    const durationMs = Date.now() - resumeStartedAt;
    setGpuHealthy(true);
    setLastRequestTime(Date.now());
    setDeployState({
      status: 'ready',
      message: `GPU ready (resumed in ${Math.round(durationMs / 1000)}s): ${endpoint}`,
      step: 'ready', stepDetail: '', deployDurationMs: durationMs,
    });
    broadcastProviderStatus('booting', 'cloud', 'GPU resumed — warming up models');
    deploymentSM.markReady(podId, endpoint, deployState.gpuType, deployState.costPerHr);
    startGpuMonitoring();

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
      setDeployModalApiKey: _setDeployModalApiKey, setDeployHyperstackApiKey: _setDeployHyperstackApiKey,
    } = await import('./state');

    // Save API keys BEFORE reset (resetDeployState clears them)
    const savedKeys = {
      runpod: deployApiKey,
      vast: deployVastApiKey,
      tensordock: deployTensordockApiKey ? { apiKey: deployTensordockApiKey, authId: deployTensordockAuthId } : undefined,
      modal: deployModalApiKey,
      hyperstack: deployHyperstackApiKey,
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
    if (savedKeys.hyperstack) _setDeployHyperstackApiKey(savedKeys.hyperstack);

    // Build tiers from saved credentials
    const tiers = buildGpuTiers(
      savedKeys.runpod,
      savedKeys.vast || undefined,
      savedKeys.tensordock,
      savedKeys.modal || undefined,
      savedKeys.hyperstack || undefined,
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
