// ── BabelCast Gateway — Metrics ──────────────────────────────────────────────
// logRequest, logGpuEvent, deploy session tracking, handleMetrics,
// handleRequestLog, computePercentile.

import type { IncomingMessage, ServerResponse } from 'http';
import {
  prisma, latencyRing, latencyRingIdx, setLatencyRingIdx, LATENCY_RING_SIZE,
  metricsCounters, providerMetrics, pendingDbWrites, setPendingDbWrites,
  consecutiveDbFailures, setConsecutiveDbFailures, DB_FAILURE_WARN_THRESHOLD,
  activeDeploySessionId, setActiveDeploySessionId, startedAt, deployState,
} from './state';
import { getOrCreateRequestId, setRequestIdHeader } from './http-utils';
import { getTranslationCacheStats } from './ai-handlers';

// ── Request Log (Prisma + SQLite) ────────────────────────────────────────────

interface RequestLogInput {
  timestamp: number;
  stage: 'stt' | 'llm' | 'tts' | 'pipeline';
  provider: 'gpu' | 'groq' | 'ollama';
  model?: string;
  latencyMs: number;
  success: boolean;
  error?: string;
  inputSize?: number;
  outputPreview?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export function logRequest(entry: RequestLogInput & { requestId?: string }) {
  // Track GPU request latency in host reputation (fire-and-forget)
  if (entry.provider === 'gpu' && entry.success && entry.latencyMs > 0) {
    // Import deploy state lazily to avoid circular deps
    const { deployState } = require('./state');
    if (deployState.provider && deployState.gpuType) {
      updateHostLatency(deployState.provider, deployState.gpuType, entry.latencyMs, entry.stage, deployState.providerMeta);
    }
  }

  // Update in-memory metrics

  // Update per-provider performance metrics
  if (!providerMetrics[entry.provider]) {
    providerMetrics[entry.provider] = { requests: 0, totalLatencyMs: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
  }
  providerMetrics[entry.provider].requests++;
  providerMetrics[entry.provider].totalLatencyMs += entry.latencyMs;
  if (!entry.success) providerMetrics[entry.provider].errors++;
  if (entry.inputTokens) providerMetrics[entry.provider].inputTokens += entry.inputTokens;
  if (entry.outputTokens) providerMetrics[entry.provider].outputTokens += entry.outputTokens;
  metricsCounters.requestsTotal++;
  if (!entry.success) metricsCounters.errorsTotal++;
  if (entry.inputTokens) metricsCounters.totalInputTokens += entry.inputTokens;
  if (entry.outputTokens) metricsCounters.totalOutputTokens += entry.outputTokens;
  metricsCounters.byStage[entry.stage] = (metricsCounters.byStage[entry.stage] || 0) + 1;
  metricsCounters.byProvider[entry.provider] = (metricsCounters.byProvider[entry.provider] || 0) + 1;

  // Store latency in circular buffer for percentile calculation
  if (latencyRing.length < LATENCY_RING_SIZE) {
    latencyRing.push(entry.latencyMs);
  } else {
    if (latencyRingIdx >= latencyRing.length) setLatencyRingIdx(0);
    latencyRing[latencyRingIdx] = entry.latencyMs;
  }
  setLatencyRingIdx((latencyRingIdx + 1) % LATENCY_RING_SIZE);

  if (entry.requestId) {
    if (!entry.success && entry.error) {
      const e = entry.error.toLowerCase();
      const isTransient = e.includes('timeout') || e.includes('econnrefused') || e.includes('fetch failed') ||
        e.includes('502') || e.includes('503') || e.includes('504');
      const errorType = isTransient ? 'transient' : 'permanent';
      console.log(`[req=${entry.requestId.slice(0, 8)}] ${entry.stage} ${entry.provider} ${entry.latencyMs}ms ERR errorType=${errorType}`);
    } else {
      console.log(`[req=${entry.requestId.slice(0, 8)}] ${entry.stage} ${entry.provider} ${entry.latencyMs}ms ${entry.success ? 'OK' : 'ERR'}`);
    }
  }

  // Fire-and-forget — don't block the request handler
  setPendingDbWrites(pendingDbWrites + 1);
  prisma.requestLog
    .create({
      data: {
        timestamp: new Date(entry.timestamp),
        stage: entry.stage,
        provider: entry.provider,
        model: entry.model ?? null,
        latencyMs: entry.latencyMs,
        success: entry.success,
        error: entry.error ?? null,
        inputSize: entry.inputSize ?? null,
        outputPreview: entry.outputPreview ?? null,
      },
    })
    .then(() => {
      setPendingDbWrites(pendingDbWrites - 1);
      setConsecutiveDbFailures(0);
    })
    .catch(err => {
      setPendingDbWrites(pendingDbWrites - 1);
      metricsCounters.dbLogFailures++;
      setConsecutiveDbFailures(consecutiveDbFailures + 1);
      if (consecutiveDbFailures === DB_FAILURE_WARN_THRESHOLD) {
        console.error(`[db] WARN: ${DB_FAILURE_WARN_THRESHOLD} consecutive DB write failures — database may be unavailable`);
      }
      console.warn('[db] Failed to log request:', err);
    });
}

// ── GPU event logging ────────────────────────────────────────────────────────

export function logGpuEvent(
  event: string,
  provider: string,
  success: boolean,
  opts?: {
    durationMs?: number;
    cooldownMs?: number;
    failCount?: number;
    error?: string;
    metadata?: Record<string, unknown>;
  },
) {
  setPendingDbWrites(pendingDbWrites + 1);
  prisma.gpuEvent
    .create({
      data: {
        event,
        provider,
        success,
        durationMs: opts?.durationMs ?? null,
        cooldownMs: opts?.cooldownMs ?? null,
        failCount: opts?.failCount ?? null,
        error: opts?.error ?? null,
        metadata: opts?.metadata ? JSON.stringify(opts.metadata) : null,
      },
    })
    .then(() => {
      setPendingDbWrites(pendingDbWrites - 1);
      setConsecutiveDbFailures(0);
    })
    .catch(err => {
      setPendingDbWrites(pendingDbWrites - 1);
      setConsecutiveDbFailures(consecutiveDbFailures + 1);
      if (consecutiveDbFailures === DB_FAILURE_WARN_THRESHOLD) {
        console.error(`[db] WARN: ${DB_FAILURE_WARN_THRESHOLD} consecutive DB write failures — database may be unavailable`);
      }
      console.warn('[db] Failed to log GPU event:', err);
    });
}

// ── Deploy session tracking ──────────────────────────────────────────────────
// Records every production GPU pod deploy to GpuDeploySession table.
// Used for audit trail and to filter GPU types by what has actually run.

export function startDeploySession(provider: string, dockerImage: string, gpuType: string) {
  prisma.gpuDeploySession
    .create({ data: { provider, dockerImage, gpuType, status: 'deploying' } })
    .then(row => { setActiveDeploySessionId(row.id); })
    .catch(err => console.warn('[db] Failed to create deploy session:', err));
}

export function updateDeploySession(patch: {
  status?: string;
  podId?: string;
  endpoint?: string;
  gpuType?: string;
  region?: string;
  costPerHr?: number;
  provisionTimeS?: number;
  stoppedAt?: Date;
  errorMessage?: string;
}) {
  if (!activeDeploySessionId) return;
  const id = activeDeploySessionId;
  if (patch.status === 'stopped' || patch.status === 'failed') {
    setActiveDeploySessionId(null);
  }
  prisma.gpuDeploySession
    .update({ where: { id }, data: patch })
    .catch(err => console.warn('[db] Failed to update deploy session:', err));
}

// ── Host Reputation ─────────────────────────────────────────────────────────
// Per-host performance tracking for GPU offer selection.
// Stores historical deploy outcomes, boot times, and provider quality metrics.
// Used by autoSelectCheapestGpu to rank offers by cost-benefit ratio.

const EMA_ALPHA = 0.3; // 30% new data, 70% history

/** Derive a unique host key from provider + instance metadata. */
export function deriveHostKey(
  provider: string,
  providerMeta?: Record<string, unknown>,
): string {
  if (provider === 'vast') {
    const ip = providerMeta?.hostIp as string | undefined;
    if (ip) return `vast:${ip}`;
  }
  if (provider === 'tensordock') {
    const nodeId = providerMeta?.hostnodeId as string | undefined;
    if (nodeId) return `tensordock:${nodeId}`;
  }
  // RunPod/Modal: pool-based, no per-host granularity
  const gpuType = providerMeta?.gpuType as string | undefined;
  return `${provider}:${gpuType || 'unknown'}`;
}

/** EMA update: blend new value into running average. */
function emaUpdate(current: number, newValue: number): number {
  if (current <= 0) return newValue; // first observation
  return EMA_ALPHA * newValue + (1 - EMA_ALPHA) * current;
}

/**
 * Compute reputation score (0.0-1.0) from host metrics.
 * Optimized for real-time translation: latency and consistency dominate.
 *
 * Weights (tuned for real-time pipeline):
 *   latencyScore     × 0.30  — raw speed matters most
 *   consistencyScore × 0.15  — low jitter = predictable real-time UX
 *   successRate      × 0.20  — deploy reliability
 *   networkScore     × 0.10  — bandwidth affects audio upload/download
 *   providerQuality  × 0.10  — host reliability/tier from provider
 *   bootScore        × 0.05  — faster boot = faster recovery
 *   uptimeScore      × 0.05  — session stability
 *   crashPenalty     × 0.05  — hard penalty per crash
 *
 * Applies recency decay toward 0.5 as data ages (τ=30 days).
 */
export function computeReputationScore(host: {
  deployCount: number;
  successCount: number;
  failCount: number;
  crashCount: number;
  avgBootTimeS: number;
  avgUptimeS: number;
  avgLatencyMs: number;
  latencyVariance?: number;
  requestCount?: number;
  reliability: number;
  inetDownMbps: number;
  inetUpMbps?: number;
  tier: number;
  uptimePct: number;
  pcieBw?: number;
  diskReadMbps?: number;
  lastDeployAt: Date;
}): number {
  if (host.deployCount === 0) return 0.5; // neutral for unknown hosts

  // ── 1. Latency score (0-1): <150ms=1.0, 400ms=0.5, 800ms+=0.0
  // This is the most important factor for real-time translation
  let latencyScore = 0.5; // neutral if no data
  if (host.avgLatencyMs > 0) {
    latencyScore = Math.max(0, Math.min(1, 1 - (host.avgLatencyMs - 150) / 650));
  }

  // ── 2. Consistency score (0-1): low variance = predictable latency
  // stddev < 30ms = 1.0, 100ms = 0.5, 300ms+ = 0.0
  let consistencyScore = 0.5;
  if ((host.latencyVariance ?? 0) > 0 && (host.requestCount ?? 0) >= 5) {
    const stddev = Math.sqrt(host.latencyVariance!);
    consistencyScore = Math.max(0, Math.min(1, 1 - (stddev - 30) / 270));
  }

  // ── 3. Success rate (0-1) — crashes count as 0.5 failures
  const totalEvents = host.deployCount + host.crashCount * 0.5;
  const successRate = totalEvents > 0 ? host.successCount / totalEvents : 0.5;

  // ── 4. Network score (0-1): bandwidth matters for audio transfer
  // Combines download + upload. 200+ Mbps = 1.0, 50 = 0.5, <10 = 0.0
  let networkScore = 0.5;
  if (host.inetDownMbps >= 0) {
    const downScore = Math.max(0, Math.min(1, (host.inetDownMbps - 10) / 190));
    const upScore = (host.inetUpMbps ?? -1) >= 0
      ? Math.max(0, Math.min(1, ((host.inetUpMbps!) - 10) / 190))
      : downScore;
    networkScore = downScore * 0.6 + upScore * 0.4;
  }

  // ── 5. Provider quality (reliability2 for Vast, tier/uptimePct for TensorDock)
  let providerQuality = 0.5;
  if (host.reliability >= 0) {
    providerQuality = host.reliability;
  } else if (host.tier >= 0) {
    providerQuality = Math.min(1, (host.tier / 4) * 0.7 + (host.uptimePct / 100) * 0.3);
  }

  // ── 6. Boot score: 60s=1.0, 300s=0.5, 600s+=0.0
  let bootScore = 0.5;
  if (host.avgBootTimeS > 0) {
    bootScore = Math.max(0, Math.min(1, 1 - (host.avgBootTimeS - 60) / 540));
  }

  // ── 7. Uptime score: avg session vs expected 1 hour
  const uptimeScore = host.avgUptimeS > 0 ? Math.min(1, host.avgUptimeS / 3600) : 0.5;

  // ── 8. Crash penalty: each crash reduces by 15%, floor 0
  const crashPenalty = host.crashCount > 0
    ? Math.max(0, 1 - host.crashCount * 0.15)
    : 1.0;

  // ── Weighted sum (tuned for real-time translation)
  const raw =
    latencyScore     * 0.30 +
    consistencyScore * 0.15 +
    successRate      * 0.20 +
    networkScore     * 0.10 +
    providerQuality  * 0.10 +
    bootScore        * 0.05 +
    uptimeScore      * 0.05 +
    crashPenalty     * 0.05;

  // Recency decay: blend toward 0.5 as data ages (τ=30 days)
  const daysSinceLastDeploy = (Date.now() - host.lastDeployAt.getTime()) / (1000 * 60 * 60 * 24);
  const decayFactor = Math.exp(-daysSinceLastDeploy / 30);
  return 0.5 + (raw - 0.5) * decayFactor;
}

/** Extract region + machine specs from providerMeta, only including non-empty values. */
function extractMachineSpecs(meta?: Record<string, unknown>): Record<string, string | number> {
  if (!meta) return {};
  const specs: Record<string, string | number> = {};
  // Region: Vast→geolocation, TensorDock→city
  const region = (meta.region || meta.city || '') as string;
  if (region) specs.region = region;
  // Machine specs
  if (meta.cpuName) specs.cpuName = meta.cpuName as string;
  if (meta.cpuCores) specs.cpuCores = meta.cpuCores as number;
  if (meta.ramGb) specs.ramGb = meta.ramGb as number;
  if (meta.gpuVramGb) specs.gpuVramGb = meta.gpuVramGb as number;
  if (meta.numGpus) specs.numGpus = meta.numGpus as number;
  if (meta.diskGb) specs.diskGb = meta.diskGb as number;
  if (meta.diskReadMbps) specs.diskReadMbps = meta.diskReadMbps as number;
  if (meta.diskWriteMbps) specs.diskWriteMbps = meta.diskWriteMbps as number;
  if (meta.pcieBw) specs.pcieBw = meta.pcieBw as number;
  if (meta.cudaVersion) specs.cudaVersion = meta.cudaVersion as number;
  return specs;
}

/**
 * Record a deploy outcome for a host. Creates or updates the HostReputation row.
 */
/** Error categories that are NOT the host's fault — do not penalize reputation. */
const NON_HOST_FAILURES = new Set(['billing', 'api_error', 'docker_image', 'cancelled']);

/**
 * Classify a deploy failure to determine if it should affect host reputation.
 *
 * Host-attributable (penalize):  timeout, crashed, network, unknown
 * Non-host (skip):              billing, api_error, docker_image, cancelled
 */
export function isHostAttributableFailure(failureCategory?: string): boolean {
  if (!failureCategory) return true;  // unknown → assume host's fault
  return !NON_HOST_FAILURES.has(failureCategory);
}

/**
 * Record a deploy outcome for a host. Creates or updates the HostReputation row.
 *
 * When failureCategory is a non-host error (billing, docker_image, api_error, cancelled),
 * the failure is logged but does NOT increment failCount or deployCount — so the host's
 * reputation score remains unaffected by problems outside its control.
 */
export async function upsertHostReputation(opts: {
  provider: string;
  gpuType: string;
  providerMeta?: Record<string, unknown>;
  success: boolean;
  bootTimeS?: number;
  pullTimeS?: number;
  uptimeS?: number;
  latencyMs?: number;
  dockerImage?: string;
  costUsd?: number;
  crash?: boolean;  // true = crash during operation (not deploy failure)
  failureCategory?: string;  // from categorizeDeployFailure(): billing, timeout, crashed, api_error, network, docker_image, cancelled, unknown
}): Promise<void> {
  const hostKey = deriveHostKey(opts.provider, opts.providerMeta);

  try {
    const existing = await prisma.hostReputation.findUnique({ where: { hostKey } });

    if (existing) {
      // Update existing record
      const isCrash = opts.crash === true;
      // Non-host failures (billing, docker image, API error) don't affect deploy/fail counts
      const skipCounting = !opts.success && !isCrash && !isHostAttributableFailure(opts.failureCategory);
      const deployCount = (isCrash || skipCounting) ? existing.deployCount : existing.deployCount + 1;
      const successCount = (isCrash || skipCounting) ? existing.successCount : existing.successCount + (opts.success ? 1 : 0);
      const failCount = (isCrash || skipCounting) ? existing.failCount : existing.failCount + (opts.success ? 0 : 1);
      const crashCount = existing.crashCount + (isCrash ? 1 : 0);
      if (skipCounting) {
        console.log(`[reputation] ${hostKey}: skipping fail count for non-host error (${opts.failureCategory})`);
      }
      const avgBootTimeS = opts.bootTimeS != null
        ? emaUpdate(existing.avgBootTimeS, opts.bootTimeS)
        : existing.avgBootTimeS;
      const avgPullTimeS = opts.pullTimeS != null
        ? emaUpdate(existing.avgPullTimeS, opts.pullTimeS)
        : existing.avgPullTimeS;
      const avgUptimeS = opts.uptimeS != null
        ? emaUpdate(existing.avgUptimeS, opts.uptimeS)
        : existing.avgUptimeS;
      const avgLatencyMs = opts.latencyMs != null
        ? emaUpdate(existing.avgLatencyMs, opts.latencyMs)
        : existing.avgLatencyMs;
      const totalCostUsd = existing.totalCostUsd + (opts.costUsd ?? 0);

      // Update provider-reported fields if available
      const reliability = opts.providerMeta?.reliability2 != null
        ? opts.providerMeta.reliability2 as number
        : existing.reliability;
      const inetDownMbps = opts.providerMeta?.inetDown != null
        ? opts.providerMeta.inetDown as number
        : existing.inetDownMbps;
      const inetUpMbps = opts.providerMeta?.inetUp != null
        ? opts.providerMeta.inetUp as number
        : existing.inetUpMbps;
      const tier = opts.providerMeta?.tier != null
        ? opts.providerMeta.tier as number
        : existing.tier;
      const uptimePct = opts.providerMeta?.uptimePct != null
        ? opts.providerMeta.uptimePct as number
        : existing.uptimePct;

      const reputationScore = computeReputationScore({
        deployCount, successCount, failCount, crashCount,
        avgBootTimeS, avgUptimeS, avgLatencyMs,
        latencyVariance: existing.latencyVariance, requestCount: existing.requestCount,
        reliability, inetDownMbps, inetUpMbps, tier, uptimePct,
        pcieBw: existing.pcieBw, diskReadMbps: existing.diskReadMbps,
        lastDeployAt: new Date(),
      });

      await prisma.hostReputation.update({
        where: { hostKey },
        data: {
          deployCount, successCount, failCount, crashCount,
          avgBootTimeS, avgPullTimeS, avgUptimeS, avgLatencyMs, totalCostUsd,
          reliability, inetDownMbps, inetUpMbps, tier, uptimePct,
          reputationScore,
          gpuType: opts.gpuType || existing.gpuType,
          ...extractMachineSpecs(opts.providerMeta),
          ...(opts.dockerImage ? { lastDockerImage: opts.dockerImage } : {}),
          ...(!isCrash ? { lastDeployAt: new Date() } : {}),
          ...(opts.success && !isCrash ? { lastSuccessAt: new Date() } : {}),
          ...(!opts.success && !isCrash ? { lastFailAt: new Date() } : {}),
          ...(isCrash ? { lastCrashAt: new Date() } : {}),
        },
      });
      const extra = isCrash ? ` CRASH #${crashCount}` : '';
      console.log(`[reputation] Updated ${hostKey}: score=${reputationScore.toFixed(3)} (${successCount}/${deployCount} success, ${crashCount} crashes, boot=${avgBootTimeS.toFixed(0)}s, latency=${avgLatencyMs.toFixed(0)}ms)${extra}`);
    } else {
      // Create new record
      const bootTimeS = opts.bootTimeS ?? 0;
      const pullTimeS = opts.pullTimeS ?? 0;
      const uptimeS = opts.uptimeS ?? 0;
      const latencyMs = opts.latencyMs ?? 0;
      const isCrash = opts.crash === true;
      const reliability = opts.providerMeta?.reliability2 as number ?? -1;
      const inetDownMbps = opts.providerMeta?.inetDown as number ?? -1;
      const inetUpMbps = opts.providerMeta?.inetUp as number ?? -1;
      const tier = opts.providerMeta?.tier as number ?? -1;
      const uptimePct = opts.providerMeta?.uptimePct as number ?? -1;

      const skipCounting = !opts.success && !isCrash && !isHostAttributableFailure(opts.failureCategory);
      const newDeployCount = (isCrash || skipCounting) ? 0 : 1;
      const newSuccessCount = (opts.success && !isCrash && !skipCounting) ? 1 : 0;
      const newFailCount = (!opts.success && !isCrash && !skipCounting) ? 1 : 0;

      const reputationScore = computeReputationScore({
        deployCount: newDeployCount,
        successCount: newSuccessCount,
        failCount: newFailCount,
        crashCount: isCrash ? 1 : 0,
        avgBootTimeS: bootTimeS, avgUptimeS: uptimeS, avgLatencyMs: latencyMs,
        reliability, inetDownMbps, tier, uptimePct,
        lastDeployAt: new Date(),
      });

      await prisma.hostReputation.create({
        data: {
          hostKey,
          provider: opts.provider,
          gpuType: opts.gpuType || '',
          deployCount: newDeployCount,
          successCount: newSuccessCount,
          failCount: newFailCount,
          crashCount: isCrash ? 1 : 0,
          avgBootTimeS: bootTimeS, avgPullTimeS: pullTimeS,
          avgUptimeS: uptimeS, avgLatencyMs: latencyMs,
          totalCostUsd: opts.costUsd ?? 0,
          lastDockerImage: opts.dockerImage ?? '',
          reliability, inetDownMbps, inetUpMbps, tier, uptimePct,
          ...extractMachineSpecs(opts.providerMeta),
          reputationScore,
          ...(opts.success && !isCrash ? { lastSuccessAt: new Date() } : {}),
          ...(!opts.success && !isCrash ? { lastFailAt: new Date() } : {}),
          ...(isCrash ? { lastCrashAt: new Date() } : {}),
        },
      });
      const outcomeLabel = isCrash ? 'crash' : opts.success ? 'success' : skipCounting ? `ignored:${opts.failureCategory}` : 'fail';
      console.log(`[reputation] Created ${hostKey}: score=${reputationScore.toFixed(3)} (${outcomeLabel}, boot=${bootTimeS}s)`);
    }
  } catch (err) {
    console.warn(`[reputation] Failed to upsert ${hostKey}:`, err);
  }
}

/**
 * Record a crash event for the current host (health probe failures while running).
 * Called from the GPU monitor when consecutive health failures indicate a crash.
 */
export async function recordHostCrash(provider: string, gpuType: string, providerMeta?: Record<string, unknown>): Promise<void> {
  await upsertHostReputation({
    provider,
    gpuType,
    providerMeta,
    success: false,
    crash: true,
  });
}

/**
 * Update host latency EMA from a successful GPU request.
 * Tracks per-stage latency (stt/llm/tts/pipeline) and latency variance (jitter).
 */
export async function updateHostLatency(
  provider: string, gpuType: string, latencyMs: number,
  stage: 'stt' | 'llm' | 'tts' | 'pipeline',
  providerMeta?: Record<string, unknown>,
): Promise<void> {
  const hostKey = deriveHostKey(provider, providerMeta);
  try {
    const existing = await prisma.hostReputation.findUnique({ where: { hostKey } });
    if (!existing) return;

    const avgLatencyMs = emaUpdate(existing.avgLatencyMs, latencyMs);
    // Variance tracking: EMA of squared deviation from mean (jitter proxy)
    const deviation = latencyMs - existing.avgLatencyMs;
    const latencyVariance = emaUpdate(existing.latencyVariance, deviation * deviation);
    const requestCount = existing.requestCount + 1;

    // Per-stage latency EMA
    const stageUpdate: Record<string, number> = {};
    if (stage === 'stt') stageUpdate.avgSttMs = emaUpdate(existing.avgSttMs, latencyMs);
    else if (stage === 'llm') stageUpdate.avgLlmMs = emaUpdate(existing.avgLlmMs, latencyMs);
    else if (stage === 'tts') stageUpdate.avgTtsMs = emaUpdate(existing.avgTtsMs, latencyMs);
    else if (stage === 'pipeline') stageUpdate.avgPipelineMs = emaUpdate(existing.avgPipelineMs, latencyMs);

    await prisma.hostReputation.update({
      where: { hostKey },
      data: { avgLatencyMs, latencyVariance, requestCount, ...stageUpdate },
    });
  } catch {
    // non-critical, don't log every request
  }
}

/**
 * Load reputation scores for a set of host keys.
 * Returns a Map<hostKey, reputationScore>.
 */
export async function loadReputations(hostKeys: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (hostKeys.length === 0) return map;
  try {
    const rows = await prisma.hostReputation.findMany({
      where: { hostKey: { in: hostKeys } },
      select: { hostKey: true, reputationScore: true },
    });
    for (const row of rows) {
      map.set(row.hostKey, row.reputationScore);
    }
  } catch (err) {
    console.warn('[reputation] Failed to load reputations:', err);
  }
  return map;
}

/**
 * Load aggregated reputation scores grouped by provider+gpuType.
 * Used for offer ranking when we don't know the specific host yet.
 * Returns weighted average score (by deploy count) and best/worst scores.
 */
export async function loadReputationsByGpuType(): Promise<Map<string, { avgScore: number; bestScore: number; worstScore: number; hostCount: number; avgLatencyMs: number }>> {
  const map = new Map<string, { avgScore: number; bestScore: number; worstScore: number; hostCount: number; avgLatencyMs: number }>();
  try {
    const rows = await prisma.hostReputation.findMany({
      where: { deployCount: { gt: 0 } },
      select: { provider: true, gpuType: true, reputationScore: true, deployCount: true, avgLatencyMs: true },
    });
    // Group by provider:gpuType
    const groups = new Map<string, Array<{ score: number; deployCount: number; latency: number }>>();
    for (const row of rows) {
      const key = `${row.provider}:${row.gpuType}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ score: row.reputationScore, deployCount: row.deployCount, latency: row.avgLatencyMs });
    }
    for (const [key, hosts] of groups) {
      const totalDeploys = hosts.reduce((s, h) => s + h.deployCount, 0);
      const weightedScore = totalDeploys > 0
        ? hosts.reduce((s, h) => s + h.score * h.deployCount, 0) / totalDeploys
        : 0.5;
      const weightedLatency = totalDeploys > 0
        ? hosts.reduce((s, h) => s + h.latency * h.deployCount, 0) / totalDeploys
        : 0;
      map.set(key, {
        avgScore: weightedScore,
        bestScore: Math.max(...hosts.map(h => h.score)),
        worstScore: Math.min(...hosts.map(h => h.score)),
        hostCount: hosts.length,
        avgLatencyMs: weightedLatency,
      });
    }
  } catch (err) {
    console.warn('[reputation] Failed to load GPU type reputations:', err);
  }
  return map;
}

/**
 * Load all reputation data (for the API endpoint).
 */
export async function getAllReputations(): Promise<unknown[]> {
  try {
    return await prisma.hostReputation.findMany({
      orderBy: { reputationScore: 'desc' },
    });
  } catch (err) {
    console.warn('[reputation] Failed to load all reputations:', err);
    return [];
  }
}

// ── Percentile calculation ──────────────────────────────────────────────────

export function computePercentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}

// ── /metrics endpoint ───────────────────────────────────────────────────────

export async function handleMetrics(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sorted = [...latencyRing].sort((a, b) => a - b);
  const uptimeSec = Math.round((Date.now() - startedAt) / 1000);

  const body = {
    requestsTotal: metricsCounters.requestsTotal,
    requestsByStage: { ...metricsCounters.byStage },
    requestsByProvider: { ...metricsCounters.byProvider },
    errorsTotal: metricsCounters.errorsTotal,
    dbLogFailures: metricsCounters.dbLogFailures,
    latencyP50Ms: computePercentile(sorted, 50),
    latencyP95Ms: computePercentile(sorted, 95),
    latencyP99Ms: computePercentile(sorted, 99),
    gpuStatus: deployState.status,
    uptimeSec,
    tokenUsage: {
      totalInputTokens: metricsCounters.totalInputTokens,
      totalOutputTokens: metricsCounters.totalOutputTokens,
      totalTokens: metricsCounters.totalInputTokens + metricsCounters.totalOutputTokens,
    },
    translationCache: getTranslationCacheStats(),
  };

  const requestId = getOrCreateRequestId(_req);
  setRequestIdHeader(res, requestId);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ── Request log endpoint ─────────────────────────────────────────────────────

export async function handleRequestLog(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const sinceId = parseInt(url.searchParams.get('since_id') || '0');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);

  try {
    // Fetch recent entries from SQLite
    const entries = await prisma.requestLog.findMany({
      where: sinceId > 0 ? { id: { gt: sinceId } } : undefined,
      orderBy: { id: 'desc' },
      take: limit,
    });
    entries.reverse(); // oldest first

    // Compute aggregate stats from all records
    const [totals, gpuCount, stageGroups] = await Promise.all([
      prisma.requestLog.aggregate({
        _count: true,
        _avg: { latencyMs: true },
        _sum: { latencyMs: true },
      }),
      prisma.requestLog.count({ where: { provider: 'gpu' } }),
      prisma.requestLog.groupBy({
        by: ['stage'],
        _count: true,
      }),
    ]);

    const totalRequests = totals._count ?? 0;
    const errorCount = await prisma.requestLog.count({ where: { success: false } });
    const cloudCount = totalRequests - gpuCount;
    const gpuPercent = totalRequests > 0 ? Math.round((gpuCount / totalRequests) * 100) : 0;
    const avgLatencyMs = Math.round(totals._avg?.latencyMs ?? 0);

    const byStage: Record<string, number> = {};
    for (const g of stageGroups) {
      byStage[g.stage] = g._count;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      entries: entries.map(e => ({
        id: e.id,
        timestamp: e.timestamp.getTime(),
        stage: e.stage,
        provider: e.provider,
        model: e.model,
        latencyMs: e.latencyMs,
        success: e.success,
        error: e.error,
        inputSize: e.inputSize,
        outputPreview: e.outputPreview,
      })),
      stats: {
        totalRequests,
        gpuRequests: gpuCount,
        cloudRequests: cloudCount,
        totalLatencyMs: totals._sum?.latencyMs ?? 0,
        avgLatencyMs,
        gpuPercent,
        errors: errorCount,
        byStage,
      },
    }));
  } catch (err) {
    console.error('[db] Request log query failed:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Database query failed', entries: [], stats: {} }));
  }
}

// ── Per-service latency stats (last N requests avg + cold start) ─────────────

export async function handleServiceStats(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const SAMPLE_SIZE = 5;

  try {
    // Get last 200 successful requests, grouped by stage+provider
    const recent = await prisma.requestLog.findMany({
      where: { success: true },
      orderBy: { id: 'desc' },
      take: 200,
      select: { stage: true, provider: true, model: true, latencyMs: true },
    });

    // Group by stage::provider and compute avg of last N
    const buckets = new Map<string, number[]>();
    for (const r of recent) {
      const key = `${r.stage}::${r.provider}`;
      if (!buckets.has(key)) buckets.set(key, []);
      const arr = buckets.get(key)!;
      if (arr.length < SAMPLE_SIZE) arr.push(r.latencyMs);
    }

    const stats: Record<string, { avgMs: number; samples: number }> = {};
    for (const [key, latencies] of buckets) {
      const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
      stats[key] = { avgMs: avg, samples: latencies.length };
    }

    // Cold start data from deploy state
    const { deployState, getColdStartProfile } = await import('./state');
    let coldStart: { provider: string; coldTtfbMs: number; warmTtfbAvgMs: number } | null = null;
    if (deployState.gpuType && deployState.dockerImage && deployState.provider) {
      const profile = getColdStartProfile(deployState.gpuType, deployState.dockerImage, deployState.provider);
      if (profile) {
        coldStart = {
          provider: profile.provider,
          coldTtfbMs: profile.coldTtfbMs,
          warmTtfbAvgMs: profile.warmTtfbAvgMs,
        };
      }
    }

    // Model warmth (per-stage avg latency from GPU health)
    const { gpuModelWarmth } = await import('./state');
    const warmth = gpuModelWarmth;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stats, coldStart, warmth }));
  } catch (err) {
    console.error('[db] Service stats query failed:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stats: {}, coldStart: null, warmth: null }));
  }
}
