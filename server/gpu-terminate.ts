// ── GPU Terminate — permanently destroy the active GPU instance ─────────────
// Used by manual terminate, budget exceeded, idle destroy, crash recovery.

import { createLogger } from '../src/logger';
import { categorizeDeployError } from '../src/errors/deploy-errors';
import { errorSummary } from '../src/error-summary';
import { tryAutoRemediation } from '../src/auto-remediation';
import {
  deployState, deployApiKey, deployVastApiKey,
  deployTensordockApiKey, deployTensordockAuthId, deployModalApiKey, deployHyperstackApiKey,
  activeProvider, resetDeployState,
} from './state';
import { updateActivePipeline, vast, tensordock, modal, hyperstack } from './providers';
import { logGpuEvent, updateDeploySession } from './metrics';
import { broadcastProviderStatus } from './ws-state';
import { emitGatewayEvent } from './event-bus';
import { cleanupAllPods, cleanupVastInstances, cleanupTensordockInstances, cleanupModalApps, cleanupHyperstackInstances } from './gpu-orphan-cleanup';
import { stopGpuMonitoring } from './gpu-monitor-loop';
import { stopWarmthMonitor } from './gpu-warmth-monitor';
import { clearAutoDestroyTimer } from './gpu-destroy-timer';
import type { DeleteReason } from './gpu-destroy-timer';

const log = createLogger('gpu-deploy');

/**
 * Permanently terminate the active GPU instance across all providers.
 *
 * Stops monitoring, closes SSH tunnels, resets deploy state, and cleans up the
 * tracked instance plus gateway-owned provider resources. Broadcasts the
 * termination event and updates the deploy session.
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
  const hyperstackKey = deployHyperstackApiKey;
  const provider = activeProvider;
  const podId = deployState.podId;
  // Capture deploy context BEFORE resetDeployState() clears it — error
  // categorization and event emission need the original values.
  const deployId = deployState.deployId;
  const gpuType = deployState.gpuType;
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
        deployId,
        provider: 'modal',
        gpuType,
      });
      errorSummary.record(deployErr, deployId);
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
        deployId,
        provider: 'tensordock',
        gpuType,
      });
      errorSummary.record(deployErr, deployId);
      const remediation = await tryAutoRemediation(deployErr);
      if (remediation) {
        log.warn({ action: remediation.action, suggestions: remediation.suggestions }, 'Auto-remediation attempted');
      }
      log.error({ code: deployErr.code, category: deployErr.category }, deployErr.message);
      await cleanupTensordockInstances(tdKey, tdAuthId);
    }
  } else if (provider === 'vast' && vastKey) {
    await cleanupVastInstances(vastKey, podId ? [podId] : []);
    logGpuEvent('instance_stopped', 'vast', true, { metadata: { reason } });
  } else if (provider === 'hyperstack' && hyperstackKey) {
    if (podId) {
      try {
        await hyperstack.deleteInstance(podId, { apiKey: hyperstackKey });
        logGpuEvent('instance_stopped', 'hyperstack', true, { metadata: { podId, reason } });
      } catch (err) {
        const deployErr = categorizeDeployError(err, {
          deployId,
          provider: 'hyperstack',
          gpuType,
        });
        errorSummary.record(deployErr, deployId);
        const remediation = await tryAutoRemediation(deployErr);
        if (remediation) {
          log.warn({ action: remediation.action, suggestions: remediation.suggestions }, 'Auto-remediation attempted');
        }
        log.error({ code: deployErr.code, category: deployErr.category }, deployErr.message);
        await cleanupHyperstackInstances(hyperstackKey);
      }
    } else {
      await cleanupHyperstackInstances(hyperstackKey);
      logGpuEvent('instance_stopped', 'hyperstack', true, { metadata: { reason } });
    }
  } else if (rpKey) {
    await cleanupAllPods(rpKey);
    logGpuEvent('instance_stopped', 'runpod', true, { metadata: { podId, reason } });
  }
  emitGatewayEvent('gpu.terminated', { deployId, podId, provider, reason });
  updateDeploySession({ status: 'stopped', stoppedAt: new Date() });
}
