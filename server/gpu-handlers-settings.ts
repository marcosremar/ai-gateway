// ── BabelCast Gateway — GPU Settings / Readiness / Latency Handlers ────────
// Extracted from gpu-handlers.ts for separation of concerns.

import type { IncomingMessage, ServerResponse } from 'http';
import {
  gpuReadinessState, gpuReadyForProduction, gpuShadowMode, getPerStageP95,
} from './state';
import { createLogger } from '../src/logger';

const log = createLogger('gpu-handlers-settings');
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
import {
  getStandbyEnabled, setStandbyEnabled, getStandbyTriggerHours, setStandbyTriggerHours,
  getStandbyDrainTimeoutMs, setStandbyDrainTimeoutMs,
} from '../src/gpu-providers/deploy-settings';
import { getReadinessHistory } from './gpu-readiness';
import { getLatencyDbStats, setHostsMonitored } from './latency-db';
import { readJsonBody } from './http-utils';

/**
 * GET /v1/gpu/latency/settings
 * Returns scheduler status, settings, and DB stats.
 */
export async function handleGetLatencySettings(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const status = getLatencySchedulerStatus();
  const dbStats = await getLatencyDbStats();
  // Pull time learning stats
  let pullTimeLearning: Record<string, unknown> = {};
  try {
    const { getObservationCount, estimatePullTimeout } = await import('../src/gpu-providers/pull-time-estimator');
    const pfx = process.env.DOCKER_IMAGE_PREFIX || 'marcosremar';
    const knownImages = [
      `${pfx}/babelcast-translategemma:latest`,
      `${pfx}/babelcast-mistral:latest`,
      `${pfx}/babelcast-groq:latest`,
      `${pfx}/babelcast-qwen3asr:latest`,
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
    ).catch(err => { log.warn(`GPU readiness check failed after reset: ${err instanceof Error ? err.message : err}`); });
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
  await setHostsMonitored(hostIds, body.monitored);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, updated: hostIds.length || 'all' }));
}
