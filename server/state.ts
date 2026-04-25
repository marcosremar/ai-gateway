// ── BabelCast Gateway — Shared Mutable State ─────────────────────────────────
// All shared mutable state + state mutation helpers.
// Other modules import and directly mutate these variables.
//
// Phase 5 DDD: Domain state extracted to src/gateway/state/*.
// This file re-exports everything from those modules and keeps server-specific
// state (prisma, bot, server lifecycle, complex mutations with server deps).

import { deploymentSM } from './deployment-state-machine';
export { deploymentSM };

import type { Server } from 'http';
import { createLogger } from '../src/logger';

const log = createLogger('state');

// ── Re-export domain state modules ──────────────────────────────────────────
// Using `export *` preserves live bindings for mutable (let) variables.

export * from '../src/gateway/state/deploy-state';
export * from '../src/gateway/state/readiness-state';
export * from '../src/gateway/state/standby-state';
export * from '../src/gateway/state/cost-state';
export * from '../src/gateway/state/metrics-state';

// Import from domain modules for use in server-specific functions below
import {
  deployState, deployCancelled,
  deployApiKey, deployVastApiKey, deployTensordockApiKey, deployTensordockAuthId, deployModalApiKey,
  activeProvider, gpuHealthy,
  persistDeployState, clearPersistedDeploy,
  setDeployCancelled as _setDeployCancelled,
  setDeployApiKey as _setDeployApiKey,
  setDeployVastApiKey as _setDeployVastApiKey,
  setDeployTensordockApiKey as _setDeployTensordockApiKey,
  setDeployTensordockAuthId as _setDeployTensordockAuthId,
  setDeployModalApiKey as _setDeployModalApiKey,
  setDeployHyperstackApiKey as _setDeployHyperstackApiKey,
  setActiveProvider as _setActiveProvider,
  type DeploymentState,
} from '../src/gateway/state/deploy-state';

import {
  standbyDeployState,
  setStandbyDeployState as _setStandbyDeployState,
  type StandbyDeployState,
  deployTarget,
} from '../src/gateway/state/standby-state';

import {
  gpuReadyForProduction,
  resetTtsWarmth,
  resetGpuReadinessState,
} from '../src/gateway/state/readiness-state';

// ── PostgreSQL (server-specific) ────────────────────────────────────────────
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

// ── Server lifecycle state ──────────────────────────────────────────────────

export const startedAt = Date.now();
export let activeRequests = 0;
export let gatewayServer: Server | null = null;
export let lastRequestTime = 0;
export let monitorInterval: Timer | null = null;

// Allow mutation from other modules
export function setActiveRequests(v: number) { activeRequests = v; }
export function setGatewayServer(v: Server | null) { gatewayServer = v; }
export function setLastRequestTime(v: number) { lastRequestTime = v; }
export function setMonitorInterval(v: Timer | null) { monitorInterval = v; }

// ── Deploy state mutation (server-specific — uses require('./ws-state')) ─────

export function setDeployState(patch: Partial<DeploymentState>) {
  if (deployTarget === 'standby') {
    // Route to standby state during standby deploy — do NOT persist to active_deploy.json
    const mapped: Partial<StandbyDeployState> = {};
    if (patch.status !== undefined) {
      if (patch.status === 'ready') mapped.status = 'benchmarking';
      else if (patch.status === 'error') mapped.status = 'error';
      else if (patch.status === 'idle') mapped.status = 'idle';
      else if (patch.status === 'warming') mapped.status = 'deploying';
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
    _setStandbyDeployState(mapped);
    return; // don't update primary deployState or persist
  }
  if (deployCancelled && patch.status !== 'idle') return; // don't update after cancel

  // Track alert history
  if (patch.alert && patch.alert !== deployState.alert) {
    const level = patch.alertLevel ?? (patch.status === 'error' ? 'error' : 'warning');
    deployState.alertHistory.push({ level, message: patch.alert, ts: Date.now() });
    if (deployState.alertHistory.length > 30) deployState.alertHistory.splice(0, deployState.alertHistory.length - 30);
  }

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
    // Keep last 50 transitions (splice in-place instead of allocating new array)
    if (deployState.transitions.length > 50) deployState.transitions.splice(0, deployState.transitions.length - 50);
    // Broadcast transition for real-time UI
    try { const { broadcastWs: bws } = require('./ws-state'); bws?.({ type: 'gpu:transition', status: newStatus, step: newStep, provider: deployState.provider, elapsed, gpuType: deployState.gpuType, detail: deployState.message?.slice(0, 80), pullHistory: deployState.pullHistory, warmingStatus: deployState.warmingStatus }); } catch (e) { log.warn('broadcastWs failed:', e instanceof Error ? e.message : e); }
  }

  log.log(`${deployState.status}: ${deployState.message}`);
  // Persist to disk so we can reconnect after restart
  persistDeployState();
}

export function resetDeployState() {
  _setDeployCancelled(true);
  _setDeployApiKey('');
  _setDeployVastApiKey('');
  _setDeployTensordockApiKey('');
  _setDeployTensordockAuthId('');
  _setDeployModalApiKey('');
  _setDeployHyperstackApiKey('');
  _setActiveProvider('');
  Object.assign(deployState, { status: 'idle', podId: '', endpoint: '', gpuType: '', dockerImage: '', message: '', step: '', stepDetail: '', startedAt: 0, retryCount: 0, provider: '', alert: '', alertLevel: 'info' as const, alertHistory: [], sshHost: '', sshPort: 0, lastLogs: '', deployDurationMs: 0, costPerHr: 0, providerMeta: {}, transitions: [], pullHistory: [], warmingStatus: { phase: 'idle' as const, startedAt: 0 }, deployId: '', gpuTemp: 0, gpuUtil: -1, gpuMemUsed: 0, gpuMemTotal: 0, templateHashId: '', canary: undefined, canaryEvalTimer: null });
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
let autoResumeInFlight = false;

export function touchModelRequest() {
  lastModelRequestTime = Date.now();
  // Reset idle-related state in gpu-deploy (lazy import to avoid circular deps)
  try { const { resetIdleState } = require('./gpu-deploy'); resetIdleState?.(); } catch (e) { log.warn('resetIdleState failed:', e instanceof Error ? e.message : e); }
  // Auto-resume: if a stopped GPU pod exists, transparently resume it (or fall
  // back to fresh deploy) when a new AI request arrives. Fire-and-forget —
  // the caller gets a "booting" status and retries on the next poll.
  // Guard against concurrent auto-resume attempts (race condition fix)
  if (autoResumeInFlight) return;
  (async () => {
    try {
      const { deploymentSM: sm } = require('./deployment-state-machine');
      if (sm.isStopped) {
        autoResumeInFlight = true;
        const { resumeOrDeploy } = require('./gpu-deploy');
        await resumeOrDeploy({ reason: 'autoscaler' });
      }
    } catch (e) { log.warn('auto-resume failed:', e instanceof Error ? e.message : e); } finally {
      autoResumeInFlight = false;
    }
  })();
}
export function setLastModelRequestTime(v: number) { lastModelRequestTime = v; }

export function isGpuAvailable(): boolean {
  return deployState.status === 'ready' && gpuHealthy && !!deployState.endpoint;
}

export function isGpuReadyForProduction(): boolean {
  return deployState.status === 'ready' && gpuHealthy && !!deployState.endpoint && gpuReadyForProduction;
}

// ── Bot Deployment State (server-specific) ──────────────────────────────────

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

export function setBotStateVar(v: BotDeploymentState) { botState = v; }
export function setBotDeployLock(v: boolean) { botDeployLock = v; }
export function setBotApiKey(v: string) { botApiKey = v; }
export function setBotPodApiKey(v: string) { botPodApiKey = v; }

// ── Auto-Swap State ──────────────────────────────────────────────────────────
// Runtime toggle for language auto-swap detection. Broadcasted to Python app via WS.

export let autoSwapEnabled = true;  // on by default

export function setAutoSwapEnabled(v: boolean) {
  autoSwapEnabled = v;
  log.log(`${v ? 'enabled' : 'disabled'}`);
}
