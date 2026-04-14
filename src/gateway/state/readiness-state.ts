// ── GPU Readiness & Warmth State ────────────────────────────────────────────
// Per-service readiness lifecycle, model warmth tracking, TTS warmth, cold start profiles.
// Extracted from server/state.ts — Phase 5 DDD migration.

import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { createLogger } from '../../platform/logger';

const log = createLogger('readiness-state');

const BABELCAST_DIR = join(homedir(), '.babelcast');

// ── Per-service readiness state ────────────────────────────────────────────

// Per-service lifecycle phases (independent of deploy/infra states)
export type ServiceReadinessPhase =
  | 'idle'           // not started
  | 'downloading'    // model downloading from HuggingFace/registry
  | 'loading'        // model loading into memory/VRAM
  | 'compiling'      // CUDA graph compilation (TTS)
  | 'warming'        // first inference warming up
  | 'benchmarking'   // latency benchmark running
  | 'shadow'         // shadow mode validation
  | 'ready'          // serving production traffic
  | 'degraded'       // P95 exceeded, falling back to cloud
  | 'failed'         // benchmark failed
  | 'repechage'      // retrying after failure
  | 'condemned';     // permanently failed

export interface ServiceReadinessState {
  phase: ServiceReadinessPhase;
  completedRuns: number;
  latencySamples: number[];
  targetMs: number;        // effective target = configuredMax * (1 - margin%)
  bestLatencyMs: number | null;
  /** Model download/load progress detail (e.g., "downloading whisper-large-v3") */
  loadDetail?: string;
  /** Timestamp when this phase started */
  phaseStartedAt?: number;
}

function _defaultServiceState(): ServiceReadinessState {
  return { phase: 'idle', completedRuns: 0, latencySamples: [], targetMs: 0, bestLatencyMs: null };
}

export interface GpuReadinessState {
  stt: ServiceReadinessState;
  llm: ServiceReadinessState;
  tts: ServiceReadinessState;
  repechageAttempts: number;
  shadowCompletedRuns: number;
  shadowPhase: boolean;
  condemned: boolean;
  autoRecoveryAttempt: number;
}

export let gpuReadinessState: GpuReadinessState = {
  stt: _defaultServiceState(), llm: _defaultServiceState(), tts: _defaultServiceState(),
  repechageAttempts: 0, shadowCompletedRuns: 0, shadowPhase: false, condemned: false,
  autoRecoveryAttempt: 0,
};

export let gpuReadyForProduction = false;
export let gpuShadowMode = false;

export function setServiceReadiness(stage: 'stt' | 'llm' | 'tts', patch: Partial<ServiceReadinessState>): void {
  gpuReadinessState[stage] = { ...gpuReadinessState[stage], ...patch };
}

export function setGpuReadinessState(patch: Partial<GpuReadinessState>): void {
  gpuReadinessState = { ...gpuReadinessState, ...patch };
}

export function setGpuReadyForProduction(v: boolean): void { gpuReadyForProduction = v; }
export function setGpuShadowMode(v: boolean): void { gpuShadowMode = v; }

export function resetGpuReadinessState(): void {
  gpuReadinessState = {
    stt: _defaultServiceState(), llm: _defaultServiceState(), tts: _defaultServiceState(),
    repechageAttempts: 0, shadowCompletedRuns: 0, shadowPhase: false, condemned: false,
    autoRecoveryAttempt: 0,
  };
  gpuReadyForProduction = false;
  gpuShadowMode = false;
  resetPerStageLatencyRings();
}

// ── Per-Stage P95 Ring Buffers ────────────────────────────────────────────────
// 20-sample ring buffer per stage for continuous P95 monitoring.

const PER_STAGE_RING_SIZE = 20;
const MIN_PER_STAGE_SAMPLES = 5;

export const perStageLatencyRing: Record<'stt' | 'llm' | 'tts', number[]> = {
  stt: [], llm: [], tts: [],
};

const perStageRingIdx: Record<string, number> = {};

export function recordPerStageLatency(stage: 'stt' | 'llm' | 'tts', ms: number): void {
  const ring = perStageLatencyRing[stage];
  const key = stage;
  if (!perStageRingIdx[key]) perStageRingIdx[key] = 0;

  if (ring.length < PER_STAGE_RING_SIZE) {
    ring.push(ms);
  } else {
    const idx = perStageRingIdx[key] % PER_STAGE_RING_SIZE;
    ring[idx] = ms;
  }
  perStageRingIdx[key]++;
}

export function getPerStageP95(stage: 'stt' | 'llm' | 'tts'): number | null {
  const ring = perStageLatencyRing[stage];
  if (ring.length < MIN_PER_STAGE_SAMPLES) return null;
  const sorted = [...ring].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Per-stage GPU latency check. Returns true if the GPU's P95 for this
 * specific stage is acceptable. Used by the per-stage auto-swap routing
 * in ai-handlers.ts to independently route STT/LLM/TTS to GPU or cloud.
 *
 * Target thresholds come from the active profile's latencyTargetsMs (set
 * in config-persistence.ts). If no per-stage target is set, falls back to
 * the global GPU_P95_THRESHOLD_MS (3000ms).
 */
export function isStageLatencyAcceptable(stage: 'stt' | 'llm' | 'tts'): boolean {
  const p95 = getPerStageP95(stage);
  if (p95 === null) return true; // not enough data — give GPU a chance

  const GPU_P95_THRESHOLD_MS = 3_000;

  // Try to read profile-specific target from deploy settings
  let target: number;
  try {
    const { getSttTargetLatencyMs, getLlmTargetLatencyMs, getTtsTargetLatencyMs } =
      require('../../gpu-providers/deploy-settings');
    const targets: Record<string, () => number> = {
      stt: getSttTargetLatencyMs,
      llm: getLlmTargetLatencyMs,
      tts: getTtsTargetLatencyMs,
    };
    // Use 2x the target as the "acceptable" threshold — the target itself is
    // for readiness gating (strict), the auto-swap threshold should be looser
    // to avoid oscillation between GPU and cloud on small spikes.
    target = (targets[stage]?.() ?? GPU_P95_THRESHOLD_MS) * 2;
  } catch {
    target = GPU_P95_THRESHOLD_MS;
  }

  return p95 < target;
}

export function resetPerStageLatencyRings(): void {
  perStageLatencyRing.stt.length = 0;
  perStageLatencyRing.llm.length = 0;
  perStageLatencyRing.tts.length = 0;
  perStageRingIdx.stt = 0;
  perStageRingIdx.llm = 0;
  perStageRingIdx.tts = 0;
}

// ── Per-model warmth from GPU pod /health response ──────────────────────────

export interface ModelWarmthEntry {
  warm: boolean;
  firstLatencyMs: number | null;
  avgLatencyMs: number | null;
  requests: number;
}

export interface GpuModelWarmth {
  stt: ModelWarmthEntry;
  llm: ModelWarmthEntry;
  tts: ModelWarmthEntry;
  updatedAt: number; // timestamp of last health check
}

const _defaultEntry = (): ModelWarmthEntry => ({ warm: false, firstLatencyMs: null, avgLatencyMs: null, requests: 0 });

export let gpuModelWarmth: GpuModelWarmth = {
  stt: _defaultEntry(), llm: _defaultEntry(), tts: _defaultEntry(), updatedAt: 0,
};

/** Update warmth state from GPU pod /health response.
 *  Supports two formats:
 *  - `model_warmth: { stt: { warm, first_latency_ms, avg_latency_ms, requests }, ... }`
 *  - `services: { whisper: "loaded", llama_cpp: "ready", tts: "loaded" }`
 */
export function updateGpuModelWarmth(healthData: Record<string, any>): void {
  const mw = healthData?.model_warmth;
  if (mw) {
    for (const stage of ['stt', 'llm', 'tts'] as const) {
      const src = mw[stage];
      if (!src) continue;
      gpuModelWarmth[stage] = {
        warm: !!src.warm,
        firstLatencyMs: src.first_latency_ms ?? null,
        avgLatencyMs: src.avg_latency_ms ?? null,
        requests: src.requests ?? 0,
      };
    }
    gpuModelWarmth.updatedAt = Date.now();
    const warmStages = (['stt', 'llm', 'tts'] as const).filter(s => gpuModelWarmth[s].warm);
    if (warmStages.length > 0) {
      log.log(`GPU models warm: ${warmStages.join(', ')} (${warmStages.length}/3)`);
    }
  } else if (healthData?.services) {
    // Derive warmth from services status (e.g. {whisper: "loaded", llama_cpp: "ready", tts: "loaded"})
    const svc = healthData.services;
    const serviceWarmMap: Record<string, 'stt' | 'llm' | 'tts'> = {
      whisper: 'stt',
      llama_cpp: 'llm',
      tts: 'tts',
    };
    // Map service status -> per-service readiness phase
    const STATUS_TO_PHASE: Record<string, ServiceReadinessPhase> = {
      downloading: 'downloading', loading: 'loading', starting: 'loading',
      compiling: 'compiling', warming: 'warming',
      loaded: 'ready', ready: 'ready', disabled: 'idle',
      failed: 'failed', error: 'failed',
    };

    for (const [svcName, stage] of Object.entries(serviceWarmMap)) {
      const status = svc[svcName] as string | undefined;
      if (status) {
        const isWarm = status === 'loaded' || status === 'ready';
        if (isWarm && !gpuModelWarmth[stage].warm) {
          gpuModelWarmth[stage] = {
            warm: true,
            firstLatencyMs: gpuModelWarmth[stage].firstLatencyMs,
            avgLatencyMs: gpuModelWarmth[stage].avgLatencyMs,
            requests: gpuModelWarmth[stage].requests,
          };
        }

        // Update per-service readiness phase (only for loading states — don't override benchmark/shadow)
        const newPhase = STATUS_TO_PHASE[status];
        const currentPhase = gpuReadinessState[stage].phase;
        const isLoadingPhase = ['idle', 'downloading', 'loading', 'compiling', 'warming'].includes(currentPhase);
        if (newPhase && isLoadingPhase) {
          setServiceReadiness(stage, {
            phase: newPhase,
            loadDetail: `${svcName}: ${status}`,
            phaseStartedAt: gpuReadinessState[stage].phaseStartedAt || Date.now(),
          });
        }
      }
    }
    gpuModelWarmth.updatedAt = Date.now();
    const warmStages = (['stt', 'llm', 'tts'] as const).filter(s => gpuModelWarmth[s].warm);
    if (warmStages.length > 0) {
      log.log(`GPU models warm: ${warmStages.join(', ')} (${warmStages.length}/3)`);
    }
  }
}

export function resetGpuModelWarmth(): void {
  gpuModelWarmth = { stt: _defaultEntry(), llm: _defaultEntry(), tts: _defaultEntry(), updatedAt: 0 };
}

export function isStageWarm(stage: 'stt' | 'llm' | 'tts'): boolean {
  return gpuModelWarmth[stage].warm;
}

/** Per-stage average latency from GPU pod health data. Returns null if < 3 requests. */
export function getStageAvgLatency(stage: 'stt' | 'llm' | 'tts'): number | null {
  const entry = gpuModelWarmth[stage];
  return (entry.requests >= 3 && entry.avgLatencyMs !== null) ? entry.avgLatencyMs : null;
}

// Legacy aliases for backward compat
export function isTtsWarm(): boolean { return gpuModelWarmth.tts.warm; }

// ── TTS Warmth Tracking ─────────────────────────────────────────────────────
// Tracks whether the GPU TTS model has completed CUDA graph compilation.
// Cold start (first inference) takes ~11-16s; warm TTFB is ~230ms.
// Used to route TTS: cold GPU -> cloud fallback; warm GPU -> GPU streaming.

export interface TtsWarmthState {
  warm: boolean;
  warmSince: number;
  lastTtsRequestAt: number;
  coldTtfbMs: number | null;
  warmTtfbMs: number | null;
}

export let ttsWarmth: TtsWarmthState = {
  warm: false, warmSince: 0, lastTtsRequestAt: 0,
  coldTtfbMs: null, warmTtfbMs: null,
};

export function markTtsWarm(coldTtfbMs?: number): void {
  if (ttsWarmth.warm) return;
  ttsWarmth.warm = true;
  ttsWarmth.warmSince = Date.now();
  if (coldTtfbMs !== undefined) ttsWarmth.coldTtfbMs = coldTtfbMs;
  gpuModelWarmth.tts.warm = true;
  gpuModelWarmth.tts.firstLatencyMs = coldTtfbMs ?? null;
  log.log(`GPU TTS warm (cold TTFB was ${coldTtfbMs ?? '?'}ms)`);
}

export function recordTtsTtfb(ttfbMs: number): void {
  ttsWarmth.lastTtsRequestAt = Date.now();
  if (ttsWarmth.warm) {
    ttsWarmth.warmTtfbMs = ttsWarmth.warmTtfbMs === null
      ? ttfbMs
      : Math.round(ttsWarmth.warmTtfbMs * 0.7 + ttfbMs * 0.3);
  }
}

export function resetTtsWarmth(): void {
  ttsWarmth = { warm: false, warmSince: 0, lastTtsRequestAt: 0, coldTtfbMs: null, warmTtfbMs: null };
  resetGpuModelWarmth();
}

export function setTtsWarmth(v: TtsWarmthState) { ttsWarmth = v; }

// ── Cold Start Profiles (persisted) ─────────────────────────────────────────
// Auto-saved benchmarks per GPU type + model. Used to predict cold start time
// and decide whether to use cloud fallback while GPU warms up.

const COLD_START_PROFILES_FILE = join(BABELCAST_DIR, 'tts_cold_start_profiles.json');

export interface ColdStartProfile {
  gpuType: string;       // e.g. "NVIDIA GeForce RTX 5080"
  dockerImage: string;   // e.g. "marcosremar/babelcast-mistral:latest"
  provider: string;      // e.g. "runpod", "vast", "tensordock", "modal"
  coldTtfbMs: number;
  warmTtfbAvgMs: number;
  modelLoadMs: number;
  measuredAt: number;    // timestamp
  sampleCount: number;   // number of warm samples
}

/** Composite key for profile lookup: dockerImage|gpuType|provider */
function profileKey(p: { dockerImage: string; gpuType: string; provider: string }): string {
  return `${p.dockerImage}|${p.gpuType}|${p.provider}`;
}

export function loadColdStartProfiles(): ColdStartProfile[] {
  try {
    if (!existsSync(COLD_START_PROFILES_FILE)) return [];
    return JSON.parse(readFileSync(COLD_START_PROFILES_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

export function saveColdStartProfile(profile: ColdStartProfile): void {
  try {
    mkdirSync(BABELCAST_DIR, { recursive: true });
    const profiles = loadColdStartProfiles();
    const key = profileKey(profile);
    const idx = profiles.findIndex(p => profileKey(p) === key);
    if (idx >= 0) {
      profiles[idx] = profile;
    } else {
      profiles.push(profile);
    }
    writeFileSync(COLD_START_PROFILES_FILE, JSON.stringify(profiles, null, 2));
    log.log(`Saved profile: ${profile.provider}/${profile.gpuType} (${profile.dockerImage}) — cold=${profile.coldTtfbMs}ms warm=${profile.warmTtfbAvgMs}ms`);
  } catch (err) {
    log.warn(`Failed to save profile: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Find saved cold start profile for current deploy config.
 * Tries exact match (image+gpu+provider), then partial matches.
 */
export function getColdStartProfile(gpuType: string, dockerImage?: string, provider?: string): ColdStartProfile | null {
  const profiles = loadColdStartProfiles();
  if (!profiles.length) return null;

  // 1. Exact match: same image + GPU + provider
  if (dockerImage && provider) {
    const exact = profiles.find(p => p.dockerImage === dockerImage && p.gpuType === gpuType && p.provider === provider);
    if (exact) return exact;
  }

  // 2. Same image + GPU (any provider) — different providers have similar cold start
  if (dockerImage) {
    const imageGpu = profiles.find(p => p.dockerImage === dockerImage && p.gpuType === gpuType);
    if (imageGpu) return imageGpu;
  }

  // 3. Same GPU + any image on same provider — rough estimate
  if (provider) {
    const gpuProvider = profiles.find(p => p.gpuType === gpuType && p.provider === provider);
    if (gpuProvider) return gpuProvider;
  }

  // 4. Same GPU type (any image/provider) — last resort
  return profiles.find(p => p.gpuType === gpuType) || null;
}
