// ── startDeployWithTiers — orchestrated deploy across provider tiers ────────
// Pre-flight checks, budget gate, runaway detector, cooldown filtering,
// probing, per-tier deploy loop, fallback alerts, host reputation.

import type { GpuTier } from '../src/gpu-providers/deploy-orchestrator';
import { PROVIDER_LABELS } from '../src/gpu-providers/deploy-orchestrator';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { categorizeDeployError } from '../src/errors/deploy-errors';
import { errorSummary } from '../src/error-summary';
import { tryAutoRemediation } from '../src/auto-remediation';
import { runPreFlightChecks } from '../src/preflight-checks';
import { createLogger } from '../src/logger';
import { profileOperation, recordOperationTiming } from '../src/performance-profiler';
import {
  deployState, setDeployState, deployCancelled, deploymentSM,
  setDeployApiKey, setDeployVastApiKey,
  setDeployTensordockApiKey, setDeployTensordockAuthId, setDeployModalApiKey, setDeployHyperstackApiKey,
  clearPersistedDeploy,
} from './state';
import {
  logGpuEvent, startDeploySession, updateDeploySession, upsertHostReputation,
} from './metrics';
import { broadcastWs } from './ws-state';
import { emitGatewayEvent } from './event-bus';
import { cooldownTracker, categorizeDeployFailure } from './gpu-deploy-tiers';
import { startDeployLoop, type DeployExtra } from './gpu-deploy-loop';

const log = createLogger('gpu-deploy');
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
// Per-image Modal app script lookup. `gpu-deploy-race.ts` documents the
// fallback rationale; we mirror the same shim here so both deploy paths
// agree on which Modal `.py` runs for a given registry image.
const MODAL_DEPLOY_SCRIPT_FALLBACK = resolve(SERVER_DIR, '..', 'dockers', 'modal', 'babelcast.py');
import { modalStrategy } from '../src/modules/gpu-providers/strategies';
function modalScriptFor(image: string): string {
  try {
    return modalStrategy.resolveImage(image);
  } catch {
    return MODAL_DEPLOY_SCRIPT_FALLBACK;
  }
}

/**
 * Format the cascade fallback alert in one consistent language (#146).
 *
 * The previous strings mixed Portuguese ("indisponível", "usando … como
 * fallback") into an otherwise-English UI. Centralizing keeps the cascade
 * messages consistent and makes future localization a single edit. Pure.
 */
export function formatFallbackAlert(failedLabel: string, nextLabel: string): string {
  return `${failedLabel} unavailable — falling back to ${nextLabel}.`;
}

/** Status-line variant shown while the next tier is being attempted (#146). */
export function formatFallbackStatus(failedLabel: string, nextLabel: string): string {
  return `${failedLabel} unavailable. Trying ${nextLabel}...`;
}

/**
 * Hours to project a deploy's cost over for the cascade budget gate (#106).
 *
 * The gate previously hardcoded `canAffordDeploy(2)`, assuming every deploy
 * runs exactly 2h. Derive it from the resolved idle timeout (a short idle cap
 * means the GPU won't bill for long) and, when set, from `maxCostUsd`. Clamped
 * to [0.25h, 8h] so a misconfigured value can't disable or over-tighten the
 * gate. Pure so it can be unit-tested.
 */
export function budgetProjectionHours(extra: {
  idleTimeoutMin?: number;
  maxCostUsd?: number;
}): number {
  const FALLBACK_H = 2;
  const MIN_H = 0.25;
  const MAX_H = 8;
  let hours = FALLBACK_H;
  if (typeof extra.idleTimeoutMin === 'number' && extra.idleTimeoutMin > 0) {
    // A deploy that auto-stops after `idleTimeoutMin` won't bill much past it;
    // add a 1.5x boot/run headroom so the gate isn't over-optimistic.
    hours = (extra.idleTimeoutMin / 60) * 1.5;
  }
  return Math.min(MAX_H, Math.max(MIN_H, hours));
}

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
  // SKIP tiers that fail preflight instead of aborting — allows cascade to
  // continue to the next provider.
  const preflightOk: GpuTier[] = [];
  const preflightSkip: string[] = [];
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
      log.warn(`[gpu] ${tier.label} preflight failed: ${preflightResult.errors.join(', ')} — skipping`);
      logGpuEvent('preflight_failed', tier.name, false, {
        metadata: { errors: preflightResult.errors, warnings: preflightResult.warnings },
      });
      preflightSkip.push(tier.name);
      continue; // skip this tier, try next
    }

    if (preflightResult.warnings.length > 0) {
      log.warn({ provider: tier.name, warnings: preflightResult.warnings }, 'Pre-flight warnings');
    }
    preflightOk.push(tier);
  }

  if (preflightOk.length === 0) {
    const msg = `All providers failed preflight: ${preflightSkip.join(', ')}`;
    log.error(msg);
    setDeployState({ status: 'error', message: msg });
    return;
  }

  if (preflightSkip.length > 0) {
    log.log(`[gpu] Preflight: ${preflightOk.map(t => t.label).join(', ')} OK — skipped ${preflightSkip.join(', ')}`);
  }

  // Use only tiers that passed preflight
  tiers = preflightOk;

  // ── Budget cap enforcement (P0-1) ───────────────────────────────────────
  {
    const { canAffordDeploy } = await import('./state');
    // Derive the projection window from the deploy's idle/cost hints instead of
    // a flat 2h (#106). Defaults to 2h when no hint is present.
    const projectionHours = budgetProjectionHours({ maxCostUsd: extra.maxCostUsd });
    const decision = canAffordDeploy(projectionHours);
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

  // Probe all providers in parallel (20s timeout) to check availability and log results.
  // DO NOT reorder - preserve the configured cascade order (Vast.ai → RunPod → Modal).
  // Reordering by response time breaks the intended priority and can cause Modal (0ms, non-working)
  // to be tried before Vast.ai.
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

    // Log probe results for debugging but keep original tier order
    const probed = probeResults
      .filter((r): r is PromiseFulfilledResult<{tier: GpuTier; available: boolean; ms: number; offerCount: number}> => r.status === 'fulfilled')
      .map(r => r.value);
    log.log(`[gpu] Provider probe: ${probed.map(p => `${p.tier.label}(${p.available ? p.offerCount + ' offers' : 'unavailable'}, ${p.ms}ms)`).join(', ')}`);
    // availableTiers stays in original order - do NOT reorder
  }

  for (let i = 0; i < availableTiers.length; i++) {
    const tier = availableTiers[i];
    if (deployCancelled) return;

    // Track active credentials
    if (tier.name === 'runpod') setDeployApiKey(tier.apiKey);
    else if (tier.name === 'vast') setDeployVastApiKey(tier.apiKey);
    else if (tier.name === 'tensordock') { setDeployTensordockApiKey(tier.apiKey); setDeployTensordockAuthId(tier.authId ?? ''); }
    else if (tier.name === 'modal') setDeployModalApiKey(tier.apiKey);
    else if (tier.name === 'hyperstack') setDeployHyperstackApiKey(tier.apiKey);

    const tierStartedAt = Date.now();
    logGpuEvent('deploy_started', tier.name, true);
    startDeploySession(tier.name, dockerImage, gpuTypes[0] ?? '');

    try {
      // Modal uses a deploy script, not a Docker image — resolve to absolute path
      const tierDockerImage = tier.name === 'modal'
        ? modalScriptFor(dockerImage)
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

      const message = deployState.message ?? '';
      if (failureCategory === 'app_error' || failureCategory === 'docker_image') {
        log.error(`[gpu] ${tier.label} failed with non-provider error (${failureCategory}); stopping cascade because another provider will run the same broken image.`);
        clearPersistedDeploy();
        deploymentSM.markError(message || `${tier.label} failed: ${failureCategory}`);
        return;
      }
      if (message.toLowerCase().includes('failed to clean up crashed instance')) {
        log.error(`[gpu] ${tier.label} cleanup failed; stopping cascade to avoid creating another billable orphan.`);
        deploymentSM.markError(message);
        return;
      }
    }

    // If this tier failed and there's a next tier, clear stale instance fields and set fallback alert.
    if (i < availableTiers.length - 1 && deployState.status === 'error') {
      const next = availableTiers[i + 1];
      const alertMsg = formatFallbackAlert(tier.label, next.label);
      log.warn(`[gpu] ⚠️ ${alertMsg}`);
      clearPersistedDeploy();
      setDeployState({
        status: 'creating', provider: next.name, step: 'creating_pod',
        podId: '', endpoint: '', sshHost: '', sshPort: 0, gpuType: '',
        costPerHr: 0, providerMeta: {}, stepDetail: '',
        message: formatFallbackStatus(tier.label, next.label),
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
