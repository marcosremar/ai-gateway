// ── BabelCast Gateway — GPU HTTP Handlers ───────────────────────────────────
// Deploy, lifecycle (stop/resume/terminate), standby, snapshots.
// Status, health, offers, latency, settings are in gpu-handlers-{info,offers,settings}.ts

import { createLogger } from '../src/logger';
import { readUserIdHeader } from './ws/api-key-resolver';
const log = createLogger('gpu-handlers');

import type { IncomingMessage, ServerResponse } from 'http';
import type { GpuProviderClient, GpuOffer, ProviderCredentials } from '../src/gpu-providers/types';
import { pauseInstanceForIdle } from '../src/gateway/providers/gpu/idle-pause';
import { filterTiers, dropModalForDockerImage } from '../src/gpu-providers/deploy-orchestrator';
import type { ProviderName } from '../src/gpu-providers/deploy-orchestrator';
import {
  deployState, setDeployState, deployCancelled, setDeployCancelled, deployLock, setDeployLock,
  deployPromise, setDeployPromise,
  deployVastApiKey, deployTensordockApiKey, deployTensordockAuthId, deployModalApiKey, deployHyperstackApiKey, deployApiKey,
  isGpuAvailable, resetDeployState, prisma,
  deploymentSM,
  standbyDeployState, standbyReadyForHandover,
} from './state';
import { triggerStandbyDeploy, initiateHandover, cancelStandby, startStandbyMonitor } from './gpu-standby';
export { startStandbyMonitor };
import { updateActivePipeline, runpod, vast, tensordock, modal, hyperstack } from './providers';
import {
  startGpuMonitoring, stopGpuMonitoring, startDeployWithTiers, startDeployRace, buildGpuTiers, cooldownTracker,
  cleanupAllPods, cleanupVastInstances, cleanupTensordockInstances, cleanupModalApps, cleanupHyperstackInstances,
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
  getGpuSortBy, getDeployTimeoutMin, setDeployTimeoutMin, getDeployRegion, getMinVramGb, getMinInetDownMbps, getPreferSsd,
  getDeployRaceCount, getLatencyMaxMs,
} from '../src/gpu-providers/deploy-settings';
import { getBestLatencyByGpuModel, sortGpuTypesByLatency } from './latency-db';
import { resolveDeployRegion } from './gpu-latency';
import { runPreFlightChecks, validateDockerImageReference } from '../src/preflight-checks';
import type { DockerCapability } from '../src/gateway/providers/gpu/docker-manifest';
import { defaultApiPathsForCapabilities } from '../src/gateway/providers/gpu/docker-manifest';
import { categorizeDeployError } from '../src/errors/deploy-errors';
import { errorSummary } from '../src/error-summary';

// ── GPU management endpoints ────────────────────────────────────────────────

// ── VRAM vs Model Size Pre-Deploy Validation ────────────────────────────────

/** Known VRAM (GB) per GPU type name. Used for pre-deploy model-size validation. */
const GPU_VRAM_GB: Record<string, number> = {
  'NVIDIA GeForce RTX 5090': 32,
  'NVIDIA GeForce RTX 5080': 16,
  'NVIDIA GeForce RTX 5070 Ti': 16,
  'NVIDIA GeForce RTX 5070': 12,
  'NVIDIA GeForce RTX 4090': 24,
  'NVIDIA GeForce RTX 4080': 16,
  'NVIDIA GeForce RTX 4080 SUPER': 16,
  'NVIDIA GeForce RTX 4070 Ti': 12,
  'NVIDIA GeForce RTX 4070 Ti SUPER': 16,
  'NVIDIA GeForce RTX 3090': 24,
  'NVIDIA GeForce RTX 3080': 10,
  'NVIDIA GeForce RTX 3070': 8,
  'NVIDIA RTX A6000': 48,
  'NVIDIA RTX A5000': 24,
  'NVIDIA RTX A4000': 16,
  'NVIDIA L40S': 48,
  'NVIDIA L40': 48,
  'NVIDIA L4': 24,
  'NVIDIA A40': 48,
  'NVIDIA A10G': 24,
  'NVIDIA A100-SXM4-80GB': 80,
  'NVIDIA A100 80GB PCIe': 80,
  'NVIDIA A100-SXM4-40GB': 40,
  'NVIDIA A100 40GB PCIe': 40,
  'NVIDIA H100 80GB HBM3': 80,
  'NVIDIA H200': 141,
  'NVIDIA V100': 16,
  'NVIDIA T4': 16,
};

/**
 * Estimate the minimum VRAM (GB) a model needs based on size hints in
 * the Docker image name, onstart command, env vars, or llmModel field.
 * Returns 0 if no model size hint is detected.
 */
function estimateModelVramGb(dockerImage: string, dockerStartCmd: string, env: Record<string, string>, llmModel: string): { vramGb: number; hint: string } {
  const haystack = `${dockerImage} ${dockerStartCmd} ${JSON.stringify(env)} ${llmModel}`.toLowerCase();

  // Check for quantization hints to refine estimation
  const isQ2 = /\b(q2|2bit)\b/.test(haystack);
  const isQ3 = /\b(q3|3bit)\b/.test(haystack);
  const isQ4 = /\b(q4|4bit)\b/.test(haystack);
  const isQ5 = /\b(q5|5bit)\b/.test(haystack);
  const isQ8 = /\b(q8|8bit)\b/.test(haystack);
  const isFp16 = /\b(fp16|half)\b/.test(haystack);
  const isGguf = /\b(gguf|llama\.cpp)\b/.test(haystack);

  // KV cache overhead for long context (adds 5-20GB depending on context length)
  const hasLongContext = /\b(32k|64k|128k|long.context)\b/.test(haystack);
  const kvCacheOverhead = hasLongContext ? 15 : 5;

  // CUDA context overhead (~2-4GB)
  const cudaOverhead = 3;

  // Multi-model setup (STT + LLM + TTS simultaneously)
  const isMultiModel = /\b(multi|pipeline|stt.*llm|llm.*tts)\b/.test(haystack);
  const multiModelMultiplier = isMultiModel ? 1.5 : 1;

  if (/\b(200b|175b)\b/.test(haystack)) {
    let base = isQ4 ? 110 : isQ8 ? 180 : isFp16 ? 350 : 400;
    return { vramGb: Math.ceil((base + kvCacheOverhead + cudaOverhead) * multiModelMultiplier), hint: '200B-class model' };
  }
  if (/\b(70b|65b|72b)\b/.test(haystack)) {
    let base = isQ4 ? 40 : isQ5 ? 50 : isQ8 ? 75 : isFp16 ? 140 : isGguf ? 42 : 48;
    return { vramGb: Math.ceil((base + kvCacheOverhead + cudaOverhead) * multiModelMultiplier), hint: '70B-class model' };
  }
  if (/\b(32b|33b|34b|35b)\b/.test(haystack)) {
    let base = isQ4 ? 20 : isQ8 ? 36 : isFp16 ? 68 : isGguf ? 22 : 24;
    return { vramGb: Math.ceil((base + kvCacheOverhead + cudaOverhead) * multiModelMultiplier), hint: '32B-class model' };
  }
  if (/\b(13b|14b|15b)\b/.test(haystack)) {
    let base = isQ4 ? 10 : isQ8 ? 16 : isFp16 ? 28 : isGguf ? 11 : 16;
    return { vramGb: Math.ceil((base + kvCacheOverhead + cudaOverhead) * multiModelMultiplier), hint: '13B-class model' };
  }
  if (/\b(7b|8b)\b/.test(haystack)) {
    let base = isQ4 ? 5 : isQ8 ? 8 : isFp16 ? 16 : isGguf ? 6 : 8;
    return { vramGb: Math.ceil((base + kvCacheOverhead + cudaOverhead) * multiModelMultiplier), hint: '7B-class model' };
  }
  if (/\b(3b|4b)\b/.test(haystack)) {
    let base = isQ4 ? 3 : isQ8 ? 4 : isFp16 ? 8 : isGguf ? 3 : 4;
    return { vramGb: Math.ceil((base + kvCacheOverhead + cudaOverhead) * multiModelMultiplier), hint: '3-4B model' };
  }

  return { vramGb: 0, hint: '' };
}

/** GPU types with enough VRAM for the given requirement.
 * FIX #1: Unknown GPU types now FAIL validation instead of passing.
 * Unknown GPUs must be explicitly added to GPU_VRAM_GB map first. */
function gpuTypesWithSufficientVram(gpuTypes: string[], requiredVramGb: number): string[] {
  return gpuTypes.filter(gpu => {
    const vram = GPU_VRAM_GB[gpu];
    // FIX: Unknown GPUs fail validation — must be explicitly mapped
    if (vram === undefined) {
      log.warn(`[VRAM] Unknown GPU type "${gpu}" — failing validation. Add to GPU_VRAM_GB map.`);
      return false;
    }
    return vram >= requiredVramGb;
  });
}

/** GPU names that are known to have insufficient VRAM. */
function gpuTypesWithInsufficientVram(gpuTypes: string[], requiredVramGb: number): Array<{ gpu: string; vram: number }> {
  return gpuTypes
    .filter(gpu => {
      const vram = GPU_VRAM_GB[gpu];
      return vram !== undefined && vram < requiredVramGb;
    })
    .map(gpu => ({ gpu, vram: GPU_VRAM_GB[gpu] }));
}

/**
 * Validate that requested GPU types have enough VRAM for the detected model.
 * Throws { status: 400, message } if ALL requested GPUs are too small.
 * Logs a warning and filters out insufficient GPUs if some are adequate.
 * Returns the (possibly filtered) GPU types list.
 */
function validateVramForModel(
  gpuTypes: string[],
  dockerImage: string,
  dockerStartCmd: string,
  env: Record<string, string>,
  llmModel: string,
  requestId: string,
): string[] {
  if (gpuTypes.length === 0) return gpuTypes;

  const { vramGb: requiredVram, hint } = estimateModelVramGb(dockerImage, dockerStartCmd, env, llmModel);
  if (requiredVram === 0) return gpuTypes;

  const insufficient = gpuTypesWithInsufficientVram(gpuTypes, requiredVram);
  if (insufficient.length === 0) return gpuTypes;

  const sufficient = gpuTypesWithSufficientVram(gpuTypes, requiredVram);

  if (sufficient.length === 0) {
    const gpuList = insufficient.map(g => `${g.gpu} (${g.vram}GB)`).join(', ');
    const suggestions = Object.entries(GPU_VRAM_GB)
      .filter(([, v]) => v >= requiredVram)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 4)
      .map(([name, v]) => `${name} (${v}GB)`)
      .join(', ');
    throw {
      status: 400,
      message: `Model requires ~${requiredVram}GB VRAM (${hint}) but all requested GPUs are too small: ${gpuList}. Use: ${suggestions}`,
    };
  }

  const removed = insufficient.map(g => `${g.gpu} (${g.vram}GB)`).join(', ');
  log.warn(`[req=${requestId}] VRAM filter: removed ${removed} -- ${hint} needs ${requiredVram}GB. Keeping: ${sufficient.join(', ')}`);
  return sufficient;
}

function parseExpectedApiPaths(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : null;
  if (!raw) {
    throw { status: 400, message: 'expectedApiPaths must be a string or array of strings' };
  }

  const seen = new Set<string>();
  const paths: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw { status: 400, message: 'expectedApiPaths must contain only strings' };
    }
    const path = entry.trim();
    if (!path) continue;
    if (!path.startsWith('/') || path.includes('?') || path.includes('#') || /\s/.test(path) || /[;&|`$<>]/.test(path)) {
      throw { status: 400, message: `Invalid expected API path "${entry}". Use path-only values like "/generate-from-text".` };
    }
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

function inferExpectedApiPaths(dockerImage: string): string[] {
  const image = dockerImage.toLowerCase();
  if (image.includes('hunyuan')) return ['/generate-from-text'];
  if (image.includes('trellis') || image.includes('fbx2glb') || image.includes('glb') || image.includes('3d')) return ['/generate'];
  return [];
}

const VALID_DOCKER_CAPABILITIES = new Set<DockerCapability>([
  'speech_pipeline',
  'openai_compat',
  'stt',
  'llm',
  'tts',
  'image',
  'embedding',
  'rerank',
  'glb_generation',
  'motion_generation',
]);

function parseExpectedCapabilities(value: unknown): DockerCapability[] {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : null;
  if (!raw) {
    throw { status: 400, message: 'expectedCapabilities must be a string or array of strings' };
  }

  const seen = new Set<DockerCapability>();
  const capabilities: DockerCapability[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw { status: 400, message: 'expectedCapabilities must contain only strings' };
    }
    const capability = entry.trim() as DockerCapability;
    if (!capability) continue;
    if (!VALID_DOCKER_CAPABILITIES.has(capability)) {
      throw { status: 400, message: `Invalid expected capability "${entry}".` };
    }
    if (!seen.has(capability)) {
      seen.add(capability);
      capabilities.push(capability);
    }
  }
  return capabilities;
}

function inferExpectedCapabilities(dockerImage: string): DockerCapability[] {
  const image = dockerImage.toLowerCase();
  if (image.includes('hunyuan') || image.includes('trellis') || image.includes('fbx2glb') || image.includes('glb') || image.includes('3d')) {
    return ['glb_generation'];
  }
  return [];
}

// ── Deploy request validation & config types ─────────────────────────────────

/** Validated deploy configuration produced by _validateDeployRequest. */
interface DeployConfig {
  apiKey: string;              // RunPod API key (may be empty)
  vastApiKey: string;
  hyperstackApiKey: string;
  tensordockApiKey: string;
  tensordockAuthId: string;
  modalApiKey: string;
  dockerImage: string;
  expectedApiPaths: string[];
  expectedCapabilities: DockerCapability[];
  requireDockerManifest: boolean;
  runSmokeTests: boolean;
  gpuTypes: string[];
  autoSelectGpu: boolean;
  region: string;
  minVramGb: number;
  minInetDownMbps: number;
  preferSsd: boolean;
  storageGb: number;
  hfToken: string;
  llmModel: string;
  interruptible: boolean | undefined;
  raceCount: number;
  deployEnv: Record<string, string>;
  dockerStartCmd: string;
  onstart: string;
  containerDiskInGb: number;
  volumeId: string;
  providerFilter: ProviderName | undefined;
  /** Vast.ai template hash ID — pre-configured image/env/ports for faster boot */
  templateHashId: string | undefined;
  /** Force SSH tunnel for Vast.ai (skip direct-port endpoint, use SSH proxy) */
  forceSshTunnel: boolean | undefined;
  /** Enable CRIU checkpoint/restore via SnapGPU wrapper */
  useSnapgpu: boolean;
  /** Auto-capture checkpoint after first successful boot (only when useSnapgpu=true) */
  autoSnapshot: boolean;
  /** App name to preload at boot for snapshot capture */
  snapgpuPreloadApp: string;
  /** Underlying provider for SnapGPU (vast or runpod) */
  snapgpuBackend: 'vast' | 'runpod';
  /** Maximum total cost in USD for this deploy. If set, deploy is rejected when estimated
   *  hourly cost exceeds the cap, and the monitor auto-stops when cumulative cost exceeds it. */
  maxCostUsd: number | undefined;
  /** Enable canary deployment after successful deploy */
  canary: boolean;
  /** Initial traffic percentage to canary (0-100) */
  canaryInitialTraffic: number;
  /** Max error rate before rollback (0-1) */
  canaryMaxErrorRate: number;
  /** Step size for traffic increase */
  canaryTrafficStep: number;
  /** Dev mode: pause on idle but skip the auto-destroy timer (user resumes manually). */
  devMode?: boolean;
  /**
   * Human-readable task label propagated to the provider as the instance
   * `label`/`name`. Required for accountability + orphan reconciliation —
   * hosts that fall out of gateway tracking can still be matched back to
   * their owning task. Format: 3-64 chars, [a-zA-Z0-9_-]+ ([space] for
   * Vast acceptance). Mandatory unless AIGW_LABEL_OPTIONAL=1 is set.
   */
  label: string;
  /**
   * Strict-fast filter: only deploy onto hosts where SSH/HTTP boot is
   * historically fast. Default true. When true, candidate offers must
   * have direct_port_count>=1 (no SSH-proxy hops), reliability>=0.97,
   * and inet_down>=200 Mbps. Set false to fall back to current
   * permissive search (zombie-prone).
   */
  strictFastBoot: boolean;
  /**
   * Vast.ai-only: opt-in to deverified/unverified rentable hosts.
   * When false (default), only Vast-verified hosts are eligible. Set true
   * to widen the offer pool when no verified hosts are available for the
   * requested GPU. Trade-off: host may be reclaimed mid-boot.
   */
  allowUnverified?: boolean;
  /**
   * Disable provider tier cascade. When true, deploy uses only the first
   * resolved tier (or the forced provider). Useful when caller wants race=N
   * within a single provider — no fallback to next provider on failure.
   */
  noTierCascade?: boolean;
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
  const hyperstackApiKey = (body.hyperstackApiKey as string) || process.env.HYPERSTACK_API_KEY || '';
  const tensordockApiKey = (body.tensordockApiKey as string) || process.env.TENSORDOCK_API_KEY || '';
  const tensordockAuthId = (body.tensordockAuthId as string) || process.env.TENSORDOCK_AUTH_ID || '';
  const modalTokenId = (body.modalTokenId as string) || process.env.MODAL_TOKEN_ID || '';
  const modalTokenSecret = (body.modalTokenSecret as string) || process.env.MODAL_TOKEN_SECRET || '';
  const modalApiKey = modalTokenId && modalTokenSecret ? `${modalTokenId}:${modalTokenSecret}` : '';

  // Validate credential format before using them
  const credError = validateGpuCredentials({
    runpodApiKey: apiKey,
    vastApiKey,
    hyperstackApiKey,
    tensordockApiKey,
    tensordockAuthId,
    modalTokenId,
    modalTokenSecret,
  });
  if (credError) {
    throw { status: 400, message: credError };
  }

  if (!apiKey && !vastApiKey && !hyperstackApiKey && !tensordockApiKey && !modalApiKey) {
    throw { status: 400, message: 'At least one provider API key is required (apiKey, vastApiKey, hyperstackApiKey, or Modal tokens)' };
  }

  // ── Label requirement ────────────────────────────────────────────────────
  // Mandatory by default. Goal: every running pod traces back to a named
  // task. Set AIGW_LABEL_OPTIONAL=1 to disable for legacy callers (CI
  // pipelines that haven't updated). The env opt-out is intentional —
  // we DO want a hard error, not a default that silently auto-generates.
  // Auto-generated labels would defeat the purpose (every pod looks the
  // same in vast.ai console, can't reconcile orphans by task).
  const rawLabel = typeof body.label === 'string' ? body.label.trim() : '';
  const labelOptional = process.env.AIGW_LABEL_OPTIONAL === '1';
  let label = rawLabel;
  if (!label) {
    if (!labelOptional) {
      throw {
        status: 400,
        message:
          'Deploy rejected: missing required `label` field describing the task. ' +
          'Pass `{"label":"my-task-name"}` in the body, or set AIGW_LABEL_OPTIONAL=1 to disable. ' +
          'Format: 3-64 chars, [a-zA-Z0-9_ -]. The label is attached to the provider instance ' +
          'so orphans can be reconciled back to their owning task.',
      };
    }
    // Opt-out path — fall back to a generic but traceable label so we
    // still know who created it (gateway, not user).
    label = `aigw-${requestId.slice(0, 8)}`;
  } else {
    if (label.length < 3 || label.length > 64) {
      throw { status: 400, message: `label length must be 3-64 chars, got ${label.length}` };
    }
    if (!/^[a-zA-Z0-9_/ -]+$/.test(label)) {
      throw { status: 400, message: 'label must match [a-zA-Z0-9_/ -]+ (provider compatibility; "/" allowed for owner/task namespacing)' };
    }
  }
  log.log(`[req=${requestId}] deploy label="${label}"`);

  // Strict fast-boot filter — opt-out via body.strictFastBoot=false.
  // Defaults to true so the most common path (user races 3 random hosts)
  // is the safe one. The looser filter lives in the existing offer
  // search (reliability>=0.95) and is preserved for callers that
  // explicitly set strictFastBoot=false.
  const strictFastBoot = body.strictFastBoot === false ? false : true;
  const allowUnverified = body.allowUnverified === true ? true : undefined;
  const noTierCascade = body.noTierCascade === true ? true : undefined;

  // Resolve app-based GPU deploy config — use active app as defaults
  const config = await loadProviderConfig();
  const appId = (body.profileId as string) || config.activeAppId;
  const apps = config.apps;
  const activeApp = appId ? apps.find(p => p.id === appId) : null;
  const appGpu = activeApp?.gpuDeploy;

  const dockerImage = (body.dockerImage as string) || appGpu?.dockerImage || '';
  if (!dockerImage) {
    throw { status: 400, message: 'dockerImage is required — provide dockerImage, profileId, or set an active app with gpuDeploy config' };
  }
  const providerFilter = body.provider as ProviderName | undefined;
  const onlyModalProvider = Boolean(modalApiKey && !apiKey && !vastApiKey && !hyperstackApiKey && !tensordockApiKey);
  const dockerImageFormat = validateDockerImageReference(dockerImage, {
    allowModalDeployScript: providerFilter === 'modal' || onlyModalProvider,
  });
  if (!dockerImageFormat.ok) {
    throw { status: 400, message: dockerImageFormat.error };
  }
  const expectedApiPaths = parseExpectedApiPaths(
    body.expectedApiPaths ?? appGpu?.expectedApiPaths,
  );
  const expectedCapabilities = parseExpectedCapabilities(
    body.expectedCapabilities ?? appGpu?.expectedCapabilities,
  );
  const effectiveExpectedCapabilities = expectedCapabilities.length > 0
    ? expectedCapabilities
    : inferExpectedCapabilities(dockerImage);
  const effectiveExpectedApiPaths = expectedApiPaths.length > 0
    ? expectedApiPaths
    : [...new Set([
        ...inferExpectedApiPaths(dockerImage),
        ...defaultApiPathsForCapabilities(effectiveExpectedCapabilities),
      ])];
  const requireDockerManifest = body.requireDockerManifest === true || appGpu?.requireDockerManifest === true;
  const runSmokeTests = body.runSmokeTests === false || appGpu?.runSmokeTests === false ? false : true;

  const rawGpuTypes = body.gpuTypes;
  let gpuTypes: string[] = [];
  if (Array.isArray(rawGpuTypes)) {
    gpuTypes = rawGpuTypes.filter((g): g is string => typeof g === 'string' && g.trim().length > 0 && g.length <= 100);
    if (rawGpuTypes.length !== gpuTypes.length) {
      log.warn(`gpuTypes contains invalid entries, filtering out`);
    }
  } else if (typeof rawGpuTypes === 'string' && rawGpuTypes.trim()) {
    gpuTypes = rawGpuTypes.split(',').map((s: string) => s.trim()).filter(Boolean);
  } else if (rawGpuTypes !== undefined) {
    throw { status: 400, message: 'gpuTypes must be a string or array of strings' };
  } else {
    gpuTypes = appGpu?.gpuTypes ?? [];
  }
  const autoSelectGpu = body.autoSelectGpu === true;

  // Region / hardware filters: app → saved preference → request body
  // Use nullish coalescing on body.region so callers can override with the
  // empty string ("any region") — `||` treats `""` as falsy and surprises
  // anyone trying to disable a sticky persisted region. Same fix for the
  // app-level fallback. The env-level `VAST_NO_DEFAULT_REGION=1` short-
  // circuits to "" entirely (kills the sticky `us-east` that some upstream
  // helpers set during latency probing).
  const requestedRegion = process.env.VAST_NO_DEFAULT_REGION === '1'
    ? ''
    : (typeof body.region === 'string' ? body.region : (appGpu?.region ?? getDeployRegion()));
  // region "near[:km]" → countries around the client (ADR-017)
  const region = resolveDeployRegion(requestedRegion, body.clientLat, body.clientLon);
  if (region !== requestedRegion) log.log(`[gpu] region "${requestedRegion}" → ${region}`);
  // Apply app timeout if provided (and not overridden by body)
  if (appGpu?.timeoutMin && typeof body.timeoutMin !== 'number') {
    setDeployTimeoutMin(appGpu.timeoutMin);
  }
  // Per-deploy idle override. Callers (canal-dark, voice-clone scripts,
  // etc.) often need a longer idle window than the persisted default —
  // the gateway used to silently kill 5-min-boot containers after 25 min
  // even though the user hadn't issued the first inference yet. Accept
  // body.idleTimeoutMin (minutes) and apply it for the lifetime of this
  // deploy. Falls through to whatever loadDeploySettings() / config set.
  if (typeof body.idleTimeoutMin === 'number' && body.idleTimeoutMin > 0) {
    const { setIdleTimeoutMs } = await import('./gpu-deploy');
    setIdleTimeoutMs(Math.min(body.idleTimeoutMin, 24 * 60) * 60_000);
    log.log(`[req=${requestId}] Per-deploy idle override: ${body.idleTimeoutMin}min`);
  }
  const minVramGbRaw = body.minVramGb;
  let minVramGb: number;
  if (typeof minVramGbRaw === 'number' && minVramGbRaw >= 0 && Number.isFinite(minVramGbRaw)) {
    minVramGb = Math.min(Math.max(minVramGbRaw, 0), 100);
  } else if (typeof minVramGbRaw !== 'undefined') {
    throw { status: 400, message: 'minVramGb must be a non-negative number (0-100)' };
  } else {
    minVramGb = getMinVramGb();
  }
  const preferSsd = typeof body.preferSsd === 'boolean' ? body.preferSsd : getPreferSsd();
  const minInetDownMbpsRaw = body.minInetDownMbps;
  const minInetDownMbps = typeof minInetDownMbpsRaw === 'number' && minInetDownMbpsRaw >= 0
    ? Math.min(minInetDownMbpsRaw, 100_000)
    : getMinInetDownMbps();
  const storageGb = typeof body.storageGb === 'number' ? Math.min(Math.max(body.storageGb, 0), 1000) : 0;
  // HuggingFace token has FOUR canonical env-var spellings depending on
  // which library is reading it (transformers, diffusers, datasets, hub).
  // Accept any of them so the operator does not have to remember which one
  // — whichever is set in the gateway env, we forward it as HF_TOKEN to
  // the container, which is the most widely accepted name.
  const hfToken = (body.hfToken as string)
    || process.env.HF_TOKEN
    || process.env.HUGGINGFACE_TOKEN
    || process.env.HUGGINGFACE_HUB_TOKEN
    || process.env.HUGGING_FACE_HUB_TOKEN
    || '';
  const llmModel = (body.llmModel as string) || '';
  const interruptible = body.interruptible === true ? true : body.interruptible === false ? false : undefined;

  // Hedged deploy: launch raceCount instances in parallel, keep first healthy
  const raceCountRaw = body.raceCount;
  let raceCount: number;
  if (typeof raceCountRaw === 'number' && raceCountRaw >= 1 && Number.isFinite(raceCountRaw)) {
    raceCount = Math.min(Math.floor(raceCountRaw), 10);
  } else if (typeof raceCountRaw !== 'undefined') {
    throw { status: 400, message: 'raceCount must be a positive number between 1 and 10' };
  } else {
    raceCount = getDeployRaceCount();
  }

  // Custom env vars, Docker start command, and container disk
  const customEnv = (typeof body.env === 'object' && body.env !== null && !Array.isArray(body.env))
    ? body.env as Record<string, string> : {};
  const dockerStartCmd = (body.dockerStartCmd as string) || '';
  const onstart = (body.onstart as string) || '';
  const containerDiskInGb = typeof body.containerDiskInGb === 'number'
    ? Math.min(Math.max(body.containerDiskInGb, 0), 100)
    : 0;
  // RunPod Network Volume ID — attach existing volume for persistent LLM GGUF cache
  const volumeId = (body.volumeId as string) || '';
  const deployEnv: Record<string, string> = { ...customEnv };
  if (llmModel) deployEnv.CONF_LLM_MODEL = llmModel;

  // Enforce GPU allowlist — only tested & approved GPUs are permitted.
  // When gpuPriorityList is empty, filtering is disabled — allow all types.
  const effectiveAllowed = new Set(getGpuPriorityList());
  const allowlistActive = effectiveAllowed.size > 0;
  if (gpuTypes.length > 0) {
    if (allowlistActive) {
      const rejected = gpuTypes.filter(g => !effectiveAllowed.has(g));
      if (rejected.length > 0) {
        log.warn(`[req=${requestId}] Rejected non-tested GPU(s): ${rejected.join(', ')}`);
      }
      gpuTypes = gpuTypes.filter(g => effectiveAllowed.has(g));
      if (gpuTypes.length === 0) {
        throw { status: 400, message: `None of the requested GPUs are in the tested allowlist. Allowed: ${[...effectiveAllowed].join(', ')}` };
      }
    }
    // else: allowlist disabled (empty list) — accept all requested GPU types
  } else if (!autoSelectGpu) {
    // No GPU specified and no auto-select — use user-configured priority list from settings
    const userList = getGpuPriorityList();
    gpuTypes = userList.length > 0 ? userList : await getVerifiedGpuTypes(dockerImage);
    log.log(`[req=${requestId}] No GPU specified — using priority list: ${gpuTypes.join(', ')}`);
  }

  // SnapGPU / CRIU — read from app gpuDeploy or active service, body can override
  const useSnapgpu = body.useSnapgpu === true || appGpu?.useSnapgpu === true
    || (activeApp as unknown as Record<string, unknown>)?.services != null &&
       ((activeApp as unknown as Record<string, unknown>).services as unknown[])
         .some((s: unknown) => (s as Record<string, unknown>)?.kind === 'gpu-pod' &&
           (s as Record<string, unknown>)?.useSnapgpu === true);
  const autoSnapshot = typeof body.autoSnapshot === 'boolean' ? body.autoSnapshot : (appGpu?.autoSnapshot ?? true);
  const snapgpuPreloadApp = (body.snapgpuPreloadApp as string) || appGpu?.snapgpuPreloadApp || 'default';
  const snapgpuBackend = ((body.snapgpuBackend as string) || appGpu?.snapgpuBackend || 'vast') as 'vast' | 'runpod';

  // Per-deploy cost cap
  const maxCostUsd = typeof body.maxCostUsd === 'number' && body.maxCostUsd > 0 ? body.maxCostUsd : undefined;

  // Canary deployment options
  const canary = body.canary === true;
  const canaryInitialTraffic = typeof body.canaryInitialTraffic === 'number' ? body.canaryInitialTraffic : 5;
  const canaryMaxErrorRate = typeof body.canaryMaxErrorRate === 'number' ? body.canaryMaxErrorRate : 0.05;
  const canaryTrafficStep = typeof body.canaryTrafficStep === 'number' ? body.canaryTrafficStep : 10;

  // Dev mode: skip auto-destroy after idle-stop (pod stays paused until manually resumed)
  const devMode = body.devMode === true;

  return {
    apiKey, vastApiKey, hyperstackApiKey, tensordockApiKey, tensordockAuthId, modalApiKey,
    dockerImage,
    expectedApiPaths: effectiveExpectedApiPaths,
    expectedCapabilities: effectiveExpectedCapabilities,
    requireDockerManifest,
    runSmokeTests,
    gpuTypes, autoSelectGpu, region, minVramGb, minInetDownMbps, preferSsd,
    storageGb, hfToken, llmModel, interruptible, raceCount, deployEnv,
    dockerStartCmd, onstart, containerDiskInGb, volumeId,
    providerFilter,
    templateHashId: typeof body.templateHashId === 'string' && body.templateHashId.length > 0
      ? body.templateHashId : undefined,
    forceSshTunnel: body.forceSshTunnel === true ? true : undefined,
    useSnapgpu: useSnapgpu === true,
    autoSnapshot,
    snapgpuPreloadApp,
    snapgpuBackend,
    maxCostUsd,
    canary,
    canaryInitialTraffic,
    canaryMaxErrorRate,
    canaryTrafficStep,
    devMode,
    label,
    strictFastBoot,
    allowUnverified,
    noTierCascade,
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
  /** Estimated cheapest cost per hour from available offers (if known). */
  estimatedCostPerHr?: number;
  /** Total available balance across all providers (sum of checked balances). */
  totalBalance?: number;
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
  const { apiKey, vastApiKey, hyperstackApiKey, tensordockApiKey, tensordockAuthId, modalApiKey,
    dockerImage, autoSelectGpu, region, minVramGb: minVramGbReq, preferSsd: preferSsdReq,
    providerFilter } = config;

  // Accumulate provider balances for cost estimate in deploy response
  let totalBalance = 0;

  // Pre-flight: validate RunPod key + check balance via RunpodClient
  let runpodApiKey = apiKey;
  if (runpodApiKey) {
    try {
      const runpodBal = await runpod.checkBalance({ apiKey: runpodApiKey });
      if (runpodBal !== null) {
        log.log(`[gpu] RunPod balance: $${runpodBal.balance.toFixed(2)}`);
        totalBalance += runpodBal.balance;
        if (runpodBal.balance < 1.0) {
          log.warn(`[gpu] RunPod balance too low ($${runpodBal.balance.toFixed(2)}) — skipping provider`);
          runpodApiKey = '';  // exclude from tier list
        }
      }
    } catch (balErr) {
      const msg = balErr instanceof Error ? balErr.message : String(balErr);
      if (/401|403|unauthorized|invalid/i.test(msg)) {
        throw { status: 401, message: 'RunPod API key is invalid' };
      }
      log.warn(`[gpu] RunPod balance check failed: ${msg} — proceeding anyway`);
    }
  }

  // Pre-deploy balance check for TensorDock
  let tensordockOpts = tensordockApiKey && tensordockAuthId ? { apiKey: tensordockApiKey, authId: tensordockAuthId } : undefined;
  if (tensordockOpts) {
    try {
      const bal = await tensordock.checkBalance({ apiKey: tensordockApiKey, authId: tensordockAuthId });
      if (bal !== null) {
        log.log(`[gpu] TensorDock balance: $${bal.balance.toFixed(2)} (hourly cost: $${bal.hourlyCost.toFixed(3)})`);
        totalBalance += bal.balance;
        if (bal.balance < 0.5) {
          log.warn(`[gpu] TensorDock balance too low ($${bal.balance.toFixed(2)}) — skipping provider`);
          tensordockOpts = undefined;  // exclude from tier list
        }
      }
    } catch (balErr) {
      const msg = balErr instanceof Error ? balErr.message : String(balErr);
      if (/401|403|unauthorized|invalid/i.test(msg)) {
        throw { status: 401, message: 'TensorDock credentials are invalid' };
      }
      log.warn(`[gpu] TensorDock balance check failed: ${msg} — proceeding anyway`);
    }
  }

  // Pre-deploy balance check for Vast.ai
  let effectiveVastApiKey = vastApiKey;
  if (effectiveVastApiKey) {
    try {
      const bal = await vast.checkBalance({ apiKey: effectiveVastApiKey });
      if (bal !== null) {
        log.log(`[gpu] Vast.ai balance: $${bal.balance.toFixed(2)}`);
        totalBalance += bal.balance;
        if (bal.balance <= 0) {
          log.warn(`[gpu] Vast.ai balance is $${bal.balance.toFixed(2)} — skipping provider`);
          effectiveVastApiKey = '';  // exclude from tier list
        } else if (bal.balance < LOW_BALANCE_THRESHOLD_USD) {
          log.warn(`[gpu] Vast.ai balance low ($${bal.balance.toFixed(2)}) — skipping provider`);
          effectiveVastApiKey = '';  // exclude from tier list
        }
      }
    } catch (balErr) {
      const msg = balErr instanceof Error ? balErr.message : String(balErr);
      if (/401|403|unauthorized|invalid/i.test(msg)) {
        throw { status: 401, message: 'Vast.ai API key is invalid' };
      }
      log.warn(`[gpu] Vast.ai balance check failed: ${msg} — proceeding anyway`);
    }
  }

  // Log providers excluded due to insufficient balance
  const balanceExcluded: string[] = [];
  if (apiKey && !runpodApiKey) balanceExcluded.push('RunPod');
  if ((tensordockApiKey && tensordockAuthId) && !tensordockOpts) balanceExcluded.push('TensorDock');
  if (vastApiKey && !effectiveVastApiKey) balanceExcluded.push('Vast.ai');
  if (balanceExcluded.length > 0) {
    log.warn(`[gpu] Providers excluded (balance < $${LOW_BALANCE_THRESHOLD_USD}): ${balanceExcluded.join(', ')}`);
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
  let allTiers = buildGpuTiers(
    runpodApiKey,
    effectiveVastApiKey || undefined,
    tensordockOpts,
    modalApiKey || undefined,
    hyperstackApiKey || undefined,
  );

  // If CRIU/SnapGPU is enabled, wrap the backend tier with the snapgpu client.
  // The snapgpu client delegates to vast or runpod but adds checkpoint/restore capability.
  if (config.useSnapgpu) {
    const backendApiKey = config.snapgpuBackend === 'runpod' ? runpodApiKey : (effectiveVastApiKey || '');
    if (backendApiKey) {
      const { providerClients } = await import('./gpu-deploy');
      const snapgpuTier = {
        client: providerClients.snapgpu,
        name: 'snapgpu' as ProviderName,
        label: `SnapGPU (${config.snapgpuBackend})`,
        apiKey: backendApiKey,
        // Pass snapgpu-specific options through tier metadata
        snapgpuBackend: config.snapgpuBackend,
        snapgpuPreloadApp: config.snapgpuPreloadApp,
        autoSnapshot: config.autoSnapshot,
      };
      // Prepend snapgpu tier — it gets first shot; falls back to regular tiers on failure
      allTiers = [snapgpuTier, ...allTiers];
      log.log(`[req=${requestId}] SnapGPU enabled (backend=${config.snapgpuBackend}, preloadApp=${config.snapgpuPreloadApp}, autoSnapshot=${config.autoSnapshot})`);
    } else {
      log.warn(`[req=${requestId}] SnapGPU requested but no API key for backend=${config.snapgpuBackend} — falling back to regular deploy`);
    }
  }

  log.log(`[req=${requestId}] providerFilter=${providerFilter ?? 'none'}, allTiers=[${allTiers.map(t => t.name).join(', ')}]`);
  const filtered = filterTiers(allTiers, providerFilter);
  if ('error' in filtered) {
    const balanceHint = balanceExcluded.length > 0
      ? ` (${balanceExcluded.join(', ')} excluded — balance < $1)`
      : '';
    throw { status: 400, message: filtered.error + balanceHint };
  }
  const tiersBeforeModalDrop = filtered.tiers;
  const tiers = dropModalForDockerImage(tiersBeforeModalDrop, dockerImage, providerFilter);
  if (tiers.length < tiersBeforeModalDrop.length) {
    log.log(`[req=${requestId}] Dropped modal tier — dockerImage is not a .py script; pass --provider modal to opt in.`);
  }

  // Auto-select cheapest GPUs with adequate VRAM when autoSelectGpu is true and no gpuTypes specified
  if (autoSelectGpu && gpuTypes.length === 0 && tiers.length > 0) {
    const selectedGpus = await autoSelectCheapestGpu(tiers, { region, minVramGb: minVramGbReq, preferSsd: preferSsdReq });
    if (selectedGpus.length > 0) {
      gpuTypes = selectedGpus;
      log.log(`[gpu] Auto-selected ${gpuTypes.length} GPU types: ${gpuTypes.join(', ')}`);
    } else {
      log.warn(`[gpu] autoSelectGpu: no suitable GPU found (>=${getMinVramGb()}GB VRAM), falling back to verified GPU list`);
      gpuTypes = await getVerifiedGpuTypes(dockerImage);
    }
  }

  // VRAM validation: filter out GPUs that are too small for the detected model size.
  // Runs after GPU type resolution so we validate the final list (including auto-selected types).
  gpuTypes = validateVramForModel(
    gpuTypes,
    config.dockerImage,
    `${config.dockerStartCmd} ${config.onstart}`,
    config.deployEnv,
    config.llmModel,
    requestId,
  );

  // Latency-aware GPU type ordering: deprioritise types where ALL known hosts exceed threshold.
  const maxLatencyMs = getLatencyMaxMs();
  if (maxLatencyMs > 0 && gpuTypes.length > 1) {
    const sorted = await sortGpuTypesByLatency(gpuTypes, maxLatencyMs);
    if (sorted.join(',') !== gpuTypes.join(',')) {
      log.log(`[gpu] Latency filter (threshold=${maxLatencyMs}ms): ${gpuTypes.join(', ')} → ${sorted.join(', ')}`);
    }
    gpuTypes = sorted;
  }

  // Auto-swap Docker image to Blackwell variant when a Blackwell GPU is selected
  const resolvedDockerImage = resolveDockerImageForGpus(dockerImage, gpuTypes);

  // Validate GPU types against cached provider inventory
  if (gpuTypes.length > 0) {
    const gpuTypeError = await validateGpuTypesFromCache(gpuTypes);
    if (gpuTypeError) {
      log.warn(`[req=${requestId}] GPU type validation warning: ${gpuTypeError}`);
    }
  }

  // Clean up the tracked instance plus gateway-owned strays to prevent orphans
  const oldPodId = deployState.podId;
  stopGpuMonitoring();
  updateActivePipeline({ gpuEndpoint: undefined }, 'handleGpuDeploy:cleanup');
  try {
    if (apiKey) {
      await cleanupAllPods(apiKey, oldPodId ? [oldPodId] : []);
    }
    if (vastApiKey) {
      await cleanupVastInstances(vastApiKey, oldPodId ? [oldPodId] : []);
    }
    if (tensordockOpts) {
      await cleanupTensordockInstances(tensordockOpts.apiKey, tensordockOpts.authId);
    }
    if (modalApiKey) {
      await cleanupModalApps(modalApiKey);
    }
    if (hyperstackApiKey) {
      await cleanupHyperstackInstances(hyperstackApiKey);
    }
  } catch (cleanupErr) {
    const deployErr = categorizeDeployError(cleanupErr, {
      deployId: deployState.deployId,
      provider: 'cleanup',
    });
    errorSummary.record(deployErr, deployState.deployId);
    log.error({ code: deployErr.code, category: deployErr.category }, `Pre-deploy cleanup failed: ${deployErr.message} — proceeding with deploy but orphaned instances may exist`);
    // Don't fail the deploy, but warn the user
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
    log.log(`[gpu] deploy sort=latency → ${gpuTypes.map(g => `${g.replace('NVIDIA ','').replace('GeForce ','')}(${getLatMs(g) === Infinity ? '?' : getLatMs(g) + 'ms'})`).join(', ')}`);
  } else if (sortBy === 'price') {
    // Price sorting is handled inside autoSelectCheapestGpu / provider clients — nothing to reorder here.
  }
  // balanced: keep existing order (user priority list already incorporates reputation/latency balance)

  // Estimate cost by querying cheapest offer matching the selected GPU types
  let estimatedCostPerHr: number | undefined;
  try {
    const allOffers: GpuOffer[] = [];
    await Promise.allSettled(
      tiers.map(async (tier) => {
        if (!tier.client.listOffers) return;
        const offers = await Promise.race([
          tier.client.listOffers(
            { region, limit: 20 },
            { apiKey: tier.apiKey, authId: tier.authId },
          ),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 10_000)),
        ]);
        allOffers.push(...offers);
      }),
    );
    const matchingOffers = allOffers.filter(o =>
      o.pricePerHr > 0 && o.available !== 0 &&
      (gpuTypes.length === 0 || gpuTypes.includes(o.gpuType)),
    );
    if (matchingOffers.length > 0) {
      estimatedCostPerHr = Math.min(...matchingOffers.map(o => o.pricePerHr));
    }
  } catch { /* cost estimate is best-effort */ }

  return {
    tiers, gpuTypes, resolvedDockerImage, gpuPriorityByProvider,
    balanceWarnings: balanceExcluded,
    estimatedCostPerHr,
    totalBalance: totalBalance > 0 ? totalBalance : undefined,
  };
}

// ── Deploy kickoff: launch the deploy promise and send HTTP response ──────────

// ── Idempotency guard for rapid double-deploys ─────────────────────────────

let lastDeployRequest: { hash: string; deployId: string; ts: number } | null = null;
let finetuneDeployActive = false;

/**
 * Start the async deploy, set up the deploy promise, and write the 202 response.
 */
/** Generate a unique deploy ID: deploy-{base36-timestamp}-{random-4-chars} */
function generateDeployId(): string {
  return `deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Start an asynchronous GPU deployment and write a 202 response immediately.
 *
 * Takes ownership of the deploy lock (released in the deploy promise's `.finally()`).
 * Launches either a hedged race deploy (raceCount > 1) or a tiered cascade deploy.
 * The deploy runs in the background; callers should poll `/v1/gpu/status` for progress.
 *
 * @param config - Validated deployment configuration from `_validateDeployRequest`
 * @param tierResult - Selected deployment tiers, GPU types, and resolved Docker image
 * @param requestId - Unique request identifier for tracing
 * @param res - HTTP response object; sent a 202 with deployId and status
 */
function _startDeployAndRespond(
  config: DeployConfig,
  tierResult: TierSelectionResult,
  requestId: string,
  res: ServerResponse,
  isFinetune = false,
): void {
  const { raceCount, region, storageGb, hfToken, deployEnv, interruptible, dockerStartCmd, onstart, containerDiskInGb, volumeId, templateHashId, forceSshTunnel, useSnapgpu, autoSnapshot, snapgpuPreloadApp, snapgpuBackend, maxCostUsd, canary, canaryInitialTraffic, canaryMaxErrorRate, canaryTrafficStep, label, strictFastBoot, allowUnverified, noTierCascade, minInetDownMbps } = config;
  const { tiers, gpuTypes, resolvedDockerImage, gpuPriorityByProvider } = tierResult;

  // Reset cancel flag FIRST so setDeployState won't be blocked by the guard
  setDeployCancelled(false);

  // Generate a unique deploy ID for tracking this deploy through its lifecycle
  const deployId = generateDeployId();
  // Record for idempotency — subsequent identical requests within 5s return this deployId
  lastDeployRequest = { hash: JSON.stringify({ dockerImage: tierResult.resolvedDockerImage, gpuTypes: tierResult.gpuTypes }), deployId, ts: Date.now() };
  // Clear stale SSH fields from previous deploy so poll loops don't exit early on old host:port
  setDeployState({ deployId, devMode: config.devMode === true, sshHost: '', sshPort: 0, podId: '' });
  try {
    deploymentSM.startDeploying();
  } catch (smErr) {
    const deployErr = categorizeDeployError(smErr, {
      deployId: deployState.deployId,
    });
    errorSummary.record(deployErr, deployState.deployId);
    log.error({ code: deployErr.code, category: deployErr.category }, `State machine error: ${deployErr.message}`);
    setDeployLock(false);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Internal server error', type: 'server_error' } }));
    return;
  }

  const extra = {
    region, storageGb, hfToken, env: Object.keys(deployEnv).length > 0 ? deployEnv : undefined, interruptible,
    ...(dockerStartCmd ? { dockerStartCmd } : {}),
    ...(onstart ? { onstart } : {}),
    ...(containerDiskInGb > 0 ? { containerDiskInGb } : {}),
    ...(volumeId ? { volumeId } : {}),
    ...(templateHashId ? { templateHashId } : {}),
    ...(forceSshTunnel ? { forceSshTunnel } : {}),
    // Propagate label + strictFastBoot to the provider client. The Vast
    // client uses `label` for the instance label (orphan reconciliation)
    // and `strictFastBoot` to bump the host-quality threshold + suppress
    // the SSH-only-host phase-2 fallback.
    ...(label ? { label } : {}),
    ...(strictFastBoot ? { strictFastBoot } : {}),
    ...(allowUnverified ? { allowUnverified } : {}),
    ...(minInetDownMbps > 0 ? { minInetDownMbps } : {}),
    ...(config.expectedApiPaths.length > 0 ? { expectedApiPaths: config.expectedApiPaths } : {}),
    ...(config.expectedCapabilities.length > 0 ? { expectedCapabilities: config.expectedCapabilities } : {}),
    ...(config.requireDockerManifest ? { requireDockerManifest: true } : {}),
    runSmokeTests: config.runSmokeTests,
    ...(useSnapgpu ? { snapgpuPreloadApp, snapgpuAutoSnapshot: autoSnapshot, snapgpuBackend } : {}),
    ...(canary ? { canary, canaryInitialTraffic, canaryMaxErrorRate, canaryTrafficStep } : {}),
    // Cost-control flags propagated to deploy loop / cascade.
    raceCount,
    ...(noTierCascade ? { noTierCascade } : {}),
  };

  const deployFn = raceCount > 1
    ? startDeployRace(tiers, resolvedDockerImage, gpuTypes, extra, raceCount)
    : startDeployWithTiers(tiers, resolvedDockerImage, gpuTypes, extra, gpuPriorityByProvider);
  setDeployPromise(
    deployFn
      .catch(err => {
        const deployErr = categorizeDeployError(err, {
          deployId: deployState.deployId,
          provider: tiers[0]?.name,
          gpuType: gpuTypes[0],
          imageName: resolvedDockerImage,
        });
        errorSummary.record(deployErr, deployState.deployId);
        log.error(`[gpu] Deploy failed unexpectedly: ${deployErr.message}`);
        setDeployState({ status: 'error', message: `Deploy failed: ${deployErr.message}` });
      })
      .finally(() => { setDeployLock(false); setDeployPromise(null); if (isFinetune) finetuneDeployActive = false; })
  );

  const modeLabel = raceCount > 1 ? `race×${raceCount}` : `${tiers.length} tier(s): ${tiers.map(t => t.label).join(' → ')}`;
  log.log(`[req=${requestId}] GPU deploy started: ${modeLabel}`);
  res.writeHead(202, { 'Content-Type': 'application/json' });
  const responseBody: Record<string, unknown> = { deployId, status: 'creating', message: `Deploy started (${modeLabel})` };
  if (tierResult.balanceWarnings.length > 0) {
    responseBody.balanceWarnings = tierResult.balanceWarnings.map(p =>
      `${p} excluded — balance below $${LOW_BALANCE_THRESHOLD_USD}`
    );
    log.warn(`[req=${requestId}] Deploy balance warnings: ${tierResult.balanceWarnings.join(', ')} excluded (low balance)`);
  }

  // Pre-deploy cost warning: include estimated cost and max runtime in response
  if (tierResult.estimatedCostPerHr) {
    responseBody.estimatedCostPerHr = Math.round(tierResult.estimatedCostPerHr * 1000) / 1000;
    if (tierResult.totalBalance) {
      const maxRuntimeHours = Math.round((tierResult.totalBalance / tierResult.estimatedCostPerHr) * 10) / 10;
      responseBody.maxRuntimeHours = maxRuntimeHours;
      responseBody.costEstimate = `This deploy will cost approximately $${tierResult.estimatedCostPerHr.toFixed(2)}/hr. With your $${tierResult.totalBalance.toFixed(2)} balance, maximum runtime is ${maxRuntimeHours} hours.`;
      // Warn if balance covers less than 2 hours of runtime
      if (tierResult.totalBalance < 2 * tierResult.estimatedCostPerHr) {
        responseBody.balanceWarning = `Low balance warning: $${tierResult.totalBalance.toFixed(2)} covers less than 2 hours at $${tierResult.estimatedCostPerHr.toFixed(2)}/hr. Add funds to avoid auto-termination.`;
        log.warn(`[req=${requestId}] Balance warning: $${tierResult.totalBalance.toFixed(2)} < 2 * $${tierResult.estimatedCostPerHr.toFixed(2)}/hr`);
      }
    }
  }

  // Include cost cap in response if set
  if (maxCostUsd !== undefined) {
    responseBody.maxCostUsd = maxCostUsd;
  }

  res.end(JSON.stringify(responseBody));
}

// ── Main deploy handler (orchestrator) ───────────────────────────────────────

/**
 * Handle POST /v1/gpu/deploy — create a new GPU deployment.
 *
 * Validates the request body, selects deployment tiers based on provider
 * balances and GPU availability, runs pre-flight checks, and starts the
 * async deployment loop. Returns 202 immediately; poll `/v1/gpu/status`
 * for progress.
 *
 * Supports idempotent retries (identical request within 5s returns existing
 * deployId) and cancel-and-redeploy when a deploy is already in progress.
 *
 * @param req - Incoming HTTP request with JSON body containing deploy params
 * @param res - Outgoing HTTP response; returns 202 with deployId on success
 * @returns Promise<void>
 * @throws {Error} With { status, message } on validation failure
 *
 * @example
 * ```bash
 * POST /v1/gpu/deploy
 * { "dockerImage": "my-image:latest", "gpuTypes": ["RTX 4090"] }
 * ```
 */
export async function handleGpuDeploy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  // Read body once upfront — consumed stream cannot be re-read
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  // Per-app isolation: when the caller authenticated with a per-app key
  // (resolved by the auth wrapper into x-aigw-user-id), automatically
  // namespace the label so list/terminate can scope by ownership without
  // the caller having to remember the convention. Skip if the label
  // already contains "/" (caller knows what they're doing) or the call is
  // unauthenticated (loopback admin).
  const callerUserId = readUserIdHeader(req.headers as Record<string, string | string[] | undefined>);
  if (callerUserId && typeof body.label === 'string' && body.label.length > 0 && !body.label.includes('/')) {
    body.label = `${callerUserId}/${body.label}`;
  }

  const readinessProbe: 'health' | 'ssh' = body.readinessProbe === 'ssh' ? 'ssh' : 'health';

  // Lock out autoscaler redeploys immediately when a finetune deploy arrives.
  // Setting this BEFORE the cancel-and-redeploy block prevents the autoscaler's
  // watchdog from winning the race during the multi-second validation/preflight.
  const isFinetuneDeploy = body.finetune === true;
  if (isFinetuneDeploy) finetuneDeployActive = true;

  // ── Idempotency: prevent double-deploy when user clicks twice rapidly ──
  const requestHash = JSON.stringify({ dockerImage: body.dockerImage, gpuTypes: body.gpuTypes });
  if (lastDeployRequest && lastDeployRequest.hash === requestHash && Date.now() - lastDeployRequest.ts < 5000) {
    log.log(`[req=${requestId}] Idempotent deploy — returning existing deployId=${lastDeployRequest.deployId}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deployId: lastDeployRequest.deployId, status: 'creating', message: 'Deploy already in progress (idempotent)', idempotent: true }));
    return;
  }

  // If a deploy is already in progress (creating/booting/installing), cancel it first for redeploy
  if (deployState.status !== 'idle' && deployState.status !== 'stopped' && deployState.status !== 'error' && deployState.status !== 'ready') {
    // Protect finetune deploys from being cancelled by unrelated callers (e.g. autoscaler)
    if (finetuneDeployActive && body.finetune !== true) {
      log.log(`[req=${requestId}] Rejecting deploy — finetune deploy in progress (protected)`);
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Finetune deploy in progress — cannot cancel', status: deployState.status }));
      return;
    }
    log.log(`[req=${requestId}] Cancelling in-progress deploy (status=${deployState.status}) for redeploy`);
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
      log.log(`[req=${requestId}] Deploy still in-flight after 10s wait (status=${deployState.status}) — releasing lock after cancel`);
      setDeployCancelled(true);
    }
    setDeployLock(false);
  }

  // If GPU is ready, stop monitoring and reset for new deploy
  if (deployState.status === 'ready') {
    if (finetuneDeployActive && body.finetune !== true) {
      log.log(`[req=${requestId}] Rejecting deploy — finetune deploy ready (protected)`);
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Finetune deploy in progress — cannot cancel', status: deployState.status }));
      return;
    }
    log.log(`[req=${requestId}] GPU was ready — tearing down for redeploy`);
    stopGpuMonitoring();
    updateActivePipeline({ gpuEndpoint: undefined }, 'handleGpuDeploy:redeploy');
    setDeployLock(false);
  }

  // SAFETY: check-then-set is atomic here because JS is single-threaded and there
  // is no `await` between the check and the set. No other code can interleave.
  // Do NOT insert any async operation between these two lines.
  if (deployLock) {
    log.log(`[req=${requestId}] GPU deploy rejected: lock held`);
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

    // Step 2.5: Per-deploy cost cap — reject if estimated hourly cost exceeds maxCostUsd
    if (config.maxCostUsd !== undefined && tierResult.estimatedCostPerHr) {
      if (tierResult.estimatedCostPerHr > config.maxCostUsd) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: `Estimated cost ($${tierResult.estimatedCostPerHr.toFixed(2)}/hr) exceeds your maxCostUsd ($${config.maxCostUsd.toFixed(2)})`,
            type: 'cost_cap_exceeded',
          },
          estimatedCostPerHr: tierResult.estimatedCostPerHr,
          maxCostUsd: config.maxCostUsd,
        }));
        return;
      }
    }

    // Step 2.6: Run pre-flight checks (image, DNS, CUDA, cost, template)
    const preflightResult = await runPreFlightChecks({
      imageName: config.dockerImage,
      provider: tierResult.tiers[0]?.name || 'vast',
      apiKey: config.vastApiKey || process.env.VAST_API_KEY || '',
      gpuTypes: config.gpuTypes,
      quotedPricePerHr: tierResult.estimatedCostPerHr,
      dockerhubUser: process.env.DOCKERHUB_USERNAME,
      dockerhubToken: process.env.DOCKERHUB_TOKEN,
      templateId: config.templateHashId,
    });

    if (!preflightResult.ok) {
      log.error(`[req=${requestId}] Pre-flight checks FAILED:`, preflightResult.errors);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: `Deploy aborted — pre-flight checks failed:\n${preflightResult.errors.join('\n')}`,
          type: 'preflight_error',
        },
        checks: preflightResult.checks,
        warnings: preflightResult.warnings,
      }));
      return;
    }

    // Log warnings (non-blocking)
    if (preflightResult.warnings.length > 0) {
      log.warn(`[req=${requestId}] Pre-flight warnings:`, preflightResult.warnings);
      config.deployEnv._PREFLIGHT_WARNINGS = JSON.stringify(preflightResult.warnings);
    }

    // Step 3: Start the deploy and send the 202 response.
    // _startDeployAndRespond takes ownership of the lock (released in .finally()).
    lockTransferred = true;
    setDeployState({ readinessProbe });
    _startDeployAndRespond(config, tierResult, requestId, res, isFinetuneDeploy);
  } finally {
    if (!lockTransferred) {
      setDeployLock(false);
      // finetuneDeployActive was set early; clear it if deploy didn't actually start
      if (isFinetuneDeploy) finetuneDeployActive = false;
    }
  }
}

/**
 * Auto-boot GPU from the active profile's gpuDeploy config.
 * Called at gateway startup when the active profile has bootOnStartup: true.
 * Fires-and-forgets: deploy runs in background, gateway starts regardless.
 */
export async function autoBootFromProfile(): Promise<void> {
  const cfg = await loadProviderConfig();
  const activeApp = cfg.apps?.find(p => p.id === cfg.activeAppId);
  if (!activeApp?.gpuDeploy?.bootOnStartup) return;
  if (deployState.status !== 'idle') {
    log.log('[gpu] autoBootFromProfile: deploy already in progress, skipping');
    return;
  }
  if (deployLock) {
    log.log('[gpu] autoBootFromProfile: deploy lock held, skipping');
    return;
  }

  const gd = activeApp.gpuDeploy;
  log.log(`[gpu] Auto-booting GPU for app: ${activeApp.name} (${gd.dockerImage})`);
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
          log.log(`[gpu] autoBootFromProfile: ${j.status} — ${j.message}`);
        } catch { /* best-effort: cleanup or optional side-effect */ }
      },
    } as unknown as ServerResponse;

    lockTransferred = true;
    _startDeployAndRespond(config, tierResult, requestId, stubRes);
  } catch (err: unknown) {
    const msg = (err as { message?: string })?.message ?? String(err);
    log.warn(`[gpu] autoBootFromProfile failed: ${msg}`);
  } finally {
    if (!lockTransferred) setDeployLock(false);
  }
}

// ── GPU lifecycle handlers (stop/resume/terminate) ────────────────────────────

/**
 * Handle POST /v1/gpu/terminate — permanently destroy the active GPU deployment.
 *
 * Terminates the tracked instance plus gateway-owned strays across configured
 * providers to prevent orphaned resources from accruing cost.
 * Resets deploy state, stops monitoring, and updates the active pipeline.
 *
 * Idempotent: returns 200 if already idle with no active pod.
 * Supports deploy ID safety check to avoid terminating the wrong deployment.
 *
 * @param req - Incoming HTTP request; optional JSON body with { deployId, apiKey, ... }
 * @param res - Outgoing HTTP response; returns 200 with { ok, deployId }
 * @returns Promise<void>
 *
 * @example
 * ```bash
 * POST /v1/gpu/terminate
 * { "deployId": "deploy-abc123" }
 * ```
 */
/**
 * Resolve the owner (per-app userId) of a provider instance from its label.
 * Convention: labels are formatted "<owner>/<task>" — see the deploy
 * handler's namespacing path. Used by the terminate ownership guard.
 *
 * Returns:
 *   { found: false }                       — instance not visible to us
 *   { found: true, owner: undefined }      — visible but label not namespaced
 *   { found: true, owner: 'foo', label }   — namespaced; owner is foo
 */
async function _resolveInstanceOwner(
  instanceId: string,
  body: Record<string, unknown>,
): Promise<{ found: boolean; owner?: string; label?: string }> {
  const vastKey = deployVastApiKey || (body.vastApiKey as string) || process.env.VAST_API_KEY || '';
  const tdKey = deployTensordockApiKey || (body.tensordockApiKey as string) || process.env.TENSORDOCK_API_KEY || '';
  const tdAuthId = deployTensordockAuthId || (body.tensordockAuthId as string) || process.env.TENSORDOCK_AUTH_ID || '';
  const rpKey = deployApiKey || (body.apiKey as string) || process.env.RUNPOD_API_KEY || '';
  const modalTokenId = (body.modalTokenId as string) || process.env.MODAL_TOKEN_ID || '';
  const modalTokenSecret = (body.modalTokenSecret as string) || process.env.MODAL_TOKEN_SECRET || '';
  const modalKey = deployModalApiKey || (modalTokenId && modalTokenSecret ? `${modalTokenId}:${modalTokenSecret}` : '');
  const hyperstackKey = deployHyperstackApiKey || (body.hyperstackApiKey as string) || process.env.HYPERSTACK_API_KEY || '';

  const probes: Promise<{ instanceName?: string } | null>[] = [];
  if (vastKey)       probes.push(vast.listInstances({ apiKey: vastKey }).then(arr => arr.find(i => i.instanceId === instanceId) || null).catch(() => null));
  if (rpKey)         probes.push(runpod.listInstances({ apiKey: rpKey }).then(arr => arr.find(i => i.instanceId === instanceId) || null).catch(() => null));
  if (tdKey)         probes.push(tensordock.listInstances({ apiKey: tdKey, authId: tdAuthId }).then(arr => arr.find(i => i.instanceId === instanceId) || null).catch(() => null));
  if (modalKey)      probes.push(modal.listInstances({ apiKey: modalKey }).then(arr => arr.find(i => i.instanceId === instanceId) || null).catch(() => null));
  if (hyperstackKey) probes.push(hyperstack.listInstances({ apiKey: hyperstackKey }).then(arr => arr.find(i => i.instanceId === instanceId) || null).catch(() => null));

  const results = await Promise.all(probes);
  const hit = results.find(r => r !== null);
  if (!hit) return { found: false };

  const label = hit.instanceName || '';
  if (!label.includes('/')) return { found: true, label };

  const owner = label.split('/', 1)[0];
  return { found: true, owner, label };
}

export async function handleGpuTerminate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);
  log.log(`GPU terminate requested`);

  // Acquire lock to prevent concurrent lifecycle operations
  if (deployLock) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Deploy lock held — try again in a moment', status: deployState.status }));
    return;
  }
  setDeployLock(true);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); setDeployLock(false); return; }

  // Per-app isolation: when caller authenticated as a per-app key, refuse
  // to terminate an instance whose label-owner doesn't match. Looks up the
  // instance via the providers' listInstances() (same path as /v1/gpu/list).
  // Loopback / unauthenticated callers (callerUserId === null) are admin
  // and bypass the check.
  const callerUserId = readUserIdHeader(req.headers as Record<string, string | string[] | undefined>);
  const targetInstanceId = typeof body.instanceId === 'string' ? body.instanceId : '';
  const force = body.force === true || body.force === '1';
  if (callerUserId && targetInstanceId && !force) {
    try {
      const ownerCheckResult = await _resolveInstanceOwner(targetInstanceId, body);
      if (ownerCheckResult.found && ownerCheckResult.owner && ownerCheckResult.owner !== callerUserId) {
        log.warn(`[req=${requestId}] terminate refused: caller=${callerUserId} != instance-owner=${ownerCheckResult.owner} (label=${ownerCheckResult.label})`);
        setDeployLock(false);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Cross-app terminate refused',
          message: `Instance ${targetInstanceId} is owned by app '${ownerCheckResult.owner}' (label="${ownerCheckResult.label}"). Caller is '${callerUserId}'. Pass {"force":true} only if you legitimately own that app.`,
          owner: ownerCheckResult.owner,
          caller: callerUserId,
        }));
        return;
      }
    } catch (err) {
      // Fail-CLOSED on resolver failure: a degraded resolver must not become
      // a cross-app terminate bypass. Caller can pass {"force":true} once they
      // confirm ownership. Previously this fell open ("legitimate cleanups
      // shouldn't strand"), but that allowed any caller who DoSed the
      // resolver path to destroy other apps' instances.
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(`[req=${requestId}] terminate ownership check failed (denying): ${errMsg}`);
      setDeployLock(false);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Ownership resolver unavailable',
        message: 'Cross-app terminate ownership check failed. Retry, or pass {"force":true} if you confirm ownership.',
        detail: errMsg.slice(0, 200),
      }));
      return;
    }
  }

  // Targeted termination — caller passed { instanceId, provider } for an
  // instance the gateway state machine doesn't track. This happens when:
  //   - race deploys leave losers behind that the race resolver failed to
  //     kill (network blip during cleanup, gateway restart mid-race),
  //   - the user manually deployed via a previous gateway process whose
  //     state was reset,
  //   - any case where `gpu list` (which queries the provider directly)
  //     shows an instance but `deployState.podId` doesn't match.
  // Without this branch the old code returned the idempotent
  // "No active deployment to terminate" 200 even though Vast.ai is still
  // billing for the orphan — exactly the leak the user just hit.
  // We only invoke this path when the requested instanceId is NOT the
  // currently-tracked one; the tracked-deploy flow below handles the
  // normal case (and additionally cleans gateway-owned strays).
  const requestedInstanceId =
    typeof body.instanceId === 'string' && body.instanceId.length > 0 && body.instanceId.length <= 200
      ? body.instanceId
      : '';
  const requestedProvider =
    typeof body.provider === 'string' && body.provider.length > 0 && body.provider.length <= 50
      ? (body.provider as ProviderName)
      : undefined;
  if (requestedInstanceId && requestedInstanceId !== deployState.podId) {
    const vastKey = deployVastApiKey || (body.vastApiKey as string) || process.env.VAST_API_KEY || '';
    const tdKey = deployTensordockApiKey || (body.tensordockApiKey as string) || process.env.TENSORDOCK_API_KEY || '';
    const tdAuthId = deployTensordockAuthId || (body.tensordockAuthId as string) || process.env.TENSORDOCK_AUTH_ID || '';
    const rpKey = deployApiKey || (body.apiKey as string) || process.env.RUNPOD_API_KEY || '';
    const modalTokenId = (body.modalTokenId as string) || process.env.MODAL_TOKEN_ID || '';
    const modalTokenSecret = (body.modalTokenSecret as string) || process.env.MODAL_TOKEN_SECRET || '';
    const modalKey = deployModalApiKey || (modalTokenId && modalTokenSecret ? `${modalTokenId}:${modalTokenSecret}` : '');
    const hyperstackKey = deployHyperstackApiKey || (body.hyperstackApiKey as string) || process.env.HYPERSTACK_API_KEY || '';

    // If provider not given, try each one we have credentials for. Vast
    // first because it's where the orphan-leak bug actually surfaces.
    const candidates: { name: ProviderName; client: GpuProviderClient; creds: ProviderCredentials }[] = [];
    if (vastKey && (!requestedProvider || requestedProvider === 'vast')) {
      candidates.push({ name: 'vast', client: vast, creds: { apiKey: vastKey } });
    }
    if (rpKey && (!requestedProvider || requestedProvider === 'runpod')) {
      candidates.push({ name: 'runpod', client: runpod, creds: { apiKey: rpKey } });
    }
    if (tdKey && (!requestedProvider || requestedProvider === 'tensordock')) {
      candidates.push({ name: 'tensordock', client: tensordock, creds: { apiKey: tdKey, authId: tdAuthId } });
    }
    if (modalKey && (!requestedProvider || requestedProvider === 'modal')) {
      candidates.push({ name: 'modal', client: modal, creds: { apiKey: modalKey } });
    }
    if (hyperstackKey && (!requestedProvider || requestedProvider === 'hyperstack')) {
      candidates.push({ name: 'hyperstack', client: hyperstack, creds: { apiKey: hyperstackKey } });
    }

    let terminatedBy: string | null = null;
    let lastErr = '';
    for (const c of candidates) {
      try {
        await c.client.deleteInstance(requestedInstanceId, c.creds);
        terminatedBy = c.name;
        log.log(`[req=${requestId}] orphan terminate: instance=${requestedInstanceId} via ${c.name}`);
        logGpuEvent('instance_terminated', c.name, true, {
          metadata: { reason: 'manual_terminate_orphan', instanceId: requestedInstanceId },
        });
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        // Try next provider — providers reject unknown instanceIds with
        // 404-style errors, which is exactly when we want to try another.
      }
    }

    setDeployLock(false);
    if (terminatedBy) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        instanceId: requestedInstanceId,
        provider: terminatedBy,
        mode: 'orphan_terminate',
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: `Instance ${requestedInstanceId} not found in any provider (tried ${candidates.map(c => c.name).join(', ') || 'none'}). Last error: ${lastErr || '(no candidates)'}`,
      }));
    }
    return;
  }

  // Idempotent: if already idle (nothing running), return 200 instead of
  // error. Reached only when the caller did NOT pass an instanceId the
  // gateway considers untracked — otherwise we already terminated above.
  if (deployState.status === 'idle' && !deployState.podId) {
    log.log(`GPU already idle — idempotent 200`);
    setDeployLock(false);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'No active deployment to terminate.', idempotent: true }));
    return;
  }

  // Deploy ID safety check: if caller provides deployId, verify it matches the active deploy
  if (body.deployId && deployState.deployId && body.deployId !== deployState.deployId) {
    setDeployLock(false);
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Deploy ID mismatch — this deploy may have been replaced', expected: deployState.deployId, received: body.deployId }));
    return;
  }

  const apiKey = body.apiKey as string;
  const vastKey = deployVastApiKey || (body.vastApiKey as string) || process.env.VAST_API_KEY || '';
  const tdKey = deployTensordockApiKey || (body.tensordockApiKey as string) || process.env.TENSORDOCK_API_KEY || '';
  const tdAuthId = deployTensordockAuthId || (body.tensordockAuthId as string) || process.env.TENSORDOCK_AUTH_ID || '';
  const modalTokenId = (body.modalTokenId as string) || process.env.MODAL_TOKEN_ID || '';
  const modalTokenSecret = (body.modalTokenSecret as string) || process.env.MODAL_TOKEN_SECRET || '';
  const modalKey = deployModalApiKey || (modalTokenId && modalTokenSecret ? `${modalTokenId}:${modalTokenSecret}` : '');
  const hyperstackKey = deployHyperstackApiKey || (body.hyperstackApiKey as string) || process.env.HYPERSTACK_API_KEY || '';

  // Capture deploy state before reset for reputation tracking and response
  const prevDeployId = deployState.deployId;
  const prevProvider = deployState.provider;
  const prevGpuType = deployState.gpuType;
  const prevMeta = { ...deployState.providerMeta };
  const prevStartedAt = deployState.startedAt;
  const prevCostPerHr = deployState.costPerHr;
  const prevPodId = deployState.podId;
  const wasReady = deployState.status === 'ready';

  try {
    stopGpuMonitoring();
    resetDeployState(); // sets deployCancelled=true, stops the deploy loop
    deploymentSM.reset();
    updateActivePipeline({ gpuEndpoint: undefined }, 'handleGpuTerminate');

    // Terminate the tracked instance plus gateway-owned strays to prevent orphans
    if (apiKey) {
      await cleanupAllPods(apiKey);
    }
    if (vastKey) {
      await cleanupVastInstances(vastKey, prevPodId ? [prevPodId] : []);
    }
    if (tdKey) {
      await cleanupTensordockInstances(tdKey, tdAuthId);
    }
    if (modalKey) {
      await cleanupModalApps(modalKey);
    }
    if (hyperstackKey) {
      await cleanupHyperstackInstances(hyperstackKey);
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
  } finally {
    setDeployLock(false);
  }
}

// ── GPU Stop (pause without destroying) ──────────────────────────────────────

/**
 * POST /v1/gpu/keepalive — Reset the idle timeout counter on the active pod
 * so the autoscaler doesn't pause/destroy it. /health probes deliberately
 * don't count as activity (they're external liveness checks); pipelines
 * that boot a pod ahead of a long offline batch can ping this every few
 * minutes to keep the pod alive without burning quota on real inferences.
 *
 * Optional body: { deployId?: string } — safety check.
 */
export async function handleGpuKeepalive(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  let body: Record<string, unknown> = {};
  try { body = await readJsonBody(req); } catch { /* empty body fine */ }

  if (body.deployId && deployState.deployId && body.deployId !== deployState.deployId) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      error: 'deployId mismatch',
      activeDeployId: deployState.deployId,
      requestedDeployId: body.deployId,
    }));
    return;
  }

  if (deployState.status !== 'ready') {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      error: 'no active GPU pod',
      status: deployState.status,
    }));
    return;
  }

  const { setLastModelRequestTime } = await import('./state');
  const now = Date.now();
  setLastModelRequestTime(now);
  log.log(`[req=${requestId}] keepalive — idle counter reset`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    deployId: deployState.deployId,
    podId: deployState.podId,
    lastActivityAt: now,
  }));
}

/**
 * POST /v1/gpu/stop — Stop (pause) the current GPU pod without destroying it.
 * The pod can be resumed later with POST /v1/gpu/resume.
 * Disk/data is preserved. No hourly charges while stopped.
 */
export async function handleGpuStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);
  log.log(`[req=${requestId}] GPU stop (pause) requested`);

  // Read optional body for deployId safety check
  let body: Record<string, unknown> = {};
  try { body = await readJsonBody(req); } catch { /* empty body is fine */ }

  // Deploy ID safety check: if caller provides deployId, verify it matches the active deploy
  if (body.deployId && deployState.deployId && body.deployId !== deployState.deployId) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Deploy ID mismatch — this deploy may have been replaced', expected: deployState.deployId, received: body.deployId }));
    return;
  }

  // Idempotent: if already stopped or idle, return 200 instead of error
  if (deployState.status === 'stopped') {
    log.log(`[req=${requestId}] GPU already stopped — idempotent 200`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deployId: deployState.deployId || undefined, podId: deployState.podId, provider: deployState.provider, message: 'Pod already stopped.', idempotent: true }));
    return;
  }
  if (deployState.status === 'idle') {
    log.log(`[req=${requestId}] GPU idle (nothing to stop) — idempotent 200`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'No active pod (idle).', idempotent: true }));
    return;
  }

  // Cancel any in-progress deploy/race so background tasks don't overwrite the stopped state
  if (deployState.status === 'creating' || deployState.status === 'booting' || deployState.status === 'installing') {
    log.log(`[req=${requestId}] Deploy in progress (${deployState.status}) — cancelling before stop`);
    setDeployCancelled(true);
  }

  if (!deployState.podId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No active pod to stop' }));
    setDeployLock(false);
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
  } else if (provider === 'hyperstack' && (deployHyperstackApiKey || process.env.HYPERSTACK_API_KEY)) {
    client = hyperstack;
    credentials = { apiKey: deployHyperstackApiKey || process.env.HYPERSTACK_API_KEY || '' };
  }

  if (!client) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Cannot stop: no credentials for provider "${provider}"` }));
    return;
  }

  try {
    // Optional opt-in: { hibernate: true } triggers Hyperstack hibernate instead
    // of a plain stop (billing drops to ~10–15% on hyperstack). Other providers
    // always fall back to stopInstance.
    const allowHibernate = body.hibernate === true;
    const pausedMode = await pauseInstanceForIdle(provider, podId, credentials, client, { allowHibernate });
    stopGpuMonitoring();
    updateActivePipeline({ gpuEndpoint: undefined }, 'handleGpuStop');
    // Transition to 'stopped' — preserves pod info for fast resume
    const gpuType = deployState.gpuType;
    const costPerHr = deployState.costPerHr;
    const dockerImage = deployState.dockerImage;
    deploymentSM.markStopped(podId, provider, gpuType, costPerHr, dockerImage);
    const stopMsg = pausedMode === 'hibernate'
      ? `Pod ${podId} hibernated (billing paused). Use POST /v1/gpu/resume to restart.`
      : `Pod ${podId} stopped (paused). Use POST /v1/gpu/resume to restart.`;
    setDeployState({
      status: 'stopped',
      message: stopMsg,
      podId,
      provider,
      pausedMode,
    });

    log.log(`[req=${requestId}] Pod ${podId} ${pausedMode === 'hibernate' ? 'hibernated' : 'stopped'} on ${provider} (was ${prevStatus})`);
    logGpuEvent(
      pausedMode === 'hibernate' ? 'instance_hibernated' : 'instance_stopped',
      'manual',
      true,
      { metadata: { reason: 'manual_stop', provider, pausedMode } },
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      deployId: deployState.deployId || undefined,
      podId,
      provider,
      pausedMode,
      message: pausedMode === 'hibernate'
        ? 'Pod hibernated (billing paused). Data preserved. Use /v1/gpu/resume to restart.'
        : 'Pod stopped (paused). Data preserved. Use /v1/gpu/resume to restart.',
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[req=${requestId}] GPU stop failed: ${msg}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Stop failed: ${msg}` }));
  } finally {
    setDeployLock(false);
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
  log.log(`[req=${requestId}] GPU resume requested`);

  if (deployLock) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Deploy lock held — try again in a moment', status: deployState.status }));
    return;
  }
  setDeployLock(true);

  let body: Record<string, unknown> = {};
  try { body = await readJsonBody(req); }
  catch { /* empty body is fine */ }

  // Deploy ID safety check: if caller provides deployId, verify it matches the active deploy
  if (body.deployId && deployState.deployId && body.deployId !== deployState.deployId) {
    setDeployLock(false);
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Deploy ID mismatch — this deploy may have been replaced', expected: deployState.deployId, received: body.deployId }));
    return;
  }

  // Allow explicit podId/provider override from body (backward compat) with validation
  if (body.podId && typeof body.podId === 'string' && body.podId.length > 0 && body.podId.length <= 200) {
    setDeployState({ podId: body.podId, ...(body.provider ? { provider: body.provider as ProviderName } : {}) });
  }
  if (body.provider && typeof body.provider === 'string' && body.provider.length > 0 && body.provider.length <= 50 && !body.podId) {
    setDeployState({ provider: body.provider as ProviderName });
  }

  if (!deployState.podId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No pod to resume. Provide { podId } or stop a pod first.' }));
    setDeployLock(false);
    return;
  }

  try {
    // resumeOrDeploy: tries resume first, falls back to fresh deploy if
    // the host was reclaimed / pod was GC'd / any other error.
    const result = await resumeOrDeploy({ reason: 'manual', requestId });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      deployId: deployState.deployId || undefined,
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
    log.error(`[req=${requestId}] GPU resume + fallback deploy failed: ${msg}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Resume and fallback deploy both failed: ${msg}` }));
  } finally {
    setDeployLock(false);
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

type SnapshotIdBody = { id?: string; snapshotId?: string; snapshot_id?: string };

async function resolveSnapshotId(req: IncomingMessage, action: 'restore' | 'delete'): Promise<string> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathParts = url.pathname.split('/').filter(Boolean);
  let snapshotId = '';

  if (action === 'restore' && pathParts.at(-1) === 'restore') {
    const candidate = pathParts.at(-2);
    if (candidate && candidate !== 'snapshot') snapshotId = candidate;
  } else if (action === 'delete') {
    const candidate = pathParts.at(-1);
    if (candidate && candidate !== 'snapshot') snapshotId = candidate;
  }

  snapshotId ||= url.searchParams.get('snapshotId')
    || url.searchParams.get('snapshot_id')
    || url.searchParams.get('id')
    || '';

  if (!snapshotId) {
    try {
      const body = await readJsonBody(req) as SnapshotIdBody;
      snapshotId = body.snapshotId || body.snapshot_id || body.id || '';
    } catch {
      // Body is optional for dynamic snapshot routes.
    }
  }

  return snapshotId.trim();
}

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
  const snapshotId = await resolveSnapshotId(req, 'restore');
  if (!snapshotId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing snapshot_id in URL, query, or body' }));
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
  const snapshotId = await resolveSnapshotId(req, 'delete');
  if (!snapshotId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing snapshot_id in URL, query, or body' }));
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

/**
 * Live SSH forensics on the current GPU instance. Spawns ssh to the
 * deployed instance's sshHost:sshPort and runs a battery of diagnostic
 * commands. Returns the combined output as plain text. Useful when a
 * deploy is stuck in "booting" / "waiting_health" and you want to see
 * what's actually going on inside the container.
 *
 * Requires the deploy to be in 'creating', 'booting', or 'ready' state
 * with sshHost/sshPort populated.
 */
export async function handleGpuInspect(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!deployState.sshHost || !deployState.sshPort) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No active deploy with SSH host', state: deployState.status }));
    return;
  }

  const { spawn } = await import('child_process');
  const sshHost = deployState.sshHost;
  const sshPort = deployState.sshPort;

  // The remote command is intentionally a single multi-line bash here-doc
  // executed via SSH. We pull EVERYTHING the operator might need in one
  // round-trip: process state, ports, the raw /var/log/app.log tail, the
  // FastAPI /health + /diag + /logs endpoints (which carry the full
  // model-load traceback when it failed), HF cache size, and dmesg.
  // Each section is bracketed by '===== ' so the output is grep-friendly.
  const cmd = `
echo '===== STATUS ====='
date
uptime
echo
echo '===== PORTS LISTENING ====='
ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo 'no ss/netstat'
echo
echo '===== PROCESSES ====='
ps auxf | head -50
echo
echo '===== PYTHON / SERVER ====='
ps aux | grep -E 'python|server\\.py|uvicorn' | grep -v grep
echo
echo '===== SSHD ====='
ps aux | grep sshd | grep -v grep
echo
echo '===== APP LOG (last 300 lines) ====='
tail -300 /var/log/app.log 2>/dev/null || echo 'NO /var/log/app.log'
echo
echo '===== DOCKER ENV ====='
env | grep -iE 'pytorch|cuda|hf_|trellis|public_key' | head -20
echo
echo '===== HF CACHE ====='
du -sh /root/.cache/huggingface/ 2>/dev/null || echo 'no hf cache'
ls /root/.cache/huggingface/hub/ 2>/dev/null | head -5
echo
echo '===== /APP CONTENTS ====='
ls -la /app/ 2>/dev/null
echo
echo '===== HEALTH FROM INSIDE ====='
curl -sf --max-time 5 http://localhost:8000/health 2>&1 || echo 'localhost:8000 /health failed'
echo
echo '===== DIAG FROM INSIDE ====='
curl -sf --max-time 10 http://localhost:8000/diag 2>&1 || echo 'localhost:8000 /diag failed'
echo
echo '===== /LOGS ENDPOINT (last 500 lines from FastAPI) ====='
curl -sf --max-time 10 'http://localhost:8000/logs?lines=500' 2>&1 || echo 'localhost:8000 /logs failed'
echo
echo '===== DMESG (kernel — OOM check) ====='
dmesg 2>/dev/null | tail -20 || echo 'no dmesg access'
echo
echo '===== DISK ====='
df -h / 2>&1
`;

  const result: string[] = [];
  const sshProc = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
    '-o', 'LogLevel=ERROR',
    '-p', String(sshPort),
    `root@${sshHost}`,
    cmd,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  sshProc.stdout.on('data', (chunk) => result.push(chunk.toString()));
  sshProc.stderr.on('data', (chunk) => result.push(`STDERR: ${chunk.toString()}`));

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try { sshProc.kill('SIGKILL'); } catch { /* best-effort: cleanup or optional side-effect */ }
      result.push('\nTIMEOUT after 30s\n');
      resolve();
    }, 30_000);
    sshProc.on('exit', (code) => {
      clearTimeout(timer);
      result.push(`\n--- ssh exited with code ${code} ---\n`);
      resolve();
    });
    sshProc.on('error', (err) => {
      clearTimeout(timer);
      result.push(`\nERROR: ${err.message}\n`);
      resolve();
    });
  });

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(result.join(''));
}

// ── Deploy history (persisted failure diagnostics) ───────────────────────────

/**
 * GET /v1/gpu/deploy-history — list past deploy attempts (newest first).
 * Returns lightweight summaries; use the per-id endpoint for full bundles.
 */
export async function handleGpuDeployHistory(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { listDeployDiagnostics, getDeployDiagnostics } = await import('./deploy-diagnostics');
  // Per-id fetch lives at the same URL with ?id=... so we don't need a
  // separate route handler. Path-based routing in this codebase is flat,
  // and ?id keeps it parseable by any HTTP client.
  const url = new URL(req.url || '/', 'http://localhost');
  const id = url.searchParams.get('id');
  if (id) {
    const record = getDeployDiagnostics(id);
    if (!record) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `deploy diagnostic ${id} not found` }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(record, null, 2));
    return;
  }
  const limit = Number(url.searchParams.get('limit') || '50');
  const summaries = listDeployDiagnostics(Math.min(Math.max(limit, 1), 500));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ count: summaries.length, items: summaries }, null, 2));
}

/**
 * POST /v1/gpu/deploy/validate — validate a deploy request without creating an instance.
 *
 * This endpoint is intentionally dry-run only: it validates the Docker image
 * reference, expected API contract, credentials shape, and registry preflight
 * checks without selecting/cleaning provider instances.
 */
export async function handleGpuDeployValidate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  const callerUserId = readUserIdHeader(req.headers as Record<string, string | string[] | undefined>);
  if (callerUserId && typeof body.label === 'string' && body.label.length > 0 && !body.label.includes('/')) {
    body.label = `${callerUserId}/${body.label}`;
  }

  let config: DeployConfig;
  try {
    config = await _validateDeployRequest(body, requestId);
  } catch (err: unknown) {
    const status = (err as any)?.status ?? 400;
    const message = (err as any)?.message ?? String(err);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { message, type: 'validation_error' } }));
    return;
  }

  const provider = config.providerFilter || 'vast';
  const preflight = await runPreFlightChecks({
    imageName: config.dockerImage,
    provider,
    apiKey: config.vastApiKey || config.apiKey || config.hyperstackApiKey || process.env.VAST_API_KEY || '',
    gpuTypes: config.gpuTypes,
    dockerhubUser: process.env.DOCKERHUB_USERNAME,
    dockerhubToken: process.env.DOCKERHUB_TOKEN,
    templateId: config.templateHashId,
  });

  const glbSmokePlanned = config.runSmokeTests && (
    config.expectedCapabilities.includes('glb_generation')
    || config.expectedApiPaths.some(path => /generate(?:-from-text)?|glb/i.test(path))
  );

  const ok = preflight.ok;
  res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok,
    dryRun: true,
    dockerImage: config.dockerImage,
    provider,
    gpuTypes: config.gpuTypes,
    apiContract: {
      expectedCapabilities: config.expectedCapabilities,
      expectedApiPaths: config.expectedApiPaths,
      requireDockerManifest: config.requireDockerManifest,
      glbSmokeTestWillRunAfterBoot: glbSmokePlanned,
    },
    preflight,
  }, null, 2));
}

// ── GPU Heartbeat — external workload keepalive ─────────────────────────────

/**
 * POST /v1/gpu/heartbeat — Reset the idle timer from an external workload.
 *
 * When the GPU pod is accessed directly (not through the gateway), the idle
 * timer isn't reset because requests don't flow through ai-handlers.ts.
 * The GPU server (e.g. HybrIK) or a wrapper script can POST to this endpoint
 * to signal "I'm still in use, don't auto-stop me".
 *
 * The GPU pod just needs to know the gateway URL and optionally the API key:
 *   curl -X POST http://gateway:3017/v1/gpu/heartbeat
 *   curl -X POST http://gateway:3017/v1/gpu/heartbeat -d '{"source":"hybrik","activeRequests":1}'
 *
 * Lightweight: no body required, 200 OK with updated idle state.
 */
export async function handleGpuHeartbeat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { setLastModelRequestTime, lastModelRequestTime, deployState } = await import('./state');
  const { resetIdleState, IDLE_TIMEOUT_MS } = await import('./gpu-monitor-loop');

  // Per-app scoping: when GATEWAY_API_KEYS is configured, the caller's userId
  // must match the deploy owner. Otherwise app A's heartbeat could keep app B's
  // GPU alive indefinitely. Falls open when no multi-key registry configured
  // (single-key / loopback-admin mode).
  const callerId = (req.headers['x-aigw-user-id'] as string | undefined) || null;
  if (process.env.GATEWAY_API_KEYS && callerId) {
    const ownerId = (deployState as { userId?: string | null } | undefined)?.userId ?? null;
    if (ownerId && ownerId !== callerId) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Heartbeat denied: deploy owned by another app' }));
      return;
    }
  }

  setLastModelRequestTime(Date.now());
  resetIdleState();

  // Parse optional body for logging (fire-and-forget, never fail on bad body)
  let source = 'unknown';
  let activeRequests: number | undefined;
  try {
    const body = await readJsonBody(req);
    if (body.source) source = String(body.source);
    if (typeof body.activeRequests === 'number') activeRequests = body.activeRequests;
    if (typeof body.active_requests === 'number') activeRequests = body.active_requests;
  } catch { /* body is optional */ }

  // Sanitize against log-line injection (newlines/CR could forge entries when
  // a SIEM consumes the log stream).
  const safeSource = source.replace(/[\r\n\t]/g, ' ').slice(0, 80);

  log.log(`[gpu] Heartbeat received (source=${safeSource}${activeRequests !== undefined ? `, active=${activeRequests}` : ''}) — idle timer reset`);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    lastModelRequestAt: lastModelRequestTime,
    source: safeSource,
  }));
}

// ── Re-exports from split modules ────────────────────────────────────────────

export {
  handleGpuOffers, handleGpuOffersRanked, handleGpuTypes, handleGetGpuTypes,
  buildProviderQueries,
} from './gpu-handlers-offers';
export {
  handleGpuStatus, handleGpuList, handleHealth, handleGpuLogs, handleGpuEventLogs,
  handleGpuCatalog, handleGpuMyLocation, handleGpuReputation, handleGpuLatencyProbe,
  handlePreflightCheck, handleErrorSummary, handleErrorAlerts, handleCanaryStatus,
  handlePerformanceStats, handleGpuCompatibility,
} from './gpu-handlers-info';
export {
  handleGetLatencySettings, handlePatchLatencySettings, handleGetGpuDefaults,
  handleGetGpuReadinessHistory, handlePostResetReadiness, handleGetGpuReadinessStatus,
  handleTriggerLatencyRun, handlePatchLatencyHosts,
} from './gpu-handlers-settings';
