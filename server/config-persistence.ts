// ── BabelCast Gateway — Provider Config Persistence ──────────────────────────
// Persists provider configuration (profiles, pipeline chains) to
// ~/.babelcast/provider-config.json so the BabelCast app can access it
// via the AI Gateway SDK.

import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { setIdleTimeoutMs } from './gpu-deploy';
import { setSttTargetLatencyMs, setLlmTargetLatencyMs, setTtsTargetLatencyMs } from '../src/gpu-providers/deploy-settings';
import type { AIProfile } from '../src/client';

const BABELCAST_DIR = join(homedir(), '.babelcast');
const CONFIG_FILE = join(BABELCAST_DIR, 'provider-config.json');

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
}

/**
 * GatewayProfile extends AIProfile with gateway-specific fields.
 * Inherits voice, audioFormat, temperature, maxTokens, language, fallbackOptions, etc.
 * Old JSON files (with only stt/llm/tts/gpuDeploy) are backward-compatible since
 * all AIProfile fields are optional.
 */
export interface GatewayProfile extends AIProfile {
  id: string;
  name: string;
  gpuDeploy?: GpuDeployConfig;
  lastActivatedAt?: number;
  lastRequestAt?: number;
  /** Per-stage latency targets (ms). Overrides the tier-based defaults when set. */
  latencyTargetsMs?: {
    stt?: number;
    llm?: number;
    tts?: number;
  };
}


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
  profiles: GatewayProfile[];
  activeProfileId: string | null;
  pipelineStt: PipelineChainEntry[];
  pipelineLlm: PipelineChainEntry[];
  pipelineTts: PipelineChainEntry[];
  idleTimeoutMin: number;  // auto-terminate GPU after N minutes idle (0 = disabled)
  /** STT hallucination filter settings. */
  sttHallucinationFilter?: SttHallucinationFilterSettings;
  updatedAt: number;
  [key: string]: unknown;  // allow extra fields from UI (dockerImages, gpuTypes, etc.)
}

export const DEFAULT_GPU_PROFILES: GatewayProfile[] = [
  {
    id: 'realtime-translation-dubbing-mistral',
    name: 'Real-time Translation + Dubbing (Mistral)',
    stt: [{ provider: 'gpu', model: 'whisper' }, { provider: 'groq', model: 'whisper-large-v3-turbo' }],
    llm: [{ provider: 'gpu', model: 'mistral' }, { provider: 'groq', model: 'llama-3.3-70b-versatile' }],
    tts: [{ provider: 'gpu', model: 'qwen3-tts' }, { provider: 'modal', model: 'qwen3-tts' }],
    gpuDeploy: {
      dockerImage: 'marcosremar/babelcast-mistral:latest',
      gpuTypes: ['NVIDIA GeForce RTX 5090', 'NVIDIA RTX 5090', 'NVIDIA GeForce RTX 4090', 'NVIDIA RTX A6000', 'NVIDIA A40'],
      region: '',
      timeoutMin: 30,
      bootOnStartup: true,
    },
  },
  {
    id: 'realtime-translation-dubbing',
    name: 'Real-time Translation + Dubbing (TranslateGemma)',
    stt: [{ provider: 'gpu', model: 'whisper' }, { provider: 'groq', model: 'whisper-large-v3-turbo' }],
    llm: [{ provider: 'gpu', model: 'translategemma' }, { provider: 'groq', model: 'llama-3.3-70b-versatile' }],
    tts: [{ provider: 'gpu', model: 'qwen3-tts' }, { provider: 'modal', model: 'qwen3-tts' }],
    gpuDeploy: {
      dockerImage: 'marcosremar/babelcast-translategemma:latest',
      gpuTypes: ['NVIDIA GeForce RTX 5090', 'NVIDIA GeForce RTX 4090', 'NVIDIA RTX A6000', 'NVIDIA A40'],
      region: '',
      timeoutMin: 30,
    },
  },
  {
    id: 'subtitles-only',
    name: 'Subtitles Only (no dubbing)',
    stt: [{ provider: 'gpu', model: 'whisper' }, { provider: 'groq', model: 'whisper-large-v3-turbo' }],
    llm: [{ provider: 'gpu', model: 'translategemma' }, { provider: 'groq', model: 'llama-3.3-70b-versatile' }],
    tts: [{ provider: 'groq', model: 'orpheus-v1-english' }],
    gpuDeploy: {
      dockerImage: 'marcosremar/babelcast-subtitle:latest',
      gpuTypes: ['NVIDIA GeForce RTX 5090', 'NVIDIA GeForce RTX 4090', 'NVIDIA RTX A6000', 'NVIDIA A40'],
      region: '',
      timeoutMin: 30,
    },
  },
  {
    id: 'cloud-only',
    name: 'Cloud Only (fast boot, no GPU)',
    stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
    llm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
    tts: [{ provider: 'groq', model: 'orpheus-v1-english' }, { provider: 'modal', model: 'qwen3-tts' }],
  },
];

const DEFAULT_CONFIG: ProviderConfig = {
  profiles: [...DEFAULT_GPU_PROFILES],
  activeProfileId: 'realtime-translation-dubbing-mistral',
  pipelineStt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
  pipelineLlm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
  pipelineTts: [{ provider: 'gpu', model: 'qwen3-tts' }, { provider: 'modal', model: 'qwen3-tts' }],
  idleTimeoutMin: 15,
  updatedAt: 0,
};

/** Load provider config from disk. Returns defaults if file doesn't exist.
 *  Uses in-memory cache with 5s TTL to avoid sync file I/O on the hot path. */
export function loadProviderConfig(): ProviderConfig {
  const now = Date.now();
  if (_cachedConfig && (now - _cacheTime) < CONFIG_CACHE_TTL_MS) {
    return _cachedConfig;
  }
  try {
    if (!existsSync(CONFIG_FILE)) {
      _cachedConfig = { ...DEFAULT_CONFIG };
      _cacheTime = now;
      return _cachedConfig;
    }
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    const data = JSON.parse(raw) as Partial<ProviderConfig>;
    const config: ProviderConfig = {
      profiles: Array.isArray(data.profiles) && data.profiles.length > 0
        ? data.profiles : [...DEFAULT_GPU_PROFILES],
      activeProfileId: data.activeProfileId ?? DEFAULT_CONFIG.activeProfileId,
      pipelineStt: Array.isArray(data.pipelineStt) && data.pipelineStt.length > 0
        ? data.pipelineStt : DEFAULT_CONFIG.pipelineStt,
      pipelineLlm: Array.isArray(data.pipelineLlm) && data.pipelineLlm.length > 0
        ? data.pipelineLlm : DEFAULT_CONFIG.pipelineLlm,
      pipelineTts: Array.isArray(data.pipelineTts) && data.pipelineTts.length > 0
        ? data.pipelineTts : DEFAULT_CONFIG.pipelineTts,
      idleTimeoutMin: typeof data.idleTimeoutMin === 'number' ? data.idleTimeoutMin : 15,
      updatedAt: data.updatedAt ?? 0,
    };
    // Merge any default profiles that are missing (new defaults added in code updates)
    for (const def of DEFAULT_GPU_PROFILES) {
      if (!config.profiles.find(p => p.id === def.id)) {
        config.profiles.push(def);
      }
    }
    // Preserve extra UI fields (dockerImages, gpuImage, gpuTypes, etc.)
    for (const key of Object.keys(data)) {
      if (!(key in config)) config[key] = data[key as keyof typeof data];
    }
    _cachedConfig = config;
    _cacheTime = now;
    return config;
  } catch (err) {
    console.warn('[config] Failed to load provider config:', err instanceof Error ? err.message : err);
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
export function saveProviderConfig(config: ProviderConfig): void {
  try {
    mkdirSync(BABELCAST_DIR, { recursive: true });
    config.updatedAt = Date.now();
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    // Update cache so subsequent reads skip file I/O
    _cachedConfig = config;
    _cacheTime = Date.now();
    console.log(`[config] Saved provider config (${config.profiles.length} profiles) to ${CONFIG_FILE}`);
  } catch (err) {
    console.warn('[config] Failed to save provider config:', err instanceof Error ? err.message : err);
  }
  // Also persist to the AI Gateway user DB if there is an authenticated user (fire-and-forget)
  if (_currentUserApiKey) {
    const apiKey = _currentUserApiKey;
    import('./user-profiles').then(({ saveUserConfig }) => {
      saveUserConfig(apiKey, 'Default', config).catch(() => {});
    }).catch(() => {});
  }
}

/** Patch provider config — merges partial update into existing config. */
export function patchProviderConfig(partial: Partial<ProviderConfig>): ProviderConfig {
  const current = loadProviderConfig();
  const updated: ProviderConfig = {
    ...current,  // preserve extra UI fields
    profiles: partial.profiles !== undefined ? partial.profiles : current.profiles,
    activeProfileId: partial.activeProfileId !== undefined ? partial.activeProfileId : current.activeProfileId,
    pipelineStt: partial.pipelineStt !== undefined ? partial.pipelineStt : current.pipelineStt,
    pipelineLlm: partial.pipelineLlm !== undefined ? partial.pipelineLlm : current.pipelineLlm,
    pipelineTts: partial.pipelineTts !== undefined ? partial.pipelineTts : current.pipelineTts,
    idleTimeoutMin: partial.idleTimeoutMin !== undefined ? partial.idleTimeoutMin : current.idleTimeoutMin,
    updatedAt: Date.now(),
  };
  // Copy any extra fields from partial (dockerImages, gpuImage, etc.)
  for (const key of Object.keys(partial)) {
    if (!(key in updated) && partial[key as keyof typeof partial] !== undefined) {
      updated[key] = partial[key as keyof typeof partial];
    }
  }

  // Track lastActivatedAt + apply latency targets when activeProfileId changes
  if (partial.activeProfileId !== undefined && partial.activeProfileId !== current.activeProfileId) {
    updated.profiles = updated.profiles.map(p =>
      p.id === partial.activeProfileId ? { ...p, lastActivatedAt: Date.now() } : p
    );
    applyProfileLatencyTargets(partial.activeProfileId, updated.profiles);
  }

  // Apply idle timeout to runtime
  if (partial.idleTimeoutMin !== undefined) {
    const ms = partial.idleTimeoutMin <= 0 ? Infinity : partial.idleTimeoutMin * 60_000;
    setIdleTimeoutMs(ms);
    console.log(`[config] Idle timeout set to ${partial.idleTimeoutMin} min${partial.idleTimeoutMin <= 0 ? ' (disabled)' : ''}`);
  }

  saveProviderConfig(updated);
  return updated;
}

// ── Latency target mapping ─────────────────────────────────────────────────────

const LATENCY_TARGETS: Record<string, { sttMs: number; llmMs: number; ttsMs: number }> = {
  realtime: { sttMs: 300,   llmMs: 500,    ttsMs: 300   },
  low:      { sttMs: 800,   llmMs: 2_000,  ttsMs: 1_500 },
  batch:    { sttMs: 10_000, llmMs: 30_000, ttsMs: 15_000 },
};

/**
 * Apply a profile's latency field to the benchmarking thresholds.
 * Called whenever the active profile changes or on gateway startup.
 */
export function applyProfileLatencyTargets(profileId: string | null, profiles: GatewayProfile[]): void {
  if (!profileId) return;
  const profile = profiles.find(p => p.id === profileId);
  if (!profile) return;

  // Profile-level per-stage overrides take precedence over tier defaults
  if (profile.latencyTargetsMs) {
    const { stt, llm, tts } = profile.latencyTargetsMs;
    const sttMs = stt;
    const llmMs = llm;
    const ttsMs = tts;
    if (sttMs !== undefined) setSttTargetLatencyMs(sttMs);
    if (llmMs !== undefined) setLlmTargetLatencyMs(llmMs);
    if (ttsMs !== undefined) setTtsTargetLatencyMs(ttsMs);
    console.log(`[config] Latency targets applied for profile "${profileId}" (custom): STT=${sttMs}ms LLM=${llmMs}ms TTS=${ttsMs}ms`);
    return;
  }

  console.log(`[config] No latency targets configured for profile "${profileId}"`);
}

/** Debounced stamp: update lastRequestAt on the given profile.
 *  Batches writes — persists at most once per 10 seconds to avoid
 *  sync file I/O on every pipeline request. */
let _stampTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingStampId: string | null = null;

function _flushStamp(profileId: string): void {
  try {
    const config = loadProviderConfig();
    const now = Date.now();
    const updated = {
      ...config,
      profiles: config.profiles.map(p => p.id === profileId ? { ...p, lastRequestAt: now } : p),
    };
    saveProviderConfig(updated);
  } catch (e) { console.warn('[config] profile lastRequestAt update failed:', e instanceof Error ? e.message : e); }
}

export function stampProfileRequest(profileId: string | null): void {
  if (!profileId) return;
  _pendingStampId = profileId;
  if (!_stampTimer) {
    _stampTimer = setTimeout(() => {
      _stampTimer = null;
      if (_pendingStampId) {
        _flushStamp(_pendingStampId);
        _pendingStampId = null;
      }
    }, 10_000);
  }
}

// ── User config stubs (local/desktop — no multi-user DB) ─────────────────────

let _currentUserApiKey: string | null = null;

export function setCurrentUserApiKey(apiKey: string): void {
  _currentUserApiKey = apiKey;
}

export function applyUserConfig(_config: Record<string, unknown>): void {
  // No-op for desktop — single user, config already loaded from JSON
}
