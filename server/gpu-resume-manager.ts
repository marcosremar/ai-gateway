// ── GPU Resume Manager — stopped → ready, with fresh-deploy fallback ────────
// Core cold-boot optimization: a stopped pod resumes in ~19s (vs 288s cold boot).
// If the host was reclaimed or resume fails, we transparently fall back to a
// standard deploy via the existing tier cascade.

import type { GpuProviderClient, ProviderCredentials } from '../src/gpu-providers/types';
import type { ProviderName } from '../src/gpu-providers/deploy-orchestrator';
import { createLogger } from '../src/logger';
import { categorizeDeployError } from '../src/errors/deploy-errors';
import { errorSummary } from '../src/error-summary';
import { tryAutoRemediation } from '../src/auto-remediation';
import {
  deployState, setDeployState, deployApiKey, deployVastApiKey,
  deployTensordockApiKey, deployTensordockAuthId, deployModalApiKey,
  resetDeployState, deploymentSM,
} from './state';
import { runpod, vast, tensordock, modal } from './providers';
import { logGpuEvent } from './metrics';
import { broadcastWs } from './ws-state';
import { startGpuMonitoring } from './gpu-monitor-loop';
import { clearAutoDestroyTimer } from './gpu-destroy-timer';

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
