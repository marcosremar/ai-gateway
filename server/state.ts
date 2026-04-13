// ── BabelCast Gateway — Shared Mutable State ─────────────────────────────────
// All shared mutable state + state mutation helpers.
// Other modules import and directly mutate these variables.

import { deploymentSM } from './deployment-state-machine';
export { deploymentSM };

import type { Server } from 'http';
import type { ProviderName } from '../src/gpu-providers/deploy-orchestrator';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, renameSync } from 'fs';

// PostgreSQL via DATABASE_URL (Neon serverless pooler)
// Optional: gateway works without DB (GPU events logged to file instead).
// No-op proxy: any prisma.table.method() call resolves silently.
const _noopPrisma: any = new Proxy({}, {
  get: (_t, _p) => new Proxy({}, {
    get: (_t2, m) => (..._a: unknown[]) => Promise.resolve(m === 'findMany' ? [] : null),
  }),
});
export let prisma: any = _noopPrisma;
/** Replace the no-op prisma with a real client. Called by prisma-init.ts. */
export function setPrisma(p: any): void { prisma = p; }

export const startedAt = Date.now();
export let activeRequests = 0;
export let gatewayServer: Server | null = null;

// ── In-memory metrics ───────────────────────────────────────────────────────

export const LATENCY_RING_SIZE = 1000;
export const latencyRing: number[] = [];
export let latencyRingIdx = 0;
export const metricsCounters = {
  requestsTotal: 0,
  errorsTotal: 0,
  dbLogFailures: 0,
  byStage: {} as Record<string, number>,
  byProvider: {} as Record<string, number>,
  totalInputTokens: 0,
  totalOutputTokens: 0,
};
export let pendingDbWrites = 0;
export let consecutiveDbFailures = 0;
export const DB_FAILURE_WARN_THRESHOLD = 10;

// ── Budget tracking ──────────────────────────────────────────────────────────
//
// Historical gotcha: 2026-03-25 saw a $130 daily spend even though the cap
// was $50. Root cause: the cap was only enforced *inside* the monitor loop
// of an already-running pod. Nothing prevented new deploys from starting
// when current spend was already near cap. The fix is canAffordDeploy()
// which projects the new deploy's cost against the cap BEFORE the deploy
// path touches any provider client. See P0-1 in docs/improvement-plan.md.

const _parsedBudget = process.env.DAILY_BUDGET_USD ? parseFloat(process.env.DAILY_BUDGET_USD) : 0;
if (process.env.DAILY_BUDGET_USD && isNaN(_parsedBudget)) {
  console.warn(`[gateway] Warning: DAILY_BUDGET_USD="${process.env.DAILY_BUDGET_USD}" is not a valid number, defaulting to 0 (no limit)`);
}
export const DAILY_BUDGET_USD = isNaN(_parsedBudget) ? 0 : _parsedBudget; // 0 = no limit
export let dailyGpuSpendUsd = 0;
export let dailySpendResetDate = new Date().toDateString();

/** Default estimated cost of a new deploy if the caller doesn't pass one. */
const DEFAULT_ESTIMATED_DEPLOY_COST_USD = 2;

/**
 * Structured budget decision returned by canAffordDeploy(). Callers should
 * inspect `allowed` and emit `reason` in the deploy_rejected lifecycle event.
 */
export interface BudgetDecision {
  allowed: boolean;
  currentSpend: number;
  projected: number;
  cap: number;
  reason?: 'no_cap' | 'under_cap' | 'soft_limit_exceeded' | 'hard_limit_exceeded';
}

/**
 * Check whether a new deploy with the given estimated cost would fit under
 * the daily spend cap. This is the single authoritative gate — every code
 * path that starts a new GPU deploy must call this before touching a
 * provider client.
 *
 * @param estimatedCostUsd upper-bound estimate of what the new deploy
 *   will consume before the next monitor tick catches it. A reasonable
 *   default is 2 USD (one hour at typical 4090 spot price).
 * @returns BudgetDecision with structured reason codes
 */
export function canAffordDeploy(estimatedCostUsd: number = DEFAULT_ESTIMATED_DEPLOY_COST_USD): BudgetDecision {
  const cap = DAILY_BUDGET_USD;
  const currentSpend = dailyGpuSpendUsd;
  const projected = currentSpend + estimatedCostUsd;

  // Cap of 0 = no limit set, always allow.
  if (cap <= 0) {
    return { allowed: true, currentSpend, projected, cap, reason: 'no_cap' };
  }

  // Hard limit: projected spend would exceed the cap entirely. Refuse.
  if (projected > cap) {
    return { allowed: false, currentSpend, projected, cap, reason: 'hard_limit_exceeded' };
  }

  // Soft limit: already at ≥80% of cap. Refuse new deploys but don't
  // interrupt running pods. The threshold of 0.8 matches the monitor-loop
  // soft-limit threshold so both paths agree.
  if (currentSpend / cap >= 0.8) {
    return { allowed: false, currentSpend, projected, cap, reason: 'soft_limit_exceeded' };
  }

  return { allowed: true, currentSpend, projected, cap, reason: 'under_cap' };
}

// ── Provider performance metrics ─────────────────────────────────────────────

export const providerMetrics: Record<string, {
  requests: number; totalLatencyMs: number; errors: number;
  inputTokens: number; outputTokens: number;
}> = {};

// ── GPU Deployment State ─────────────────────────────────────────────────────

export interface DeploymentState {
  status: 'idle' | 'stopped' | 'searching' | 'queued' | 'creating' | 'booting' | 'installing' | 'ready' | 'error';
  podId: string;
  endpoint: string;
  gpuType: string;
  dockerImage: string;  // e.g. "marcosremar/babelcast-mistral:latest"
  message: string;
  step: string;       // structured step: 'searching_offers' | 'no_offers' | 'queued' | 'creating_pod' | 'pulling_image' | 'starting_container' | 'downloading_models' | 'loading_stt' | 'loading_llm' | 'loading_tts' | 'compiling_tts' | 'waiting_health' | 'draining' | 'ready'
  stepDetail: string;  // e.g. image name, GPU type, cost
  startedAt: number;
  retryCount: number;
  provider: ProviderName | '';
  alert: string;       // e.g. "RunPod blocked, using Vast.ai fallback"
  sshHost: string;
  sshPort: number;
  lastLogs: string;    // last fetched remote logs (persisted across status changes)
  deployDurationMs: number;  // time from deploy start to ready
  costPerHr: number;         // last known hourly cost for budget tracking
  providerMeta: Record<string, unknown>;  // host-level metadata for reputation tracking
  /** Ordered log of state transitions with timestamps — for UI timeline and debugging */
  transitions: Array<{ status: string; step: string; provider: string; ts: number; elapsed: number; detail?: string }>;
}

export let deployState: DeploymentState = {
  status: 'idle', podId: '', endpoint: '', gpuType: '', dockerImage: '', message: '', step: '', stepDetail: '', startedAt: 0, retryCount: 0, provider: '', alert: '', sshHost: '', sshPort: 0, lastLogs: '', deployDurationMs: 0, costPerHr: 0, providerMeta: {}, transitions: [],
};
export let deployCancelled = false;
export let deployLock = false;
export let deployPromise: Promise<void> | null = null;  // tracks in-flight deploy for clean cancellation

// ── Standby GPU State ─────────────────────────────────────────────────────────

export interface StandbyDeployState {
  status: 'idle' | 'deploying' | 'benchmarking' | 'ready' | 'handover' | 'error';
  podId: string;
  endpoint: string;
  gpuType: string;
  dockerImage: string;
  provider: string;
  startedAt: number;
  triggeredReason: 'manual' | 'session_duration' | 'latency_degradation' | '';
  message: string;
  costPerHr: number;
  step: string;
}

export let standbyDeployState: StandbyDeployState = {
  status: 'idle', podId: '', endpoint: '', gpuType: '', dockerImage: '',
  provider: '', startedAt: 0, triggeredReason: '', message: '', costPerHr: 0, step: '',
};

export function setStandbyDeployState(patch: Partial<StandbyDeployState>): void {
  standbyDeployState = { ...standbyDeployState, ...patch };
}

export function resetStandbyDeployState(): void {
  standbyDeployState = {
    status: 'idle', podId: '', endpoint: '', gpuType: '', dockerImage: '',
    provider: '', startedAt: 0, triggeredReason: '', message: '', costPerHr: 0, step: '',
  };
}

/** When 'standby', setDeployState() writes to standbyDeployState instead of deployState. */
export let deployTarget: 'primary' | 'standby' = 'primary';
export function setDeployTarget(t: 'primary' | 'standby'): void { deployTarget = t; }

// GPU health & routing state
export let deployApiKey = '';
export let deployVastApiKey = '';
export let deployTensordockApiKey = '';
export let deployTensordockAuthId = '';
export let deployModalApiKey = '';
export let activeProvider: ProviderName | '' = '';
export let gpuHealthy = false;
export let lastRequestTime = 0;
export let monitorInterval: Timer | null = null;

// ── Active deploy persistence ────────────────────────────────────────────────
// Persists active deploy to ~/.babelcast/active_deploy.json so we can reconnect
// to running GPU pods after gateway restart.

const BABELCAST_DIR = join(homedir(), '.babelcast');
const ACTIVE_DEPLOY_FILE = join(BABELCAST_DIR, 'active_deploy.json');

interface PersistedDeploy {
  podId: string;
  endpoint: string;
  gpuType: string;
  dockerImage: string;
  provider: string;
  costPerHr: number;
  startedAt: number;
  sshHost: string;
  sshPort: number;
  providerMeta: Record<string, unknown>;
  savedAt: number;
  /** When set, indicates this is a stopped (paused) pod that can be resumed. */
  stoppedAt?: number;
}

function persistDeployState(): void {
  // Only persist states where a pod exists
  if (!deployState.podId) return;
  // Persist running pods (ready/booting/installing) and stopped pods (resumable)
  const isStopped = deployState.status === 'stopped';
  if (!isStopped && !deployState.endpoint) return;
  if (!isStopped && deployState.status !== 'ready' && deployState.status !== 'booting' && deployState.status !== 'installing') return;
  try {
    mkdirSync(BABELCAST_DIR, { recursive: true });
    const data: PersistedDeploy = {
      podId: deployState.podId,
      endpoint: deployState.endpoint,
      gpuType: deployState.gpuType,
      dockerImage: deployState.dockerImage,
      provider: deployState.provider,
      costPerHr: deployState.costPerHr,
      startedAt: deployState.startedAt,
      sshHost: deployState.sshHost,
      sshPort: deployState.sshPort,
      providerMeta: deployState.providerMeta ?? {},
      savedAt: Date.now(),
      ...(isStopped ? { stoppedAt: Date.now() } : {}),
    };
    // Atomic write: write to temp file then rename, so a crash mid-write
    // never corrupts the active deploy file.
    const tmpFile = ACTIVE_DEPLOY_FILE + '.tmp';
    writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    renameSync(tmpFile, ACTIVE_DEPLOY_FILE);
  } catch (e) {
    console.warn('[gpu] Failed to persist deploy state:', e instanceof Error ? e.message : e);
  }
}

export function clearPersistedDeploy(): void {
  try {
    if (existsSync(ACTIVE_DEPLOY_FILE)) unlinkSync(ACTIVE_DEPLOY_FILE);
    // Clean up stale temp file too
    const tmpFile = ACTIVE_DEPLOY_FILE + '.tmp';
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
  } catch (e) {
    console.warn('[gpu] Failed to clear persisted deploy:', e instanceof Error ? e.message : e);
  }
}

export function loadPersistedDeploy(): PersistedDeploy | null {
  try {
    if (!existsSync(ACTIVE_DEPLOY_FILE)) return null;
    const raw = readFileSync(ACTIVE_DEPLOY_FILE, 'utf-8');
    const data = JSON.parse(raw) as PersistedDeploy;
    // Reject stale records — stopped pods expire faster (2h = auto-destroy window),
    // running pods expire after 6h.
    const maxAgeMs = data.stoppedAt ? 2 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
    if (Date.now() - data.savedAt > maxAgeMs) {
      console.log(`[gpu] Persisted deploy too old (>${data.stoppedAt ? '2h stopped' : '6h running'}), ignoring`);
      clearPersistedDeploy();
      return null;
    }
    if (!data.podId || !data.endpoint) return null;
    return data;
  } catch (e) {
    console.warn('[gpu] Failed to load persisted deploy:', e instanceof Error ? e.message : e);
    return null;
  }
}

export function setDeployState(patch: Partial<DeploymentState>) {
  if (deployTarget === 'standby') {
    // Route to standby state during standby deploy — do NOT persist to active_deploy.json
    const mapped: Partial<StandbyDeployState> = {};
    if (patch.status !== undefined) {
      if (patch.status === 'ready') mapped.status = 'benchmarking';
      else if (patch.status === 'error') mapped.status = 'error';
      else if (patch.status === 'idle') mapped.status = 'idle';
      else mapped.status = 'deploying';
    }
    if (patch.podId !== undefined) mapped.podId = patch.podId;
    if (patch.endpoint !== undefined) mapped.endpoint = patch.endpoint;
    if (patch.gpuType !== undefined) mapped.gpuType = patch.gpuType;
    if (patch.dockerImage !== undefined) mapped.dockerImage = patch.dockerImage;
    if (patch.provider !== undefined) mapped.provider = patch.provider as string;
    if (patch.startedAt !== undefined) mapped.startedAt = patch.startedAt;
    if (patch.message !== undefined) mapped.message = patch.message;
    if (patch.costPerHr !== undefined) mapped.costPerHr = patch.costPerHr;
    if (patch.step !== undefined) mapped.step = patch.step;
    standbyDeployState = { ...standbyDeployState, ...mapped };
    return; // don't update primary deployState or persist
  }
  if (deployCancelled && patch.status !== 'idle') return; // don't update after cancel

  // Record state transition when status or step changes
  const prevStatus = deployState.status;
  const prevStep = deployState.step;
  Object.assign(deployState, patch);

  const newStatus = deployState.status;
  const newStep = deployState.step;
  if (newStatus !== prevStatus || newStep !== prevStep) {
    const elapsed = deployState.startedAt > 0 ? Math.round((Date.now() - deployState.startedAt) / 1000) : 0;
    deployState.transitions.push({
      status: newStatus, step: newStep, provider: deployState.provider || '',
      ts: Date.now(), elapsed,
      detail: deployState.gpuType || deployState.message?.slice(0, 60),
    });
    // Keep last 30 transitions (splice in-place instead of allocating new array)
    if (deployState.transitions.length > 30) deployState.transitions.splice(0, deployState.transitions.length - 30);
    // Broadcast transition for real-time UI
    try { const { broadcastWs: bws } = require('./ws-state'); bws?.({ type: 'gpu:transition', status: newStatus, step: newStep, provider: deployState.provider, elapsed, gpuType: deployState.gpuType, detail: deployState.message?.slice(0, 80) }); } catch (e) { console.warn('[state] broadcastWs failed:', e instanceof Error ? e.message : e); }
  }

  console.log(`[gpu] ${deployState.status}: ${deployState.message}`);
  // Persist to disk so we can reconnect after restart
  persistDeployState();
}

export function resetDeployState() {
  deployCancelled = true;
  deployApiKey = '';
  deployVastApiKey = '';
  deployTensordockApiKey = '';
  deployTensordockAuthId = '';
  deployModalApiKey = '';
  activeProvider = '';
  deployState = { status: 'idle', podId: '', endpoint: '', gpuType: '', dockerImage: '', message: '', step: '', stepDetail: '', startedAt: 0, retryCount: 0, provider: '', alert: '', sshHost: '', sshPort: 0, lastLogs: '', deployDurationMs: 0, costPerHr: 0, providerMeta: {}, transitions: [] };
  clearPersistedDeploy();
  resetTtsWarmth(); // new pod = cold TTS
  resetGpuReadinessState();
}

export function touchRequest() {
  lastRequestTime = Date.now();
}

// ── Model-request idle tracking (GPU auto-shutdown) ──────────────────────────
// Only updated when actual AI work happens (STT / LLM / TTS / pipeline).
// Health checks, status polls, and admin endpoints do NOT count.
export let lastModelRequestTime = 0;
export function touchModelRequest() {
  lastModelRequestTime = Date.now();
  // Reset idle-related state in gpu-deploy (lazy import to avoid circular deps)
  try { const { resetIdleState } = require('./gpu-deploy'); resetIdleState?.(); } catch (e) { console.warn('[state] resetIdleState failed:', e instanceof Error ? e.message : e); }
  // Auto-resume: if a stopped GPU pod exists, transparently resume it (or fall
  // back to fresh deploy) when a new AI request arrives. Fire-and-forget —
  // the caller gets a "booting" status and retries on the next poll.
  try {
    const { deploymentSM } = require('./deployment-state-machine');
    if (deploymentSM.isStopped) {
      const { resumeOrDeploy } = require('./gpu-deploy');
      resumeOrDeploy({ reason: 'autoscaler' }).catch((err: unknown) =>
        console.error(`[gpu] Auto-resume failed: ${err instanceof Error ? err.message : err}`)
      );
    }
  } catch (e) { console.warn('[state] auto-resume failed:', e instanceof Error ? e.message : e); }
}
export function setLastModelRequestTime(v: number) { lastModelRequestTime = v; }

export function isGpuAvailable(): boolean {
  return deployState.status === 'ready' && gpuHealthy && !!deployState.endpoint;
}

// ── Latency-based GPU routing ───────────────────────────────────────────────

/** P95 latency threshold: if GPU P95 exceeds this, prefer cloud providers. */
const GPU_P95_THRESHOLD_MS = 3_000;
/** Minimum samples before latency-based routing kicks in. */
const MIN_LATENCY_SAMPLES = 5;

/**
 * Compute P95 latency from the latency ring buffer.
 * Returns null if not enough samples.
 * Cached for 5s to avoid O(n log n) sort on every request.
 */
let _p95Cache: number | null = null;
let _p95CacheTime = 0;
let _p95CacheSampleCount = 0;
const P95_CACHE_TTL_MS = 5_000;

export function getP95Latency(): number | null {
  if (latencyRing.length < MIN_LATENCY_SAMPLES) return null;
  const now = Date.now();
  // Return cached value if still fresh and sample count hasn't changed
  if (_p95Cache !== null && now - _p95CacheTime < P95_CACHE_TTL_MS && _p95CacheSampleCount === latencyRing.length) {
    return _p95Cache;
  }
  const sorted = [...latencyRing].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  _p95Cache = sorted[Math.max(0, idx)];
  _p95CacheTime = now;
  _p95CacheSampleCount = latencyRing.length;
  return _p95Cache;
}

/**
 * Record a GPU request latency sample.
 */
export function recordGpuLatency(ms: number): void {
  if (latencyRing.length < LATENCY_RING_SIZE) {
    latencyRing.push(ms);
  } else {
    latencyRing[latencyRingIdx] = ms;
    setLatencyRingIdx((latencyRingIdx + 1) % LATENCY_RING_SIZE);
  }
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
 *
 * Example: if GPU STT P95 = 4000ms but LLM P95 = 500ms:
 *   isStageLatencyAcceptable('stt') → false (STT goes to cloud)
 *   isStageLatencyAcceptable('llm') → true  (LLM stays on GPU)
 */
export function isStageLatencyAcceptable(stage: 'stt' | 'llm' | 'tts'): boolean {
  const p95 = getPerStageP95(stage);
  if (p95 === null) return true; // not enough data — give GPU a chance

  // Try to read profile-specific target from deploy settings
  let target: number;
  try {
    const { getSttTargetLatencyMs, getLlmTargetLatencyMs, getTtsTargetLatencyMs } =
      require('../src/gpu-providers/deploy-settings');
    const targets: Record<string, () => number> = {
      stt: getSttTargetLatencyMs,
      llm: getLlmTargetLatencyMs,
      tts: getTtsTargetLatencyMs,
    };
    // Use 2× the target as the "acceptable" threshold — the target itself is
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

/**
 * Whether GPU should be preferred over cloud based on recent latency.
 * Returns true if: GPU is available AND (not enough data OR P95 is under threshold).
 */
export function isGpuLatencyAcceptable(): boolean {
  const p95 = getP95Latency();
  if (p95 === null) return true; // not enough data — give GPU a chance
  return p95 < GPU_P95_THRESHOLD_MS;
}

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

export let standbyGpuHealthy = false;
export let standbyReadyForHandover = false;
export function setStandbyGpuHealthy(v: boolean): void { standbyGpuHealthy = v; }
export function setStandbyReadyForHandover(v: boolean): void { standbyReadyForHandover = v; }

export function setServiceReadiness(stage: 'stt' | 'llm' | 'tts', patch: Partial<ServiceReadinessState>): void {
  gpuReadinessState[stage] = { ...gpuReadinessState[stage], ...patch };
}

export function setGpuReadinessState(patch: Partial<GpuReadinessState>): void {
  gpuReadinessState = { ...gpuReadinessState, ...patch };
}

export function setGpuReadyForProduction(v: boolean): void { gpuReadyForProduction = v; }
export function setGpuShadowMode(v: boolean): void { gpuShadowMode = v; }

export function isGpuReadyForProduction(): boolean {
  return deployState.status === 'ready' && gpuHealthy && !!deployState.endpoint && gpuReadyForProduction;
}

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

// These mutate translationProfile which lives in providers.ts.
// They are defined here but import translationProfile from providers.ts.
// To avoid circular deps, the actual mark functions are defined in providers.ts
// and re-exported from there. See providers.ts for markGpuUnhealthy/markGpuHealthy.

// ── TTS Warmth Tracking ─────────────────────────────────────────────────────
// Tracks whether the GPU TTS model has completed CUDA graph compilation.
// Cold start (first inference) takes ~11-16s; warm TTFB is ~230ms.
// Used to route TTS: cold GPU → cloud fallback; warm GPU → GPU streaming.

// Per-model warmth from GPU pod /health response
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
      console.log(`[warmth] GPU models warm: ${warmStages.join(', ')} (${warmStages.length}/3)`);
    }
  } else if (healthData?.services) {
    // Derive warmth from services status (e.g. {whisper: "loaded", llama_cpp: "ready", tts: "loaded"})
    const svc = healthData.services;
    const serviceWarmMap: Record<string, 'stt' | 'llm' | 'tts'> = {
      whisper: 'stt',
      llama_cpp: 'llm',
      tts: 'tts',
    };
    // Map service status → per-service readiness phase
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
      console.log(`[warmth] GPU models warm: ${warmStages.join(', ')} (${warmStages.length}/3)`);
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

// Legacy TtsWarmthState for existing code
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
  console.log(`[tts-warmth] GPU TTS warm (cold TTFB was ${coldTtfbMs ?? '?'}ms)`);
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
    console.log(`[tts-warmth] Saved profile: ${profile.provider}/${profile.gpuType} (${profile.dockerImage}) — cold=${profile.coldTtfbMs}ms warm=${profile.warmTtfbAvgMs}ms`);
  } catch (err) {
    console.warn(`[tts-warmth] Failed to save profile: ${err instanceof Error ? err.message : err}`);
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

// ── Bot Deployment State ─────────────────────────────────────────────────────

export interface BotDeploymentState {
  status: 'idle' | 'creating' | 'booting' | 'ready' | 'joined' | 'joining' | 'error';
  podId: string;
  endpoint: string;  // http://<pod-ip>:8080
  sshHost: string;
  sshPort: number;
  message: string;
  startedAt: number;
  botId: string;     // UUID for this bot session
  meetingUrl: string;
  webcamRtmpUrl: string;   // rtmp://<pod-ip>:<mapped-1936>/live for Mac webcam push
  youtubeStreamKey: string; // YouTube stream key for server-side streaming
}

export let botState: BotDeploymentState = {
  status: 'idle', podId: '', endpoint: '', sshHost: '', sshPort: 0,
  message: '', startedAt: 0, botId: '', meetingUrl: '',
  webcamRtmpUrl: '', youtubeStreamKey: '',
};
export let botDeployLock = false;
export let botApiKey = '';  // RunPod key used for the bot pod
export let botPodApiKey = '';  // Bearer token for bot HTTP API auth

// ── Deploy session tracking ──────────────────────────────────────────────────

export let activeDeploySessionId: number | null = null;

// Allow mutation from other modules
export function setActiveRequests(v: number) { activeRequests = v; }
export function setGatewayServer(v: Server | null) { gatewayServer = v; }
export function setLatencyRingIdx(v: number) { latencyRingIdx = v; }
export function setPendingDbWrites(v: number) { pendingDbWrites = v; }
export function setConsecutiveDbFailures(v: number) { consecutiveDbFailures = v; }
export function setDailyGpuSpendUsd(v: number) { dailyGpuSpendUsd = v; }
export function setDailySpendResetDate(v: string) { dailySpendResetDate = v; }
export function setDeployCancelled(v: boolean) { deployCancelled = v; }
export function setDeployLock(v: boolean) { deployLock = v; }
export function setDeployPromise(v: Promise<void> | null) { deployPromise = v; }
export function setDeployApiKey(v: string) { deployApiKey = v; }
export function setDeployVastApiKey(v: string) { deployVastApiKey = v; }
export function setDeployTensordockApiKey(v: string) { deployTensordockApiKey = v; }
export function setDeployTensordockAuthId(v: string) { deployTensordockAuthId = v; }
export function setDeployModalApiKey(v: string) { deployModalApiKey = v; }
export function setActiveProvider(v: ProviderName | '') { activeProvider = v; }
export function setGpuHealthy(v: boolean) { gpuHealthy = v; }
export function setLastRequestTime(v: number) { lastRequestTime = v; }
export function setMonitorInterval(v: Timer | null) { monitorInterval = v; }
export function setBotStateVar(v: BotDeploymentState) { botState = v; }
export function setBotDeployLock(v: boolean) { botDeployLock = v; }
export function setBotApiKey(v: string) { botApiKey = v; }
export function setBotPodApiKey(v: string) { botPodApiKey = v; }
export function setActiveDeploySessionId(v: number | null) { activeDeploySessionId = v; }
export function setTtsWarmth(v: TtsWarmthState) { ttsWarmth = v; }

// ── Auto-Swap State ──────────────────────────────────────────────────────────
// Runtime toggle for language auto-swap detection. Broadcasted to Python app via WS.

export let autoSwapEnabled = true;  // on by default

export function setAutoSwapEnabled(v: boolean) {
  autoSwapEnabled = v;
  console.log(`[auto-swap] ${v ? 'enabled' : 'disabled'}`);
}
