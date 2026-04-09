// ── BabelCast Gateway — GPU HTTP Handlers ───────────────────────────────────
// Deploy, lifecycle (stop/resume/terminate), standby, snapshots.
// Status, health, offers, latency, settings are in gpu-handlers-{info,offers,settings}.ts

import type { IncomingMessage, ServerResponse } from 'http';
import type { GpuProviderClient, GpuOffer, ProviderCredentials } from '../src/gpu-providers/types';
import { filterTiers } from '../src/gpu-providers/deploy-orchestrator';
import type { ProviderName } from '../src/gpu-providers/deploy-orchestrator';
import {
  deployState, setDeployState, deployCancelled, setDeployCancelled, deployLock, setDeployLock,
  deployPromise, setDeployPromise,
  deployVastApiKey, deployTensordockApiKey, deployTensordockAuthId, deployModalApiKey, deployApiKey,
  isGpuAvailable, resetDeployState, prisma,
  deploymentSM,
  standbyDeployState, standbyReadyForHandover,
} from './state';
import { triggerStandbyDeploy, initiateHandover, cancelStandby, startStandbyMonitor } from './gpu-standby';
export { startStandbyMonitor };
import { updateTranslationProfile, runpod, vast, tensordock, modal } from './providers';
import {
  startGpuMonitoring, stopGpuMonitoring, startDeployWithTiers, startDeployRace, buildGpuTiers, cooldownTracker,
  cleanupAllPods, cleanupVastInstances, cleanupTensordockInstances, cleanupModalApps,
  autoSelectCheapestGpu, getVerifiedGpuTypes, validateGpuTypesFromCache,
  IDLE_TIMEOUT_MS, clearAutoDestroyTimer, resumeOrDeploy,
} from './gpu-deploy';
import { logGpuEvent, updateDeploySession, upsertHostReputation } from './metrics';
import {
  getOrCreateRequestId, setRequestIdHeader, readJsonBody, handleBodyError,
  validateGpuCredentials,
} from './http-utils';
import { resolveDockerImageForGpus, LOW_BALANCE_THRESHOLD_USD } from './config';
import { loadProviderConfig } from './config-persistence';
import {
  getGpuPriorityList, getDefaultGpuPriorityByProvider, getGpuPriorityForProvider,
  getGpuSortBy, getDeployTimeoutMin, setDeployTimeoutMin, getDeployRegion, getMinVramGb, getPreferSsd,
  getDeployRaceCount, getLatencyMaxMs,
} from '../src/gpu-providers/deploy-settings';
import { getBestLatencyByGpuModel, sortGpuTypesByLatency } from './latency-db';

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
  /** Vast.ai template hash ID — pre-configured image/env/ports for faster boot */
  templateHashId: string | undefined;
  /** Force SSH tunnel for Vast.ai (skip direct-port endpoint, use SSH proxy) */
  forceSshTunnel: boolean | undefined;
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
    templateHashId: typeof body.templateHashId === 'string' && body.templateHashId.length > 0
      ? body.templateHashId : undefined,
    forceSshTunnel: body.forceSshTunnel === true ? true : undefined,
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
        if (bal.balance < 0.5) {
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
    const sorted = await sortGpuTypesByLatency(gpuTypes, maxLatencyMs);
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
    const latencyData = await getBestLatencyByGpuModel();
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
  const { raceCount, region, storageGb, hfToken, deployEnv, interruptible, dockerStartCmd, containerDiskInGb, volumeId, templateHashId, forceSshTunnel } = config;
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

  const extra = { region, storageGb, hfToken, env: Object.keys(deployEnv).length > 0 ? deployEnv : undefined, interruptible, ...(dockerStartCmd ? { dockerStartCmd } : {}), ...(containerDiskInGb > 0 ? { containerDiskInGb } : {}), ...(volumeId ? { volumeId } : {}), ...(templateHashId ? { templateHashId } : {}), ...(forceSshTunnel ? { forceSshTunnel } : {}) };

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
  if (deployState.status !== 'idle' && deployState.status !== 'stopped' && deployState.status !== 'error' && deployState.status !== 'ready') {
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

/**
 * Auto-boot GPU from the active profile's gpuDeploy config.
 * Called at gateway startup when the active profile has bootOnStartup: true.
 * Fires-and-forgets: deploy runs in background, gateway starts regardless.
 */
export async function autoBootFromProfile(): Promise<void> {
  const cfg = loadProviderConfig();
  const activeProfile = cfg.profiles?.find(p => p.id === cfg.activeProfileId);
  if (!activeProfile?.gpuDeploy?.bootOnStartup) return;
  if (deployState.status !== 'idle') {
    console.log('[gpu] autoBootFromProfile: deploy already in progress, skipping');
    return;
  }
  if (deployLock) {
    console.log('[gpu] autoBootFromProfile: deploy lock held, skipping');
    return;
  }

  const gd = activeProfile.gpuDeploy;
  console.log(`[gpu] Auto-booting GPU for profile: ${activeProfile.name} (${gd.dockerImage})`);
  const requestId = 'startup:autoboot';

  setDeployLock(true);
  let lockTransferred = false;
  try {
    const body: Record<string, unknown> = {
      dockerImage: gd.dockerImage,
      gpuTypes: gd.gpuTypes,
      region: gd.region ?? '',
      ...(gd.timeoutMin ? { deployTimeoutMin: gd.timeoutMin } : {}),
      ...(typeof gd.raceCount === 'number' && gd.raceCount > 1 ? { raceCount: gd.raceCount } : {}),
    };
    const config = await _validateDeployRequest(body, requestId);
    const tierResult = await _selectDeploymentTier(config, requestId);

    // No-op HTTP stub — deploy is fire-and-forget at startup
    const stubRes = {
      writeHead: () => {},
      end: (data: string) => {
        try {
          const j = JSON.parse(data);
          console.log(`[gpu] autoBootFromProfile: ${j.status} — ${j.message}`);
        } catch {}
      },
    } as unknown as ServerResponse;

    lockTransferred = true;
    _startDeployAndRespond(config, tierResult, requestId, stubRes);
  } catch (err: unknown) {
    const msg = (err as { message?: string })?.message ?? String(err);
    console.warn(`[gpu] autoBootFromProfile failed: ${msg}`);
  } finally {
    if (!lockTransferred) setDeployLock(false);
  }
}

// ── GPU lifecycle handlers (stop/resume/terminate) ────────────────────────────

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

// ── GPU Stop (pause without destroying) ──────────────────────────────────────

/**
 * POST /v1/gpu/stop — Stop (pause) the current GPU pod without destroying it.
 * The pod can be resumed later with POST /v1/gpu/resume.
 * Disk/data is preserved. No hourly charges while stopped.
 */
export async function handleGpuStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);
  console.log(`[req=${requestId}] GPU stop (pause) requested`);

  if (!deployState.podId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No active pod to stop' }));
    return;
  }

  const provider = deployState.provider || 'runpod';
  const podId = deployState.podId;
  const prevStatus = deployState.status;

  // Resolve provider client and credentials
  let client: GpuProviderClient | null = null;
  let credentials: ProviderCredentials = { apiKey: '' };

  if (provider === 'runpod' && (deployApiKey || process.env.RUNPOD_API_KEY)) {
    client = runpod;
    credentials = { apiKey: deployApiKey || process.env.RUNPOD_API_KEY || '' };
  } else if (provider === 'vast' && (deployVastApiKey || process.env.VAST_API_KEY)) {
    client = vast;
    credentials = { apiKey: deployVastApiKey || process.env.VAST_API_KEY || '' };
  } else if (provider === 'tensordock' && (deployTensordockApiKey || process.env.TENSORDOCK_API_KEY)) {
    client = tensordock;
    credentials = { apiKey: deployTensordockApiKey || process.env.TENSORDOCK_API_KEY || '', authId: deployTensordockAuthId || process.env.TENSORDOCK_AUTH_ID || '' };
  }

  if (!client) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Cannot stop: no credentials for provider "${provider}"` }));
    return;
  }

  try {
    await client.stopInstance(podId, credentials);
    stopGpuMonitoring();
    updateTranslationProfile({ gpuEndpoint: undefined }, 'handleGpuStop');
    // Transition to 'stopped' — preserves pod info for fast resume
    const gpuType = deployState.gpuType;
    const costPerHr = deployState.costPerHr;
    const dockerImage = deployState.dockerImage;
    deploymentSM.markStopped(podId, provider, gpuType, costPerHr, dockerImage);
    setDeployState({
      status: 'stopped',
      message: `Pod ${podId} stopped (paused). Use POST /v1/gpu/resume to restart.`,
      podId,
      provider,
    });

    console.log(`[req=${requestId}] Pod ${podId} stopped on ${provider} (was ${prevStatus})`);
    logGpuEvent('instance_stopped', 'manual', true, { metadata: { reason: 'manual_stop', provider } });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, podId, provider, message: 'Pod stopped (paused). Data preserved. Use /v1/gpu/resume to restart.' }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[req=${requestId}] GPU stop failed: ${msg}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Stop failed: ${msg}` }));
  }
}

// ── GPU Resume (restart a stopped pod) ───────────────────────────────────────

/**
 * POST /v1/gpu/resume — Resume a previously stopped GPU pod.
 * Optionally accepts { podId, provider } in body to resume a specific pod.
 * If omitted, resumes the last stopped pod from deploy state.
 */
export async function handleGpuResume(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);
  console.log(`[req=${requestId}] GPU resume requested`);

  let body: Record<string, unknown> = {};
  try { body = await readJsonBody(req); }
  catch { /* empty body is fine */ }

  // Allow explicit podId/provider override from body (backward compat)
  if (body.podId) {
    deployState.podId = body.podId as string;
    if (body.provider) deployState.provider = body.provider as ProviderName;
  }

  if (!deployState.podId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No pod to resume. Provide { podId } or stop a pod first.' }));
    return;
  }

  try {
    // resumeOrDeploy: tries resume first, falls back to fresh deploy if
    // the host was reclaimed / pod was GC'd / any other error.
    const result = await resumeOrDeploy({ reason: 'manual', requestId });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      method: result.method, // 'resumed' or 'fresh_deploy'
      podId: result.podId,
      provider: result.provider,
      message: result.method === 'resumed'
        ? 'Pod resumed. Poll /v1/gpu/status for readiness.'
        : 'Resume failed — fresh deploy started. Poll /v1/gpu/status for readiness.',
    }));
  } catch (err) {
    // Both resume AND fallback deploy failed
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[req=${requestId}] GPU resume + fallback deploy failed: ${msg}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Resume and fallback deploy both failed: ${msg}` }));
  }
}

// ── Standby GPU endpoints ─────────────────────────────────────────────────────

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

// ── SnapGPU Snapshot endpoints ────────────────────────────────────────────────
// Proxy to the snapgpu-gateway /v1/snapshots routes running inside the GPU pod.
// The ai-gateway acts as a pass-through — it reads the active GPU endpoint from
// deployState and forwards the request to the snapgpu-gateway.

/** POST /v1/gpu/snapshot — create snapshot of the current GPU container */
export async function handleSnapshotCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const endpoint = deployState.endpoint;
  if (!endpoint) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No active GPU — deploy first' }));
    return;
  }
  try {
    const body = await readJsonBody(req).catch(() => ({}));
    const upstream = await fetch(`${endpoint.replace(/\/$/, '')}/v1/snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await upstream.json();
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Snapshot create failed: ${err instanceof Error ? err.message : err}` }));
  }
}

/** GET /v1/gpu/snapshot — list all snapshots on the active GPU */
export async function handleSnapshotList(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const endpoint = deployState.endpoint;
  if (!endpoint) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ snapshots: [] }));
    return;
  }
  try {
    const upstream = await fetch(`${endpoint.replace(/\/$/, '')}/v1/snapshots`, {
      signal: AbortSignal.timeout(10_000),
    });
    const data = await upstream.json();
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Snapshot list failed: ${err instanceof Error ? err.message : err}` }));
  }
}

/** POST /v1/gpu/snapshot/:id/restore — restore a snapshot on the active GPU */
export async function handleSnapshotRestore(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const endpoint = deployState.endpoint;
  if (!endpoint) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No active GPU — deploy first' }));
    return;
  }
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const snapshotId = url.pathname.split('/').pop() === 'restore'
    ? url.pathname.split('/').at(-2) || ''
    : '';
  if (!snapshotId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing snapshot_id in URL' }));
    return;
  }
  try {
    const upstream = await fetch(`${endpoint.replace(/\/$/, '')}/v1/snapshots/${encodeURIComponent(snapshotId)}/restore`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
    });
    const data = await upstream.json();
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Snapshot restore failed: ${err instanceof Error ? err.message : err}` }));
  }
}

/** DELETE /v1/gpu/snapshot/:id — delete a snapshot */
export async function handleSnapshotDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const endpoint = deployState.endpoint;
  if (!endpoint) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No active GPU — deploy first' }));
    return;
  }
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const snapshotId = url.pathname.split('/').pop() || '';
  if (!snapshotId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing snapshot_id in URL' }));
    return;
  }
  try {
    const upstream = await fetch(`${endpoint.replace(/\/$/, '')}/v1/snapshots/${encodeURIComponent(snapshotId)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(10_000),
    });
    const data = await upstream.json();
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Snapshot delete failed: ${err instanceof Error ? err.message : err}` }));
  }
}

// ── Re-exports from split modules ────────────────────────────────────────────

export {
  handleGpuOffers, handleGpuOffersRanked, handleGpuTypes, handleGetGpuTypes,
  buildProviderQueries,
} from './gpu-handlers-offers';
export {
  handleGpuStatus, handleGpuList, handleHealth, handleGpuLogs, handleGpuEventLogs,
  handleGpuCatalog, handleGpuMyLocation, handleGpuReputation, handleGpuLatencyProbe,
} from './gpu-handlers-info';
export {
  handleGetLatencySettings, handlePatchLatencySettings, handleGetGpuDefaults,
  handleGetGpuReadinessHistory, handlePostResetReadiness, handleGetGpuReadinessStatus,
  handleTriggerLatencyRun, handlePatchLatencyHosts,
} from './gpu-handlers-settings';
