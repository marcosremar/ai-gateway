// ── BabelCast Gateway — Secondary GPU Standby & Handover ───────────────────────
// Manages a second GPU pod that can take over from the primary on:
//   - Session duration exceeding standbyTriggerHours
//   - P95 latency degradation (> 2× llmTargetLatencyMs)
//   - Manual trigger via UI/API
//
// Flow: trigger → deploy standby → readiness benchmark → ready → handover
// Handover: drain primary (wait activeRequests=0, max 30s) → promote standby → terminate old

import {
  deployState,
  standbyDeployState, setStandbyDeployState, resetStandbyDeployState,
  deployTarget, setDeployTarget, deployLock,
  gpuReadyForProduction,
  setStandbyGpuHealthy, setStandbyReadyForHandover,
  activeRequests,
  getP95Latency,
  setGpuReadyForProduction, setGpuShadowMode,
  resetGpuReadinessState,
  deployApiKey, deployVastApiKey, deployTensordockApiKey, deployTensordockAuthId, deployModalApiKey,
} from './state';
import { broadcastWs } from './ws-state';
import {
  getStandbyEnabled, getStandbyTriggerHours, getStandbyDrainTimeoutMs,
  getLlmTargetLatencyMs,
} from '../src/gpu-providers/deploy-settings';
import { runStandbyReadinessCheck } from './gpu-readiness';

// ── State ─────────────────────────────────────────────────────────────────────

let standbyDeployInProgress = false;
let standbyMonitorTimer: ReturnType<typeof setInterval> | null = null;
let _standbyErrorResetTimer: ReturnType<typeof setTimeout> | null = null;
const STANDBY_MONITOR_INTERVAL_MS = 60_000; // check every 60s

// ── Trigger monitoring ────────────────────────────────────────────────────────

export function startStandbyMonitor(): void {
  stopStandbyMonitor();
  standbyMonitorTimer = setInterval(checkStandbyTriggers, STANDBY_MONITOR_INTERVAL_MS);
  console.log('[standby] Monitor started');
}

export function stopStandbyMonitor(): void {
  if (standbyMonitorTimer) { clearInterval(standbyMonitorTimer); standbyMonitorTimer = null; }
}

function checkStandbyTriggers(): void {
  if (!getStandbyEnabled()) return;
  if (standbyDeployInProgress || standbyDeployState.status !== 'idle') return;
  if (!gpuReadyForProduction || deployState.status !== 'ready') return;

  // Trigger 1: session duration
  const sessionHours = (Date.now() - deployState.startedAt) / 3_600_000;
  if (sessionHours >= getStandbyTriggerHours()) {
    console.log(`[standby] Auto-trigger: session running ${sessionHours.toFixed(1)}h (threshold ${getStandbyTriggerHours()}h)`);
    triggerStandbyDeploy('session_duration').catch(err =>
      console.error('[standby] Auto-trigger failed:', err instanceof Error ? err.message : err),
    );
    return;
  }

  // Trigger 2: P95 latency degradation
  const p95 = getP95Latency();
  const targetMs = getLlmTargetLatencyMs();
  if (p95 !== null && p95 > targetMs * 2) {
    console.log(`[standby] Auto-trigger: P95=${p95}ms > 2× target (${targetMs * 2}ms)`);
    triggerStandbyDeploy('latency_degradation').catch(err =>
      console.error('[standby] Auto-trigger failed:', err instanceof Error ? err.message : err),
    );
  }
}

// ── Deploy standby ────────────────────────────────────────────────────────────

export async function triggerStandbyDeploy(reason: 'manual' | 'session_duration' | 'latency_degradation'): Promise<{ ok: boolean; error?: string }> {
  if (standbyDeployInProgress) return { ok: false, error: 'Standby deploy already in progress' };
  if (standbyDeployState.status !== 'idle') return { ok: false, error: `Standby already ${standbyDeployState.status}` };
  if (deployState.status !== 'ready' || !deployState.endpoint) return { ok: false, error: 'Primary GPU not ready' };
  if (deployLock) return { ok: false, error: 'Deploy lock held — primary may still be deploying' };

  standbyDeployInProgress = true;
  setStandbyDeployState({ status: 'deploying', triggeredReason: reason, startedAt: Date.now(), message: 'Starting standby deploy...' });
  broadcastWs({ type: 'gpu:standby', status: 'deploying', reason });
  console.log(`[standby] Deploy triggered: reason=${reason}, image=${deployState.dockerImage}, gpu=${deployState.gpuType}`);

  try {
    // Temporarily route setDeployState writes to standbyDeployState
    setDeployTarget('standby');

    // Dynamic imports to avoid circular deps at module load time
    const { startDeployWithTiers, buildGpuTiers } = await import('./gpu-deploy');

    const tiers = buildGpuTiers(
      deployApiKey,
      deployVastApiKey,
      (deployTensordockApiKey && deployTensordockAuthId)
        ? { apiKey: deployTensordockApiKey, authId: deployTensordockAuthId }
        : undefined,
      deployModalApiKey,
    );

    // Prefer same provider as primary (no need for tier failover)
    const primaryProvider = deployState.provider;
    const filteredTiers = primaryProvider ? tiers.filter(t => t.name === primaryProvider) : tiers;
    const deployTiers = filteredTiers.length > 0 ? filteredTiers : tiers;

    await startDeployWithTiers(
      deployTiers,
      deployState.dockerImage,
      [deployState.gpuType],
    );

    // startDeployWithTiers completed — standbyDeployState should now have the endpoint
    const standbyEndpoint = standbyDeployState.endpoint;

    if (!standbyEndpoint) {
      throw new Error('Deploy completed but no endpoint in standby state');
    }

    console.log(`[standby] Pod deployed at ${standbyEndpoint} — running readiness benchmark`);
    setStandbyDeployState({ status: 'benchmarking', message: 'Running readiness benchmark...' });
    broadcastWs({ type: 'gpu:standby', status: 'benchmarking', endpoint: standbyEndpoint });

    // Run readiness benchmark on standby endpoint (separate from primary check)
    await runStandbyReadinessCheck(
      standbyEndpoint,
      () => {
        // Benchmark passed — standby is ready for handover
        setStandbyDeployState({ status: 'ready', message: 'Ready for handover' });
        setStandbyReadyForHandover(true);
        setStandbyGpuHealthy(true);
        console.log('[standby] Benchmark PASSED — standby ready for handover');
        broadcastWs({ type: 'gpu:standby', status: 'ready', endpoint: standbyEndpoint });
      },
      (stage, bestMs, targetMs) => {
        setStandbyDeployState({ status: 'error', message: `Readiness failed: ${stage} ${bestMs}ms > ${targetMs}ms` });
        setStandbyReadyForHandover(false);
        setStandbyGpuHealthy(false);
        broadcastWs({ type: 'gpu:standby', status: 'error', reason: `Readiness failed: ${stage}` });
        console.warn(`[standby] Benchmark FAILED: ${stage} ${bestMs}ms > ${targetMs}ms`);
      },
    );

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[standby] Deploy failed:', msg);
    setStandbyDeployState({ status: 'error', message: msg });
    broadcastWs({ type: 'gpu:standby', status: 'error', reason: msg });
    // Reset to idle after 30s so deploys aren't permanently blocked
    if (_standbyErrorResetTimer) clearTimeout(_standbyErrorResetTimer);
    _standbyErrorResetTimer = setTimeout(() => {
      _standbyErrorResetTimer = null;
      if (standbyDeployState.status === 'error') {
        setStandbyDeployState({ status: 'idle', message: '' });
      }
    }, 30_000);
    return { ok: false, error: msg };
  } finally {
    setDeployTarget('primary'); // Always restore primary target
    standbyDeployInProgress = false;
  }

  return { ok: true };
}

// ── Handover ─────────────────────────────────────────────────────────────────

let handoverInProgress = false;

/** True during handover drain — new GPU requests should route to cloud */
export function isHandoverDraining(): boolean { return handoverInProgress; }

export async function initiateHandover(): Promise<{ ok: boolean; error?: string }> {
  if (handoverInProgress) return { ok: false, error: 'Handover already in progress' };
  if (standbyDeployState.status !== 'ready' || !standbyDeployState.endpoint) {
    return { ok: false, error: 'Standby not ready' };
  }

  handoverInProgress = true;
  const oldEndpoint = deployState.endpoint;
  const oldPodId = deployState.podId;
  const oldProvider = deployState.provider;
  const standbyEndpoint = standbyDeployState.endpoint;

  console.log(`[standby] Handover initiated: ${oldEndpoint} → ${standbyEndpoint}`);
  setStandbyDeployState({ status: 'handover', message: 'Handover in progress — draining primary...' });
  broadcastWs({ type: 'gpu:standby', status: 'handover', from: oldEndpoint, to: standbyEndpoint });

  try {
    // Drain primary: wait for active requests to finish (max drainTimeout)
    // Set deploy step to 'draining' so UI shows the drain state
    const { setDeployState } = await import('./state');
    setDeployState({ step: 'draining', message: `Draining ${activeRequests} active request(s) before handover...` });
    broadcastWs({ type: 'gpu:transition', status: 'draining', step: 'draining', provider: deployState.provider, elapsed: 0, detail: `${activeRequests} requests draining` });

    const drainTimeout = getStandbyDrainTimeoutMs();
    const drainStart = Date.now();
    while (activeRequests > 0 && Date.now() - drainStart < drainTimeout) {
      if ((Date.now() - drainStart) % 2000 < 200) {
        broadcastWs({ type: 'gpu:draining', activeRequests, elapsed: Math.round((Date.now() - drainStart) / 1000), timeout: Math.round(drainTimeout / 1000) });
      }
      await new Promise(r => setTimeout(r, 200));
    }
    if (activeRequests > 0) {
      console.warn(`[standby] Drain timeout after ${drainTimeout}ms (${activeRequests} requests still active) — force switching`);
    } else {
      console.log(`[standby] Primary drained (${Date.now() - drainStart}ms)`);
    }

    // Promote standby to primary
    setDeployState({
      endpoint: standbyEndpoint,
      podId: standbyDeployState.podId,
      gpuType: standbyDeployState.gpuType,
      dockerImage: standbyDeployState.dockerImage,
      provider: standbyDeployState.provider as import('./state').DeploymentState['provider'],
      costPerHr: standbyDeployState.costPerHr,
      step: 'ready',
      message: 'Promoted from standby',
    });

    // Activate the new endpoint for production traffic
    const { updateTranslationProfile } = await import('./providers');
    updateTranslationProfile({ gpuEndpoint: standbyEndpoint }, 'standbyHandover');
    setGpuShadowMode(false);
    resetGpuReadinessState(); // resets readiness phases but also gpuReadyForProduction
    setGpuReadyForProduction(true); // re-activate: standby already passed benchmark
    setStandbyGpuHealthy(false);
    setStandbyReadyForHandover(false);

    console.log('[standby] Primary promoted from standby — terminating old pod');
    broadcastWs({ type: 'gpu:standby', status: 'idle', message: 'Handover complete' });

    // Terminate old pod with retry to prevent dual billing
    terminateOldPod(oldPodId, oldProvider).catch(async (err) => {
      console.warn('[standby] Old pod termination failed, retrying in 10s:', err instanceof Error ? err.message : err);
      await new Promise(r => setTimeout(r, 10_000));
      terminateOldPod(oldPodId, oldProvider).catch(err2 =>
        console.error('[standby] Old pod termination retry failed — MANUAL CLEANUP NEEDED:', oldPodId, err2 instanceof Error ? err2.message : err2),
      );
    });

    resetStandbyDeployState();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[standby] Handover failed:', msg);
    setStandbyDeployState({ status: 'error', message: `Handover failed: ${msg}` });
    broadcastWs({ type: 'gpu:standby', status: 'error', reason: msg });
    return { ok: false, error: msg };
  } finally {
    handoverInProgress = false;
  }
}

async function terminateOldPod(podId: string, provider: string): Promise<void> {
  if (!podId) return;
  const { runpod, vast, tensordock } = await import('./providers');
  try {
    if (provider === 'runpod' && deployApiKey) {
      await runpod.deleteInstance(podId, { apiKey: deployApiKey });
    } else if (provider === 'vast' && deployVastApiKey) {
      await vast.deleteInstance(podId, { apiKey: deployVastApiKey });
    } else if (provider === 'tensordock' && deployTensordockApiKey) {
      await tensordock.deleteInstance(podId, { apiKey: deployTensordockApiKey, authId: deployTensordockAuthId });
    }
    console.log(`[standby] Old pod ${podId} terminated`);
  } catch (err) {
    console.warn(`[standby] Failed to terminate old pod ${podId}:`, err instanceof Error ? err.message : err);
  }
}

// ── Cancel standby ────────────────────────────────────────────────────────────

export async function cancelStandby(): Promise<void> {
  const podId = standbyDeployState.podId;
  const provider = standbyDeployState.provider;
  resetStandbyDeployState();
  setStandbyGpuHealthy(false);
  setStandbyReadyForHandover(false);
  setDeployTarget('primary'); // ensure primary target is restored
  standbyDeployInProgress = false;
  broadcastWs({ type: 'gpu:standby', status: 'idle', message: 'Standby cancelled' });
  console.log('[standby] Cancelled');
  if (podId) {
    terminateOldPod(podId, provider).catch(e => console.warn('[standby] old pod termination failed:', e instanceof Error ? e.message : e));
  }
}
