// ── BabelCast Gateway — Provider Config Persistence ──────────────────────────
// Persists provider configuration (apps, pipeline chains) to
// ~/.babelcast/provider-config.json so the BabelCast app can access it
// via the AI Gateway SDK.

import { createLogger } from '../src/logger';
import { homedir } from 'os';
import { join } from 'path';
import { readFile, access } from 'fs/promises';
import { mkdirSync, writeFileSync, renameSync, existsSync, readFileSync } from 'fs';
import { setIdleTimeoutMs } from './gpu-deploy';
import { setSttTargetLatencyMs, setLlmTargetLatencyMs, setTtsTargetLatencyMs, setGpuSortBy, loadDeploySettings } from '../src/gpu-providers/deploy-settings';
import type { AIProfile } from '../src/client';

/**
 * Config directory layout:
 *   ~/.babelcast/          — app config, deploy state, session data (user-facing)
 *   ~/.ai-gateway/         — autoscaler telemetry, latency probes, perf ranker (operational)
 *
 * TODO: consolidate into single ~/.ai-gateway/ directory
 */
const BABELCAST_DIR = join(homedir(), '.babelcast');
const CONFIG_FILE = join(BABELCAST_DIR, 'provider-config.json');

const log = createLogger('config-persistence');

// ── In-memory config cache (avoids sync file I/O on every pipeline request) ──
let _cachedConfig: ProviderConfig | null = null;
let _cacheTime = 0;
const CONFIG_CACHE_TTL_MS = 5_000;

export interface PipelineChainEntry {
  provider: string;
  model?: string;
  sttType?: 'streaming' | 'batch';
}

export interface GpuDeployConfig {
  dockerImage: string;
  gpuTypes: string[];
  region: string;       // '' = any, 'EU', 'US', 'FR', etc.
  timeoutMin: number;   // deploy timeout in minutes
  raceCount?: number;   // hedged deploy: launch N in parallel, keep first healthy (1 = off)
  bootOnStartup?: boolean; // auto-boot GPU when gateway starts (Groq handles requests during boot)
  /** Force the autoscaler to deploy via snapgpu (CRIU + cuda-checkpoint snapshots
   *  for fast cold starts). Snapgpu wraps the underlying provider — see snapgpuBackend. */
  useSnapgpu?: boolean;
  /** Backend provider snapgpu sits on top of when useSnapgpu=true. */
  snapgpuBackend?: 'vast' | 'runpod';
  /** Snapgpu app name to preload at boot (calls @enter(snap=True) hooks). */
  snapgpuPreloadApp?: string;
  /** When true, the autoscaler captures a snapshot after the first successful
   *  inference, then restores from it on subsequent cold boots. */
  autoSnapshot?: boolean;
  /** When true AND provider supports it (Hyperstack today), idle auto-stop
   *  hibernates the VM instead of shutting it off — billing drops to ~10-15%
   *  (IP + storage only) while compute resources are deallocated. Resume via
   *  the normal `/v1/gpu/resume` path. */
  hibernateOnIdle?: boolean;
  /** When true AND the profile's standby-pool tier supports SSH signalling,
   *  idle pool slots drop the model off the GPU via the /tmp/bench.offload
   *  protocol instead of hibernate/terminate. Wake-on-request is 2-5s vs
   *  60-90s for hibernate. NOTE: on Hyperstack, billing is per-VM so the
   *  VM keeps billing at the full running rate while offloaded — this
   *  trades cost for latency. Use hibernateOnIdle or terminate when cost
   *  is the priority. */
  offloadOnIdle?: boolean;
  /** API paths that must exist on the deployed container before it is marked ready. */
  expectedApiPaths?: string[];
  /** Manifest capabilities that must be declared by /v1/manifest before ready. */
  expectedCapabilities?: string[];
  /** Require /v1/manifest to exist and match the expected capabilities/paths. */
  requireDockerManifest?: boolean;
  /** Run capability-specific smoke tests before marking ready. Default true for GLB generation. */
  runSmokeTests?: boolean;
}

/**
 * GatewayProfile extends AIProfile with gateway-specific fields.
 * Inherits voice, audioFormat, temperature, maxTokens, language, fallbackOptions, etc.
 * Old JSON files (with only stt/llm/tts/gpuDeploy) are backward-compatible since
 * all AIProfile fields are optional.
 */
/** Service definition — persisted with profile. Matches web/src/sections/provider-types.ts Service. */
export interface GatewayService {
  id: string;
  name: string;
  kind: 'cloud' | 'container' | 'serverless';
  provides?: ('stt' | 'llm' | 'tts' | 'image')[];
  cloudProvider?: string;
  dockerImage?: string;
  gpuTypes?: string[];
  gpuProvider?: string;
  sttModel?: string;
  llmModel?: string;
  ttsModel?: string;
  [key: string]: unknown;  // allow deploy settings (raceCount, region, etc.)
}

/**
 * An app configuration — extends AIProfile with gateway-specific fields.
 * Each app represents a different use case for the AI Gateway.
 *
 * Inherits from AIProfile: stt[], llm[], tts[], image[], voice, temperature,
 * maxTokens, language, gpuEndpoint, fallbackOptions, etc.
 * These inherited fields are used by AIClient for runtime pipeline execution.
 *
 * Gateway-specific fields below add: deployment config, services, latency targets.
 */
export interface GatewayApp extends AIProfile {
  id: string;
  name: string;
  gpuDeploy?: GpuDeployConfig;
  /** Services backing this app (cloud APIs, containers, serverless). */
  services?: GatewayService[];
  lastActivatedAt?: number;
  lastRequestAt?: number;
  /** Per-stage latency targets (ms). Overrides the tier-based defaults when set. */
  latencyTargetsMs?: {
    stt?: number;
    llm?: number;
    tts?: number;
  };
  /** Load balance strategy for this app when multiple GPU tiers are ready.
   *  Real-time apps should use 'least-latency' to route to the fastest tier.
   *  Default: inherits from AutoScalerConfig.loadBalanceStrategy. */
  loadBalanceStrategy?: 'hash' | 'least-latency' | 'weighted-round-robin' | 'affinity' | 'least-busy' | 'priority';
}

/** @deprecated Use GatewayApp */
export type GatewayProfile = GatewayApp;


/** STT hallucination filter thresholds (persisted with provider config). */
export interface SttHallucinationFilterSettings {
  /** Enable metadata-based filtering (no_speech_prob, compression_ratio, avg_logprob). Default: true */
  metadataFilterEnabled?: boolean;
  /** Enable blocklist-based filtering (sachaarbonel/whisper-hallucinations dataset). Default: true */
  blocklistFilterEnabled?: boolean;
  /** Maximum no_speech_prob before a segment is rejected. Default: 0.6 */
  noSpeechProbThreshold?: number;
  /** Maximum compression_ratio before a segment is rejected. Default: 2.4 */
  compressionRatioThreshold?: number;
  /** Minimum avg_logprob — below this the segment is rejected. Default: -0.8 */
  avgLogprobThreshold?: number;
}

export interface ProviderConfig {
  apps: GatewayApp[];
  activeAppId: string | null;
  /** Active app's STT chain (auto-synced when activeAppId changes — do NOT set independently). */
  pipelineStt: PipelineChainEntry[];
  /** Active app's LLM chain (auto-synced when activeAppId changes — do NOT set independently). */
  pipelineLlm: PipelineChainEntry[];
  /** Active app's TTS chain (auto-synced when activeAppId changes — do NOT set independently). */
  pipelineTts: PipelineChainEntry[];
  idleTimeoutMin: number;  // auto-terminate GPU after N minutes idle (0 = disabled)
  /** STT hallucination filter settings. */
  sttHallucinationFilter?: SttHallucinationFilterSettings;
  updatedAt: number;
  [key: string]: unknown;  // allow extra fields from UI (dockerImages, gpuTypes, etc.)
}

/** Get the active app, or null if none is active. */
export async function getActiveApp(config?: ProviderConfig): Promise<GatewayApp | null> {
  const cfg = config ?? await loadProviderConfig();
  if (!cfg.activeAppId) return null;
  return cfg.apps.find(a => a.id === cfg.activeAppId) ?? null;
}

export const DEFAULT_APPS: GatewayApp[] = [
  {
    id: 'realtime-translation-dubbing-mistral',
    name: 'Real-time Translation + Dubbing (Mistral)',
    stt: [{ provider: 'gpu', model: 'whisper' }, { provider: 'groq', model: 'whisper-large-v3-turbo' }],
    llm: [{ provider: 'gpu', model: 'mistral' }, { provider: 'groq', model: 'llama-3.3-70b-versatile' }],
    tts: [{ provider: 'gpu', model: 'qwen3-tts' }, { provider: 'modal', model: 'qwen3-tts' }],
    gpuDeploy: {
      dockerImage: `${process.env.DOCKER_IMAGE_PREFIX || 'marcosremar'}/babelcast-mistral:latest`,
      gpuTypes: ['NVIDIA GeForce RTX 5090', 'NVIDIA RTX 5090', 'NVIDIA GeForce RTX 4090', 'NVIDIA RTX A6000', 'NVIDIA A40'],
      region: '',
      timeoutMin: 30,
      bootOnStartup: true,
    },
    // Real-time speech pipeline: tight latency targets so the readiness
    // benchmark gates GPU→production only when the pod is fast enough for
    // live translation. Without these, the default 800/2000/1500ms targets
    // apply which are acceptable for async but too loose for real-time.
    latencyTargetsMs: {
      stt: 500,   // STT must complete in 500ms for real-time subtitle overlay
      llm: 1000,  // LLM translation under 1s for natural dubbing cadence
      tts: 800,   // TTS under 800ms for continuous audio playback without gaps
    },
    // When multiple GPU tiers are ready, route to the fastest one.
    loadBalanceStrategy: 'least-latency',
  },
  {
    id: 'realtime-translation-dubbing',
    name: 'Real-time Translation + Dubbing (TranslateGemma)',
    stt: [{ provider: 'gpu', model: 'whisper' }, { provider: 'groq', model: 'whisper-large-v3-turbo' }],
    llm: [{ provider: 'gpu', model: 'translategemma' }, { provider: 'groq', model: 'llama-3.3-70b-versatile' }],
    tts: [{ provider: 'gpu', model: 'qwen3-tts' }, { provider: 'modal', model: 'qwen3-tts' }],
    gpuDeploy: {
      dockerImage: `${process.env.DOCKER_IMAGE_PREFIX || 'marcosremar'}/babelcast-translategemma:latest`,
      gpuTypes: ['NVIDIA GeForce RTX 5090', 'NVIDIA GeForce RTX 4090', 'NVIDIA RTX A6000', 'NVIDIA A40'],
      region: '',
      timeoutMin: 30,
    },
    latencyTargetsMs: {
      stt: 500,
      llm: 800,   // TranslateGemma is faster than Mistral — tighter target
      tts: 800,
    },
    loadBalanceStrategy: 'least-latency',
  },
  {
    id: 'subtitles-only',
    name: 'Subtitles Only (no dubbing)',
    stt: [{ provider: 'gpu', model: 'whisper' }, { provider: 'groq', model: 'whisper-large-v3-turbo' }],
    llm: [{ provider: 'gpu', model: 'translategemma' }, { provider: 'groq', model: 'llama-3.3-70b-versatile' }],
    tts: [{ provider: 'groq', model: 'orpheus-v1-english' }],
    gpuDeploy: {
      dockerImage: `${process.env.DOCKER_IMAGE_PREFIX || 'marcosremar'}/babelcast-subtitle:latest`,
      // P1-4 (docs/improvement-plan.md): removed RTX 5090 from the
      // allowlist. Readiness history on 2026-04-11 showed STT p95=8030ms
      // on 5090 (breaches sttP95Ms=1500 SLO 5.4x), while the same image
      // on 4090 has p95=1024ms (within SLO). Likely cause: first-request
      // Blackwell CUDA kernel compilation. Pinning to 4090 until a warmup
      // phase lands in the container (P2-2).
      gpuTypes: ['NVIDIA GeForce RTX 4090', 'NVIDIA RTX A6000', 'NVIDIA A40'],
      region: '',
      timeoutMin: 30,
    },
    latencyTargetsMs: {
      stt: 500,
      llm: 600,   // subtitle-only: no TTS path, LLM can be tight
    },
  },
  {
    id: 'pose-estimation-hybrik-x',
    name: 'Pose Estimation (HybrIK-X)',
    gpuDeploy: {
      dockerImage: `${process.env.DOCKER_IMAGE_PREFIX || 'marcosremar'}/hybrik-x:latest`,
      gpuTypes: ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 3090', 'NVIDIA RTX A6000', 'NVIDIA A40'],
      region: '',
      timeoutMin: 30,
    },
  },
  {
    // HY-Motion 1.0 (Tencent): text → SMPL-H motion via DiT + flow matching.
    // Used by avatar-engine's /api/animations/generate route — prompt goes
    // to this GPU pod, raw SMPL-H FBX comes back, then the avatar-engine's
    // local Blender v1.2 retarget pipeline converts to Sofia/Mixamo GLB.
    // ~1B params + torch deps = ~16GB image, so boot is slow the first time.
    id: 'text-to-motion-hy-motion',
    name: 'Text-to-Motion (HY-Motion)',
    gpuDeploy: {
      dockerImage: `${process.env.DOCKER_IMAGE_PREFIX || 'marcosremar'}/hy-motion:latest`,
      // HY-Motion needs ≥24GB VRAM for the DiT weights + cache. RTX 5090
      // and A6000 fit comfortably; older cards run out of memory.
      gpuTypes: ['NVIDIA GeForce RTX 5090', 'NVIDIA GeForce RTX 4090', 'NVIDIA RTX A6000'],
      region: '',
      timeoutMin: 30,
      bootOnStartup: false,
    },
    latencyTargetsMs: {
      // First inference ~180 s (model warmup). Warm inference ~5-10 s for
      // a 3 s motion clip. We budget generously to avoid false negatives.
      llm: 60_000,
    },
  },
  {
    // Snapgpu profile: same speech pipeline as babelcast-subtitle, but the
    // autoscaler routes through SnapgpuClient → CRIU + cuda-checkpoint
    // snapshots reduce cold boot from ~2 min to ~5 s on Vast.ai/RunPod hosts
    // with NVIDIA driver 570+. Requires the snapgpu-runtime image to be built.
    id: 'speech-snapgpu-fast-cold-start',
    name: 'Speech (SnapGPU fast cold start)',
    stt: [{ provider: 'gpu', model: 'whisper' }, { provider: 'groq', model: 'whisper-large-v3-turbo' }],
    llm: [{ provider: 'gpu', model: 'translategemma' }, { provider: 'groq', model: 'llama-3.3-70b-versatile' }],
    tts: [{ provider: 'groq', model: 'orpheus-v1-english' }],
    gpuDeploy: {
      dockerImage: `${process.env.DOCKER_IMAGE_PREFIX || 'marcosremar'}/snapgpu-runtime-babelcast:latest`,
      // Driver 570+ required for cuda-checkpoint. Most RTX 4090/5090 hosts on
      // Vast.ai have it; older RTX 3090 hosts may not. The autoscaler will
      // gracefully degrade to CPU-only CRIU when the driver is too old.
      gpuTypes: ['NVIDIA GeForce RTX 5090', 'NVIDIA GeForce RTX 4090'],
      region: '',
      timeoutMin: 30,
      useSnapgpu: true,
      snapgpuBackend: 'vast',
      snapgpuPreloadApp: 'babelcast',
      autoSnapshot: true,
    },
  },
  {
    id: 'fast-serve',
    name: 'Fast-serve (Modal-style warm pool)',
    stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
    llm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
    tts: [{ provider: 'modal', model: 'qwen3-tts' }],
    gpuDeploy: {
      dockerImage: 'marcosremar/babelcast-subtitle:latest',
      gpuTypes: ['NVIDIA L40'],
      region: 'CANADA-1',
      timeoutMin: 30,
      raceCount: 1,
      offloadOnIdle: true,
      hibernateOnIdle: false,
      bootOnStartup: false,
    },
    latencyTargetsMs: { stt: 500, llm: 1000, tts: 800 },
    loadBalanceStrategy: 'least-latency',
  },
  {
    id: 'cloud-only',
    name: 'Cloud Only (fast boot, no GPU)',
    stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
    llm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
    tts: [{ provider: 'groq', model: 'orpheus-v1-english' }, { provider: 'modal', model: 'qwen3-tts' }],
  },
];

/** Alias for DEFAULT_APPS — used by tests and external tooling. */
export const DEFAULT_GPU_PROFILES = DEFAULT_APPS;

const DEFAULT_CONFIG: ProviderConfig = {
  apps: [...DEFAULT_APPS],
  activeAppId: 'realtime-translation-dubbing-mistral',
  pipelineStt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
  pipelineLlm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
  pipelineTts: [{ provider: 'gpu', model: 'qwen3-tts' }, { provider: 'modal', model: 'qwen3-tts' }],
  idleTimeoutMin: 5, // cold-start plan A3: was 15; stop→resume is cheaper than idle billing
  updatedAt: 0,
};

/** Load provider config from disk. Returns defaults if file doesn't exist.
 *  Uses in-memory cache with 5s TTL to avoid sync file I/O on the hot path.
 *  Note: Returns a shallow copy to prevent accidental mutation, but nested
 *  arrays/objects are NOT deep-cloned. Caller must not mutate returned arrays. */
export async function loadProviderConfig(): Promise<ProviderConfig> {
  const now = Date.now();
  if (_cachedConfig && (now - _cacheTime) < CONFIG_CACHE_TTL_MS) {
    return _cachedConfig;
  }
  try {
    let fileExists: boolean;
    try {
      await access(CONFIG_FILE);
      fileExists = true;
    } catch {
      fileExists = false;
    }
    if (!fileExists) {
      _cachedConfig = { ...DEFAULT_CONFIG };
      _cacheTime = now;
      return _cachedConfig;
    }
    let raw: string;
    let source = 'primary';
    try {
      raw = await readFile(CONFIG_FILE, 'utf-8');
      JSON.parse(raw); // validate JSON
    } catch (parseErr) {
      // Primary file corrupted — try backup
      log.error('Primary config corrupted: %s', parseErr instanceof Error ? parseErr.message : parseErr);
      const bakFile = CONFIG_FILE + '.bak';
      let bakExists: boolean;
      try {
        await access(bakFile);
        bakExists = true;
      } catch {
        bakExists = false;
      }
      if (bakExists) {
        try {
          raw = await readFile(bakFile, 'utf-8');
          JSON.parse(raw); // validate backup JSON
          source = 'backup';
          log.warn('Recovered from backup: %s', bakFile);
        } catch {
          log.error('Backup also corrupted — using defaults');
          _cachedConfig = { ...DEFAULT_CONFIG };
          _cacheTime = now;
          return _cachedConfig;
        }
      } else {
        log.error('No backup available — using defaults');
        _cachedConfig = { ...DEFAULT_CONFIG };
        _cacheTime = now;
        return _cachedConfig;
      }
    }
    if (source !== 'primary') log.log('Loaded from %s', source);
    const data = JSON.parse(raw) as Record<string, unknown>;
    // Migrate legacy field names: profiles → apps, activeProfileId → activeAppId
    const rawApps = (data.apps ?? data.profiles) as GatewayApp[] | undefined;
    const rawActiveId = (data.activeAppId ?? data.activeProfileId) as string | null | undefined;
    const config: ProviderConfig = {
      apps: Array.isArray(rawApps) && rawApps.length > 0
        ? rawApps : [...DEFAULT_APPS],
      activeAppId: rawActiveId ?? DEFAULT_CONFIG.activeAppId,
      pipelineStt: Array.isArray(data.pipelineStt) && data.pipelineStt.length > 0
        ? [...data.pipelineStt] : [...DEFAULT_CONFIG.pipelineStt],
      pipelineLlm: Array.isArray(data.pipelineLlm) && data.pipelineLlm.length > 0
        ? [...data.pipelineLlm] : [...DEFAULT_CONFIG.pipelineLlm],
      pipelineTts: Array.isArray(data.pipelineTts) && data.pipelineTts.length > 0
        ? [...data.pipelineTts] : [...DEFAULT_CONFIG.pipelineTts],
      idleTimeoutMin: typeof data.idleTimeoutMin === 'number' ? data.idleTimeoutMin : DEFAULT_CONFIG.idleTimeoutMin,
      updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
    };
    // Migrate legacy service fields in apps
    for (const app of config.apps) {
      if (!Array.isArray(app.services)) continue;
      for (const svc of app.services) {
        // gpu-pod → container
        if ((svc as any).kind === 'gpu-pod') (svc as any).kind = 'container';
        // gpuCloudProvider → gpuProvider
        if ((svc as any).gpuCloudProvider && !svc.gpuProvider) {
          svc.gpuProvider = (svc as any).gpuCloudProvider;
          delete (svc as any).gpuCloudProvider;
        }
      }
    }
    // Merge any default apps that are missing (new defaults added in code updates)
    for (const def of DEFAULT_APPS) {
      if (!config.apps.find(a => a.id === def.id)) {
        config.apps.push(def);
      }
    }
    // Preserve extra UI fields (dockerImages, gpuImage, gpuTypes, etc.)
    for (const key of Object.keys(data)) {
      if (!(key in config)) config[key] = data[key as keyof typeof data];
    }
    _cachedConfig = config;
    _cacheTime = now;
    return _cachedConfig;
  } catch (err) {
    log.warn('Failed to load provider config: %s', err instanceof Error ? err.message : err);
    _cachedConfig = { ...DEFAULT_CONFIG };
    _cacheTime = now;
    return _cachedConfig;
  }
}

// ── Current authenticated user API key ───────────────────────────────────────
// Set by onAuth hook when a request is authenticated. Used so saveProviderConfig
// can persist to the user's DB record without breaking existing call signatures.

let _currentUserApiKey: string | null = null;

/** Set the API key of the currently authenticated user (called from onAuth hook). */
export function setCurrentUserApiKey(apiKey: string | null): void {
  _currentUserApiKey = apiKey;
}

/** Get the API key of the currently authenticated user (null in localhost-only mode). */
export function getCurrentUserApiKey(): string | null {
  return _currentUserApiKey;
}

/**
 * Apply a config directly to the in-memory cache without writing to disk.
 * Called after loading a user's profile from DB so all subsequent reads use it.
 */
export function applyUserConfig(config: ProviderConfig): void {
  _cachedConfig = config;
  _cacheTime = Date.now();
}

/** Save provider config to disk + DB (if a user API key is active). Also updates the in-memory cache. */
export function saveProviderConfig(config: ProviderConfig): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      mkdirSync(BABELCAST_DIR, { recursive: true });
      config.updatedAt = Date.now();
      // Backup current file before overwriting (corruption recovery)
      if (existsSync(CONFIG_FILE)) {
        try { writeFileSync(CONFIG_FILE + '.bak', readFileSync(CONFIG_FILE)); } catch { /* best-effort backup */ }
      }
      // Atomic write: write to temp file then renameSync (prevents corruption on crash)
      const tmpFile = CONFIG_FILE + '.tmp';
      writeFileSync(tmpFile, JSON.stringify(config, null, 2));
      renameSync(tmpFile, CONFIG_FILE);
      // Update cache so subsequent reads skip file I/O
      _cachedConfig = config;
      _cacheTime = Date.now();
      log.log('Saved provider config (%d apps) to %s', config.apps.length, CONFIG_FILE);
    } catch (err) {
      log.warn('Failed to save provider config: %s', err instanceof Error ? err.message : err);
    }
    // Also persist to the AI Gateway user DB if there is an authenticated user (fire-and-forget)
    if (_currentUserApiKey) {
      const apiKey = _currentUserApiKey;
      import('./user-profiles').then(({ saveUserConfig }) => {
        saveUserConfig(apiKey, 'Default', config).catch((err) => {
          log.warn('Failed to persist user config to DB: %s', err instanceof Error ? err.message : err);
        });
      }).catch((err) => {
        log.warn('Failed to load user-profiles module for DB sync: %s', err instanceof Error ? err.message : err);
      });
    }
    resolve();
  });
}

/** Patch provider config — merges partial update into existing config. */
export async function patchProviderConfig(partial: Partial<ProviderConfig>): Promise<ProviderConfig> {
  const current = await loadProviderConfig();
  const updated: ProviderConfig = {
    ...current,  // preserve extra UI fields
    apps: (partial as any).apps !== undefined ? (partial as any).apps
      : (partial as any).profiles !== undefined ? (partial as any).profiles  // legacy compat
      : current.apps,
    activeAppId: partial.activeAppId !== undefined ? partial.activeAppId : current.activeAppId,
    pipelineStt: partial.pipelineStt !== undefined ? [...partial.pipelineStt] : [...current.pipelineStt],
    pipelineLlm: partial.pipelineLlm !== undefined ? [...partial.pipelineLlm] : [...current.pipelineLlm],
    pipelineTts: partial.pipelineTts !== undefined ? [...partial.pipelineTts] : [...current.pipelineTts],
    idleTimeoutMin: partial.idleTimeoutMin !== undefined ? partial.idleTimeoutMin : current.idleTimeoutMin,
    sttHallucinationFilter: partial.sttHallucinationFilter !== undefined ? partial.sttHallucinationFilter : current.sttHallucinationFilter,
    updatedAt: Date.now(),
  };
  // Copy any extra fields from partial (dockerImages, gpuImage, etc.)
  for (const key of Object.keys(partial)) {
    if (!(key in updated) && partial[key as keyof typeof partial] !== undefined) {
      updated[key] = partial[key as keyof typeof partial];
    }
  }

  // Track lastActivatedAt + apply latency targets when activeAppId changes
  if (partial.activeAppId !== undefined && partial.activeAppId !== current.activeAppId) {
    updated.apps = updated.apps.map(a =>
      a.id === partial.activeAppId ? { ...a, lastActivatedAt: Date.now() } : a
    );
    applyAppLatencyTargets(partial.activeAppId, updated.apps);
  }

  // Apply idle timeout to runtime
  if (partial.idleTimeoutMin !== undefined) {
    const ms = partial.idleTimeoutMin <= 0 ? Infinity : partial.idleTimeoutMin * 60_000;
    setIdleTimeoutMs(ms);
    log.log('Idle timeout set to %d min%s', partial.idleTimeoutMin, partial.idleTimeoutMin <= 0 ? ' (disabled)' : '');
  }

  await saveProviderConfig(updated);
  return updated;
}

// ── Latency target mapping ─────────────────────────────────────────────────────


/**
 * Apply a profile's latency field to the benchmarking thresholds.
 * Called whenever the active profile changes or on gateway startup.
 */
export function applyAppLatencyTargets(appId: string | null, apps: GatewayApp[]): void {
  if (!appId) return;
  const app = apps.find(a => a.id === appId);
  if (!app) return;

  if (app.latencyTargetsMs) {
    const { stt, llm, tts } = app.latencyTargetsMs;
    if (stt !== undefined) setSttTargetLatencyMs(stt);
    if (llm !== undefined) setLlmTargetLatencyMs(llm);
    if (tts !== undefined) setTtsTargetLatencyMs(tts);
    log.log('Latency targets applied for app "%s": STT=%dms LLM=%dms TTS=%dms', appId, stt, llm, tts);
  }

  // Auto-switch GPU sort mode for real-time apps
  const isRealtime = app.latencyTargetsMs?.stt !== undefined && app.latencyTargetsMs.stt < 600;
  if (isRealtime) {
    setGpuSortBy('realtime');
    log.log("GPU sort mode set to 'realtime' for app \"%s\" (STT target < 600ms)", appId);
  }
}

/** @deprecated Use applyAppLatencyTargets */
export const applyProfileLatencyTargets = applyAppLatencyTargets;

/**
 * Restore all persisted config values to the in-memory runtime on server startup.
 * Must be called once after the server loads — config values like idleTimeoutMin
 * are only applied to the runtime inside patchProviderConfig() (API-driven updates),
 * so without this call they revert to hardcoded defaults after every restart.
 */
export async function applyRuntimeConfig(): Promise<void> {
  const config = await loadProviderConfig();

  // Restore idle timeout
  const ms = config.idleTimeoutMin <= 0 ? Infinity : config.idleTimeoutMin * 60_000;
  setIdleTimeoutMs(ms);
  if (config.idleTimeoutMin <= 0) {
    log.log('Startup: idle timeout disabled (idleTimeoutMin=0)');
  } else if (config.idleTimeoutMin !== DEFAULT_CONFIG.idleTimeoutMin) {
    log.log('Startup: idle timeout restored to %d min from persisted config', config.idleTimeoutMin);
  }

  // Restore active app latency targets
  if (config.activeAppId && config.apps?.length) {
    applyAppLatencyTargets(config.activeAppId, config.apps);
  }

  // Restore deploy settings (deployTimeoutMin, minVramGb, gpuSortBy, raceCount, etc.)
  // loadDeploySettings() reads ~/.ai-gateway/latency-settings.json directly into the
  // in-memory _s object — all getters (getDeployTimeoutMin, getMinVramGb, …) then
  // return the persisted values instead of hardcoded defaults.
  await loadDeploySettings();
}

/** Debounced stamp: update lastRequestAt on the given app.
 *  Batches writes — persists at most once per 10 seconds to avoid
 *  sync file I/O on every pipeline request. */
let _stampTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingStampId: string | null = null;

async function _flushStamp(appId: string): Promise<void> {
  try {
    const config = await loadProviderConfig();
    const now = Date.now();
    const updated = {
      ...config,
      apps: config.apps.map(a => a.id === appId ? { ...a, lastRequestAt: now } : a),
    };
    await saveProviderConfig(updated);
  } catch (e) { log.warn('app lastRequestAt update failed: %s', e instanceof Error ? e.message : e); }
}

export function stampAppRequest(appId: string | null): void {
  if (!appId) return;
  if (!_stampTimer) {
    _pendingStampId = appId;
    _stampTimer = setTimeout(() => {
      _stampTimer = null;
      const pending = _pendingStampId;
      _pendingStampId = null;
      if (pending) {
        _flushStamp(pending);
      }
    }, 10_000);
  } else {
    _pendingStampId = appId;
  }
}

/** @deprecated Use stampAppRequest */
export const stampProfileRequest = stampAppRequest;

// ── User config stubs (local/desktop — no multi-user DB) ─────────────────────
// applyUserConfig is already exported above (line 213) — no duplicate needed.
