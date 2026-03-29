// ── BabelCast Gateway — GPU HTTP Handlers ───────────────────────────────────
// handleGpuDeploy, handleGpuStatus, handleGpuOffers, handleGpuTypes,
// handleGpuTerminate, handleGpuLogs, handleGpuCatalog, handleHealth.

import type { IncomingMessage, ServerResponse } from 'http';
import type { GpuProviderClient, GpuOffer, ListOffersOptions, ProviderCredentials } from '../src/gpu-providers/types';
import { filterTiers } from '../src/gpu-providers/deploy-orchestrator';
import type { ProviderName } from '../src/gpu-providers/deploy-orchestrator';
import {
  deployState, setDeployState, deployCancelled, setDeployCancelled, deployLock, setDeployLock,
  deployPromise, setDeployPromise, gpuHealthy, lastRequestTime,
  deployVastApiKey, deployTensordockApiKey, deployTensordockAuthId, deployModalApiKey, deployApiKey,
  latencyRing, startedAt, pendingDbWrites, providerMetrics, metricsCounters, activeRequests,
  isGpuAvailable, resetDeployState, prisma, DAILY_BUDGET_USD, dailyGpuSpendUsd,
  deploymentSM,
  ttsWarmth, getColdStartProfile, gpuModelWarmth, isStageWarm,
  standbyDeployState, standbyReadyForHandover,
} from './state';
import { triggerStandbyDeploy, initiateHandover, cancelStandby, startStandbyMonitor } from './gpu-standby';
export { startStandbyMonitor };
import {
  getStandbyEnabled, setStandbyEnabled, getStandbyTriggerHours, setStandbyTriggerHours,
  getStandbyDrainTimeoutMs, setStandbyDrainTimeoutMs,
} from '../src/gpu-providers/deploy-settings';
import { shouldPreferGpuTts, getStageBreakersSnapshot } from './providers';
import {
  translationProfile, updateTranslationProfile, runpod, vast, tensordock, modal,
  ollamaAvailable, groqAvailable, openaiAvailable,
} from './providers';
import {
  stopGpuMonitoring, startDeployWithTiers, startDeployRace, buildGpuTiers, cooldownTracker,
  cleanupAllPods, cleanupVastInstances, cleanupTensordockInstances, cleanupModalApps,
  autoSelectCheapestGpu, fetchGpuLogs, getVerifiedGpuTypes, validateGpuTypesFromCache,
  IDLE_TIMEOUT_MS, POD_NAME_PREFIX,
} from './gpu-deploy';
import { logGpuEvent, updateDeploySession, computePercentile, upsertHostReputation, getAllReputations } from './metrics';
import {
  getOrCreateRequestId, setRequestIdHeader, readJsonBody, handleBodyError,
  validateGpuCredentials,
} from './http-utils';
import { getImageCatalog, PORT, PROVIDER_CHAIN, resolveDockerImageForGpus, LOW_BALANCE_THRESHOLD_USD } from './config';
import { BILLING_URLS } from '../src/providers/errors';
import { fetchIpLocation, extractIp, fetchRunPodDatacenter, parseProviderRegion, fetchMyLocation } from './ip-location';
import { rankOffers, scheduleBackgroundProbes, probeAndSaveOffers } from './gpu-latency';
import { upsertHostMeta, getHostRttMap, getAllHostLatencies, getLatencyDbStats, setHostsMonitored, sortGpuTypesByLatency, getBestLatencyByGpuModel } from './latency-db';
import { loadProviderConfig } from './config-persistence';

// ── GPU management endpoints ────────────────────────────────────────────────

// ── Deploy request validation & config types ─────────────────────────────────

/** Validated deploy configuration produced by _validateDeployRequest. */
interface DeployConfig {
  apiKey: string;              // RunPod API key (may be empty)
  vastApiKey: string;
  tensordockApiKey: string;
  tensordockAuthId: string;
  modalApiKey: string;
  dockerImage: string;
  gpuTypes: string[];
  autoSelectGpu: boolean;
  region: string;
  minVramGb: number;
  preferSsd: boolean;
  storageGb: number;
  hfToken: string;
  llmModel: string;
  interruptible: boolean | undefined;
  raceCount: number;
  deployEnv: Record<string, string>;
  dockerStartCmd: string;
  containerDiskInGb: number;
  volumeId: string;
  providerFilter: ProviderName | undefined;
}

/**
 * Parse and validate the deploy request body. Returns a typed DeployConfig or
 * throws an error with { status, message } for the caller to send as an HTTP response.
 */
async function _validateDeployRequest(
  body: Record<string, unknown>,
  requestId: string,
): Promise<DeployConfig> {
  const apiKey = (body.apiKey as string) || process.env.RUNPOD_API_KEY || '';
  const vastApiKey = (body.vastApiKey as string) || process.env.VAST_API_KEY || '';
  const tensordockApiKey = (body.tensordockApiKey as string) || process.env.TENSORDOCK_API_KEY || '';
  const tensordockAuthId = (body.tensordockAuthId as string) || process.env.TENSORDOCK_AUTH_ID || '';
  const modalTokenId = (body.modalTokenId as string) || process.env.MODAL_TOKEN_ID || '';
  const modalTokenSecret = (body.modalTokenSecret as string) || process.env.MODAL_TOKEN_SECRET || '';
  const modalApiKey = modalTokenId && modalTokenSecret ? `${modalTokenId}:${modalTokenSecret}` : '';

  // Validate credential format before using them
  const credError = validateGpuCredentials({
    runpodApiKey: apiKey,
    vastApiKey,
    tensordockApiKey,
    tensordockAuthId,
    modalTokenId,
    modalTokenSecret,
  });
  if (credError) {
    throw { status: 400, message: credError };
  }

  if (!apiKey && !vastApiKey && !tensordockApiKey && !modalApiKey) {
    throw { status: 400, message: 'At least one provider API key is required (apiKey, vastApiKey, or Modal tokens)' };
  }

  // Resolve profile-based GPU deploy config — use active profile as defaults
  const profileId = (body.profileId as string) || loadProviderConfig().activeProfileId;
  const profiles = loadProviderConfig().profiles;
  const activeProfile = profileId ? profiles.find(p => p.id === profileId) : null;
  const profileGpu = activeProfile?.gpuDeploy;

  const dockerImage = (body.dockerImage as string) || profileGpu?.dockerImage || '';
  if (!dockerImage) {
    throw { status: 400, message: 'dockerImage is required — provide dockerImage, profileId, or set an active profile with gpuDeploy config' };
  }

  const rawGpuTypes = body.gpuTypes;
  let gpuTypes: string[] = Array.isArray(rawGpuTypes)
    ? rawGpuTypes
    : typeof rawGpuTypes === 'string'
      ? rawGpuTypes.split(',').map((s: string) => s.trim()).filter(Boolean)
      : profileGpu?.gpuTypes ?? [];
  const autoSelectGpu = body.autoSelectGpu === true;

  // Region / hardware filters: profile → saved preference → request body
  const region = (body.region as string) || profileGpu?.region || getDeployRegion();
  // Apply profile timeout if provided (and not overridden by body)
  if (profileGpu?.timeoutMin && typeof body.timeoutMin !== 'number') {
    setDeployTimeoutMin(profileGpu.timeoutMin);
  }
  const minVramGb = typeof body.minVramGb === 'number' ? body.minVramGb : getMinVramGb();
  const preferSsd = typeof body.preferSsd === 'boolean' ? body.preferSsd : getPreferSsd();
  const storageGb = (body.storageGb as number) || 0;
  const hfToken = (body.hfToken as string) || process.env.HF_TOKEN || '';
  const llmModel = (body.llmModel as string) || '';
  const interruptible = body.interruptible === true ? true : undefined;

  // Hedged deploy: launch raceCount instances in parallel, keep first healthy
  const raceCount = typeof body.raceCount === 'number' && body.raceCount >= 1
    ? Math.min(Math.floor(body.raceCount), 10)
    : getDeployRaceCount();

  // Custom env vars, Docker start command, and container disk
  const customEnv = (typeof body.env === 'object' && body.env !== null && !Array.isArray(body.env))
    ? body.env as Record<string, string> : {};
  const dockerStartCmd = (body.dockerStartCmd as string) || '';
  const containerDiskInGb = typeof body.containerDiskInGb === 'number' ? body.containerDiskInGb : 0;
  // RunPod Network Volume ID — attach existing volume for persistent LLM GGUF cache
  const volumeId = (body.volumeId as string) || '';
  const deployEnv: Record<string, string> = { ...customEnv };
  if (llmModel) deployEnv.CONF_LLM_MODEL = llmModel;

  // Enforce GPU allowlist — only tested & approved GPUs are permitted.
  if (gpuTypes.length > 0) {
    const effectiveAllowed = new Set(getGpuPriorityList());
    const rejected = gpuTypes.filter(g => !effectiveAllowed.has(g));
    if (rejected.length > 0) {
      console.warn(`[req=${requestId}] Rejected non-tested GPU(s): ${rejected.join(', ')}`);
    }
    gpuTypes = gpuTypes.filter(g => effectiveAllowed.has(g));
    if (gpuTypes.length === 0) {
      throw { status: 400, message: `None of the requested GPUs are in the tested allowlist. Allowed: ${[...effectiveAllowed].join(', ')}` };
    }
  } else if (!autoSelectGpu) {
    // No GPU specified and no auto-select — use user-configured priority list from settings
    const userList = getGpuPriorityList();
    gpuTypes = userList.length > 0 ? userList : await getVerifiedGpuTypes(dockerImage);
    console.log(`[req=${requestId}] No GPU specified — using priority list: ${gpuTypes.join(', ')}`);
  }

  return {
    apiKey, vastApiKey, tensordockApiKey, tensordockAuthId, modalApiKey,
    dockerImage, gpuTypes, autoSelectGpu, region, minVramGb, preferSsd,
    storageGb, hfToken, llmModel, interruptible, raceCount, deployEnv,
    dockerStartCmd, containerDiskInGb, volumeId,
    providerFilter: body.provider as ProviderName | undefined,
  };
}

// ── Tier selection: balance checks, GPU ordering, image resolution ────────────

/** Result of tier selection — everything needed to start the deploy. */
interface TierSelectionResult {
  tiers: import('../src/gpu-providers/deploy-orchestrator').GpuTier[];
  gpuTypes: string[];
  resolvedDockerImage: string;
  gpuPriorityByProvider: Record<string, string[]>;
  /** Providers excluded from this deploy due to low balance. */
  balanceWarnings: string[];
}

/**
 * Check provider balances, build tier list, auto-select GPUs, apply latency
 * sorting, and resolve the Docker image. Throws { status, message } on failure.
 */
async function _selectDeploymentTier(
  config: DeployConfig,
  requestId: string,
): Promise<TierSelectionResult> {
  let { gpuTypes } = config;
  const { apiKey, vastApiKey, tensordockApiKey, tensordockAuthId, modalApiKey,
    dockerImage, autoSelectGpu, region, minVramGb: minVramGbReq, preferSsd: preferSsdReq,
    providerFilter } = config;

  // Pre-flight: validate RunPod key + check balance via RunpodClient
  let runpodApiKey = apiKey;
  if (runpodApiKey) {
    try {
      const runpodBal = await runpod.checkBalance({ apiKey: runpodApiKey });
      if (runpodBal !== null) {
        console.log(`[gpu] RunPod balance: $${runpodBal.balance.toFixed(2)}`);
        if (runpodBal.balance < 1.0) {
          console.warn(`[gpu] RunPod balance too low ($${runpodBal.balance.toFixed(2)}) — skipping provider`);
          runpodApiKey = '';  // exclude from tier list
        }
      }
    } catch (balErr) {
      const msg = balErr instanceof Error ? balErr.message : String(balErr);
      if (/401|403|unauthorized|invalid/i.test(msg)) {
        throw { status: 401, message: 'RunPod API key is invalid' };
      }
      console.warn(`[gpu] RunPod balance check failed: ${msg} — proceeding anyway`);
    }
  }

  // Pre-deploy balance check for TensorDock
  let tensordockOpts = tensordockApiKey && tensordockAuthId ? { apiKey: tensordockApiKey, authId: tensordockAuthId } : undefined;
  if (tensordockOpts) {
    try {
      const bal = await tensordock.checkBalance({ apiKey: tensordockApiKey, authId: tensordockAuthId });
      if (bal !== null) {
        console.log(`[gpu] TensorDock balance: $${bal.balance.toFixed(2)} (hourly cost: $${bal.hourlyCost.toFixed(3)})`);
        if (bal.balance < 1.0) {
          console.warn(`[gpu] TensorDock balance too low ($${bal.balance.toFixed(2)}) — skipping provider`);
          tensordockOpts = undefined;  // exclude from tier list
        }
      }
    } catch (balErr) {
      const msg = balErr instanceof Error ? balErr.message : String(balErr);
      if (/401|403|unauthorized|invalid/i.test(msg)) {
        throw { status: 401, message: 'TensorDock credentials are invalid' };
      }
      console.warn(`[gpu] TensorDock balance check failed: ${msg} — proceeding anyway`);
    }
  }

  // Pre-deploy balance check for Vast.ai
  let effectiveVastApiKey = vastApiKey;
  if (effectiveVastApiKey) {
    try {
      const bal = await vast.checkBalance({ apiKey: effectiveVastApiKey });
      if (bal !== null) {
        console.log(`[gpu] Vast.ai balance: $${bal.balance.toFixed(2)}`);
        if (bal.balance <= 0) {
          console.warn(`[gpu] Vast.ai balance is $${bal.balance.toFixed(2)} — skipping provider`);
          effectiveVastApiKey = '';  // exclude from tier list
        } else if (bal.balance < LOW_BALANCE_THRESHOLD_USD) {
          console.warn(`[gpu] Vast.ai balance low ($${bal.balance.toFixed(2)}) — skipping provider`);
          effectiveVastApiKey = '';  // exclude from tier list
        }
      }
    } catch (balErr) {
      const msg = balErr instanceof Error ? balErr.message : String(balErr);
      if (/401|403|unauthorized|invalid/i.test(msg)) {
        throw { status: 401, message: 'Vast.ai API key is invalid' };
      }
      console.warn(`[gpu] Vast.ai balance check failed: ${msg} — proceeding anyway`);
    }
  }

  // Log providers excluded due to insufficient balance
  const balanceExcluded: string[] = [];
  if (apiKey && !runpodApiKey) balanceExcluded.push('RunPod');
  if ((tensordockApiKey && tensordockAuthId) && !tensordockOpts) balanceExcluded.push('TensorDock');
  if (vastApiKey && !effectiveVastApiKey) balanceExcluded.push('Vast.ai');
  if (balanceExcluded.length > 0) {
    console.warn(`[gpu] Providers excluded (balance < $${LOW_BALANCE_THRESHOLD_USD}): ${balanceExcluded.join(', ')}`);
  }

  // If ALL configured providers were excluded due to insufficient balance, reject the deploy
  const configuredProviders: string[] = [];
  if (apiKey) configuredProviders.push('RunPod');
  if (tensordockApiKey && tensordockAuthId) configuredProviders.push('TensorDock');
  if (vastApiKey) configuredProviders.push('Vast.ai');
  // Modal doesn't have a balance API, so don't include it in the all-excluded check
  const nonModalConfigured = configuredProviders.length;
  if (nonModalConfigured > 0 && balanceExcluded.length >= nonModalConfigured && !modalApiKey) {
    const providerList = balanceExcluded.map(p => `${p}`).join(', ');
    throw { status: 402, message: `Insufficient balance for all configured providers (${providerList}). Please add funds before deploying.` };
  }

  // Build tier list from available API keys, optionally filtered to a specific provider
  const allTiers = buildGpuTiers(runpodApiKey, effectiveVastApiKey || undefined, tensordockOpts, modalApiKey || undefined);
  console.log(`[req=${requestId}] providerFilter=${providerFilter ?? 'none'}, allTiers=[${allTiers.map(t => t.name).join(', ')}]`);
  const filtered = filterTiers(allTiers, providerFilter);
  if ('error' in filtered) {
    const balanceHint = balanceExcluded.length > 0
      ? ` (${balanceExcluded.join(', ')} excluded — balance < $1)`
      : '';
    throw { status: 400, message: filtered.error + balanceHint };
  }
  const tiers = filtered.tiers;

  // Auto-select cheapest GPUs with adequate VRAM when autoSelectGpu is true and no gpuTypes specified
  if (autoSelectGpu && gpuTypes.length === 0 && tiers.length > 0) {
    const selectedGpus = await autoSelectCheapestGpu(tiers, { region, minVramGb: minVramGbReq, preferSsd: preferSsdReq });
    if (selectedGpus.length > 0) {
      gpuTypes = selectedGpus;
      console.log(`[gpu] Auto-selected ${gpuTypes.length} GPU types: ${gpuTypes.join(', ')}`);
    } else {
      console.warn(`[gpu] autoSelectGpu: no suitable GPU found (>=${getMinVramGb()}GB VRAM), falling back to verified GPU list`);
      gpuTypes = await getVerifiedGpuTypes(dockerImage);
    }
  }

  // Latency-aware GPU type ordering: deprioritise types where ALL known hosts exceed threshold.
  const maxLatencyMs = getLatencyMaxMs();
  if (maxLatencyMs > 0 && gpuTypes.length > 1) {
    const sorted = sortGpuTypesByLatency(gpuTypes, maxLatencyMs);
    if (sorted.join(',') !== gpuTypes.join(',')) {
      console.log(`[gpu] Latency filter (threshold=${maxLatencyMs}ms): ${gpuTypes.join(', ')} → ${sorted.join(', ')}`);
    }
    gpuTypes = sorted;
  }

  // Auto-swap Docker image to Blackwell variant when a Blackwell GPU is selected
  const resolvedDockerImage = resolveDockerImageForGpus(dockerImage, gpuTypes);

  // Validate GPU types against cached provider inventory
  if (gpuTypes.length > 0) {
    const gpuTypeError = await validateGpuTypesFromCache(gpuTypes);
    if (gpuTypeError) {
      console.warn(`[req=${requestId}] GPU type validation warning: ${gpuTypeError}`);
    }
  }

  // Clean up ALL existing instances (not just the tracked one) to prevent orphans
  const oldPodId = deployState.podId;
  stopGpuMonitoring();
  updateTranslationProfile({ gpuEndpoint: undefined }, 'handleGpuDeploy:cleanup');
  try {
    if (apiKey) {
      await cleanupAllPods(apiKey, oldPodId ? [oldPodId] : []);
    }
    if (vastApiKey) {
      await cleanupVastInstances(vastApiKey);
    }
    if (tensordockOpts) {
      await cleanupTensordockInstances(tensordockOpts.apiKey, tensordockOpts.authId);
    }
    if (modalApiKey) {
      await cleanupModalApps(modalApiKey);
    }
  } catch (cleanupErr) {
    console.warn(`[gpu] Pre-deploy cleanup error (non-fatal): ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`);
  }

  // Build per-provider GPU type map (provider's own priority list, filtered to the selected types)
  const gpuPriorityByProvider = getDefaultGpuPriorityByProvider();
  for (const p of Object.keys(gpuPriorityByProvider)) {
    gpuPriorityByProvider[p] = getGpuPriorityForProvider(p)
      .filter(g => gpuTypes.includes(g) || gpuTypes.length === 0);
    if (gpuPriorityByProvider[p].length === 0) gpuPriorityByProvider[p] = gpuTypes;
  }

  // Apply selection criteria: re-sort per-provider GPU lists (and main gpuTypes) at deploy time.
  const sortBy = getGpuSortBy();
  if (sortBy === 'latency') {
    const latencyData = getBestLatencyByGpuModel();
    const normalizeGpu = (s: string) => s.replace(/nvidia|geforce/gi, '').replace(/\s+/g, '').toLowerCase();
    const getLatMs = (gpu: string): number => (latencyData[normalizeGpu(gpu)]?.bestMs ?? Infinity);
    const sortByLatency = (list: string[]) => [...list].sort((a, b) => getLatMs(a) - getLatMs(b));
    gpuTypes = sortByLatency(gpuTypes);
    for (const p of Object.keys(gpuPriorityByProvider)) {
      gpuPriorityByProvider[p] = sortByLatency(gpuPriorityByProvider[p]);
    }
    console.log(`[gpu] deploy sort=latency → ${gpuTypes.map(g => `${g.replace('NVIDIA ','').replace('GeForce ','')}(${getLatMs(g) === Infinity ? '?' : getLatMs(g) + 'ms'})`).join(', ')}`);
  } else if (sortBy === 'price') {
    // Price sorting is handled inside autoSelectCheapestGpu / provider clients — nothing to reorder here.
  }
  // balanced: keep existing order (user priority list already incorporates reputation/latency balance)

  return { tiers, gpuTypes, resolvedDockerImage, gpuPriorityByProvider, balanceWarnings: balanceExcluded };
}

// ── Deploy kickoff: launch the deploy promise and send HTTP response ──────────

/**
 * Start the async deploy, set up the deploy promise, and write the 202 response.
 */
function _startDeployAndRespond(
  config: DeployConfig,
  tierResult: TierSelectionResult,
  requestId: string,
  res: ServerResponse,
): void {
  const { raceCount, region, storageGb, hfToken, deployEnv, interruptible, dockerStartCmd, containerDiskInGb, volumeId } = config;
  const { tiers, gpuTypes, resolvedDockerImage, gpuPriorityByProvider } = tierResult;

  setDeployCancelled(false);
  try {
    deploymentSM.startDeploying();
  } catch (smErr) {
    console.error(`[gpu] State machine error: ${smErr}`);
    setDeployLock(false);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Internal server error', type: 'server_error' } }));
    return;
  }

  const extra = { region, storageGb, hfToken, env: Object.keys(deployEnv).length > 0 ? deployEnv : undefined, interruptible, ...(dockerStartCmd ? { dockerStartCmd } : {}), ...(containerDiskInGb > 0 ? { containerDiskInGb } : {}), ...(volumeId ? { volumeId } : {}) };

  const deployFn = raceCount > 1
    ? startDeployRace(tiers, resolvedDockerImage, gpuTypes, extra, raceCount)
    : startDeployWithTiers(tiers, resolvedDockerImage, gpuTypes, extra, gpuPriorityByProvider);
  setDeployPromise(
    deployFn
      .catch(err => {
        console.error(`[gpu] Deploy failed unexpectedly: ${err}`);
        setDeployState({ status: 'error', message: `Deploy failed: ${err instanceof Error ? err.message : err}` });
      })
      .finally(() => { setDeployLock(false); setDeployPromise(null); })
  );

  const modeLabel = raceCount > 1 ? `race×${raceCount}` : `${tiers.length} tier(s): ${tiers.map(t => t.label).join(' → ')}`;
  console.log(`[req=${requestId}] GPU deploy started: ${modeLabel}`);
  res.writeHead(202, { 'Content-Type': 'application/json' });
  const responseBody: Record<string, unknown> = { status: 'creating', message: `Deploy started (${modeLabel})` };
  if (tierResult.balanceWarnings.length > 0) {
    responseBody.balanceWarnings = tierResult.balanceWarnings.map(p =>
      `${p} excluded — balance below $${LOW_BALANCE_THRESHOLD_USD}`
    );
    console.warn(`[req=${requestId}] Deploy balance warnings: ${tierResult.balanceWarnings.join(', ')} excluded (low balance)`);
  }
  res.end(JSON.stringify(responseBody));
}

// ── Main deploy handler (orchestrator) ───────────────────────────────────────

export async function handleGpuDeploy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  // If a deploy is already in progress (creating/booting/installing), cancel it first for redeploy
  if (deployState.status !== 'idle' && deployState.status !== 'error' && deployState.status !== 'ready') {
    console.log(`[req=${requestId}] Cancelling in-progress deploy (status=${deployState.status}) for redeploy`);
    setDeployCancelled(true);
    stopGpuMonitoring();
    // Wait for the deploy loop to actually finish (up to 10s) instead of a fixed delay
    if (deployPromise) {
      await Promise.race([deployPromise, new Promise(r => setTimeout(r, 10_000))]);
    }
    // Only release lock if the deploy actually finished; if still running, mark cancelled and release
    const stillRunning = deployState.status === 'creating' || deployState.status === 'booting' || deployState.status === 'installing';
    if (stillRunning) {
      // Deploy timed out waiting — it's already been cancelled above; release lock so redeploy can proceed
      console.log(`[req=${requestId}] Deploy still in-flight after 10s wait (status=${deployState.status}) — releasing lock after cancel`);
      setDeployCancelled(true);
    }
    setDeployLock(false);
  }

  // If GPU is ready, stop monitoring and reset for new deploy
  if (deployState.status === 'ready') {
    console.log(`[req=${requestId}] GPU was ready — tearing down for redeploy`);
    stopGpuMonitoring();
    updateTranslationProfile({ gpuEndpoint: undefined }, 'handleGpuDeploy:redeploy');
    setDeployLock(false);
  }

  // SAFETY: check-then-set is atomic here because JS is single-threaded and there
  // is no `await` between the check and the set. No other code can interleave.
  // Do NOT insert any async operation between these two lines.
  if (deployLock) {
    console.log(`[req=${requestId}] GPU deploy rejected: lock held`);
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Deploy lock held — try again in a moment', status: deployState.status }));
    return;
  }
  setDeployLock(true);

  // Once _startDeployAndRespond is called, it takes ownership of the lock
  // (released in the deploy promise's .finally()). Track this so we only
  // release the lock in our finally block if ownership was NOT transferred.
  let lockTransferred = false;
  try {
    let body: Record<string, unknown>;
    try { body = await readJsonBody(req); }
    catch (e) { handleBodyError(res, e); return; }

    // Step 1: Validate request and build typed config
    let config: DeployConfig;
    try {
      config = await _validateDeployRequest(body, requestId);
    } catch (err: unknown) {
      const status = (err as any)?.status ?? 400;
      const message = (err as any)?.message ?? String(err);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message, type: 'validation_error' } }));
      return;
    }

    // Step 2: Select deployment tiers (balance checks, GPU ordering, image resolution)
    let tierResult: TierSelectionResult;
    try {
      tierResult = await _selectDeploymentTier(config, requestId);
    } catch (err: unknown) {
      const status = (err as any)?.status ?? 500;
      const message = (err as any)?.message ?? String(err);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message, type: 'server_error' } }));
      return;
    }

    // Step 3: Start the deploy and send the 202 response.
    // _startDeployAndRespond takes ownership of the lock (released in .finally()).
    lockTransferred = true;
    _startDeployAndRespond(config, tierResult, requestId, res);
  } finally {
    if (!lockTransferred) {
      setDeployLock(false);
    }
  }
}

export async function handleGpuStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(_req);
  setRequestIdHeader(res, requestId);
  console.log(`[req=${requestId}] GPU status query`);
  const elapsed = deployState.startedAt > 0 ? Math.round((Date.now() - deployState.startedAt) / 1000) : 0;
  const activeTier = isGpuAvailable() ? 'gpu' : 'cloud';
  const idleSec = lastRequestTime > 0 ? Math.round((Date.now() - lastRequestTime) / 1000) : 0;

  // Collect active provider cooldowns
  const cooldowns = cooldownTracker.getActiveCooldowns();

  // Fetch TensorDock balance if it's the active provider
  let providerBalance: { balance: number; hourlyCost: number } | undefined;
  if (deployState.provider === 'tensordock' && deployTensordockApiKey && deployTensordockAuthId) {
    const bal = await tensordock.checkBalance({ apiKey: deployTensordockApiKey, authId: deployTensordockAuthId });
    if (bal) providerBalance = bal;
  }

  // IP geolocation — waterfall: real IP → RunPod datacenter GraphQL → provider region string
  const hostIp = extractIp(deployState.providerMeta as Record<string, unknown>, deployState.sshHost);
  let ipLocation = hostIp ? await fetchIpLocation(hostIp) : null;
  if (!ipLocation && deployState.provider === 'runpod' && deployState.podId && deployApiKey) {
    ipLocation = await fetchRunPodDatacenter(deployState.podId, deployApiKey);
  }
  if (!ipLocation) {
    const regionStr = (deployState.providerMeta?.region as string) || '';
    ipLocation = parseProviderRegion(regionStr);
  }

  // Omit lastLogs from status (use /v1/gpu/logs for full logs)
  const { lastLogs, message: rawMessage, ...stateWithoutLogs } = deployState;
  const message = deployState.status === 'error' ? friendlyErrorMessage(rawMessage) : rawMessage;
  // Fall back to providerMeta cost fields if costPerHr wasn't captured at deploy time
  const effectiveCostPerHr = deployState.costPerHr
    || (deployState.providerMeta?.dphTotal as number)
    || (deployState.providerMeta?.costPerHr as number)
    || 0;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ...stateWithoutLogs,
    costPerHr: effectiveCostPerHr,
    message,
    elapsedSec: elapsed,
    deployTimeoutSec: getDeployTimeoutMin() * 60,
    gpuHealthy,
    activeTier,
    idleSec,
    idleTimeoutSec: Math.round(IDLE_TIMEOUT_MS / 1000),
    provider: deployState.provider,
    alert: deployState.alert,
    region: (deployState.providerMeta?.region as string) || '',
    ipLocation: ipLocation ?? undefined,
    machineInfo: {
      instanceId: deployState.podId || null,
      ramGb: (deployState.providerMeta?.ramGb as number) || null,
      gpuVramGb: (deployState.providerMeta?.gpuVramGb as number) || null,
      diskGb: (deployState.providerMeta?.diskGb as number) || null,
      numGpus: (deployState.providerMeta?.numGpus as number) || null,
      inetDownMbps: (deployState.providerMeta?.inetDown as number) || null,
      inetUpMbps: (deployState.providerMeta?.inetUp as number) || null,
      cpuCores: (deployState.providerMeta?.cpuCores as number) || null,
    },
    hasRemoteLogs: !!lastLogs,
    providerCooldowns: Object.keys(cooldowns).length > 0 ? cooldowns : undefined,
    providerBalance,
    deployDurationMs: deployState.deployDurationMs || undefined,
    sm: deploymentSM.toJSON(),
    modelWarmth: gpuModelWarmth,
    pipelineRouting: (() => {
      if (!isGpuAvailable()) return undefined;
      // Check active profile to see which stages use GPU — avoids showing 'gpu'
      // routing for stages that the active profile routes to cloud only.
      const _cfg = loadProviderConfig();
      const _activeProfile = _cfg.activeProfileId
        ? _cfg.profiles.find(p => p.id === _cfg.activeProfileId)
        : null;
      const profileUsesGpu = (stage: 'stt' | 'llm' | 'tts'): boolean => {
        if (!_activeProfile) return true;
        const chain = (_activeProfile as unknown as Record<string, unknown>)[stage] as Array<{ provider: string }> | undefined;
        return !chain || chain.some(e => e.provider === 'gpu');
      };
      const sttGpu = profileUsesGpu('stt') && isStageWarm('stt');
      const llmGpu = profileUsesGpu('llm') && isStageWarm('llm');
      const ttsGpu = profileUsesGpu('tts') && shouldPreferGpuTts();
      return {
        stt: sttGpu ? 'gpu' : 'cloud',
        llm: llmGpu ? 'gpu' : 'cloud',
        tts: ttsGpu ? 'gpu' : 'cloud',
        mode: (sttGpu && llmGpu && ttsGpu) ? 'atomic-gpu'
          : (sttGpu || llmGpu || ttsGpu) ? 'hybrid'
          : 'cloud',
        activeProfile: _cfg.activeProfileId || undefined,
      };
    })(),
    ttsColdStartProfile: getColdStartProfile(deployState.gpuType, deployState.dockerImage, deployState.provider) || undefined,
    readinessState: gpuReadinessState,
    standby: {
      status: standbyDeployState.status,
      endpoint: standbyDeployState.endpoint || null,
      gpuType: standbyDeployState.gpuType || null,
      provider: standbyDeployState.provider || null,
      triggeredReason: standbyDeployState.triggeredReason || null,
      message: standbyDeployState.message || null,
      readyForHandover: standbyReadyForHandover,
      startedAt: standbyDeployState.startedAt || null,
    },
  }));
}

/**
 * GET /v1/gpu/list — list all active GPU instances across all configured providers.
 * Aggregates listInstances() from Vast, RunPod, TensorDock in parallel.
 */
export async function handleGpuList(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(_req);
  setRequestIdHeader(res, requestId);

  // Use deploy-time keys first, fall back to env vars (so list works even after gateway restart)
  const vastKey = deployVastApiKey || process.env.VAST_API_KEY || '';
  const rpKey = deployApiKey || process.env.RUNPOD_API_KEY || '';
  const tdKey = deployTensordockApiKey || process.env.TENSORDOCK_API_KEY || '';
  const tdAuth = deployTensordockAuthId || process.env.TENSORDOCK_AUTH_ID || '';
  const providers: Array<{ name: string; client: GpuProviderClient; credentials: ProviderCredentials | null }> = [
    { name: 'vast', client: vast, credentials: vastKey ? { apiKey: vastKey } : null },
    { name: 'runpod', client: runpod, credentials: rpKey ? { apiKey: rpKey } : null },
    { name: 'tensordock', client: tensordock, credentials: (tdKey && tdAuth)
      ? { apiKey: tdKey, authId: tdAuth } : null },
  ];

  const results = await Promise.allSettled(
    providers
      .filter(p => p.credentials)
      .map(async p => {
        const instances = await p.client.listInstances(p.credentials!);
        return instances
          .map(i => ({
            provider: p.name,
            instanceId: i.instanceId,
            instanceName: i.instanceName,
            endpoint: i.endpoint,
            status: i.status,
            gpuType: i.gpuType,
            isActive: i.instanceId === deployState.podId && deployState.status === 'ready',
            sshHost: i.sshHost,
            sshPort: i.sshPort,
          }));
      })
  );

  const instances: unknown[] = [];
  // Always include the currently tracked deployState even if not in provider list (e.g. modal)
  if (deployState.podId && deployState.status !== 'idle') {
    const elapsed = deployState.startedAt > 0 ? Math.round((Date.now() - deployState.startedAt) / 1000) : 0;
    instances.push({
      provider: deployState.provider,
      instanceId: deployState.podId,
      instanceName: deployState.podId,
      endpoint: deployState.endpoint,
      status: deployState.status,
      gpuType: deployState.gpuType,
      costPerHr: deployState.costPerHr,
      elapsedSec: elapsed,
      dockerImage: deployState.dockerImage,
      isActive: deployState.status === 'ready',
    });
  }

  // Add any extra instances found from providers that aren't the current deployState
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const inst of result.value) {
      if (!instances.some((x: any) => x.instanceId === inst.instanceId)) {
        instances.push(inst);
      }
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ instances }));
}

// ── Shared offer+balance fetcher ─────────────────────────────────────────────

interface ProviderBalanceInfo {
  balance: number | null;
  canDeploy: boolean;       // false when balance is below LOW_BALANCE_THRESHOLD_USD
  balanceNote?: string;     // human-readable reason when balance is unavailable
  cachedAt?: number;        // timestamp of last successful check
}

// Balance cache — refreshed in background every 90s so offer endpoints don't block.
// TensorDock takes ~10s to respond, making caching essential.
const _offerBalanceCache = new Map<string, ProviderBalanceInfo>();
const OFFER_BALANCE_CACHE_TTL_MS = 90_000;
let _balanceRefreshPromise: Promise<void> | null = null;

/** Fetch balance for a single provider and update the cache. */
async function refreshProviderBalance(
  name: string,
  client: GpuProviderClient,
  credentials: ProviderCredentials,
): Promise<void> {
  try {
    // Modal: no credit balance API — validate credentials via HTTP health check.
    // Uses /v1/apps?limit=1 as a lightweight auth probe (returns 401 on bad creds).
    if (name === 'modal') {
      const [tokenId, tokenSecret] = (credentials.apiKey || '').split(':');
      const b64 = Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64');
      const r = await fetch('https://api.modal.com/v1/apps?limit=1', {
        headers: { Authorization: `Basic ${b64}` },
        signal: AbortSignal.timeout(5000),
      });
      _offerBalanceCache.set(name, {
        balance: null,
        canDeploy: r.ok,
        balanceNote: r.ok
          ? 'Modal does not expose a credit balance API — check modal.com/settings/billing'
          : `Modal credentials invalid (HTTP ${r.status})`,
        cachedAt: Date.now(),
      });
      return;
    }
    if (!client || !('checkBalance' in client)) return;
    const checkBalanceFn = (client as { checkBalance?: (creds: ProviderCredentials) => Promise<{ balance: number } | null> }).checkBalance;
    if (!checkBalanceFn) return;
    const result = await Promise.race([
      checkBalanceFn(credentials),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${name} checkBalance timed out`)), 10_000)),
    ]);
    if (result === null) {
      console.warn(`[balance-cache] ${name} returned null — keeping previous cache`);
      return;
    }
    _offerBalanceCache.set(name, {
      balance: result.balance,
      canDeploy: result.balance >= LOW_BALANCE_THRESHOLD_USD,
      cachedAt: Date.now(),
    });
    console.log(`[balance-cache] ${name}: $${result.balance.toFixed(2)} canDeploy=${result.balance >= LOW_BALANCE_THRESHOLD_USD}`);
  } catch (e) {
    console.warn(`[balance-cache] ${name} check failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Return cached balances, triggering a background refresh if stale. */
function getCachedOfferBalances(
  providerQueries: Array<{ name: string; client: GpuProviderClient; credentials: ProviderCredentials }>,
): Record<string, ProviderBalanceInfo> {
  const now = Date.now();
  const stale = providerQueries.some(({ name }) => {
    const cached = _offerBalanceCache.get(name);
    return !cached || (now - (cached.cachedAt ?? 0)) > OFFER_BALANCE_CACHE_TTL_MS;
  });

  if (stale && !_balanceRefreshPromise) {
    _balanceRefreshPromise = Promise.allSettled(
      providerQueries.map(({ name, client, credentials }) =>
        refreshProviderBalance(name, client, credentials),
      ),
    ).then(() => { _balanceRefreshPromise = null; }) as Promise<void>;
  }

  // Return whatever is cached (may be stale on first call — returns empty = assume OK)
  const result: Record<string, ProviderBalanceInfo> = {};
  for (const { name } of providerQueries) {
    const cached = _offerBalanceCache.get(name);
    if (cached) result[name] = cached;
  }
  return result;
}

/**
 * Fetch GPU offers from all providers AND their account balances in parallel.
 * Balance checks add zero latency because they run concurrently with listOffers.
 * Each offer gets annotated with canDeploy=false when the provider has insufficient funds.
 */
async function fetchOffersWithBalances(
  providerQueries: Array<{ name: string; client: GpuProviderClient; credentials: ProviderCredentials }>,
  options: ListOffersOptions,
): Promise<{
  allOffers: GpuOffer[];
  providerResults: Array<{ name: string; count: number; error?: string }>;
  providerBalances: Record<string, ProviderBalanceInfo>;
}> {
  // Balance check uses a background-refresh cache (90s TTL).
  // TensorDock takes ~10s per call — caching prevents blocking offer responses.
  const providerBalances = getCachedOfferBalances(providerQueries);

  const OFFER_FETCH_TIMEOUT_MS = 20_000;
  const offerResults = await Promise.allSettled(
    providerQueries.map(async ({ name, client, credentials }) => {
      if (!client.listOffers) return { name, offers: [] as GpuOffer[], error: 'listOffers not supported' };
      try {
        const offers = await Promise.race([
          client.listOffers(options, credentials),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${name} listOffers timed out after ${OFFER_FETCH_TIMEOUT_MS}ms`)), OFFER_FETCH_TIMEOUT_MS),
          ),
        ]);
        return { name, offers, error: undefined };
      } catch (err) {
        return { name, offers: [] as GpuOffer[], error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  // Collect offers
  const allOffers: GpuOffer[] = [];
  const providerResults: Array<{ name: string; count: number; error?: string }> = [];
  for (const r of offerResults) {
    if (r.status === 'fulfilled') {
      providerResults.push({ name: r.value.name, count: r.value.offers.length, error: r.value.error });
      allOffers.push(...r.value.offers);
    } else {
      providerResults.push({ name: 'unknown', count: 0, error: r.reason?.message ?? String(r.reason) });
    }
  }

  return { allOffers, providerResults, providerBalances };
}

export async function handleGpuOffers(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);
  console.log(`[req=${requestId}] GPU offers query`);
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // Reject API keys in query params — credentials must come from env vars or POST body
  const sensitiveParams = ['runpodApiKey', 'vastApiKey', 'tensordockApiKey', 'tensordockAuthId', 'modalTokenId', 'modalTokenSecret'];
  const foundInQuery = sensitiveParams.filter(p => url.searchParams.has(p));
  if (foundInQuery.length > 0) {
    console.warn(`[security] Rejected request with API keys in query params: ${foundInQuery.join(', ')}`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `API keys must not be passed via query params (found: ${foundInQuery.join(', ')}). Use environment variables instead.` }));
    return;
  }
  const gpuTypesParam = url.searchParams.get('gpuTypes');
  const gpuTypes = gpuTypesParam ? gpuTypesParam.split(',').map(s => s.trim()).filter(Boolean) : undefined;
  const region = url.searchParams.get('region') || undefined;
  const limit = parseInt(url.searchParams.get('limit') || '100', 10);
  const providerFilter = url.searchParams.get('provider') || undefined;
  const minVramGbParam = parseInt(url.searchParams.get('minVramGb') || '0', 10);
  const preferSsdParam = url.searchParams.get('preferSsd') === '1';

  // Credentials from env only (query params are rejected above)
  const runpodApiKey = process.env.RUNPOD_API_KEY || '';
  const vastApiKey = process.env.VAST_API_KEY || '';
  const tensordockApiKey = process.env.TENSORDOCK_API_KEY || '';
  const tensordockAuthId = process.env.TENSORDOCK_AUTH_ID || '';
  const modalTokenId = process.env.MODAL_TOKEN_ID || '';
  const modalTokenSecret = process.env.MODAL_TOKEN_SECRET || '';
  const modalApiKey = modalTokenId && modalTokenSecret ? `${modalTokenId}:${modalTokenSecret}` : '';

  // Validate credential format
  const credError = validateGpuCredentials({
    runpodApiKey,
    vastApiKey,
    tensordockApiKey,
    tensordockAuthId,
    modalTokenId,
    modalTokenSecret,
  });
  if (credError) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: credError }));
    return;
  }

  const options: ListOffersOptions = { gpuTypes, region, limit };

  // Build provider→credentials map for configured providers
  const providerQueries: Array<{ name: string; client: GpuProviderClient; credentials: ProviderCredentials }> = [];
  if (runpodApiKey && (!providerFilter || providerFilter === 'runpod')) {
    providerQueries.push({ name: 'runpod', client: runpod, credentials: { apiKey: runpodApiKey } });
  }
  if (vastApiKey && (!providerFilter || providerFilter === 'vast')) {
    providerQueries.push({ name: 'vast', client: vast, credentials: { apiKey: vastApiKey } });
  }
  if (tensordockApiKey && (!providerFilter || providerFilter === 'tensordock')) {
    providerQueries.push({ name: 'tensordock', client: tensordock, credentials: { apiKey: tensordockApiKey, authId: tensordockAuthId } });
  }
  if (modalApiKey && (!providerFilter || providerFilter === 'modal')) {
    providerQueries.push({ name: 'modal', client: modal, credentials: { apiKey: modalApiKey } });
  }

  if (providerQueries.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No provider API keys configured. Set API keys via environment variables.' }));
    return;
  }

  // Fetch offers + balances in parallel — no extra latency
  const { allOffers, providerResults, providerBalances } = await fetchOffersWithBalances(providerQueries, options);

  // Apply hardware filters (same logic as autoSelectCheapestGpu)
  let filteredOffers = allOffers;
  if (minVramGbParam > 0) {
    filteredOffers = filteredOffers.filter(o => o.vram >= minVramGbParam);
  }
  if (preferSsdParam) {
    const ssdOnly = filteredOffers.filter(o => {
      const bw = (o as unknown as Record<string, unknown>).diskBwReadMbps as number | undefined;
      return !bw || bw > 200;
    });
    if (ssdOnly.length > 0) filteredOffers = ssdOnly;
  }

  // Sort by price, canDeploy=false offers sink to bottom
  filteredOffers.sort((a, b) => {
    const aOk = providerBalances[a.provider]?.canDeploy !== false;
    const bOk = providerBalances[b.provider]?.canDeploy !== false;
    if (aOk !== bOk) return aOk ? -1 : 1;
    return a.pricePerHr - b.pricePerHr;
  });

  const annotated = filteredOffers.map(o => ({
    ...o,
    canDeploy: providerBalances[o.provider]?.canDeploy !== false,
    providerBalance: providerBalances[o.provider]?.balance ?? null,
  }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    offers: annotated.slice(0, limit),
    providers: providerResults,
    balances: providerBalances,
  }));
}

/** Return cached GPU types from DB (populated by periodic refresh). */
export async function handleGpuTypes(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(_req.url || '/', `http://localhost:${PORT}`);
  const providerFilter = url.searchParams.get('provider') || undefined;
  const where = providerFilter ? { provider: providerFilter } : {};
  const cached = await prisma.gpuTypeCache.findMany({ where, orderBy: [{ provider: 'asc' }, { pricePerHr: 'asc' }] });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ types: cached, count: cached.length }));
}

export async function handleGpuTerminate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);
  console.log(`[req=${requestId}] GPU terminate requested`);
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }
  const apiKey = body.apiKey as string;
  const vastKey = deployVastApiKey || (body.vastApiKey as string) || process.env.VAST_API_KEY || '';
  const tdKey = deployTensordockApiKey || (body.tensordockApiKey as string) || process.env.TENSORDOCK_API_KEY || '';
  const tdAuthId = deployTensordockAuthId || (body.tensordockAuthId as string) || process.env.TENSORDOCK_AUTH_ID || '';
  const modalTokenId = (body.modalTokenId as string) || process.env.MODAL_TOKEN_ID || '';
  const modalTokenSecret = (body.modalTokenSecret as string) || process.env.MODAL_TOKEN_SECRET || '';
  const modalKey = deployModalApiKey || (modalTokenId && modalTokenSecret ? `${modalTokenId}:${modalTokenSecret}` : '');

  // Capture deploy state before reset for reputation tracking
  const prevProvider = deployState.provider;
  const prevGpuType = deployState.gpuType;
  const prevMeta = { ...deployState.providerMeta };
  const prevStartedAt = deployState.startedAt;
  const prevCostPerHr = deployState.costPerHr;
  const wasReady = deployState.status === 'ready';

  stopGpuMonitoring();
  setDeployLock(false);  // Release deploy lock so new deploys can proceed
  resetDeployState(); // sets deployCancelled=true, stops the deploy loop
  deploymentSM.reset();
  updateTranslationProfile({ gpuEndpoint: undefined }, 'handleGpuTerminate');

  // Terminate ALL instances across all providers to prevent orphans
  if (apiKey) {
    await cleanupAllPods(apiKey);
  }
  if (vastKey) {
    await cleanupVastInstances(vastKey);
  }
  if (tdKey) {
    await cleanupTensordockInstances(tdKey, tdAuthId);
  }
  if (modalKey) {
    await cleanupModalApps(modalKey);
  }

  logGpuEvent('instance_terminated', 'manual', true, { metadata: { reason: 'manual_terminate' } });
  updateDeploySession({ status: 'stopped', stoppedAt: new Date() });

  // Record session uptime + cost in host reputation (if deploy was ready)
  if (wasReady && prevStartedAt > 0 && prevProvider) {
    const uptimeS = Math.round((Date.now() - prevStartedAt) / 1000);
    const costUsd = prevCostPerHr > 0 ? prevCostPerHr * (uptimeS / 3600) : undefined;
    upsertHostReputation({
      provider: prevProvider,
      gpuType: prevGpuType,
      providerMeta: prevMeta,
      success: true,
      uptimeS,
      costUsd,
    });
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// ── Friendly error message cleanup ──────────────────────────────────────────

/** Strip raw JSON from error messages and add billing links for balance errors. */
function friendlyErrorMessage(raw: string): string {
  const balanceMatch = raw.match(/Insufficient balance|balance is too low|balance too low|add funds/i);
  if (balanceMatch) {
    const provider = raw.includes('RunPod') ? 'RunPod' : raw.includes('TensorDock') ? 'TensorDock' : raw.includes('Vast') ? 'Vast.ai' : 'Provider';
    const billingKey = provider === 'RunPod' ? 'runpod' : provider === 'TensorDock' ? 'tensordock' : provider === 'Vast.ai' ? 'vast' : '';
    const billingUrl = billingKey ? BILLING_URLS[billingKey] : '';
    return `${provider} balance too low to start pod` + (billingUrl ? `. Add funds: https://${billingUrl}` : '');
  }
  // Strip embedded JSON objects from error strings (e.g. HTTP 500 {"error":"...", "status":500})
  const jsonStripped = raw.replace(/\s*\{[^{}]*"error"\s*:\s*"([^"]+)"[^{}]*\}/g, ': $1');
  return jsonStripped;
}

// ── Provider balance cache (refreshed every 60s, non-blocking) ──────────────

interface ProviderBalance {
  provider: string;
  apiKeyHint: string;      // masked key, e.g. "rp_...abc"
  balance: number | null;  // null = check failed
  spendPerHr: number;      // current hourly spend (0 if unknown)
  spendPerDay: number;     // spendPerHr * 24
  billingUrl: string;
  low: boolean;            // below threshold
  active: boolean;         // is this provider currently running a pod?
}

let _balanceCache: ProviderBalance[] = [];
let _balanceCacheTime = 0;
const BALANCE_CACHE_TTL_MS = 60_000;

function maskKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

async function getCachedProviderBalances(): Promise<ProviderBalance[]> {
  if (Date.now() - _balanceCacheTime < BALANCE_CACHE_TTL_MS) return _balanceCache;

  const providers: ProviderBalance[] = [];
  const threshold = LOW_BALANCE_THRESHOLD_USD;
  const checks: Promise<void>[] = [];
  const currentProvider = deployState.provider;
  const currentCostPerHr = deployState.costPerHr || 0;

  const rpKey = process.env.RUNPOD_API_KEY || '';
  if (rpKey) {
    const entry: ProviderBalance = {
      provider: 'RunPod', apiKeyHint: maskKey(rpKey), balance: null,
      spendPerHr: 0, spendPerDay: 0,
      billingUrl: `https://${BILLING_URLS.runpod}`, low: false,
      active: currentProvider === 'runpod',
    };
    providers.push(entry);
    checks.push(
      runpod.checkBalance({ apiKey: rpKey }).then(bal => {
        if (bal) {
          entry.balance = bal.balance;
          entry.spendPerHr = (bal as { balance: number; spendPerHr?: number }).spendPerHr ?? (currentProvider === 'runpod' ? currentCostPerHr : 0);
          entry.spendPerDay = entry.spendPerHr * 24;
          entry.low = bal.balance < threshold;
        }
      }).catch(err => { console.warn(`[balance] RunPod balance check failed: ${err instanceof Error ? err.message : err}`); }),
    );
  }

  const tdKey = process.env.TENSORDOCK_API_KEY || '';
  const tdAuth = process.env.TENSORDOCK_AUTH_ID || '';
  if (tdKey && tdAuth) {
    const entry: ProviderBalance = {
      provider: 'TensorDock', apiKeyHint: maskKey(tdKey), balance: null,
      spendPerHr: 0, spendPerDay: 0,
      billingUrl: `https://${BILLING_URLS.tensordock}`, low: false,
      active: currentProvider === 'tensordock',
    };
    providers.push(entry);
    checks.push(
      tensordock.checkBalance({ apiKey: tdKey, authId: tdAuth }).then(bal => {
        if (bal) {
          entry.balance = bal.balance;
          entry.spendPerHr = bal.hourlyCost ?? (currentProvider === 'tensordock' ? currentCostPerHr : 0);
          entry.spendPerDay = entry.spendPerHr * 24;
          entry.low = bal.balance < threshold;
        }
      }).catch(err => { console.warn(`[balance] TensorDock balance check failed: ${err instanceof Error ? err.message : err}`); }),
    );
  }

  const vastKey = process.env.VAST_API_KEY || '';
  if (vastKey) {
    const entry: ProviderBalance = {
      provider: 'Vast.ai', apiKeyHint: maskKey(vastKey), balance: null,
      spendPerHr: 0, spendPerDay: 0,
      billingUrl: `https://${BILLING_URLS.vast}`, low: false,
      active: currentProvider === 'vast',
    };
    providers.push(entry);
    checks.push(
      vast.checkBalance({ apiKey: vastKey }).then(bal => {
        if (bal) {
          entry.balance = bal.balance;
          entry.spendPerHr = (bal as { balance: number; spendPerHr?: number }).spendPerHr ?? (currentProvider === 'vast' ? currentCostPerHr : 0);
          entry.spendPerDay = entry.spendPerHr * 24;
          entry.low = bal.balance < threshold;
        }
      }).catch(err => { console.warn(`[balance] Vast.ai balance check failed: ${err instanceof Error ? err.message : err}`); }),
    );
  }

  // ── Cloud providers ──
  // ElevenLabs — GET /v1/user/subscription → character_count / character_limit
  const elKey = process.env.ELEVENLABS_API_KEY || '';
  if (elKey) {
    const entry: ProviderBalance = {
      provider: 'ElevenLabs', apiKeyHint: maskKey(elKey), balance: null,
      spendPerHr: 0, spendPerDay: 0, billingUrl: 'https://elevenlabs.io/subscription', low: false, active: false,
    };
    providers.push(entry);
    checks.push(
      fetch('https://api.elevenlabs.io/v1/user/subscription', {
        headers: { 'xi-api-key': elKey },
        signal: AbortSignal.timeout(3000),
      }).then(async r => {
        if (!r.ok) return;
        const d = await r.json() as { character_count?: number; character_limit?: number };
        if (typeof d.character_limit === 'number' && typeof d.character_count === 'number') {
          const pct = d.character_limit > 0 ? (d.character_limit - d.character_count) / d.character_limit * 100 : 0;
          entry.balance = Math.round(pct); // show as % remaining
          entry.low = pct < 10;
        }
      }).catch(err => { console.warn(`[balance] ElevenLabs balance check failed: ${err instanceof Error ? err.message : err}`); }),
    );
  }

  // Deepgram — GET /v1/projects → project_id, then GET /v1/projects/{id}/balances → amount USD
  const dgKey = process.env.DEEPGRAM_API_KEY || '';
  if (dgKey) {
    const entry: ProviderBalance = {
      provider: 'Deepgram', apiKeyHint: maskKey(dgKey), balance: null,
      spendPerHr: 0, spendPerDay: 0, billingUrl: 'https://console.deepgram.com/billing', low: false, active: false,
    };
    providers.push(entry);
    checks.push(
      (async () => {
        try {
          const projRes = await fetch('https://api.deepgram.com/v1/projects', {
            headers: { Authorization: `Token ${dgKey}` },
            signal: AbortSignal.timeout(3000),
          });
          if (!projRes.ok) return;
          const projData = await projRes.json() as { projects?: Array<{ project_id: string }> };
          const projId = projData.projects?.[0]?.project_id;
          if (!projId) return;
          const balRes = await fetch(`https://api.deepgram.com/v1/projects/${projId}/balances`, {
            headers: { Authorization: `Token ${dgKey}` },
            signal: AbortSignal.timeout(3000),
          });
          if (!balRes.ok) return;
          const balData = await balRes.json() as { balances?: Array<{ amount: number }> };
          const totalBal = (balData.balances || []).reduce((s, b) => s + (b.amount || 0), 0);
          entry.balance = totalBal;
          entry.low = totalBal < threshold;
        } catch (err) { console.warn(`[balance] Deepgram balance check failed: ${err instanceof Error ? err.message : err}`); }
      })(),
    );
  }

  // Providers without balance APIs — just show as configured
  const staticProviders: Array<{ name: string; envVar: string; billingKey: string }> = [
    { name: 'Groq', envVar: 'GROQ_API_KEY', billingKey: 'groq' },
    { name: 'OpenAI', envVar: 'OPENAI_API_KEY', billingKey: 'openai' },
    { name: 'Fireworks', envVar: 'FIREWORKS_API_KEY', billingKey: 'fireworks' },
    { name: 'Modal', envVar: 'MODAL_TOKEN_ID', billingKey: 'modal' },
    { name: 'OpenRouter', envVar: 'OPENROUTER_API_KEY', billingKey: 'openrouter' },
  ];
  for (const cp of staticProviders) {
    const key = process.env[cp.envVar] || '';
    if (!key) continue;
    providers.push({
      provider: cp.name, apiKeyHint: maskKey(key), balance: null,
      spendPerHr: 0, spendPerDay: 0,
      billingUrl: cp.billingKey ? `https://${BILLING_URLS[cp.billingKey] || ''}` : '',
      low: false, active: false,
    });
  }

  // 3s timeout so /health stays fast
  await Promise.race([
    Promise.all(checks),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]);

  _balanceCache = providers;
  _balanceCacheTime = Date.now();
  return providers;
}

// ── Granular /health endpoint ───────────────────────────────────────────────

export async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const uptimeSec = Math.round((Date.now() - startedAt) / 1000);
  const firstCloudProvider = PROVIDER_CHAIN.find(p => p === 'groq' || p === 'ollama') || 'groq';
  const sttProvider = firstCloudProvider;
  const llmProvider = firstCloudProvider;

  const components: Record<string, Record<string, unknown>> = {
    stt: { status: 'ok', provider: sttProvider },
    llm: { status: 'ok', provider: llmProvider },
  };

  // TTS component — GPU preferred, Modal Qwen3-TTS as primary fallback (multilingual, free),
  // then Groq Orpheus, then OpenAI TTS
  if (isGpuAvailable()) {
    components.tts = { status: 'ok', provider: 'gpu' };
  } else {
    // Modal TTS is always available (no API key, serverless GPU)
    components.tts = { status: 'ok', provider: 'modal', fallback: true };
  }

  // GPU component
  if (deployState.status === 'ready') {
    const idleSec = lastRequestTime > 0 ? Math.round((Date.now() - lastRequestTime) / 1000) : 0;
    components.gpu = {
      status: 'ready',
      endpoint: deployState.endpoint,
      healthy: gpuHealthy,
      idle_sec: idleSec,
    };
  } else if (deployState.status === 'idle') {
    components.gpu = { status: 'idle' };
  } else {
    components.gpu = { status: deployState.status, step: deployState.step };
  }

  const providersStatus: Record<string, boolean> = {
    groq: groqAvailable,
    openai: openaiAvailable,
  };
  const noApiKeys = !groqAvailable && !ollamaAvailable;

  let overallStatus: string;
  let reason: string | undefined;
  if (noApiKeys) {
    overallStatus = 'degraded';
    reason = 'No AI provider API keys configured';
  } else if (deployState.status === 'error') {
    overallStatus = 'degraded';
    reason = `GPU error: ${friendlyErrorMessage(deployState.message || 'Unknown error')}`;
  } else {
    overallStatus = 'ok';
  }

  // ── Provider balances (cached, refreshed every 60s) ──
  const providerBalances = await getCachedProviderBalances();

  const requestId = getOrCreateRequestId(_req);
  setRequestIdHeader(res, requestId);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  const sorted = [...latencyRing].sort((a, b) => a - b);
  const body: Record<string, unknown> = {
    status: overallStatus,
    uptime_sec: uptimeSec,
    gpu: deployState.status,
    providers: providersStatus,
    components,
    latency: {
      p50_ms: computePercentile(sorted, 50),
      p95_ms: computePercentile(sorted, 95),
      p99_ms: computePercentile(sorted, 99),
      samples: latencyRing.length,
    },
  };
  if (reason) body.reason = reason;
  if (providerBalances.length > 0) {
    body.providerBalances = providerBalances;
    body.balanceAlerts = providerBalances.filter(p => p.low);
  }
  // Budget tracking
  body.budget = {
    dailySpendUsd: Math.round(dailyGpuSpendUsd * 100) / 100,
    dailyLimitUsd: DAILY_BUDGET_USD || null,
    exceeded: DAILY_BUDGET_USD > 0 && dailyGpuSpendUsd > DAILY_BUDGET_USD,
  };
  // Per-stage circuit breakers (GPU pipeline stages: stt, llm, tts)
  body.circuitBreakers = getStageBreakersSnapshot();
  // Provider performance metrics (with token usage)
  const providerPerfSummary: Record<string, {
    avgLatencyMs: number; requests: number; errorRate: number;
    inputTokens: number; outputTokens: number;
  }> = {};
  for (const [name, m] of Object.entries(providerMetrics)) {
    providerPerfSummary[name] = {
      avgLatencyMs: m.requests > 0 ? Math.round(m.totalLatencyMs / m.requests) : 0,
      requests: m.requests,
      errorRate: m.requests > 0 ? Math.round((m.errors / m.requests) * 10000) / 10000 : 0,
      inputTokens: m.inputTokens || 0,
      outputTokens: m.outputTokens || 0,
    };
  }
  body.providerMetrics = providerPerfSummary;
  body.tokenUsage = {
    totalInputTokens: metricsCounters.totalInputTokens,
    totalOutputTokens: metricsCounters.totalOutputTokens,
    totalTokens: metricsCounters.totalInputTokens + metricsCounters.totalOutputTokens,
  };
  body.pendingDbWrites = pendingDbWrites;
  res.end(JSON.stringify(body));
}

// ── GPU logs endpoint ────────────────────────────────────────────────────────

export async function handleGpuLogs(_req: IncomingMessage, res: ServerResponse) {
  const requestId = getOrCreateRequestId(_req);
  setRequestIdHeader(res, requestId);

  try {
    const logs = await fetchGpuLogs();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      logs,
      sshHost: deployState.sshHost,
      sshPort: deployState.sshPort,
      endpoint: deployState.endpoint,
      podId: deployState.podId,
      provider: deployState.provider,
      status: deployState.status,
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Failed to fetch logs: ${err}` }));
  }
}

// ── GPU catalog endpoint ────────────────────────────────────────────────────

export function handleGpuCatalog(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(getImageCatalog()));
}

// ── GPU my-location endpoint ─────────────────────────────────────────────────

/**
 * GET /v1/gpu/my-location
 * Returns the gateway's own geographic location (lat, lon, country, flag).
 * Since gateway and Python app run on the same machine, this is the user's location.
 */
export async function handleGpuMyLocation(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const loc = await fetchMyLocation();
  if (!loc) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Could not determine location (ipapi.co unreachable)' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(loc));
}

// ── GPU offers ranked endpoint ───────────────────────────────────────────────

/**
 * GET /v1/gpu/offers/ranked[?clientLat=X&clientLon=Y&gpuTypes=...&limit=N&provider=...]
 * Like /v1/gpu/offers but sorted by estimated total latency:
 *   total_ms = network_rtt_ms (geo-distance) + whisper_inference_ms (GPU bandwidth)
 *
 * If clientLat/clientLon are omitted, the gateway auto-detects its own location.
 * Each offer gains: networkRttMs, inferenceMs, totalMs, distanceKm, countryCode fields.
 */
export async function handleGpuOffersRanked(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // Client coordinates — provided or auto-detected
  let clientLat = parseFloat(url.searchParams.get('clientLat') || 'NaN');
  let clientLon = parseFloat(url.searchParams.get('clientLon') || 'NaN');

  if (isNaN(clientLat) || isNaN(clientLon)) {
    const loc = await fetchMyLocation();
    if (!loc) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not determine location. Provide clientLat/clientLon params.' }));
      return;
    }
    clientLat = loc.lat;
    clientLon = loc.lon;
  }

  const gpuTypesParam = url.searchParams.get('gpuTypes');
  const gpuTypes = gpuTypesParam ? gpuTypesParam.split(',').map(s => s.trim()).filter(Boolean) : undefined;
  const region = url.searchParams.get('region') || undefined;
  const limit = parseInt(url.searchParams.get('limit') || '100', 10);
  const providerFilter = url.searchParams.get('provider') || undefined;

  const runpodApiKey = process.env.RUNPOD_API_KEY || '';
  const vastApiKey = process.env.VAST_API_KEY || '';
  const tensordockApiKey = process.env.TENSORDOCK_API_KEY || '';
  const tensordockAuthId = process.env.TENSORDOCK_AUTH_ID || '';
  const modalTokenId = process.env.MODAL_TOKEN_ID || '';
  const modalTokenSecret = process.env.MODAL_TOKEN_SECRET || '';
  const modalApiKey = modalTokenId && modalTokenSecret ? `${modalTokenId}:${modalTokenSecret}` : '';

  const options = { gpuTypes, region, limit };
  const providerQueries: Array<{ name: string; client: GpuProviderClient; credentials: ProviderCredentials }> = [];
  if (runpodApiKey && (!providerFilter || providerFilter === 'runpod'))
    providerQueries.push({ name: 'runpod', client: runpod, credentials: { apiKey: runpodApiKey } });
  if (vastApiKey && (!providerFilter || providerFilter === 'vast'))
    providerQueries.push({ name: 'vast', client: vast, credentials: { apiKey: vastApiKey } });
  if (tensordockApiKey && tensordockAuthId && (!providerFilter || providerFilter === 'tensordock'))
    providerQueries.push({ name: 'tensordock', client: tensordock, credentials: { apiKey: tensordockApiKey, authId: tensordockAuthId } });
  if (modalApiKey && (!providerFilter || providerFilter === 'modal'))
    providerQueries.push({ name: 'modal', client: modal, credentials: { apiKey: modalApiKey } });

  if (providerQueries.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No provider API keys configured.' }));
    return;
  }

  const { allOffers, providerResults, providerBalances } = await fetchOffersWithBalances(providerQueries, options);

  // Upsert metadata for all hosts so the scheduler can re-probe them later
  for (const offer of allOffers) {
    if (offer.hostId && offer.hostIp) {
      upsertHostMeta(offer.hostId, {
        hostIp:      offer.hostIp,
        provider:    offer.provider    ?? '',
        gpuName:     offer.gpuName     ?? '',
        geolocation: offer.geolocation ?? '',
        priceUsd:    offer.pricePerHr  ?? 0,
      });
    }
  }

  // ?probe=true → synchronous TCP probe of all hosts, saves to DB, blocks ~3-8s
  // default     → fire-and-forget background probes, use whatever is already in DB
  const hostIds = allOffers.map(o => o.hostId).filter(Boolean) as string[];
  let hostRtts: Record<string, number>;

  if (url.searchParams.get('probe') === 'true') {
    hostRtts = await probeAndSaveOffers(allOffers).catch(() => ({}));
  } else {
    scheduleBackgroundProbes(allOffers);
    hostRtts = getHostRttMap(hostIds);
  }

  const ranked = rankOffers(allOffers, clientLat, clientLon, {}, hostRtts).map(o => ({
    ...o,
    canDeploy: providerBalances[o.provider]?.canDeploy !== false,
    providerBalance: providerBalances[o.provider]?.balance ?? null,
  }));

  // Sink no-credit offers to bottom while preserving latency order within each group
  const deployable = ranked.filter(o => o.canDeploy);
  const blocked = ranked.filter(o => !o.canDeploy);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    offers:         [...deployable, ...blocked].slice(0, limit),
    clientLat,
    clientLon,
    providers:      providerResults,
    balances:       providerBalances,
    hostRttsCached: Object.keys(hostRtts).length,
  }));
}

// ── GPU latency DB endpoint ───────────────────────────────────────────────────

/**
 * GET /v1/gpu/latency-probe
 * Returns the latency DB: all known hosts with rolling stats (median, p90, stddev).
 * Sorted by median_ms ASC (nulls last — never probed yet).
 *
 * Query params:
 *   ?region=EU     — filter to EU hosts only
 *   ?gpu=RTX+5090  — filter by GPU name (substring match)
 */
export async function handleGpuLatencyProbe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url       = new URL(req.url || '/', `http://localhost:${PORT}`);
  const regionEU  = (url.searchParams.get('region') || '').toUpperCase() === 'EU';
  const gpuFilter = (url.searchParams.get('gpu') || '').toLowerCase();

  const EU_CCS = new Set([
    'AL','AT','BA','BE','BG','BY','CH','CY','CZ','DE','DK','EE','ES','FI',
    'FR','GB','GR','HR','HU','IE','IS','IT','LI','LT','LU','LV','MD','ME',
    'MK','MT','NL','NO','PL','PT','RO','RS','SE','SI','SK','UA','XK',
  ]);

  let hosts = getAllHostLatencies();

  if (regionEU) {
    hosts = hosts.filter(h => {
      const parts = h.geolocation.split(',');
      const cc    = parts[parts.length - 1].trim().toUpperCase();
      return EU_CCS.has(cc);
    });
  }
  if (gpuFilter) {
    hosts = hosts.filter(h => h.gpu_name.toLowerCase().includes(gpuFilter));
  }

  const stats = getLatencyDbStats();
  const loc   = await fetchMyLocation();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    from:   loc ? { city: loc.city, country: loc.country, flag: loc.flag } : null,
    dbStats: stats,
    hosts,
  }));
}

// ── Latency scheduler settings endpoints ─────────────────────────────────────

import {
  getLatencySchedulerStatus, setLatencyIntervalMin, setLatencyMaxMs, getLatencyMaxMs,
  triggerLatencyRun, isLatencyRunning,
} from './latency-scheduler';
import {
  getGpuPriorityList, setGpuPriorityList, getDefaultGpuPriority,
  getGpuPriorityForProvider, setGpuPriorityForProvider, getDefaultGpuPriorityByProvider,
  getGpuSortBy, setGpuSortBy,
  getDeployTimeoutMin, setDeployTimeoutMin, getDeployRegion, setDeployRegion,
  getDeployDockerImage, setDeployDockerImage,
  getMinVramGb, setMinVramGb, getPreferSsd, setPreferSsd,
  getSttTargetLatencyMs, getLlmTargetLatencyMs, getTtsTargetLatencyMs,
  setBenchmarkMaxRuns, setBenchmarkMarginPct, setShadowRuns,
  setSttTargetLatencyMs, setLlmTargetLatencyMs, setTtsTargetLatencyMs,
  getBenchmarkMaxRuns, getBenchmarkMarginPct, getShadowRuns,
  getP95DemotionMultiplier, setP95DemotionMultiplier,
  getP95IdleWindowSec, setP95IdleWindowSec,
  getRepechageMaxAttempts, setRepechageMaxAttempts,
  getDeployRaceCount, setDeployRaceCount,
  type GpuSortBy,
} from '../src/gpu-providers/deploy-settings';
import { getReadinessHistory } from './gpu-readiness';
import {
  gpuReadinessState, gpuReadyForProduction, gpuShadowMode,
  getPerStageP95,
} from './state';

/**
 * GET /v1/gpu/latency/settings
 * Returns scheduler status, settings, and DB stats.
 */
export async function handleGetLatencySettings(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const status = getLatencySchedulerStatus();
  const dbStats = getLatencyDbStats();
  // Pull time learning stats
  let pullTimeLearning: Record<string, unknown> = {};
  try {
    const { getObservationCount, estimatePullTimeout } = await import('../src/gpu-providers/pull-time-estimator');
    const knownImages = [
      'marcosremar/babelcast-translategemma:latest',
      'marcosremar/babelcast-mistral:latest',
      'marcosremar/babelcast-groq:latest',
      'marcosremar/babelcast-qwen3asr:latest',
    ];
    const imageStats: Record<string, unknown> = {};
    for (const img of knownImages) {
      const count = getObservationCount(img);
      const est = await estimatePullTimeout({ dockerImage: img });
      imageStats[img] = {
        observations: count,
        phase: count >= 10 ? 'data-driven' : count > 0 ? 'learning' : 'no-data',
        confidence: est.confidence,
        timeoutSec: Math.round(est.timeoutMs / 1000),
        basis: est.basis,
      };
    }
    pullTimeLearning = {
      description: 'Adaptive pull timeouts: < 10 deploys = generous 30min; ≥ 10 = avg + 30% safety',
      images: imageStats,
    };
  } catch { /* estimator not available */ }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ...status,
    sttTargetLatencyMs: getSttTargetLatencyMs(),
    llmTargetLatencyMs: getLlmTargetLatencyMs(),
    ttsTargetLatencyMs: getTtsTargetLatencyMs(),
    benchmarkMaxRuns: getBenchmarkMaxRuns(),
    benchmarkMarginPct: getBenchmarkMarginPct(),
    shadowRuns: getShadowRuns(),
    p95DemotionMultiplier: getP95DemotionMultiplier(),
    p95IdleWindowSec: getP95IdleWindowSec(),
    repechageMaxAttempts: getRepechageMaxAttempts(),
    standbyEnabled: getStandbyEnabled(),
    standbyTriggerHours: getStandbyTriggerHours(),
    standbyDrainTimeoutMs: getStandbyDrainTimeoutMs(),
    deployRaceCount: getDeployRaceCount(),
    dbStats,
    pullTimeLearning,
  }));
}

/**
 * PATCH /v1/gpu/latency/settings
 * Body: { intervalMin?, maxLatencyMs?, gpuPriorityList?, gpuPriorityByProvider?, gpuSortBy? }
 */
export async function handlePatchLatencySettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req).catch(() => null) as Record<string, unknown> | null;
  if (!body) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Body required' }));
    return;
  }
  if (typeof body.intervalMin === 'number') {
    setLatencyIntervalMin(Math.max(10, Math.min(1440, body.intervalMin)));
  }
  if (typeof body.maxLatencyMs === 'number') {
    setLatencyMaxMs(Math.max(0, Math.min(2000, body.maxLatencyMs)));
  }
  if (Array.isArray(body.gpuPriorityList)) {
    const list = (body.gpuPriorityList as unknown[]).filter((g): g is string => typeof g === 'string' && g.length > 0);
    setGpuPriorityList(list);
  }
  if (body.gpuPriorityByProvider && typeof body.gpuPriorityByProvider === 'object') {
    const byProvider = body.gpuPriorityByProvider as Record<string, unknown>;
    for (const [provider, list] of Object.entries(byProvider)) {
      if (Array.isArray(list)) {
        const filtered = list.filter((g): g is string => typeof g === 'string' && g.length > 0);
        setGpuPriorityForProvider(provider, filtered);
      }
    }
  }
  if (typeof body.gpuSortBy === 'string' && ['price', 'latency', 'balanced'].includes(body.gpuSortBy)) {
    setGpuSortBy(body.gpuSortBy as GpuSortBy);
  }
  if (typeof body.deployTimeoutMin === 'number') {
    setDeployTimeoutMin(body.deployTimeoutMin);
  }
  if (typeof body.deployRegion === 'string') {
    setDeployRegion(body.deployRegion);
  }
  if (typeof body.deployDockerImage === 'string') {
    setDeployDockerImage(body.deployDockerImage);
  }
  if (typeof body.minVramGb === 'number') {
    setMinVramGb(body.minVramGb);
  }
  if (typeof body.preferSsd === 'boolean') {
    setPreferSsd(body.preferSsd);
  }
  if (typeof body.sttTargetLatencyMs === 'number') setSttTargetLatencyMs(body.sttTargetLatencyMs);
  if (typeof body.llmTargetLatencyMs === 'number') setLlmTargetLatencyMs(body.llmTargetLatencyMs);
  if (typeof body.ttsTargetLatencyMs === 'number') setTtsTargetLatencyMs(body.ttsTargetLatencyMs);
  if (typeof body.benchmarkMaxRuns === 'number') setBenchmarkMaxRuns(body.benchmarkMaxRuns);
  if (typeof body.benchmarkMarginPct === 'number') setBenchmarkMarginPct(body.benchmarkMarginPct);
  if (typeof body.shadowRuns === 'number') setShadowRuns(body.shadowRuns);
  if (typeof body.p95DemotionMultiplier === 'number') setP95DemotionMultiplier(body.p95DemotionMultiplier);
  if (typeof body.p95IdleWindowSec === 'number') setP95IdleWindowSec(body.p95IdleWindowSec);
  if (typeof body.repechageMaxAttempts === 'number') setRepechageMaxAttempts(body.repechageMaxAttempts);
  if (typeof body.standbyEnabled === 'boolean') setStandbyEnabled(body.standbyEnabled);
  if (typeof body.standbyTriggerHours === 'number') setStandbyTriggerHours(body.standbyTriggerHours);
  if (typeof body.standbyDrainTimeoutMs === 'number') setStandbyDrainTimeoutMs(body.standbyDrainTimeoutMs);
  if (typeof body.deployRaceCount === 'number') setDeployRaceCount(body.deployRaceCount);
  const s = getLatencySchedulerStatus();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    intervalMin: s.intervalMin,
    maxLatencyMs: s.maxLatencyMs,
    gpuPriorityList: s.gpuPriorityList,
    gpuPriorityByProvider: s.gpuPriorityByProvider,
    gpuSortBy: s.gpuSortBy,
    deployTimeoutMin: s.deployTimeoutMin,
    minVramGb: getMinVramGb(),
    preferSsd: getPreferSsd(),
    sttTargetLatencyMs: getSttTargetLatencyMs(),
    llmTargetLatencyMs: getLlmTargetLatencyMs(),
    ttsTargetLatencyMs: getTtsTargetLatencyMs(),
    benchmarkMaxRuns: getBenchmarkMaxRuns(),
    benchmarkMarginPct: getBenchmarkMarginPct(),
    shadowRuns: getShadowRuns(),
    p95DemotionMultiplier: getP95DemotionMultiplier(),
    p95IdleWindowSec: getP95IdleWindowSec(),
    repechageMaxAttempts: getRepechageMaxAttempts(),
    standbyEnabled: getStandbyEnabled(),
    standbyTriggerHours: getStandbyTriggerHours(),
    standbyDrainTimeoutMs: getStandbyDrainTimeoutMs(),
    deployRaceCount: getDeployRaceCount(),
  }));
}

/**
 * GET /v1/gpu/latency/gpu-defaults
 * Returns the hardcoded default GPU priority lists (global + per-provider).
 */
export async function handleGetGpuDefaults(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ defaults: getDefaultGpuPriority(), defaultsByProvider: getDefaultGpuPriorityByProvider() }));
}

/**
 * GET /v1/gpu/readiness/history
 * Returns persisted readiness benchmark history per (dockerImage, gpuType).
 */
export async function handleGetGpuReadinessHistory(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ history: getReadinessHistory(), currentState: gpuReadinessState }));
}

/**
 * POST /v1/gpu/readiness/reset
 * Resets readiness state and restarts the benchmark check for the current pod.
 */
export async function handlePostResetReadiness(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { resetReadinessCheck, runGpuReadinessCheck } = await import('./gpu-readiness');
  const { markGpuShadowMode, markGpuWarmupFailed } = await import('./providers');
  const { deployState: ds, setGpuShadowMode, setGpuReadyForProduction, resetGpuReadinessState } = await import('./state');

  resetReadinessCheck();
  resetGpuReadinessState();
  setGpuShadowMode(false);
  setGpuReadyForProduction(false);

  if (ds.status === 'ready' && ds.endpoint) {
    const ep = ds.endpoint;
    runGpuReadinessCheck(
      ep,
      () => markGpuShadowMode(ep),
      (stage, bestMs, targetMs) => markGpuWarmupFailed(stage, bestMs, targetMs),
    ).catch(err => { console.warn(`[readiness] GPU readiness check failed after reset: ${err instanceof Error ? err.message : err}`); });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Readiness check restarted' }));
  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No active GPU pod' }));
  }
}

/**
 * GET /v1/gpu/readiness/status
 * Returns real-time readiness state with per-stage P95 latency.
 */
export async function handleGetGpuReadinessStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    readinessState: gpuReadinessState,
    gpuReadyForProduction,
    gpuShadowMode,
    perStageP95: {
      stt: getPerStageP95('stt'),
      llm: getPerStageP95('llm'),
      tts: getPerStageP95('tts'),
    },
    targets: {
      stt: getSttTargetLatencyMs(),
      llm: getLlmTargetLatencyMs(),
      tts: getTtsTargetLatencyMs(),
    },
    p95DemotionMultiplier: getP95DemotionMultiplier(),
    repechageMaxAttempts: getRepechageMaxAttempts(),
  }));
}

/**
 * GET /v1/gpu/types?provider=vast|runpod|tensordock
 * Returns available GPU types for a provider, enriched with latency data from the local DB.
 * Each entry: { name, shortName, vram, count, minPricePerHr, bestLatencyMs, bestRegion }
 */
export async function handleGetGpuTypes(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const providerFilter = url.searchParams.get('provider') || '';

  const runpodApiKey        = process.env.RUNPOD_API_KEY || '';
  const vastApiKey          = process.env.VAST_API_KEY || '';
  const tensordockApiKey    = process.env.TENSORDOCK_API_KEY || '';
  const tensordockAuthId    = process.env.TENSORDOCK_AUTH_ID || '';

  type ProviderEntry = { name: string; client: typeof vast; credentials: Record<string, string> };
  const queries: ProviderEntry[] = [];
  if (vastApiKey      && (!providerFilter || providerFilter === 'vast'))
    queries.push({ name: 'vast',       client: vast,       credentials: { apiKey: vastApiKey } });
  if (runpodApiKey    && (!providerFilter || providerFilter === 'runpod'))
    queries.push({ name: 'runpod',     client: runpod as unknown as typeof vast,     credentials: { apiKey: runpodApiKey } });
  if (tensordockApiKey && tensordockAuthId && (!providerFilter || providerFilter === 'tensordock'))
    queries.push({ name: 'tensordock', client: tensordock as unknown as typeof vast, credentials: { apiKey: tensordockApiKey, authId: tensordockAuthId } });

  const latencyMap = getBestLatencyByGpuModel();

  // Aggregate GPU types across all queried providers
  const byType = new Map<string, { name: string; vram: number; count: number; minPrice: number }>();

  await Promise.allSettled(queries.map(async q => {
    try {
      const offers = await (q.client.listOffers as Function)({ limit: 500 }, q.credentials);
      for (const offer of (offers as Array<{ gpuType?: string; gpuName?: string; vram?: number; pricePerHr?: number }>) ) {
        const name = offer.gpuType || offer.gpuName || '';
        if (!name) continue;
        const existing = byType.get(name);
        if (existing) {
          existing.count++;
          if ((offer.pricePerHr ?? 999) < existing.minPrice) existing.minPrice = offer.pricePerHr ?? 999;
        } else {
          byType.set(name, { name, vram: offer.vram ?? 0, count: 1, minPrice: offer.pricePerHr ?? 0 });
        }
      }
    } catch (err) { console.warn(`[gpu-types] Provider offer fetch failed: ${err instanceof Error ? err.message : err}`); }
  }));

  const gpuTypes = [...byType.values()]
    .sort((a, b) => b.count - a.count)
    .map(g => {
      const key = g.name.replace(/nvidia\s*/gi, '').replace(/geforce\s*/gi, '').trim().toLowerCase();
      const latency = latencyMap[key];
      return {
        name:          g.name,
        shortName:     g.name.replace('NVIDIA ', '').replace('GeForce ', ''),
        vram:          g.vram,
        count:         g.count,
        minPricePerHr: g.minPrice,
        bestLatencyMs: latency?.bestMs ?? null,
        bestRegion:    latency?.region ?? null,
      };
    });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ provider: providerFilter || 'all', gpuTypes }));
}

/**
 * POST /v1/gpu/latency/run
 * Triggers an immediate probe cycle (fire-and-forget).
 */
export async function handleTriggerLatencyRun(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (isLatencyRunning()) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Probe already running' }));
    return;
  }
  void triggerLatencyRun();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, running: true }));
}

/**
 * PATCH /v1/gpu/latency/hosts
 * Body: { hostIds: string[], monitored: boolean }
 * Sets monitored flag for given hosts. Empty hostIds = set ALL hosts.
 */
export async function handlePatchLatencyHosts(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req).catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.monitored !== 'boolean') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'monitored (boolean) required' }));
    return;
  }
  const hostIds = Array.isArray(body.hostIds) ? (body.hostIds as string[]) : [];
  setHostsMonitored(hostIds, body.monitored);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, updated: hostIds.length || 'all' }));
}

// ── GPU host reputation endpoint ─────────────────────────────────────────────

export async function handleGpuReputation(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const providerFilter = url.searchParams.get('provider') || undefined;

  try {
    const all = await getAllReputations() as Array<Record<string, unknown>>;
    const filtered = providerFilter
      ? all.filter(r => r.provider === providerFilter)
      : all;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hosts: filtered, count: filtered.length }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Failed to fetch reputations: ${err}` }));
  }
}

// ── Standby GPU endpoints ─────────────────────────────────────────────────────

/** POST /v1/gpu/standby/deploy — manually trigger standby GPU deploy */
export async function handleStandbyDeploy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req).catch(() => ({})) as Record<string, unknown>;
  const reason = (body.reason as string) === 'session_duration' || (body.reason as string) === 'latency_degradation'
    ? body.reason as 'session_duration' | 'latency_degradation'
    : 'manual';
  const result = await triggerStandbyDeploy(reason);
  res.writeHead(result.ok ? 202 : 400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

/** POST /v1/gpu/standby/handover — initiate handover from standby to primary */
export async function handleStandbyHandover(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const result = await initiateHandover();
  res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

/** POST /v1/gpu/standby/cancel — cancel standby deploy */
export async function handleStandbyCancel(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  await cancelStandby();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}
