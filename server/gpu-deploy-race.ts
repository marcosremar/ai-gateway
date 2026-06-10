// ── Hedged / Race Deploy — launch N instances, keep the first healthy ────────

import type { GpuProviderClient } from '../src/gpu-providers/types';
import type { GpuTier, ProviderName } from '../src/gpu-providers/deploy-orchestrator';
import { DEFAULT_STORAGE_GB } from '../src/gpu-providers/deploy-orchestrator';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { categorizeDeployError } from '../src/errors/deploy-errors';
import { errorSummary } from '../src/error-summary';
import { tryAutoRemediation } from '../src/auto-remediation';
import { createLogger } from '../src/logger';
import {
  deployState, setDeployState, deployCancelled,
  setDeployApiKey, setDeployVastApiKey, setDeployTensordockApiKey,
  setDeployTensordockAuthId, setDeployModalApiKey, setDeployHyperstackApiKey,
  setGpuHealthy, setLastRequestTime,
  deploymentSM, updateGpuModelWarmth,
} from './state';
import { broadcastProviderStatus, broadcastWs } from './ws-state';
import { extractAppHealthError, runGlbSmokeTest, validateEndpointApiContract, tcpReachable, sshCommandReachable } from './gpu-poll-health';
import { emitGatewayEvent } from './event-bus';
import { logGpuEvent, upsertHostReputation } from './metrics';
import { getDeployTimeoutMinForProvider } from '../src/gpu-providers/deploy-settings';
import { activeRaceInstanceIds } from './gpu-orphan-cleanup';
import { categorizeDeployFailure } from './gpu-deploy-tiers';
import type { DeployExtra } from './gpu-deploy';
import type { DeploySlot } from '../src/gateway/state/deploy-state';

const log = createLogger('gpu-deploy');
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
// Kept only as a documented constant for the legacy fallback path. The
// actual per-image script lookup goes through `modalStrategy.resolveImage`
// (see `src/modules/gpu-providers/strategies/modal-strategy.ts`) so the
// trellis2/babelcast/etc Modal apps each get the right `.py` instead of
// every modal slot collapsing onto babelcast.py and crashing.
const MODAL_DEPLOY_SCRIPT_FALLBACK = resolve(SERVER_DIR, '..', 'dockers', 'modal', 'babelcast.py');
import { modalStrategy } from '../src/modules/gpu-providers/strategies';
function modalScriptFor(image: string): string {
  try {
    return modalStrategy.resolveImage(image);
  } catch {
    return MODAL_DEPLOY_SCRIPT_FALLBACK;
  }
}

interface RaceCandidate {
  index: number;
  tier: GpuTier;
  instanceId: string;
  endpoint: string;
  gpuType: string;
  costPerHr: number;
  sshHost: string;
  sshPort: number;
  providerMeta: Record<string, unknown>;
}

export async function startDeployRace(
  tiers: GpuTier[],
  dockerImage: string,
  gpuTypes: string[],
  extra: DeployExtra,
  raceCount: number,
  slot?: DeploySlot,
): Promise<void> {
  // Import these lazily to avoid circular dependency at module load time
  const { startGpuMonitoring } = await import('./gpu-health-monitor');
  const { startCanaryIfEnabled } = await import('./gpu-deploy');
  const { cooldownTracker } = await import('./gpu-deploy');

  const deployStartedAt = Date.now();
  const raceN = Math.min(raceCount, 10); // cap at 10
  const sd = slot ? slot.state : deployState;
  const sds = (patch: Parameters<typeof setDeployState>[0]) => setDeployState(patch, slot ?? undefined);
  const isCancelled = () => slot ? slot.cancelled : deployCancelled;
  const progressInstanceIds = new Set<string>();
  const cancelCleanupInstanceIds = new Set<string>();

  // ── Provider readiness pre-filter ───────────────────────────────────────
  // Don't waste race slots on providers with no credentials (e.g. Modal with no
  // token, RunPod with no key) — they fail every slot instantly and can mask the
  // configured providers behind a misleading "all slots failed". Safe fallback:
  // if everything looks unconfigured, race the original set untouched.
  {
    const { filterUsableTiers } = await import('../src/modules/gpu-providers/provider-readiness');
    const r = filterUsableTiers(tiers);
    if (r.skipped.length > 0) {
      log.log(`[race] skipping ${r.skipped.length} unconfigured provider(s): ${r.skipped.map(t => t.name).join(', ')} — racing: ${r.usable.map(t => t.name).join(', ')}`);
    } else if (r.fellBack) {
      log.warn('[race] all providers look unconfigured (no creds detected) — racing original set as-is; check provider API keys');
    }
    tiers = r.usable;
  }

  // ── Budget gate (same as startDeployWithTiers) ──────────────────────────
  // Race deploys bypass startDeployWithTiers, so we must guard here too.
  // Estimate: $2 per instance (N instances run simultaneously during boot).
  {
    const { canAffordDeploy } = await import('./state');
    const estimatedCost = Math.max(2, raceN * 2);
    const decision = canAffordDeploy(estimatedCost);
    if (!decision.allowed) {
      const msg = `[budget] Race deploy refused: ${decision.reason} (spend=$${decision.currentSpend.toFixed(2)}, projected=$${decision.projected.toFixed(2)}, cap=$${decision.cap.toFixed(2)}, raceN=${raceN})`;
      log.error(msg);
      logGpuEvent('deploy_rejected', tiers[0]?.name ?? 'unknown', false, {
        metadata: { reason: decision.reason, currentSpend: decision.currentSpend, projected: decision.projected, cap: decision.cap, raceN },
      });
      broadcastWs({ type: 'gpu:budget', action: 'deploy-refused', spend: decision.currentSpend, projected: decision.projected, budget: decision.cap, reason: decision.reason });
      sds({ status: 'error', message: msg });
      if (!slot) deploymentSM.markError(msg);
      return;
    }
  }

  // ── Runaway detector (same as startDeployWithTiers) ─────────────────────
  {
    const { getGlobalRunawayDetector } = await import('../src/autoscaler/runaway-detector');
    const detector = getGlobalRunawayDetector();
    const providerName = tiers[0]?.name ?? 'unknown';
    const allowed = detector.recordDeployStart(providerName);
    if (!allowed) {
      const stats = detector.stats(providerName);
      const msg = `[runaway] Race deploy refused: ${providerName} has ${stats.recentStarts} recent starts`;
      log.error(msg);
      logGpuEvent('runaway_pause', providerName, false, { metadata: { recentStarts: stats.recentStarts, raceN } });
      broadcastWs({ type: 'gpu:runaway', action: 'deploy-refused', provider: providerName, recentStarts: stats.recentStarts });
      sds({ status: 'error', message: msg });
      if (!slot) deploymentSM.markError(msg);
      return;
    }
  }

  if (raceN > 1) {
    log.log(`[race] WARNING: race deploy with ${raceN} parallel instances — ${raceN - 1} loser(s) will be billed for boot time (~${getDeployTimeoutMinForProvider('vast')} min max). Cost = (raceCount-1) × costPerHr × boot_min/60.`);
  }

  // Build (tier, gpuType) pair list using provider-interleaved ordering:
  // Prefer diversity across providers before repeating the same provider.
  // e.g. [Vast×4090, TDock×4090, Vast×A6000, TDock×A6000, Vast×4090 ...]
  // rather than [Vast×4090, Vast×A6000, TDock×4090, TDock×A6000 ...]
  const gpuList = gpuTypes.length > 0 ? gpuTypes : [null];
  // Build per-tier queues (ordered by GPU priority)
  const tierQueues: Array<Array<{ tier: GpuTier; gpuType: string | null }>> = tiers.map(t =>
    gpuList.map(g => ({ tier: t, gpuType: g })),
  );
  const pairs: Array<{ tier: GpuTier; gpuType: string | null }> = [];
  let round = 0;
  while (pairs.length < raceN * 2 + 1) { // generate enough to cycle
    let addedThisRound = 0;
    for (const q of tierQueues) {
      const idx = round < q.length ? round : round % q.length;
      pairs.push(q[idx]);
      addedThisRound++;
    }
    if (addedThisRound === 0) break;
    round++;
  }

  if (pairs.length === 0) {
    sds({ status: 'error', message: 'No deployment tiers available for race' });
    if (!slot) deploymentSM.markError('No tiers available');
    return;
  }

  const slots = Array.from({ length: raceN }, (_, i) => {
    const { tier, gpuType } = pairs[i % pairs.length];
    return {
      index: i,
      tier,
      gpuTypes: gpuType ? [gpuType] : gpuTypes,
      tierDockerImage: tier.name === 'modal' ? modalScriptFor(dockerImage) : dockerImage,
    };
  });

  log.log(`[race] Hedged deploy: ${slots.length} slots across ${tiers.map(t => t.label).join(', ')}`);

  // Set credentials for all participating tiers
  for (const tier of tiers) {
    if (tier.name === 'runpod') setDeployApiKey(tier.apiKey);
    else if (tier.name === 'vast') setDeployVastApiKey(tier.apiKey);
    else if (tier.name === 'tensordock') { setDeployTensordockApiKey(tier.apiKey); setDeployTensordockAuthId(tier.authId ?? ''); }
    else if (tier.name === 'modal') setDeployModalApiKey(tier.apiKey);
    else if (tier.name === 'hyperstack') setDeployHyperstackApiKey(tier.apiKey);
  }

  sds({
    status: 'creating', startedAt: deployStartedAt, retryCount: 0,
    podId: '', endpoint: '', gpuType: '',
    message: `Launching ${slots.length} instances in parallel...`,
    step: 'creating_pod', stepDetail: '', provider: slots[0].tier.name,
  });

  // Phase 1: Create all instances in parallel
  const createResults = await Promise.allSettled(slots.map(async (slot) => {
    if (isCancelled()) throw new Error('Deploy cancelled before race slot create');
    const credentials = { apiKey: slot.tier.apiKey, authId: slot.tier.authId };
    const defaultStorage = DEFAULT_STORAGE_GB[slot.tier.name] || 50;
    // Honour explicit body.storageGb verbatim — the previous
    // Math.max(extra.storageGb||defaultStorage, defaultStorage) clamp
    // forced every Vast deploy to 100 GB and excluded most A100 PCIe
    // offers (48-94 GB disk).
    const storageGb = (typeof extra.storageGb === 'number' && extra.storageGb > 0)
      ? extra.storageGb
      : defaultStorage;
    const directPortRequired = (slot.tier.name.startsWith('vast') && extra.requireDirectPort === true)
      // This is a coarse marketplace filter. The Vast client validates the
      // actual SSH host/port after creation when direct SSH is explicitly
      // required; one direct port is enough for SSH-driven jobs.
      ? 1
      : undefined;

    // Progress callback: update deploy state during image pull so the UI
    // shows "pulling_image" instead of being stuck at "creating_pod".
    const onPollProgress = (info: { elapsedS: number; status: string; instanceId: string; ip: string }) => {
      if (info.instanceId) {
        progressInstanceIds.add(info.instanceId);
        activeRaceInstanceIds.add(info.instanceId);
      }
      if (isCancelled() && info.instanceId && !cancelCleanupInstanceIds.has(info.instanceId)) {
        cancelCleanupInstanceIds.add(info.instanceId);
        void slot.tier.client.deleteInstance(info.instanceId, credentials)
          .then(() => log.log(`[race] Cancelled race slot: deleted ${info.instanceId.slice(0, 12)} from progress callback`))
          .catch((err) => log.warn(`[race] Cancelled race slot progress cleanup failed for ${info.instanceId}: ${err instanceof Error ? err.message : err}`));
        return;
      }
      const vastStatus = info.status?.toLowerCase();
      if (vastStatus === 'loading' || vastStatus === 'pulling') {
        sds({
          step: 'pulling_image',
          stepDetail: `${info.instanceId.slice(0, 12)} pulling image (${info.elapsedS}s)`,
          message: `Pulling Docker image on ${slot.tier.label}... (${info.elapsedS}s)`,
          podId: info.instanceId,
        });
      } else if (vastStatus === 'running') {
        sds({
          step: 'waiting_health',
          stepDetail: `${info.instanceId.slice(0, 12)} running, waiting for endpoint`,
          message: `Instance running, resolving endpoint... (${info.elapsedS}s)`,
          podId: info.instanceId,
        });
      }
    };

    const instance = await Promise.race([
      slot.tier.client.createInstance(
        {
          gpuTypes: slot.gpuTypes, dockerImage: slot.tierDockerImage, storageGb,
          region: extra.region, hfToken: extra.hfToken, env: extra.env,
          bareMetal: slot.tier.name === 'tensordock', interruptible: extra.interruptible,
          ...(slot.tier.name === 'runpod' ? { cloudType: 'SECURE' as const } : {}),
          // Vast-only flags that opt the offer search out of the verified-host
          // filter / the strict-fast-boot reliability tier. The handler already
          // copies them into `extra`; we just need to forward them to the
          // provider client so they reach the search payload.
          ...(extra.allowUnverified ? { allowUnverified: extra.allowUnverified } : {}),
          ...(typeof extra.maxPricePerHr === 'number' ? { maxPricePerHr: extra.maxPricePerHr } : {}),
          // Deploy-level race already creates N instances; each slot must
          // create exactly one provider instance to avoid duplicate billing.
          raceCount: 1,
          ...(directPortRequired ? { directPortRequired } : {}),
          ...(extra.readinessProbe ? { readinessProbe: extra.readinessProbe } : {}),
          ...(extra.searchMode ? { searchMode: extra.searchMode } : {}),
          ...(extra.strictFastBoot ? { strictFastBoot: extra.strictFastBoot } : {}),
          ...(extra.label ? { label: extra.label } : {}),
          ...(extra.dockerStartCmd ? { dockerStartCmd: extra.dockerStartCmd } : {}),
          ...(extra.containerDiskInGb ? { containerDiskInGb: extra.containerDiskInGb } : {}),
          ...(extra.volumeId ? { volumeId: extra.volumeId } : {}),
          ...(extra.onstart ? { onstart: extra.onstart } : {}),
          ...(extra.templateHashId ? { templateHashId: extra.templateHashId } : {}),
          ...(extra.forceSshTunnel ? { forceSshTunnel: extra.forceSshTunnel } : {}),
          ...(extra.minInetDownMbps ? { minInetDownMbps: extra.minInetDownMbps } : {}),
          ...(extra.minRamGb ? { minRamGb: extra.minRamGb } : {}),
          ...(extra.minCuda ? { minCuda: extra.minCuda } : {}),
          ...(extra.minReliability ? { minReliability: extra.minReliability } : {}),
          ...(extra.snapgpuPreloadApp ? { snapgpuPreloadApp: extra.snapgpuPreloadApp } : {}),
          ...(extra.snapgpuAutoSnapshot !== undefined ? { autoSnapshot: extra.snapgpuAutoSnapshot } : {}),
          ...(extra.snapgpuBackend ? { snapgpuBackend: extra.snapgpuBackend } : {}),
          // Cooperative cancellation: lets the provider client stop BEFORE
          // reserving/creating an offer and skip host-reputation penalties
          // for racers we cancelled ourselves.
          isCancelled,
          onPollProgress,
        },
        credentials,
      ),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${slot.tier.name} createInstance timed out`)), getDeployTimeoutMinForProvider(slot.tier.name) * 60_000)),
    ]);
    if (isCancelled()) {
      try {
        await slot.tier.client.deleteInstance(instance.instanceId, credentials);
        log.log(`[race] Cancelled race slot: deleted ${instance.instanceId.slice(0, 12)} after create`);
      } catch (err) {
        log.warn(`[race] Cancelled race slot cleanup failed for ${instance.instanceId}: ${err instanceof Error ? err.message : err}`);
      }
      throw new Error('Deploy cancelled after race slot create');
    }
    log.log(`[race] Slot ${slot.index}: created ${instance.instanceId.slice(0, 8)} (gpu=${instance.gpuType}, tier=${slot.tier.label})`);
    return { slot, instance };
  }));

  const candidates: RaceCandidate[] = [];
  const maxPricePerHr = typeof extra.maxPricePerHr === 'number' ? extra.maxPricePerHr : 1.0;
  for (const r of createResults) {
    if (r.status === 'fulfilled') {
      const { slot, instance } = r.value;
      const costPerHr = (instance.providerMeta?.dphTotal as number)
        || (instance.providerMeta?.costPerHr as number)
        || (instance.providerMeta?.pricePerHr as number) || 0;
      if (costPerHr > maxPricePerHr) {
        log.warn(`[race] Slot ${slot.index} (${instance.gpuType}) over budget: $${costPerHr.toFixed(3)}/h > $${maxPricePerHr.toFixed(3)}/h — destroying immediately`);
        try {
          await slot.tier.client.deleteInstance(instance.instanceId, { apiKey: slot.tier.apiKey, authId: slot.tier.authId });
        } catch (err) {
          log.warn(`[race] Failed to destroy over-budget instance: ${err}`);
        }
        continue;
      }
      candidates.push({
        index: slot.index, tier: slot.tier,
        instanceId: instance.instanceId, endpoint: instance.endpoint,
        gpuType: instance.gpuType || '', costPerHr,
        sshHost: instance.sshHost || '', sshPort: instance.sshPort || 0,
        providerMeta: (instance.providerMeta as Record<string, unknown>) ?? {},
      });
    } else {
      log.warn(`[race] Slot create failed: ${r.reason}`);
    }
  }

  if (candidates.length === 0) {
    const reasons = createResults
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => String(r.reason?.message || r.reason))
      .filter(Boolean);
    const reasonSummary = reasons.length > 0 ? `: ${reasons[0]}` : '';
    const msg = isCancelled() ? 'Deploy cancelled' : `All ${slots.length} race slots failed to create instances${reasonSummary}`;
    sds({ status: isCancelled() ? 'idle' : 'error', message: msg });
    if (!slot) deploymentSM.markError(msg);
    return;
  }

  log.log(`[race] ${candidates.length}/${slots.length} instances created — racing to first healthy`);
  // Register all race candidates so the orphan sweep doesn't mistake them for orphans
  for (const c of candidates) activeRaceInstanceIds.add(c.instanceId);
  sds({
    status: 'booting', podId: candidates[0].instanceId,
    endpoint: candidates[0].endpoint, gpuType: candidates[0].gpuType,
    costPerHr: candidates[0].costPerHr, provider: candidates[0].tier.name,
    message: `${candidates.length} instances booting — racing to first healthy...`,
    step: 'waiting_health',
  });
  if (!slot) deploymentSM.startBooting(candidates[0].instanceId);

  // Phase 2: Race health polling — first healthy wins, others are terminated
  // AbortController lets the winner signal all losers instantly (no 5s sleep delay).
  const raceAbort = new AbortController();
  let winner: RaceCandidate | null = null;
  let raceDone = false;
  let lastRaceHealthError = '';

  /** Abortable sleep: resolves after `ms` or immediately when raceAbort fires.
   *  Guards against the signal being already aborted before addEventListener is called. */
  const raceSleep = (ms: number) =>
    new Promise<void>(resolve => {
      if (raceAbort.signal.aborted) { resolve(); return; }
      const t = setTimeout(resolve, ms);
      raceAbort.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });

  /** First healthy candidate becomes the winner: flip global/slot state to
   *  ready, abort the other racers immediately and record metrics. */
  const declareWinner = async (c: RaceCandidate, localEndpoint: string, healthData?: Record<string, unknown>) => {
    raceDone = true;
    raceAbort.abort(); // wake up sleeping losers right away
    const durationMs = Date.now() - deployStartedAt;
    winner = { ...c, endpoint: localEndpoint };
    setGpuHealthy(true);
    setLastRequestTime(Date.now());
    if (healthData) updateGpuModelWarmth(healthData);
    sds({
      status: 'ready',
      podId: c.instanceId, endpoint: localEndpoint, gpuType: c.gpuType,
      costPerHr: c.costPerHr, provider: c.tier.name,
      sshHost: c.sshHost, sshPort: c.sshPort, providerMeta: c.providerMeta,
      message: `GPU ready (race ${candidates.length}→1, ${Math.round(durationMs / 1000)}s): ${localEndpoint || `${c.sshHost}:${c.sshPort} (ssh)`}`,
      step: 'ready', stepDetail: '', deployDurationMs: durationMs,
      alert: '', alertLevel: 'info',
    });
    broadcastProviderStatus('booting', 'cloud', 'GPU deployed — warming up models');
    if (!slot) deploymentSM.markReady(c.instanceId, localEndpoint, c.gpuType, c.costPerHr);
    if (!slot) startGpuMonitoring();
    // startBackgroundWarmthMonitor is internal to gpu-health-monitor
    if (localEndpoint) {
      const { startBackgroundWarmthMonitor } = await import('./gpu-health-monitor');
      startBackgroundWarmthMonitor(localEndpoint);
    }
    startCanaryIfEnabled(extra, dockerImage, c.gpuType);
    log.log(`[race] Winner: deployId=${sd.deployId || '-'} instanceId=${c.instanceId.slice(0, 12)} provider=${c.tier.name} gpu=${c.gpuType} t=${Math.round(durationMs / 1000)}s`);
    logGpuEvent('deploy_ready', c.tier.name, true, { durationMs, metadata: { endpoint: localEndpoint, gpuType: c.gpuType, raceCount: candidates.length, deployId: sd.deployId, owner: slot?.ownerKey ?? 'global' } });
    upsertHostReputation({ provider: c.tier.name, gpuType: c.gpuType, providerMeta: c.providerMeta, success: true, bootTimeS: Math.round(durationMs / 1000), dockerImage });
    if (await cooldownTracker.recordSuccess(c.tier.name)) {
      logGpuEvent('cooldown_cleared', c.tier.name, true, { durationMs });
    }
    emitGatewayEvent('gpu.deployed', {
      deployId: sd.deployId,
      provider: c.tier.name,
      gpuType: c.gpuType,
      endpoint: localEndpoint,
      costPerHr: c.costPerHr,
      durationMs,
      raceCount: candidates.length,
    });
  };

  // Wrap in try/finally to guarantee loser cleanup even if Promise.all throws
  try {
  await Promise.all(candidates.map(async (c, idx) => {
    const credentials = { apiKey: c.tier.apiKey, authId: c.tier.authId };
    let localEndpoint = c.endpoint;
    const timeoutMs = getDeployTimeoutMinForProvider(c.tier.name) * 60_000;

    while (!raceDone && !isCancelled()) {
      if (Date.now() - deployStartedAt > timeoutMs) {
        log.log(`[race] Slot ${idx} timed out`);
        break;
      }

      // Re-resolve endpoint (needed for Vast.ai and others that assign ports mid-boot)
      if (!localEndpoint || c.tier.name === 'vast') {
        try {
          const resolved = await Promise.race([
            c.tier.client.resolveInstanceEndpoint(c.instanceId, credentials),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${c.tier.name} resolveInstanceEndpoint timed out`)), 30_000)),
          ]);
          if (resolved && resolved !== localEndpoint) {
            localEndpoint = resolved;
            if (idx === 0) sds({ endpoint: localEndpoint });
          }
        } catch { /* expected during early boot */ }
      }

      // SSH readiness mode (readinessProbe: 'ssh'): batch/SSH-driven
      // containers have no HTTP /health. Probe the candidate's SSH target
      // instead — mirrors pollSshUntilReady in the non-race path. Without
      // this branch the race polled /health on containers that never serve
      // it and burned the full deploy timeout on every slot.
      if (extra.readinessProbe === 'ssh') {
        if (!c.sshHost || !c.sshPort) {
          const clientWithDetail = c.tier.client as unknown as {
            getInstanceStatusDetail?: (id: string, cred: unknown) => Promise<{ sshHost?: string; sshPort?: number } | null>;
          };
          if (typeof clientWithDetail.getInstanceStatusDetail === 'function') {
            try {
              const detail = await clientWithDetail.getInstanceStatusDetail(c.instanceId, credentials);
              if (detail?.sshHost && detail?.sshPort) { c.sshHost = detail.sshHost; c.sshPort = detail.sshPort; }
            } catch { /* not ready yet — retry next round */ }
          }
        }
        if (c.sshHost && c.sshPort && !raceDone) {
          const tcpOk = await tcpReachable(c.sshHost, c.sshPort, 3000);
          const sshOk = tcpOk && await sshCommandReachable(c.sshHost, c.sshPort, 7000);
          if (sshOk && !raceDone) {
            await declareWinner(c, localEndpoint);
            return; // winner exits cleanly — no cleanup needed
          }
        }
        if (idx === 0 && !raceDone) {
          const elapsed = Math.round((Date.now() - deployStartedAt) / 1000);
          sds({ message: `${candidates.length} instances booting (ssh probe)... [${elapsed}s]` });
        }
        await raceSleep(3000);
        continue;
      }

      // Probe /health
      if (localEndpoint && !raceDone) {
        try {
          // Wire raceAbort.signal so winner-decided losers cancel in-flight
          // /health fetches immediately. Previous code used only a per-fetch
          // 8s timeout — losers wasted up to 8s+contract-validation per slot
          // after the winner was already chosen. AbortSignal.any combines the
          // two signals in Node 20.3+ / Bun.
          const healthSignal = (typeof (AbortSignal as { any?: Function }).any === 'function')
            ? (AbortSignal as { any: (sigs: AbortSignal[]) => AbortSignal }).any([raceAbort.signal, AbortSignal.timeout(8000)])
            : raceAbort.signal;
          const res = await fetch(`${localEndpoint}/health`, { signal: healthSignal });
          if (res.ok) {
            const data = await res.json() as { status?: string };
            const HEALTHY = new Set(['healthy', 'ok', 'degraded', 'ready']);
            if (HEALTHY.has(data.status ?? '')) {
              const appHealthError = extractAppHealthError(data);
              if (appHealthError) {
                lastRaceHealthError = `App load failed on ${c.tier.name}: ${appHealthError.message}`;
                log.warn(`[race] Slot ${idx} rejected: ${lastRaceHealthError}`);
                break;
              }
              // Bail out if winner already declared between fetches — avoids
              // wasted contract validation / smoke tests on losing slots.
              if (raceDone) break;
              const apiContract = await validateEndpointApiContract(localEndpoint, extra.expectedApiPaths, extra.expectedCapabilities, extra.requireDockerManifest);
              if (!apiContract.ok) {
                lastRaceHealthError = apiContract.error;
                log.warn(`[race] Slot ${idx} rejected: ${apiContract.error}`);
                break;
              }
              if (raceDone) break;
              if (extra.runSmokeTests !== false && (extra.expectedCapabilities?.includes('glb_generation') || extra.expectedApiPaths?.some(path => /generate(?:-from-text)?|glb/i.test(path)))) {
                const smoke = await runGlbSmokeTest(localEndpoint, extra.expectedApiPaths);
                if (!smoke.ok) {
                  lastRaceHealthError = smoke.error;
                  log.warn(`[race] Slot ${idx} rejected: ${smoke.error}`);
                  break;
                }
              }
              if (raceDone) break;
              await declareWinner(c, localEndpoint, data as Record<string, unknown>);
              return; // winner exits cleanly — no cleanup needed
            }
          }
        } catch { /* health probe failed — keep trying */ }
      }

      if (idx === 0 && !raceDone) {
        const elapsed = Math.round((Date.now() - deployStartedAt) / 1000);
        sds({ message: `${candidates.length} instances booting... [${elapsed}s]` });
      }

      await raceSleep(5000); // aborted immediately when winner is found
    }

    // Loser, timed out, or cancelled — terminate the instance and log wasted cost
    if (!winner || winner.instanceId !== c.instanceId) {
      const reason = raceDone ? 'lost' : isCancelled() ? 'cancelled' : 'timed out';
      const aliveMs = Date.now() - deployStartedAt;
      const wastedUsd = c.costPerHr > 0 ? c.costPerHr * aliveMs / 3_600_000 : 0;
      try {
        await Promise.race([
          c.tier.client.deleteInstance(c.instanceId, credentials),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${c.tier.name} deleteInstance timed out`)), 15_000)),
        ]);
        log.log(
          `[race] Loser destroyed: deployId=${sd.deployId || '-'} instanceId=${c.instanceId.slice(0, 12)} ` +
          `provider=${c.tier.name} gpu=${c.gpuType || '-'} reason=${reason} ` +
          `alive=${Math.round(aliveMs / 1000)}s` +
          (wastedUsd > 0 ? ` wasted≈$${wastedUsd.toFixed(3)}` : ''),
        );
        logGpuEvent('race_loser_destroyed', c.tier.name, true, {
          durationMs: aliveMs,
          metadata: { instanceId: c.instanceId, gpuType: c.gpuType, reason, wastedUsd: +wastedUsd.toFixed(4), raceCount: candidates.length },
        });
      } catch (err) {
        // Orphan sweep will eventually terminate this stray instance when race completes
        log.warn(`[race] Failed to terminate slot ${idx} (${reason}): ${err}`);
      }
    }
  }));
  } catch (raceErr) {
    // Promise.all threw — some slots may not have cleaned up their pods.
    // Force-terminate any non-winner instances that are still alive.
    const deployErr = categorizeDeployError(raceErr, {
      deployId: sd.deployId,
      provider: 'race',
      gpuType: sd.gpuType,
      imageName: sd.dockerImage,
    });
    errorSummary.record(deployErr, sd.deployId);
    const remediation = await tryAutoRemediation(deployErr);
    if (remediation) {
      log.warn({ action: remediation.action, suggestions: remediation.suggestions }, 'Auto-remediation attempted');
    }
    log.error({ code: deployErr.code, category: deployErr.category }, `Race deploy exception: ${deployErr.message}`);
    // TS narrows `winner` to `never` in this catch block because all assignments
    // live inside Promise callbacks. Re-cast to match the declared type.
    const winnerCandidate = winner as RaceCandidate | null;
    for (const c of candidates) {
      if (winnerCandidate && winnerCandidate.instanceId === c.instanceId) continue;
      try {
        await Promise.race([
          c.tier.client.deleteInstance(c.instanceId, { apiKey: c.tier.apiKey, authId: c.tier.authId }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 10_000)),
        ]);
        log.log(`[race] Force-cleaned ${c.instanceId.slice(0, 8)} on ${c.tier.name}`);
      } catch { /* best effort */ }
    }
  } finally {
    // Always clear race tracking — sweep may now treat any remaining instances as orphans
    for (const c of candidates) activeRaceInstanceIds.delete(c.instanceId);
    for (const instanceId of progressInstanceIds) activeRaceInstanceIds.delete(instanceId);
  }

  // Phase 3: Final state / race summary
  if (winner) {
    const w = winner as RaceCandidate;
    // Wall-clock since deploy started — independent of costPerHr (some price
    // probes return 0 for free/credit-funded offers, but the actual boot time
    // still matters for observability). Previous gating on costPerHr made the
    // summary log report 0ms boot for legitimate free-tier deploys.
    const winnerBootMs = Date.now() - deployStartedAt;
    const loserCount = candidates.length - 1;
    if (loserCount > 0) {
      // w is already declared above — no need to redeclare
      const totalWastedUsd = candidates
        .filter(c => c.instanceId !== w.instanceId)
        .reduce((sum, c) => sum + (c.costPerHr > 0 ? c.costPerHr * (Date.now() - deployStartedAt) / 3_600_000 : 0), 0);
      log.log(
        `[race] Summary: ${candidates.length} instances → winner in ${Math.round(winnerBootMs / 1000)}s, ` +
        `${loserCount} loser(s) terminated, total wasted≈$${totalWastedUsd.toFixed(3)}`,
      );
    }
  } else {
    const msg = isCancelled() ? 'Deploy cancelled' : (lastRaceHealthError || 'All race candidates failed to become healthy');
    sds({ status: isCancelled() ? 'idle' : 'error', message: msg });
    if (!slot) deploymentSM.markError(msg);
    if (!isCancelled()) {
      // The non-race path emits deploy_failed from the tier loop; races end
      // here, so emit it directly — without this, race failures were
      // invisible to the deploy metrics/alerts.
      logGpuEvent('deploy_failed', candidates[0]?.tier.name ?? 'race', false, {
        durationMs: Date.now() - deployStartedAt,
        error: msg,
        metadata: { failureCategory: categorizeDeployFailure(msg), deployId: sd.deployId, gpuType: candidates[0]?.gpuType ?? '', owner: slot?.ownerKey ?? 'global', raceCount: candidates.length },
      });
    }
    emitGatewayEvent('gpu.failed', {
      deployId: sd.deployId,
      error: msg,
      durationMs: Date.now() - deployStartedAt,
      raceCount: candidates.length,
    });
  }
}
