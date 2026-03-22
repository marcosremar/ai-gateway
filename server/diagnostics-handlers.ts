// ── BabelCast Gateway — Diagnostics Handlers ────────────────────────────────
// Unified score inspection, database cleanup, and on-demand benchmarking.

import type { IncomingMessage, ServerResponse } from 'http';
import {
  prisma, deployState, latencyRing, metricsCounters, providerMetrics,
} from './state';
import {
  getAllReputations, loadReputationsByGpuType,
  aggregateRequestLogsToReputation, computeReputationScore,
} from './metrics';
import { getOrCreateRequestId, setRequestIdHeader, readJsonBody } from './http-utils';
import { getLatencyDbStats, getAllHostLatencies } from './latency-db';
import { defaultPerformanceRanker } from '../src/providers/performance-ranker';
import { PORT } from './config';

// ── GET /v1/diagnostics/scores ─────────────────────────────────────────────

/**
 * Returns a unified view of ALL scoring/ranking data in the system:
 * - HostReputation scores (Prisma)
 * - PerformanceRanker state (in-memory)
 * - TCP latency probe stats (latency.db)
 * - RequestLog aggregates
 * - Database size stats
 */
export async function handleDiagnosticsScores(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  try {
    // 1. Host reputation (Prisma)
    const allReps = await getAllReputations() as Array<Record<string, unknown>>;
    const repSummary = allReps.map(r => ({
      hostKey: r.hostKey,
      provider: r.provider,
      gpuType: r.gpuType,
      score: r.reputationScore,
      deploys: r.deployCount,
      successes: r.successCount,
      fails: r.failCount,
      crashes: r.crashCount,
      avgLatencyMs: r.avgLatencyMs,
      avgBootTimeS: r.avgBootTimeS,
      requestCount: r.requestCount,
      lastDeployAt: r.lastDeployAt,
      lastSuccessAt: r.lastSuccessAt,
      lastCrashAt: r.lastCrashAt,
    }));

    // 2. GPU type aggregates
    const gpuTypeReps = await loadReputationsByGpuType();
    const gpuTypeScores: Record<string, unknown> = {};
    for (const [key, val] of gpuTypeReps) {
      gpuTypeScores[key] = val;
    }

    // 3. PerformanceRanker state (in-memory cloud provider ranking)
    const perfRankerSnapshot = defaultPerformanceRanker.toJSON();
    const perfRankerSummary: Record<string, { samples: number; newestAge: string }> = {};
    const now = Date.now();
    for (const [key, samples] of Object.entries(perfRankerSnapshot.buffers)) {
      const newest = samples.length > 0 ? samples[samples.length - 1].timestamp : 0;
      const ageMs = newest > 0 ? now - newest : -1;
      perfRankerSummary[key] = {
        samples: samples.length,
        newestAge: ageMs >= 0 ? `${Math.round(ageMs / 1000)}s ago` : 'no data',
      };
    }

    // 4. TCP latency stats (latency.db)
    const latencyDbStats = getLatencyDbStats();
    const tcpHosts = getAllHostLatencies();
    const tcpSummary = tcpHosts
      .filter(h => h.median_ms !== null)
      .sort((a, b) => (a.median_ms ?? Infinity) - (b.median_ms ?? Infinity))
      .slice(0, 20) // top 20 by latency
      .map(h => ({
        hostId: h.host_id,
        provider: h.provider,
        gpu: h.gpu_name,
        region: h.geolocation,
        medianMs: h.median_ms,
        p90Ms: h.p90_ms,
        stddevMs: h.stddev_ms,
        successRate: h.success_rate,
        probeCount: h.probe_count,
        monitored: !!h.monitored,
      }));

    // 5. Database size stats
    const [requestLogCount, gpuEventCount, hostRepCount, deploySessionCount, compatTestCount] = await Promise.all([
      prisma.requestLog.count(),
      prisma.gpuEvent.count(),
      prisma.hostReputation.count(),
      prisma.gpuDeploySession.count(),
      prisma.gpuCompatibilityTest.count(),
    ]);

    // 6. In-memory metrics
    const latencyP50 = latencyRing.length > 0
      ? [...latencyRing].sort((a, b) => a - b)[Math.floor(latencyRing.length * 0.5)]
      : null;
    const latencyP95 = latencyRing.length > 0
      ? [...latencyRing].sort((a, b) => a - b)[Math.floor(latencyRing.length * 0.95)]
      : null;

    // Oldest records
    const oldestRequest = await prisma.requestLog.findFirst({ orderBy: { timestamp: 'asc' }, select: { timestamp: true } });
    const oldestEvent = await prisma.gpuEvent.findFirst({ orderBy: { timestamp: 'asc' }, select: { timestamp: true } });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      timestamp: new Date().toISOString(),
      gpu: {
        status: deployState.status,
        provider: deployState.provider || null,
        gpuType: deployState.gpuType || null,
        endpoint: deployState.endpoint || null,
      },
      hostReputations: {
        count: repSummary.length,
        hosts: repSummary.sort((a, b) => (b.score as number) - (a.score as number)),
      },
      gpuTypeScores,
      performanceRanker: {
        trackedKeys: Object.keys(perfRankerSummary).length,
        keys: perfRankerSummary,
      },
      tcpLatency: {
        dbStats: latencyDbStats,
        topHosts: tcpSummary,
      },
      inMemoryMetrics: {
        totalRequests: metricsCounters.requestsTotal,
        totalErrors: metricsCounters.errorsTotal,
        latencyRingSamples: latencyRing.length,
        latencyP50,
        latencyP95,
        byStage: metricsCounters.byStage,
        byProvider: metricsCounters.byProvider,
      },
      database: {
        requestLogRows: requestLogCount,
        gpuEventRows: gpuEventCount,
        hostReputationRows: hostRepCount,
        deploySessionRows: deploySessionCount,
        compatTestRows: compatTestCount,
        oldestRequestLog: oldestRequest?.timestamp ?? null,
        oldestGpuEvent: oldestEvent?.timestamp ?? null,
      },
    }, null, 2));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Diagnostics failed: ${err}` }));
  }
}

// ── POST /v1/diagnostics/cleanup ───────────────────────────────────────────

/**
 * Prune old data from the database.
 * Body (all optional):
 *   requestLogDays: number (default 30) — delete RequestLog older than N days
 *   gpuEventDays: number (default 90) — delete GpuEvent older than N days
 *   staleHostDays: number (default 60) — remove HostReputation with 0 deploys and no activity
 *   dryRun: boolean (default true) — if true, only report what would be deleted
 */
export async function handleDiagnosticsCleanup(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  const body = await readJsonBody(req).catch(() => ({})) as Record<string, unknown>;
  const requestLogDays = typeof body.requestLogDays === 'number' ? body.requestLogDays : 30;
  const gpuEventDays = typeof body.gpuEventDays === 'number' ? body.gpuEventDays : 90;
  const staleHostDays = typeof body.staleHostDays === 'number' ? body.staleHostDays : 60;
  const dryRun = body.dryRun !== false; // default true for safety

  try {
    const now = new Date();
    const requestLogCutoff = new Date(now.getTime() - requestLogDays * 86400_000);
    const gpuEventCutoff = new Date(now.getTime() - gpuEventDays * 86400_000);
    const staleHostCutoff = new Date(now.getTime() - staleHostDays * 86400_000);

    // Count what would be deleted
    const requestLogStale = await prisma.requestLog.count({
      where: { timestamp: { lt: requestLogCutoff } },
    });
    const gpuEventStale = await prisma.gpuEvent.count({
      where: { timestamp: { lt: gpuEventCutoff } },
    });
    // Stale hosts: 0 deploys AND no updates since cutoff
    const staleHosts = await prisma.hostReputation.findMany({
      where: {
        deployCount: 0,
        updatedAt: { lt: staleHostCutoff },
      },
      select: { hostKey: true, provider: true, gpuType: true, updatedAt: true },
    });
    // Hosts with only failed deploys and no success ever, and old
    const failOnlyHosts = await prisma.hostReputation.findMany({
      where: {
        successCount: 0,
        deployCount: { gt: 0 },
        updatedAt: { lt: staleHostCutoff },
      },
      select: { hostKey: true, provider: true, gpuType: true, reputationScore: true, deployCount: true, updatedAt: true },
    });

    let deleted = { requestLog: 0, gpuEvent: 0, staleHosts: 0, failOnlyHosts: 0 };

    if (!dryRun) {
      // Perform deletions
      const rlResult = await prisma.requestLog.deleteMany({
        where: { timestamp: { lt: requestLogCutoff } },
      });
      deleted.requestLog = rlResult.count;

      const geResult = await prisma.gpuEvent.deleteMany({
        where: { timestamp: { lt: gpuEventCutoff } },
      });
      deleted.gpuEvent = geResult.count;

      if (staleHosts.length > 0) {
        const shResult = await prisma.hostReputation.deleteMany({
          where: {
            hostKey: { in: staleHosts.map(h => h.hostKey) },
          },
        });
        deleted.staleHosts = shResult.count;
      }

      if (failOnlyHosts.length > 0) {
        const fhResult = await prisma.hostReputation.deleteMany({
          where: {
            hostKey: { in: failOnlyHosts.map(h => h.hostKey) },
          },
        });
        deleted.failOnlyHosts = fhResult.count;
      }

      console.log(`[cleanup] Deleted: ${deleted.requestLog} request logs, ${deleted.gpuEvent} GPU events, ${deleted.staleHosts} stale hosts, ${deleted.failOnlyHosts} fail-only hosts`);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      dryRun,
      cutoffs: {
        requestLog: { days: requestLogDays, before: requestLogCutoff.toISOString() },
        gpuEvent: { days: gpuEventDays, before: gpuEventCutoff.toISOString() },
        staleHosts: { days: staleHostDays, before: staleHostCutoff.toISOString() },
      },
      wouldDelete: {
        requestLogRows: requestLogStale,
        gpuEventRows: gpuEventStale,
        staleHosts: staleHosts.map(h => ({ hostKey: h.hostKey, provider: h.provider, gpuType: h.gpuType })),
        failOnlyHosts: failOnlyHosts.map(h => ({
          hostKey: h.hostKey, provider: h.provider, gpuType: h.gpuType,
          score: h.reputationScore, deploys: h.deployCount,
        })),
      },
      ...(dryRun ? {} : { deleted }),
    }, null, 2));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Cleanup failed: ${err}` }));
  }
}

// ── POST /v1/diagnostics/benchmark ─────────────────────────────────────────

/**
 * Run an on-demand benchmark against the current GPU pod.
 * Sends test STT+LLM+TTS requests, measures per-stage latency,
 * updates HostReputation, and returns results.
 *
 * Body (optional):
 *   rounds: number (default 3) — number of benchmark rounds
 *   text: string — test text for LLM+TTS (default: short sentence)
 */
export async function handleDiagnosticsBenchmark(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);

  if (deployState.status !== 'ready' || !deployState.endpoint) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No GPU pod is currently ready', gpuStatus: deployState.status }));
    return;
  }

  const body = await readJsonBody(req).catch(() => ({})) as Record<string, unknown>;
  const rounds = Math.min(typeof body.rounds === 'number' ? body.rounds : 3, 10);
  const testText = typeof body.text === 'string' ? body.text : 'This is a benchmark test for latency measurement.';

  const endpoint = deployState.endpoint;
  const results: Array<{
    round: number;
    sttMs: number | null;
    llmMs: number | null;
    ttsMs: number | null;
    totalMs: number;
    success: boolean;
    error?: string;
  }> = [];

  for (let i = 0; i < rounds; i++) {
    const roundStart = Date.now();
    try {
      // STT benchmark: send a small WAV to the GPU's health/ping endpoint
      // We'll use the /health endpoint per-service timing instead of full pipeline
      const sttStart = Date.now();
      const sttRes = await fetch(`${endpoint}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data' },
        body: createMinimalWavForm(),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      const sttMs = sttRes?.ok ? Date.now() - sttStart : null;

      // LLM benchmark
      const llmStart = Date.now();
      const llmRes = await fetch(`${endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: testText }],
          max_tokens: 50,
        }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      const llmMs = llmRes?.ok ? Date.now() - llmStart : null;

      // TTS benchmark
      const ttsStart = Date.now();
      const ttsRes = await fetch(`${endpoint}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: testText, voice: 'default' }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      // Consume the body to measure full transfer time
      if (ttsRes?.ok) await ttsRes.arrayBuffer();
      const ttsMs = ttsRes?.ok ? Date.now() - ttsStart : null;

      const totalMs = Date.now() - roundStart;
      results.push({ round: i + 1, sttMs, llmMs, ttsMs, totalMs, success: true });
    } catch (err) {
      results.push({
        round: i + 1,
        sttMs: null, llmMs: null, ttsMs: null,
        totalMs: Date.now() - roundStart,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Compute aggregates
  const successful = results.filter(r => r.success);
  const avg = (arr: (number | null)[]) => {
    const valid = arr.filter((v): v is number => v !== null);
    return valid.length > 0 ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length) : null;
  };

  const summary = {
    rounds: results.length,
    successfulRounds: successful.length,
    avgSttMs: avg(results.map(r => r.sttMs)),
    avgLlmMs: avg(results.map(r => r.llmMs)),
    avgTtsMs: avg(results.map(r => r.ttsMs)),
    avgTotalMs: avg(results.map(r => r.totalMs)),
  };

  // Force a reputation aggregation right after benchmark
  const aggregation = await aggregateRequestLogsToReputation().catch(() => ({ processed: 0, hostKey: null }));

  // Get the current host reputation score
  let currentScore: number | null = null;
  if (deployState.provider && deployState.gpuType) {
    try {
      const { deriveHostKey } = await import('./metrics');
      const hostKey = deriveHostKey(deployState.provider, deployState.providerMeta);
      if (hostKey) {
        const rep = await prisma.hostReputation.findUnique({
          where: { hostKey },
          select: { reputationScore: true, requestCount: true, avgLatencyMs: true },
        });
        currentScore = rep?.reputationScore ?? null;
      }
    } catch {}
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    gpu: {
      provider: deployState.provider,
      gpuType: deployState.gpuType,
      endpoint: deployState.endpoint,
    },
    summary,
    results,
    reputation: {
      currentScore,
      aggregation,
    },
  }, null, 2));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a minimal valid WAV file (1s of silence at 16kHz mono) for STT benchmarking. */
function createMinimalWavForm(): FormData {
  const sampleRate = 16000;
  const numSamples = sampleRate; // 1 second
  const dataSize = numSamples * 2; // 16-bit PCM
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // WAV header
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  // PCM data: silence (all zeros already from ArrayBuffer)

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'benchmark.wav');
  form.append('model', 'whisper-large-v3');
  return form;
}

// ── Daily cleanup scheduler ────────────────────────────────────────────────

const CLEANUP_INTERVAL_MS = 24 * 3600_000; // 24 hours
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

async function runDailyCleanup(): Promise<void> {
  try {
    const requestLogCutoff = new Date(Date.now() - 30 * 86400_000);
    const gpuEventCutoff = new Date(Date.now() - 90 * 86400_000);
    const staleHostCutoff = new Date(Date.now() - 60 * 86400_000);

    const rl = await prisma.requestLog.deleteMany({ where: { timestamp: { lt: requestLogCutoff } } });
    const ge = await prisma.gpuEvent.deleteMany({ where: { timestamp: { lt: gpuEventCutoff } } });
    const sh = await prisma.hostReputation.deleteMany({
      where: { deployCount: 0, updatedAt: { lt: staleHostCutoff } },
    });

    if (rl.count > 0 || ge.count > 0 || sh.count > 0) {
      console.log(`[cleanup] Daily: ${rl.count} request logs, ${ge.count} GPU events, ${sh.count} stale hosts removed`);
    }
  } catch (err) {
    console.warn('[cleanup] Daily cleanup failed:', err);
  }
}

export function startDailyCleanup(): void {
  if (cleanupTimer) return;
  // Run first cleanup 1 hour after startup (avoid heavy I/O at boot)
  setTimeout(() => {
    runDailyCleanup().catch(() => {});
    cleanupTimer = setInterval(() => runDailyCleanup().catch(() => {}), CLEANUP_INTERVAL_MS);
    if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
      cleanupTimer.unref();
    }
  }, 3600_000).unref?.();
  console.log('[cleanup] Daily cleanup scheduled (first run in 1h, then every 24h)');
}

export function stopDailyCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
