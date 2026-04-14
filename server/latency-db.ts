/**
 * Persistent store for per-host TCP latency measurements.
 * Previously SQLite (bun:sqlite); now uses Prisma / Neon so data survives
 * Fly.io machine restarts.
 *
 * Schema: HostLatency + HostLatencyHistory (see prisma/schema.prisma)
 */

import { prisma } from './state';
import { createLogger } from '../src/logger';

const log = createLogger('latency-db');

const HISTORY_SIZE = 24;

// Adaptive probe intervals
export const INTERVAL_STABLE_MS   = 2  * 3600_000; // 2h  — stable host
export const INTERVAL_UNSTABLE_MS = 30 * 60_000;   // 30m — high variance
export const INTERVAL_FAILING_MS  = 6  * 3600_000; // 6h  — 3+ failures
const STDDEV_UNSTABLE_MS = 20;                      // ms threshold for "unstable"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HostLatencyRow {
  host_id:              string;
  host_ip:              string;
  provider:             string;
  gpu_name:             string;
  geolocation:          string;
  price_usd:            number;
  direct_port:          number | null;
  median_ms:            number | null;
  p90_ms:               number | null;
  stddev_ms:            number | null;
  success_rate:         number;
  last_probed_at:       number;
  probe_count:          number;
  consecutive_failures: number;
  monitored:            boolean;
}

export interface HostMeta {
  hostIp:      string;
  provider:    string;
  gpuName:     string;
  geolocation: string;
  priceUsd:    number;
  directPort?: number;
}

export interface ProbeResult {
  medianMs: number | null;
  p90Ms:    number | null;
  samples:  number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowFromPrisma(r: {
  hostId: string; hostIp: string; provider: string; gpuName: string;
  geolocation: string; priceUsd: number; directPort: number | null;
  medianMs: number | null; p90Ms: number | null; stddevMs: number | null;
  successRate: number; lastProbedAt: bigint; probeCount: number;
  consecutiveFailures: number; monitored: boolean;
}): HostLatencyRow {
  return {
    host_id:              r.hostId,
    host_ip:              r.hostIp,
    provider:             r.provider,
    gpu_name:             r.gpuName,
    geolocation:          r.geolocation,
    price_usd:            r.priceUsd,
    direct_port:          r.directPort,
    median_ms:            r.medianMs,
    p90_ms:               r.p90Ms,
    stddev_ms:            r.stddevMs,
    success_rate:         r.successRate,
    last_probed_at:       Number(r.lastProbedAt),
    probe_count:          r.probeCount,
    consecutive_failures: r.consecutiveFailures,
    monitored:            r.monitored,
  };
}

function computeStats(values: number[]): { median: number; p90: number; stddev: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const n      = sorted.length;
  const median = sorted[Math.floor(n / 2)];
  const p90    = sorted[Math.min(Math.ceil(n * 0.9) - 1, n - 1)];
  const mean   = values.reduce((a, b) => a + b, 0) / n;
  const stddev = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  return { median, p90, stddev: Math.round(stddev * 10) / 10 };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function upsertHostMeta(hostId: string, meta: HostMeta): Promise<void> {
  await prisma.hostLatency.upsert({
    where: { hostId },
    update: {
      hostIp:      meta.hostIp,
      provider:    meta.provider,
      gpuName:     meta.gpuName,
      geolocation: meta.geolocation,
      priceUsd:    meta.priceUsd,
      directPort:  meta.directPort ?? null,
    },
    create: {
      hostId,
      hostIp:      meta.hostIp,
      provider:    meta.provider,
      gpuName:     meta.gpuName,
      geolocation: meta.geolocation,
      priceUsd:    meta.priceUsd,
      directPort:  meta.directPort ?? null,
    },
  });
}

export async function saveProbeResult(hostId: string, result: ProbeResult, now = Date.now()): Promise<void> {
  // 1. Append history entry
  await prisma.hostLatencyHistory.create({
    data: {
      hostId,
      probedAt: BigInt(now),
      medianMs: result.medianMs,
      p90Ms:    result.p90Ms,
      samples:  result.samples,
    },
  });

  // 2. Prune to last HISTORY_SIZE entries
  const toKeep = await prisma.hostLatencyHistory.findMany({
    where:   { hostId },
    orderBy: { probedAt: 'desc' },
    take:    HISTORY_SIZE,
    select:  { id: true },
  });
  if (toKeep.length === HISTORY_SIZE) {
    const minId = toKeep[HISTORY_SIZE - 1].id;
    await prisma.hostLatencyHistory.deleteMany({
      where: { hostId, id: { lt: minId } },
    });
  }

  // 3. Compute rolling stats
  const history = await prisma.hostLatencyHistory.findMany({
    where:   { hostId, medianMs: { not: null } },
    orderBy: { probedAt: 'desc' },
    take:    HISTORY_SIZE,
    select:  { medianMs: true },
  });

  const totalInWindow = await prisma.hostLatencyHistory.count({ where: { hostId } });

  const medians     = history.map((r: { medianMs: number | null }) => r.medianMs!);
  const successRate = totalInWindow > 0 ? medians.length / totalInWindow : 1;
  const stats       = medians.length > 0 ? computeStats(medians) : null;

  // 4. Update host row
  await prisma.hostLatency.update({
    where: { hostId },
    data: {
      medianMs:            stats?.median  ?? null,
      p90Ms:               stats?.p90     ?? null,
      stddevMs:            stats?.stddev  ?? null,
      successRate,
      lastProbedAt:        BigInt(now),
      probeCount:          { increment: 1 },
      consecutiveFailures: result.samples > 0 ? 0 : { increment: 1 },
    },
  });
}

export async function getHostsToProbe(now = Date.now(), stableIntervalMs = INTERVAL_STABLE_MS): Promise<HostLatencyRow[]> {
  const failCutoff     = BigInt(now - INTERVAL_FAILING_MS);
  const unstableCutoff = BigInt(now - INTERVAL_UNSTABLE_MS);
  const stableCutoff   = BigInt(now - stableIntervalMs);

  const rows = await prisma.hostLatency.findMany({
    where: {
      monitored: true,
      OR: [
        // 3+ failures: retry every 6h
        { consecutiveFailures: { gte: 3 }, lastProbedAt: { lt: failCutoff } },
        // Unstable: retry every 30m
        {
          consecutiveFailures: { lt: 3 },
          stddevMs: { gt: STDDEV_UNSTABLE_MS },
          lastProbedAt: { lt: unstableCutoff },
        },
        // Stable: retry at stableIntervalMs
        {
          consecutiveFailures: { lt: 3 },
          OR: [{ stddevMs: null }, { stddevMs: { lte: STDDEV_UNSTABLE_MS } }],
          lastProbedAt: { lt: stableCutoff },
        },
      ],
    },
  });

  return rows.map(rowFromPrisma);
}

export async function getHostRttMap(hostIds: string[], maxAgeMs = INTERVAL_STABLE_MS): Promise<Record<string, number>> {
  if (hostIds.length === 0) return {};
  const cutoff = BigInt(Date.now() - maxAgeMs);

  const rows = await prisma.hostLatency.findMany({
    where: {
      hostId:             { in: hostIds },
      medianMs:           { not: null },
      lastProbedAt:       { gt: cutoff },
      consecutiveFailures: { lt: 3 },
    },
    select: { hostId: true, medianMs: true },
  });

  const map: Record<string, number> = {};
  for (const r of rows) {
    if (r.medianMs !== null) map[r.hostId] = r.medianMs;
  }
  return map;
}

export async function getAllHostLatencies(): Promise<HostLatencyRow[]> {
  const rows = await prisma.hostLatency.findMany({
    orderBy: [{ medianMs: { sort: 'asc', nulls: 'last' } }],
  });
  return rows.map(rowFromPrisma);
}

export async function setHostsMonitored(hostIds: string[], monitored: boolean): Promise<void> {
  if (hostIds.length === 0) {
    await prisma.hostLatency.updateMany({ data: { monitored } });
  } else {
    await prisma.hostLatency.updateMany({ where: { hostId: { in: hostIds } }, data: { monitored } });
  }
}

export async function getLatencyDbStats(): Promise<{
  totalHosts:     number;
  monitoredHosts: number;
  probedInLast2h: number;
  unstable:       number;
  failing:        number;
  historyRows:    number;
}> {
  const now    = Date.now();
  const cut2h  = BigInt(now - INTERVAL_STABLE_MS);

  const [total, monitored, recent, unstable, failing, historyRows] = await Promise.all([
    prisma.hostLatency.count(),
    prisma.hostLatency.count({ where: { monitored: true } }),
    prisma.hostLatency.count({ where: { lastProbedAt: { gt: cut2h } } }),
    prisma.hostLatency.count({ where: { stddevMs: { gt: STDDEV_UNSTABLE_MS }, consecutiveFailures: { lt: 3 } } }),
    prisma.hostLatency.count({ where: { consecutiveFailures: { gte: 3 } } }),
    prisma.hostLatencyHistory.count(),
  ]);

  return { totalHosts: total, monitoredHosts: monitored, probedInLast2h: recent, unstable, failing, historyRows };
}

export async function sortGpuTypesByLatency(gpuTypes: string[], thresholdMs: number): Promise<string[]> {
  if (thresholdMs <= 0 || gpuTypes.length === 0) return gpuTypes;

  const good: string[]    = [];
  const unknown: string[] = [];
  const allBad: string[]  = [];

  for (const gpuType of gpuTypes) {
    const model = gpuType.replace(/nvidia\s*/gi, '').replace(/geforce\s*/gi, '').trim();

    const rows = await prisma.hostLatency.findMany({
      where:  { gpuName: { contains: model, mode: 'insensitive' }, consecutiveFailures: { lt: 3 } },
      select: { medianMs: true },
    });

    const withData = rows.filter((r: { medianMs: number | null }) => r.medianMs !== null);
    if (withData.length === 0) {
      unknown.push(gpuType);
    } else {
      const best = Math.min(...withData.map((r: { medianMs: number | null }) => r.medianMs!));
      if (best <= thresholdMs) good.push(gpuType);
      else allBad.push(gpuType);
    }
  }

  if (allBad.length > 0) {
    const names = allBad.map(g => g.replace(/nvidia\s*/gi, '').replace(/geforce\s*/gi, '').trim());
    log.log(`GPU types deprioritised (all hosts > ${thresholdMs}ms): ${names.join(', ')}`);
  }

  return [...good, ...unknown, ...allBad];
}

export async function getBestLatencyByGpuModel(): Promise<Record<string, { bestMs: number; region: string }>> {
  const rows = await prisma.hostLatency.findMany({
    where:  { medianMs: { not: null }, consecutiveFailures: { lt: 3 } },
    select: { gpuName: true, medianMs: true, geolocation: true },
  });

  const result: Record<string, { bestMs: number; region: string }> = {};
  for (const row of rows) {
    if (row.medianMs === null) continue;
    const key = row.gpuName.replace(/nvidia\s*/gi, '').replace(/geforce\s*/gi, '').trim().toLowerCase();
    if (!result[key] || row.medianMs < result[key].bestMs) {
      result[key] = { bestMs: Math.round(row.medianMs), region: row.geolocation };
    }
  }
  return result;
}

/** No-op: connection managed by Prisma client in state.ts */
export function closeLatencyDb(): void {}
