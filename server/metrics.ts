// ── BabelCast Gateway — Metrics ──────────────────────────────────────────────
// logRequest, logGpuEvent, deploy session tracking, handleMetrics,
// handleRequestLog, computePercentile.

import { createLogger } from '../src/logger';
import { safeCatch } from '../src/safe-catch';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  prisma, latencyRing, latencyRingGeneration,
  metricsCounters, providerMetrics, setPendingDbWrites,
  setConsecutiveDbFailures, DB_FAILURE_WARN_THRESHOLD,
  activeDeploySessionId, setActiveDeploySessionId, startedAt, deployState,
  dailyGpuSpendUsd, DAILY_BUDGET_USD,
} from './state';
import { getInferenceCostStats } from './cost-tracker';

// Module-level counters for pending DB writes and consecutive failures.
// These are read directly inside async closures (.then/.catch), so they must
// be module-scoped variables — never captured-by-value imports.  The setter
// functions in state.ts are still called to keep the exported values in sync.
let _pendingWrites = 0;
let _consecutiveFailures = 0;
import { getOrCreateRequestId, setRequestIdHeader } from './http-utils';
import { getTranslationCacheStats } from './ai-handlers';

const log = createLogger('metrics');

// ── Request Log (Prisma + SQLite) ────────────────────────────────────────────

interface RequestLogInput {
  timestamp: number;
  stage: 'stt' | 'llm' | 'tts' | 'pipeline';
  provider: 'gpu' | 'groq' | 'ollama' | 'ensemble' | 'cache' | 'hybrid' | 'stream';
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

  // Do NOT write to latencyRing here. GPU latencies are recorded by
  // recordGpuLatency() (in ai-handlers.ts) which properly increments the
  // generation counter for P95 cache invalidation. Cloud latencies don't
  // belong in the GPU-specific ring buffer. Writing here without incrementing
  // latencyRingGeneration caused stale P95 cache misses.

  if (entry.requestId) {
    if (!entry.success && entry.error) {
      const e = entry.error.toLowerCase();
      const isTransient = e.includes('timeout') || e.includes('econnrefused') || e.includes('fetch failed') ||
        e.includes('502') || e.includes('503') || e.includes('504');
      const errorType = isTransient ? 'transient' : 'permanent';
      log.log('req=%s %s %s %dms ERR errorType=%s', entry.requestId.slice(0, 8), entry.stage, entry.provider, entry.latencyMs, errorType);
    } else {
      log.log('req=%s %s %s %dms %s', entry.requestId.slice(0, 8), entry.stage, entry.provider, entry.latencyMs, entry.success ? 'OK' : 'ERR');
    }
  }

  // Fire-and-forget with retry — don't block the request handler
  const dbData = {
    timestamp: new Date(entry.timestamp),
    stage: entry.stage,
    provider: entry.provider,
    model: entry.model ?? null,
    latencyMs: entry.latencyMs,
    success: entry.success,
    error: entry.error ?? null,
    inputSize: entry.inputSize ?? null,
    outputPreview: entry.outputPreview ?? null,
  };

  _pendingWrites++;
  setPendingDbWrites(_pendingWrites);

  const tryWrite = (attempt: number) => {
    prisma.requestLog
      .create({ data: dbData })
      .then(() => {
        _pendingWrites = Math.max(0, _pendingWrites - 1);
        setPendingDbWrites(_pendingWrites);
        _consecutiveFailures = 0;
        setConsecutiveDbFailures(0);
      })
      .catch((err: unknown) => {
        if (attempt < 2) {
          // Retry once after 500ms
          setTimeout(() => tryWrite(attempt + 1), 500);
          return;
        }
        _pendingWrites = Math.max(0, _pendingWrites - 1);
        setPendingDbWrites(_pendingWrites);
        metricsCounters.dbLogFailures++;
        _consecutiveFailures++;
        setConsecutiveDbFailures(_consecutiveFailures);
        if (_consecutiveFailures === DB_FAILURE_WARN_THRESHOLD) {
          log.error('%d consecutive DB write failures — database may be unavailable', DB_FAILURE_WARN_THRESHOLD);
        }
        log.warn('Failed to log request (attempt %d): %s', attempt + 1, err instanceof Error ? err.message : err);
      });
  };
  tryWrite(0);
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
  // Always write to file (persistent, no DB dependency). File-logger has
  // its own rotation and stderr fallback — a failure here means the file
  // system is fully unwritable, which will surface elsewhere. No point
  // double-logging it.
  try {
    const { logGpuEventToFile } = require('./file-logger');
    logGpuEventToFile(event, provider, success, opts);
  } catch { /* file-logger self-reports on stderr */ }

  _pendingWrites++;
  setPendingDbWrites(_pendingWrites);
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
      _pendingWrites = Math.max(0, _pendingWrites - 1);
      setPendingDbWrites(_pendingWrites);
      _consecutiveFailures = 0;
      setConsecutiveDbFailures(0);
    })
    .catch((err: unknown) => {
      _pendingWrites = Math.max(0, _pendingWrites - 1);
      setPendingDbWrites(_pendingWrites);
      _consecutiveFailures++;
      setConsecutiveDbFailures(_consecutiveFailures);
      if (_consecutiveFailures === DB_FAILURE_WARN_THRESHOLD) {
        log.error('%d consecutive DB write failures — database may be unavailable', DB_FAILURE_WARN_THRESHOLD);
      }
      log.warn('Failed to log GPU event: %s', err instanceof Error ? err.message : err);
    });
}

// ── Deploy session tracking ──────────────────────────────────────────────────
// Records every production GPU pod deploy to GpuDeploySession table.
// Used for audit trail and to filter GPU types by what has actually run.

export function startDeploySession(provider: string, dockerImage: string, gpuType: string) {
  prisma.gpuDeploySession
    .create({ data: { provider, dockerImage, gpuType, status: 'deploying' } })
    .then((row: { id: number }) => { setActiveDeploySessionId(row.id); })
    .catch((err: unknown) => log.warn('Failed to create deploy session: %s', err instanceof Error ? err.message : err));
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
    .catch((err: unknown) => log.warn('Failed to update deploy session: %s', err instanceof Error ? err.message : err));
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
  // Per-stage latency (optional, used for stage penalty)
  avgSttMs?: number;
  avgLlmMs?: number;
  avgTtsMs?: number;
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

  // ── 1b. Per-stage penalty: if any stage exceeds 2x its target, penalize
  // STT target ~500ms, LLM target ~300ms, TTS target ~400ms
  let stagePenalty = 0;
  const stageTargets = { stt: 500, llm: 300, tts: 400 };
  const stageLatencies = { stt: host.avgSttMs ?? 0, llm: host.avgLlmMs ?? 0, tts: host.avgTtsMs ?? 0 };
  for (const [stage, target] of Object.entries(stageTargets) as Array<[string, number]>) {
    const actual = stageLatencies[stage as keyof typeof stageLatencies];
    if (actual > target * 2 && actual > 0) {
      stagePenalty += 0.05; // 5% per stage exceeding 2x target
    }
  }
  stagePenalty = Math.min(stagePenalty, 0.15); // cap at 15%

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

  // Apply per-stage penalty (capped at 0.15)
  const rawWithStage = Math.max(0, raw - stagePenalty);

  // Confidence weighting: low-sample hosts blend toward neutral (0.5)
  // Full trust after 20 requests; hosts with fewer requests are less trusted.
  const requestCount = host.requestCount ?? 0;
  const confidence = Math.min(1, requestCount / 20);
  const rawWithConfidence = requestCount > 0
    ? rawWithStage * confidence + 0.5 * (1 - confidence)
    : rawWithStage; // no request data yet — trust deploy-time metrics

  // Recency decay: blend toward 0.5 as data ages (τ=30 days)
  const daysSinceLastDeploy = (Date.now() - host.lastDeployAt.getTime()) / (1000 * 60 * 60 * 24);
  const decayFactor = Math.exp(-daysSinceLastDeploy / 30);
  return 0.5 + (rawWithConfidence - 0.5) * decayFactor;
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
        log.log('%s: skipping fail count for non-host error (%s)', hostKey, opts.failureCategory);
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
        avgSttMs: existing.avgSttMs, avgLlmMs: existing.avgLlmMs, avgTtsMs: existing.avgTtsMs,
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
      log.log('Updated %s: score=%.3f (%d/%d success, %d crashes, boot=%.0fs, latency=%.0fms)%s', hostKey, reputationScore, successCount, deployCount, crashCount, avgBootTimeS, avgLatencyMs, extra);
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
      log.log('Created %s: score=%.3f (%s, boot=%ds)', hostKey, reputationScore, outcomeLabel, bootTimeS);
    }

    // ── GPU type failure alert: check if >50% of hosts for this GPU type failed recently
    if (!opts.success && opts.gpuType && isHostAttributableFailure(opts.failureCategory)) {
      try {
        const gpuType = opts.gpuType;
        const recentHosts = await prisma.hostReputation.findMany({
          where: {
            gpuType,
            deployCount: { gt: 0 },
            lastDeployAt: { gt: new Date(Date.now() - 24 * 3600_000) },
          },
          select: { hostKey: true, successCount: true, failCount: true, crashCount: true },
        });
        if (recentHosts.length >= 2) {
          const failedHosts = recentHosts.filter((h: { failCount: number; crashCount: number; successCount: number }) => (h.failCount + h.crashCount) > h.successCount);
          const failRate = failedHosts.length / recentHosts.length;
          if (failRate > 0.5) {
            log.warn('ALERT: GPU type "%s" failing globally — %d/%d hosts failed (%d%%) in last 24h', gpuType, failedHosts.length, recentHosts.length, Math.round(failRate * 100));
            try {
              const { broadcastWs } = await import('./ws-state');
              broadcastWs({
                type: 'gpu:type_failing',
                gpuType,
                failedHosts: failedHosts.length,
                totalHosts: recentHosts.length,
                failRate: Math.round(failRate * 100),
              });
            } catch { /* broadcast is best-effort; no connected clients = nothing to do */ }
          }
        }
      } catch { /* aggregation across one GPU type failed — continue to next */ }
    }
  } catch (err) {
    log.warn('Failed to upsert %s: %s', hostKey, err instanceof Error ? err.message : err);
  }
}

/**
 * Record a crash event for the current host (health probe failures while running).
 * Called from the GPU monitor when consecutive health failures indicate a crash.
 */
export async function recordHostCrash(provider: string, gpuType: string, providerMeta?: Record<string, unknown>): Promise<void> {
  const hostKey = deriveHostKey(provider, providerMeta);
  trackCrashTimestamp(hostKey);

  await upsertHostReputation({
    provider,
    gpuType,
    providerMeta,
    success: false,
    crash: true,
  });
}

// ── Host Crash Pattern Detection ────────────────────────────────────────────
// In-memory ring of recent crash timestamps per host IP/key.
// Detects repeated crashes that indicate a fundamentally broken host.

/** Map of hostKey → array of crash timestamps (ms) */
const crashTimestamps = new Map<string, number[]>();
const MAX_CRASH_HISTORY_PER_HOST = 20;
const CRASH_PATTERN_WINDOW_MS = 4 * 3600_000; // 4 hours
const CRASH_PATTERN_THRESHOLD = 3; // 3+ crashes in window → pattern detected

/** Record a crash timestamp for a host. */
function trackCrashTimestamp(hostKey: string): void {
  let timestamps = crashTimestamps.get(hostKey);
  if (!timestamps) {
    timestamps = [];
    crashTimestamps.set(hostKey, timestamps);
  }
  timestamps.push(Date.now());
  while (timestamps.length > MAX_CRASH_HISTORY_PER_HOST) timestamps.shift();
}

/**
 * Check if a host shows a crash pattern (3+ crashes in last 4 hours).
 * Use this before deploying to the same host to avoid repeated failures.
 */
export function isHostCrashPattern(hostKey: string): boolean {
  const timestamps = crashTimestamps.get(hostKey);
  if (!timestamps) return false;
  const cutoff = Date.now() - CRASH_PATTERN_WINDOW_MS;
  const recentCrashes = timestamps.filter((ts) => ts >= cutoff);
  return recentCrashes.length >= CRASH_PATTERN_THRESHOLD;
}

/**
 * Get crash pattern details for a host (for diagnostics).
 */
export function getHostCrashInfo(hostKey: string): {
  recentCrashes: number;
  windowHours: number;
  isPattern: boolean;
  lastCrashAt: number | null;
} {
  const timestamps = crashTimestamps.get(hostKey);
  if (!timestamps || timestamps.length === 0) {
    return { recentCrashes: 0, windowHours: 4, isPattern: false, lastCrashAt: null };
  }
  const cutoff = Date.now() - CRASH_PATTERN_WINDOW_MS;
  const recentCrashes = timestamps.filter((ts) => ts >= cutoff).length;
  return {
    recentCrashes,
    windowHours: 4,
    isPattern: recentCrashes >= CRASH_PATTERN_THRESHOLD,
    lastCrashAt: timestamps[timestamps.length - 1],
  };
}

/**
 * Update host latency EMA from a successful GPU request.
 * Tracks per-stage latency (stt/llm/tts/pipeline) and latency variance (jitter).
 */
/** Recalculate reputationScore every N requests to keep it fresh with latency data */
const REPUTATION_RECALC_INTERVAL = 10;

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

    // Recalculate reputationScore periodically so latency changes are reflected
    const shouldRecalc = requestCount % REPUTATION_RECALC_INTERVAL === 0;
    let scoreUpdate: Record<string, number> = {};
    if (shouldRecalc) {
      // Use updated per-stage latencies for score calculation
      const updatedSttMs = stageUpdate.avgSttMs ?? existing.avgSttMs;
      const updatedLlmMs = stageUpdate.avgLlmMs ?? existing.avgLlmMs;
      const updatedTtsMs = stageUpdate.avgTtsMs ?? existing.avgTtsMs;
      const reputationScore = computeReputationScore({
        deployCount: existing.deployCount,
        successCount: existing.successCount,
        failCount: existing.failCount,
        crashCount: existing.crashCount,
        avgBootTimeS: existing.avgBootTimeS,
        avgUptimeS: existing.avgUptimeS,
        avgLatencyMs,
        latencyVariance,
        requestCount,
        avgSttMs: updatedSttMs, avgLlmMs: updatedLlmMs, avgTtsMs: updatedTtsMs,
        reliability: existing.reliability,
        inetDownMbps: existing.inetDownMbps,
        inetUpMbps: existing.inetUpMbps,
        tier: existing.tier,
        uptimePct: existing.uptimePct,
        pcieBw: existing.pcieBw,
        diskReadMbps: existing.diskReadMbps,
        lastDeployAt: existing.lastDeployAt ?? new Date(),
      });
      const oldScore = existing.reputationScore;
      scoreUpdate = { reputationScore };
      // P2.2: Alert on reputation cliff drop (>0.2 in one recalc)
      if (oldScore - reputationScore > 0.2) {
        log.warn('%s score dropped %.3f → %.3f (Δ=%.3f)', hostKey, oldScore, reputationScore, oldScore - reputationScore);
        try {
          const { broadcastWs } = await import('./ws-state');
          broadcastWs({ type: 'host:degraded', hostKey, oldScore, newScore: reputationScore, reason: `latency=${avgLatencyMs.toFixed(0)}ms` });
        } catch { /* broadcast best-effort; not fatal if no WS clients */ }
      }
      log.log('Recalc %s after %d requests: score=%.3f (latency=%.0fms, var=%.0f)', hostKey, requestCount, reputationScore, avgLatencyMs, latencyVariance);
    }

    await prisma.hostReputation.update({
      where: { hostKey },
      data: { avgLatencyMs, latencyVariance, requestCount, ...stageUpdate, ...scoreUpdate },
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
    log.warn('Failed to load reputations: %s', err instanceof Error ? err.message : err);
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
    log.warn('Failed to load GPU type reputations: %s', err instanceof Error ? err.message : err);
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
    log.warn('Failed to load all reputations: %s', err instanceof Error ? err.message : err);
    return [];
  }
}

// ── Percentile calculation ──────────────────────────────────────────────────

export function computePercentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}

// ── Cached sorted latency snapshot (#501) ─────────────────────────────────────
// `snapshotMetrics()` used to `[...latencyRing].sort()` (O(n log n), n≈1000) on
// EVERY /metrics scrape, then compute p50/p95/p99 off it. The ring only changes
// when recordGpuLatency() bumps `latencyRingGeneration`, so cache the sorted copy
// and reuse it across scrapes until the generation advances — exactly the pattern
// getP95Latency() already uses. Frequent scrapers now pay the sort once per new
// sample batch, not once per request.
let _sortedLatencyCache: number[] = [];
let _sortedLatencyCacheGen = -1;

export function getSortedLatencies(): number[] {
  if (_sortedLatencyCacheGen !== latencyRingGeneration) {
    _sortedLatencyCache = [...latencyRing].sort((a, b) => a - b);
    _sortedLatencyCacheGen = latencyRingGeneration;
  }
  return _sortedLatencyCache;
}

// ── Latency histogram buckets (#591) ──────────────────────────────────────────
// p50/p95/p99 are exposed as point-in-time GAUGES, so PromQL can't re-aggregate
// across instances or compute windowed quantiles. Also export a real cumulative
// histogram (`_bucket{le="..."}` = count of samples ≤ bound, `_sum`, `_count`)
// so Grafana/`histogram_quantile()` works server-side. Buckets are in ms,
// chosen for an STT→LLM→TTS pipeline (sub-100ms hot path through multi-second
// cold GPU calls). Computed from the same generation-cached sorted ring.
export const LATENCY_BUCKETS_MS = [
  10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
] as const;

export interface LatencyHistogram {
  /** Cumulative count of samples ≤ each bound, parallel to LATENCY_BUCKETS_MS. */
  bucketCounts: number[];
  sum: number;
  count: number;
}

/**
 * Build a cumulative-count histogram of the GPU latency ring over
 * {@link LATENCY_BUCKETS_MS}. Cumulative (Prometheus `le` semantics): each
 * bucket count includes all samples ≤ that bound. The implicit `+Inf` bucket
 * equals `count`.
 */
export function computeLatencyHistogram(sortedAsc: number[] = getSortedLatencies()): LatencyHistogram {
  const bucketCounts = new Array(LATENCY_BUCKETS_MS.length).fill(0);
  let sum = 0;
  for (const v of sortedAsc) {
    sum += v;
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
      if (v <= LATENCY_BUCKETS_MS[i]) bucketCounts[i]++;
    }
  }
  return { bucketCounts, sum, count: sortedAsc.length };
}

// ── Provider label allow-list (#592) ──────────────────────────────────────────
// `byProvider`/`byStage` accept any string key, and RequestLogInput.provider is
// typed open; an unexpected provider value would add a permanent Prometheus
// series (unbounded label cardinality). Bucket unknown providers under "other"
// in the exposition so the cardinality is bounded to the known enum + 1.
const KNOWN_PROVIDERS = new Set([
  'gpu', 'groq', 'openai', 'fireworks', 'openrouter', 'ollama',
  'deepgram', 'modal', 'ensemble', 'cache', 'hybrid', 'stream', 'elevenlabs',
]);

export function isKnownProvider(provider: string): boolean {
  return KNOWN_PROVIDERS.has(provider);
}

// ── Bounded GPU-status enum (#593) ────────────────────────────────────────────
// A gauge whose label carried the raw status string created a new, lingering
// Prometheus series per distinct value. Constrain to a fixed enum (+ "other").
const GPU_STATUS_KNOWN = new Set([
  'idle', 'deploying', 'booting', 'installing', 'ready', 'error', 'stopped', 'terminated', 'unknown',
]);
const GPU_STATUS_ENUM = [...GPU_STATUS_KNOWN, 'other'] as const;

/** Collapse unknown provider keys into a single "other" bucket (#592). */
function bucketProviderCounts(byProvider: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [provider, count] of Object.entries(byProvider)) {
    const key = isKnownProvider(provider) ? provider : 'other';
    out[key] = (out[key] ?? 0) + count;
  }
  return out;
}

// ── /metrics endpoint ───────────────────────────────────────────────────────

/**
 * Snapshot the in-memory metrics state into a plain object that both
 * exporters (JSON and Prometheus) can read. Keeps the two formats in sync
 * — they always see the same underlying numbers at the same instant.
 */
function snapshotMetrics(): Record<string, unknown> {
  // #501 — reuse the generation-cached sorted ring instead of sorting per scrape.
  const sorted = getSortedLatencies();
  const uptimeSec = Math.round((Date.now() - startedAt) / 1000);
  const inference = getInferenceCostStats();
  const gpuReqCount = metricsCounters.byProvider['gpu'] || 0;

  return {
    requestsTotal: metricsCounters.requestsTotal,
    requestsByStage: { ...metricsCounters.byStage },
    requestsByProvider: { ...metricsCounters.byProvider },
    errorsTotal: metricsCounters.errorsTotal,
    dbLogFailures: metricsCounters.dbLogFailures,
    latencyP50Ms: computePercentile(sorted, 50),
    latencyP95Ms: computePercentile(sorted, 95),
    latencyP99Ms: computePercentile(sorted, 99),
    // #591 — cumulative GPU-latency histogram (buckets/sum/count) for PromQL
    // histogram_quantile() and cross-instance aggregation. Reuses `sorted`.
    gpuLatencyHistogram: computeLatencyHistogram(sorted),
    gpuStatus: deployState.status,
    uptimeSec,
    tokenUsage: {
      totalInputTokens: metricsCounters.totalInputTokens,
      totalOutputTokens: metricsCounters.totalOutputTokens,
      totalTokens: metricsCounters.totalInputTokens + metricsCounters.totalOutputTokens,
    },
    translationCache: getTranslationCacheStats(),
    cost: {
      dailySpendUsd: dailyGpuSpendUsd,
      dailyBudgetUsd: DAILY_BUDGET_USD,
      budgetPct: DAILY_BUDGET_USD > 0 ? Math.round((dailyGpuSpendUsd / DAILY_BUDGET_USD) * 100) : 0,
      costPerHr: deployState.costPerHr || 0,
      gpuRequests: gpuReqCount,
      // #533 — cloud = total − gpu, instead of an allow-list sum of 3 providers
      // (which silently dropped fireworks/openrouter/deepgram). Clamp at 0.
      cloudRequests: Math.max(0, metricsCounters.requestsTotal - gpuReqCount),
      // #532 — this divides ALL daily spend (incl. idle-time) by GPU request
      // count, so a mostly-idle pod inflates it. Label it honestly as a blended
      // daily figure rather than a true per-request cost.
      blendedCostPerGpuRequestUsd: gpuReqCount > 0 && deployState.costPerHr > 0
        ? +(dailyGpuSpendUsd / gpuReqCount).toFixed(5)
        : null,
      // #594 — monotonic cumulative cloud inference spend (survives daily reset).
      inferenceSpendTotalUsd: inference.cumulativeUsd,
      // #563 — cost per SUCCESSFUL request, per cloud provider.
      costPerSuccessByProvider: inference.costPerSuccessByProvider,
    },
  };
}

/**
 * Escape a label value for Prometheus text format. Backslash, quote, and
 * newline are the three characters that need quoting per the exposition
 * format spec: https://prometheus.io/docs/instrumenting/exposition_formats/
 */
function promLabelEscape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function promLine(name: string, help: string, type: 'counter' | 'gauge', value: number, labels?: Record<string, string>): string {
  const labelStr = labels
    ? '{' + Object.entries(labels).map(([k, v]) => `${k}="${promLabelEscape(v)}"`).join(',') + '}'
    : '';
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name}${labelStr} ${value}\n`;
}

/**
 * Render the metrics snapshot in Prometheus text exposition format.
 * Each counter/gauge gets a HELP + TYPE + sample line. Per-label metrics
 * (by stage, by provider) emit one sample per label value under a single
 * HELP/TYPE header.
 */
function renderPrometheus(snap: Record<string, unknown>): string {
  const lines: string[] = [];

  // Scalar counters / gauges
  lines.push(promLine('gateway_requests_total', 'Total requests served by the gateway', 'counter', snap.requestsTotal as number));
  lines.push(promLine('gateway_errors_total', 'Total errored requests', 'counter', snap.errorsTotal as number));
  lines.push(promLine('gateway_db_log_failures_total', 'Total DB log write failures', 'counter', snap.dbLogFailures as number));
  lines.push(promLine('gateway_uptime_seconds', 'Gateway process uptime in seconds', 'gauge', snap.uptimeSec as number));

  // Latency percentiles as point-in-time gauges. The HELP text used to claim
  // "across all stages", but `latencyRing` is fed ONLY by recordGpuLatency()
  // (cloud latencies are deliberately excluded), so these are GPU-only (#504).
  // Kept under the original names for back-compat with existing dashboards, but
  // the HELP is corrected and GPU-scoped aliases are emitted below.
  lines.push(promLine('gateway_latency_p50_ms', 'p50 GPU-stage latency in ms (GPU-only; see gateway_gpu_latency_p50_ms)', 'gauge', snap.latencyP50Ms as number));
  lines.push(promLine('gateway_latency_p95_ms', 'p95 GPU-stage latency in ms (GPU-only; see gateway_gpu_latency_p95_ms)', 'gauge', snap.latencyP95Ms as number));
  lines.push(promLine('gateway_latency_p99_ms', 'p99 GPU-stage latency in ms (GPU-only; see gateway_gpu_latency_p99_ms)', 'gauge', snap.latencyP99Ms as number));
  // #504 — correctly-named GPU-scoped percentiles. The ring only carries GPU
  // latencies, so `gpu` in the name now matches what the value actually is.
  lines.push(promLine('gateway_gpu_latency_p50_ms', 'p50 GPU inference latency in ms', 'gauge', snap.latencyP50Ms as number));
  lines.push(promLine('gateway_gpu_latency_p95_ms', 'p95 GPU inference latency in ms', 'gauge', snap.latencyP95Ms as number));
  lines.push(promLine('gateway_gpu_latency_p99_ms', 'p99 GPU inference latency in ms', 'gauge', snap.latencyP99Ms as number));

  // #591 — real cumulative histogram so PromQL histogram_quantile() and
  // cross-instance aggregation work (gauges above can't be re-aggregated).
  const hist = snap.gpuLatencyHistogram as LatencyHistogram | undefined;
  if (hist) {
    lines.push('# HELP gateway_gpu_latency_ms GPU inference latency distribution in ms\n# TYPE gateway_gpu_latency_ms histogram\n');
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
      lines.push(`gateway_gpu_latency_ms_bucket{le="${LATENCY_BUCKETS_MS[i]}"} ${hist.bucketCounts[i]}\n`);
    }
    lines.push(`gateway_gpu_latency_ms_bucket{le="+Inf"} ${hist.count}\n`);
    lines.push(`gateway_gpu_latency_ms_sum ${hist.sum}\n`);
    lines.push(`gateway_gpu_latency_ms_count ${hist.count}\n`);
  }

  // Per-stage counters
  const byStage = snap.requestsByStage as Record<string, number>;
  lines.push('# HELP gateway_requests_by_stage Requests served per pipeline stage\n# TYPE gateway_requests_by_stage counter\n');
  for (const [stage, count] of Object.entries(byStage)) {
    lines.push(`gateway_requests_by_stage{stage="${promLabelEscape(stage)}"} ${count}\n`);
  }

  // Per-provider counters — unknown providers bucketed under "other" to bound
  // label cardinality (#592).
  const byProvider = bucketProviderCounts(snap.requestsByProvider as Record<string, number>);
  lines.push('# HELP gateway_requests_by_provider Requests served per provider\n# TYPE gateway_requests_by_provider counter\n');
  for (const [provider, count] of Object.entries(byProvider)) {
    lines.push(`gateway_requests_by_provider{provider="${promLabelEscape(provider)}"} ${count}\n`);
  }

  // Token usage
  const tokens = snap.tokenUsage as { totalInputTokens: number; totalOutputTokens: number; totalTokens: number };
  lines.push(promLine('gateway_tokens_input_total', 'Total input tokens consumed across all LLM providers', 'counter', tokens.totalInputTokens));
  lines.push(promLine('gateway_tokens_output_total', 'Total output tokens emitted across all LLM providers', 'counter', tokens.totalOutputTokens));

  // Cost metrics
  const cost = snap.cost as {
    dailySpendUsd: number; dailyBudgetUsd: number; costPerHr: number;
    inferenceSpendTotalUsd: number; costPerSuccessByProvider: Record<string, number>;
  };
  lines.push(promLine('gateway_daily_spend_usd', 'Current day GPU spend in USD', 'gauge', cost.dailySpendUsd));
  lines.push(promLine('gateway_daily_budget_usd', 'Daily GPU spend cap in USD', 'gauge', cost.dailyBudgetUsd));
  lines.push(promLine('gateway_cost_per_hour_usd', 'Current GPU tier cost per hour in USD', 'gauge', cost.costPerHr));
  // #594 — monotonic cumulative cloud inference spend. Unlike the daily gauge
  // (which resets at midnight, making increase() go negative), this is a counter
  // that only grows, so PromQL increase()/rate() over the reset stay correct.
  lines.push(promLine('gateway_inference_spend_usd_total', 'Cumulative cloud inference spend in USD (monotonic, survives daily reset)', 'counter', cost.inferenceSpendTotalUsd ?? 0));

  // #563 — cost per SUCCESSFUL request, per provider. Surfaces providers that
  // burn money on retries (high error rate → inflated cost-per-success).
  const cps = cost.costPerSuccessByProvider ?? {};
  if (Object.keys(cps).length > 0) {
    lines.push('# HELP gateway_cost_per_success_usd Cloud inference cost per successful request, per provider\n# TYPE gateway_cost_per_success_usd gauge\n');
    for (const [provider, v] of Object.entries(cps)) {
      const p = isKnownProvider(provider) ? provider : 'other';
      lines.push(`gateway_cost_per_success_usd{provider="${promLabelEscape(p)}"} ${v}\n`);
    }
  }

  // #593 — GPU status. Keep the boolean-ready gauge for back-compat, but stop
  // putting the free-form status string in a label that lingers per distinct
  // value (booting/installing/error/...). Emit a bounded-enum gauge that is 1
  // for exactly the current status drawn from a fixed set.
  const gpuStatus = String(snap.gpuStatus ?? 'unknown').toLowerCase();
  const gpuReady = gpuStatus === 'ready' ? 1 : 0;
  lines.push(promLine('gateway_gpu_ready', 'GPU tier readiness (1 = ready, 0 = not ready)', 'gauge', gpuReady));
  lines.push('# HELP gateway_gpu_status GPU tier status (1 = current status, bounded enum)\n# TYPE gateway_gpu_status gauge\n');
  for (const s of GPU_STATUS_ENUM) {
    const isCurrent = s === gpuStatus || (s === 'other' && !GPU_STATUS_KNOWN.has(gpuStatus));
    lines.push(`gateway_gpu_status{status="${s}"} ${isCurrent ? 1 : 0}\n`);
  }

  return lines.join('');
}

/**
 * Public: the metrics snapshot the JSON exporter and /metrics handler share.
 * Exposed so callers (and tests) can read the in-memory metrics without going
 * through the HTTP handler.
 */
export function getMetricsSnapshot(): Record<string, unknown> {
  return snapshotMetrics();
}

/** Public: render the current metrics in Prometheus text exposition format. */
export function renderPrometheusMetrics(): string {
  return renderPrometheus(snapshotMetrics());
}

/**
 * GET /metrics handler. Default output is Prometheus text exposition format
 * (so any standard scraper works with zero adapter code). Pass `?format=json`
 * to get the legacy JSON shape used by the web UI dashboard.
 */
export async function handleMetrics(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/metrics', 'http://localhost');
  const format = url.searchParams.get('format') ?? 'prometheus';

  const snap = snapshotMetrics();
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  if (format === 'json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snap));
    return;
  }

  // Prometheus text format — Content-Type per the spec.
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
  res.end(renderPrometheus(snap));
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
      entries: entries.map((e: any) => ({
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
    log.error('Request log query failed: %s', err instanceof Error ? err.message : err);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      entries: [],
      stats: {
        totalRequests: 0, gpuRequests: 0, cloudRequests: 0,
        totalLatencyMs: 0, avgLatencyMs: 0, gpuPercent: 0, errors: 0,
        requestsByStage: {}, requestsByProvider: {}, byStage: {},
      },
    }));
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
    log.error('Service stats query failed: %s', err instanceof Error ? err.message : err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stats: {}, coldStart: null, warmth: null }));
  }
}

// ── RequestLog → HostReputation Batch Aggregation ─────────────────────────────

/** Track the last aggregated timestamp to avoid re-processing */
let lastAggregatedAt: Date = new Date(Date.now() - 5 * 60_000); // start 5min ago

/**
 * Aggregate recent GPU RequestLog entries and update HostReputation scores.
 * Reads all GPU requests since lastAggregatedAt, groups by stage, updates
 * per-stage EMA latencies and recalculates reputationScore for the current host.
 *
 * This closes the feedback loop: request-level data → host reputation.
 */
export async function aggregateRequestLogsToReputation(): Promise<{ processed: number; hostKey: string | null }> {
  const { deployState } = await import('./state');
  if (!deployState.provider || !deployState.gpuType) {
    return { processed: 0, hostKey: null };
  }

  const hostKey = deriveHostKey(deployState.provider, deployState.providerMeta);
  if (!hostKey) return { processed: 0, hostKey: null };

  try {
    const existing = await prisma.hostReputation.findUnique({ where: { hostKey } });
    if (!existing) return { processed: 0, hostKey };

    // Fetch GPU requests since last aggregation
    const logs = await prisma.requestLog.findMany({
      where: {
        provider: 'gpu',
        success: true,
        timestamp: { gt: lastAggregatedAt },
        latencyMs: { gt: 0 },
      },
      select: { stage: true, latencyMs: true, timestamp: true },
      orderBy: { timestamp: 'asc' },
    });

    if (logs.length === 0) return { processed: 0, hostKey };

    // Update the watermark
    lastAggregatedAt = logs[logs.length - 1].timestamp;

    // Group by stage and compute batch EMA updates
    let avgLatencyMs = existing.avgLatencyMs;
    let latencyVariance = existing.latencyVariance;
    let requestCount = existing.requestCount;
    let avgSttMs = existing.avgSttMs;
    let avgLlmMs = existing.avgLlmMs;
    let avgTtsMs = existing.avgTtsMs;
    let avgPipelineMs = existing.avgPipelineMs;

    for (const log of logs) {
      const deviation = log.latencyMs - avgLatencyMs;
      avgLatencyMs = emaUpdate(avgLatencyMs, log.latencyMs);
      latencyVariance = emaUpdate(latencyVariance, deviation * deviation);
      requestCount++;

      if (log.stage === 'stt') avgSttMs = emaUpdate(avgSttMs, log.latencyMs);
      else if (log.stage === 'llm') avgLlmMs = emaUpdate(avgLlmMs, log.latencyMs);
      else if (log.stage === 'tts') avgTtsMs = emaUpdate(avgTtsMs, log.latencyMs);
      else if (log.stage === 'pipeline') avgPipelineMs = emaUpdate(avgPipelineMs, log.latencyMs);
    }

    // Recalculate reputation score with aggregated data
    const reputationScore = computeReputationScore({
      deployCount: existing.deployCount,
      successCount: existing.successCount,
      failCount: existing.failCount,
      crashCount: existing.crashCount,
      avgBootTimeS: existing.avgBootTimeS,
      avgUptimeS: existing.avgUptimeS,
      avgLatencyMs,
      latencyVariance,
      requestCount,
      reliability: existing.reliability,
      inetDownMbps: existing.inetDownMbps,
      inetUpMbps: existing.inetUpMbps,
      tier: existing.tier,
      uptimePct: existing.uptimePct,
      pcieBw: existing.pcieBw,
      diskReadMbps: existing.diskReadMbps,
      lastDeployAt: existing.lastDeployAt ?? new Date(),
    });

    await prisma.hostReputation.update({
      where: { hostKey },
      data: {
        avgLatencyMs, latencyVariance, requestCount, reputationScore,
        avgSttMs, avgLlmMs, avgTtsMs, avgPipelineMs,
      },
    });

    log.log('%s: aggregated %d requests, score=%.3f (latency=%.0fms)', hostKey, logs.length, reputationScore, avgLatencyMs);
    return { processed: logs.length, hostKey };
  } catch (err) {
    log.warn('Aggregation failed: %s', err instanceof Error ? err.message : err);
    return { processed: 0, hostKey };
  }
}

const AGGREGATION_INTERVAL_MS = 5 * 60_000; // 5 minutes
let aggregationTimer: ReturnType<typeof setInterval> | null = null;

/** Start periodic aggregation of RequestLog → HostReputation. */
export function startReputationAggregation(): void {
  if (aggregationTimer) return; // already running
  aggregationTimer = setInterval(() => {
    aggregateRequestLogsToReputation().catch(safeCatch('reputation-aggregation'));
  }, AGGREGATION_INTERVAL_MS);
  // Don't prevent process exit
  if (aggregationTimer && typeof aggregationTimer === 'object' && 'unref' in aggregationTimer) {
    aggregationTimer.unref();
  }
  log.log('Started periodic aggregation (every 5min)');
}

/** Stop periodic aggregation. */
export function stopReputationAggregation(): void {
  if (aggregationTimer) {
    clearInterval(aggregationTimer);
    aggregationTimer = null;
  }
}
