// ── GPU Deployment State ─────────────────────────────────────────────────────
// Core deploy state variables, types, and persistence logic.
// Extracted from server/state.ts — Phase 5 DDD migration.

import type { ProviderName } from '../providers/gpu/deploy-orchestrator';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, renameSync } from 'fs';
import { createLogger } from '../../platform/logger';

const log = createLogger('deploy-state');

// ── Deploy state types ──────────────────────────────────────────────────────

export interface DeploymentState {
  status: 'idle' | 'stopped' | 'searching' | 'queued' | 'creating' | 'booting' | 'installing' | 'warming' | 'ready' | 'error';
  podId: string;
  endpoint: string;
  gpuType: string;
  dockerImage: string;  // e.g. "marcosremar/babelcast-mistral:latest"
  message: string;
  step: string;       // structured step: 'searching_offers' | 'no_offers' | 'queued' | 'creating_pod' | 'pulling_image' | 'starting_container' | 'downloading_models' | 'warming_stt' | 'warming_llm' | 'warming_tts' | 'waiting_health' | 'testing_inference' | 'draining' | 'ready'
  stepDetail: string;  // e.g. image name, GPU type, cost
  startedAt: number;
  retryCount: number;
  provider: ProviderName | '';
  alert: string;       // e.g. "RunPod blocked, using Vast.ai fallback"
  alertLevel: 'info' | 'warning' | 'error' | 'critical';  // severity level for UI coloring
  alertHistory: Array<{ level: 'info' | 'warning' | 'error' | 'critical'; message: string; ts: number }>;
  sshHost: string;
  sshPort: number;
  lastLogs: string;    // last fetched remote logs (persisted across status changes)
  deployDurationMs: number;  // time from deploy start to ready
  costPerHr: number;         // last known hourly cost for budget tracking
  providerMeta: Record<string, unknown>;  // host-level metadata for reputation tracking
  /** Ordered log of state transitions with timestamps — for UI timeline and debugging */
  transitions: Array<{ status: string; step: string; provider: string; ts: number; elapsed: number; detail?: string }>;
  /** Pull/download history with attempts and progress tracking */
  pullHistory: Array<{
    image: string;
    attempt: number;
    startedAt: number;
    completedAt?: number;
    bytesDownloaded?: number;
    totalBytes?: number;
    speedMbps?: number;
    status: 'pending' | 'downloading' | 'completed' | 'failed';
    error?: string;
  }>;
  /** Model warming phases tracking */
  warmingStatus: {
    phase: 'idle' | 'stt' | 'llm' | 'tts' | 'complete';
    sttProgress?: { loaded: boolean; modelName: string; loadTimeMs: number };
    llmProgress?: { loaded: boolean; modelName: string; loadTimeMs: number };
    ttsProgress?: { loaded: boolean; modelName: string; loadTimeMs: number };
    startedAt: number;
    completedAt?: number;
  };
  /** Unique deploy correlation ID — set by startDeployLoop, used for idempotency and orphan detection */
  deployId: string;
  /** Live GPU telemetry from /health — 0 means unknown, -1 means unknown (for gpuUtil) */
  gpuTemp: number;
  gpuUtil: number;
  gpuMemUsed: number;
  gpuMemTotal: number;
  /** Vast.ai template hash (tracks current template for snapshot/recreate) */
  templateHashId: string;
  /** Canary deployment controller (when canary mode is enabled) */
  canary?: unknown;
  /** Timer ID for canary evaluation interval (for cleanup) */
  canaryEvalTimer?: ReturnType<typeof setInterval> | null;
  /** Dev mode: pause on idle but never auto-destroy. Set by `gpu dev start`. */
  devMode?: boolean;
  /** Readiness probe mode. 'health' (default) polls HTTP /health; 'ssh' polls TCP port 22. */
  readinessProbe?: 'health' | 'ssh';
  /**
   * How the pod was paused. 'stop' → classic SHUTOFF, resumed via startInstance.
   * 'hibernate' → Hyperstack suspend-to-disk (billing drops to ~10–15%), resumed
   * via hibernateRestore. Undefined when the pod is not paused.
   */
  pausedMode?: 'stop' | 'hibernate';
}

// ── Mutable deploy state ────────────────────────────────────────────────────

export let deployState: DeploymentState = {
  status: 'idle', podId: '', endpoint: '', gpuType: '', dockerImage: '', message: '', step: '', stepDetail: '', startedAt: 0, retryCount: 0, provider: '', alert: '', alertLevel: 'info', alertHistory: [], sshHost: '', sshPort: 0, lastLogs: '', deployDurationMs: 0, costPerHr: 0, providerMeta: {}, transitions: [], pullHistory: [], warmingStatus: { phase: 'idle', startedAt: 0 }, deployId: '', gpuTemp: 0, gpuUtil: -1, gpuMemUsed: 0, gpuMemTotal: 0, templateHashId: '',
};
export let deployCancelled = false;
export let deployLock = false;
export let deployPromise: Promise<void> | null = null;  // tracks in-flight deploy for clean cancellation

// GPU health & routing state
export let deployApiKey = '';
export let deployVastApiKey = '';
export let deployTensordockApiKey = '';
export let deployTensordockAuthId = '';
export let deployModalApiKey = '';
export let deployHyperstackApiKey = '';
export let activeProvider: ProviderName | '' = '';
export let gpuHealthy = false;

// ── Setters for mutable state ───────────────────────────────────────────────

export function setDeployCancelled(v: boolean) { deployCancelled = v; }
export function setDeployLock(v: boolean) { deployLock = v; }
export function setDeployPromise(v: Promise<void> | null) { deployPromise = v; }
export function setDeployApiKey(v: string) { deployApiKey = v; }
export function setDeployVastApiKey(v: string) { deployVastApiKey = v; }
export function setDeployTensordockApiKey(v: string) { deployTensordockApiKey = v; }
export function setDeployTensordockAuthId(v: string) { deployTensordockAuthId = v; }
export function setDeployModalApiKey(v: string) { deployModalApiKey = v; }
export function setDeployHyperstackApiKey(v: string) { deployHyperstackApiKey = v; }
export function setActiveProvider(v: ProviderName | '') { activeProvider = v; }
export function setGpuHealthy(v: boolean) { gpuHealthy = v; }

// ── Active deploy persistence ────────────────────────────────────────────────
// Persists active deploy to ~/.babelcast/active_deploy.json so we can reconnect
// to running GPU pods after gateway restart.

const BABELCAST_DIR = join(homedir(), '.babelcast');
const ACTIVE_DEPLOY_FILE = join(BABELCAST_DIR, 'active_deploy.json');

export interface PersistedDeploy {
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
  /** Deploy status at the time of persistence — used by startup orphan detection
   * to distinguish "mid-deploy crash" (booting/installing) from "restart a healthy
   * pod" (ready). Not historically present; older files will be missing this. */
  status?: DeploymentState['status'];
  /** When set, indicates this is a stopped (paused) pod that can be resumed. */
  stoppedAt?: number;
  /** Deploy correlation ID — used to match persisted pods to their deploy session. */
  deployId?: string;
  /** Dev mode: pause on idle but skip auto-destroy. */
  devMode?: boolean;
  /** Readiness probe mode used for this deploy. */
  readinessProbe?: 'health' | 'ssh';
  /** How the pod was paused — 'stop' (default) or 'hibernate' (Hyperstack only). */
  pausedMode?: 'stop' | 'hibernate';
}

export function persistDeployState(): void {
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
      status: deployState.status,
      ...(isStopped ? { stoppedAt: Date.now() } : {}),
      ...(deployState.devMode ? { devMode: true } : {}),
      ...(deployState.readinessProbe ? { readinessProbe: deployState.readinessProbe } : {}),
      ...(deployState.pausedMode ? { pausedMode: deployState.pausedMode } : {}),
    };
    // Atomic write: write to temp file then rename, so a crash mid-write
    // never corrupts the active deploy file.
    const tmpFile = ACTIVE_DEPLOY_FILE + '.tmp';
    writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    renameSync(tmpFile, ACTIVE_DEPLOY_FILE);
  } catch (e) {
    log.warn('Failed to persist deploy state:', e instanceof Error ? e.message : e);
  }
}

export function clearPersistedDeploy(): void {
  try {
    if (existsSync(ACTIVE_DEPLOY_FILE)) unlinkSync(ACTIVE_DEPLOY_FILE);
    // Clean up stale temp file too
    const tmpFile = ACTIVE_DEPLOY_FILE + '.tmp';
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
  } catch (e) {
    log.warn('Failed to clear persisted deploy:', e instanceof Error ? e.message : e);
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
      log.log(`Persisted deploy too old (>${data.stoppedAt ? '2h stopped' : '6h running'}), ignoring`);
      clearPersistedDeploy();
      return null;
    }
    if (!data.podId) return null;
    // Stopped pods may have been persisted before receiving an endpoint
    // (e.g. Vast.ai pod stopped during boot). Allow empty endpoint for stopped pods.
    if (!data.endpoint && !data.stoppedAt) return null;
    return data;
  } catch (e) {
    log.warn('Failed to load persisted deploy:', e instanceof Error ? e.message : e);
    return null;
  }
}

// ── Deploy session tracking ──────────────────────────────────────────────────

export let activeDeploySessionId: number | null = null;
export function setActiveDeploySessionId(v: number | null) { activeDeploySessionId = v; }
