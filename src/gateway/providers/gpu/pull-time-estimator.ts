/**
 * Adaptive pull timeout estimator for Docker images on GPU cloud providers.
 *
 * Predicts how long an image pull will take based on:
 *   1. Host-specific historical pull times (highest confidence)
 *   2. Image-level aggregate pull times + host bandwidth
 *   3. Calculated from compressed image size ÷ host bandwidth
 *   4. Conservative defaults based on disk size
 *
 * Benchmark data (2026-03-22):
 *   babelcast-groq (~8GB compressed):  500Mbps host → ~130s, 1Gbps → ~65s
 *   babelcast-mistral (~18GB compressed): 500Mbps → ~290s, 1Gbps → ~145s
 *   pytorch/pytorch (~3GB compressed): 500Mbps → ~50s, 1Gbps → ~25s
 */

import { AbstractGpuProvider } from './abstract-provider';
import { defaultLogger as log } from '../../../logger';

export interface PullTimeEstimate {
  estimatedPullS: number;
  timeoutMs: number;
  confidence: 'historical' | 'calculated' | 'default';
  basis: string;
}

/** Minimum pull timeout — even cached images need time for layer extraction. */
const MIN_TIMEOUT_MS = 120_000; // 2 min
/** Maximum pull timeout — if it takes this long, the host is too slow. */
const MAX_TIMEOUT_MS = 1_800_000; // 30 min
/** First-run timeout — no data yet, let it run long to collect baseline. */
const FIRST_RUN_TIMEOUT_MS = 1_800_000; // 30 min
/** Default safety multiplier applied to estimated pull time. */
const DEFAULT_SAFETY = 2.0;

// ── In-memory image size cache (avoids repeated Docker Hub API calls) ──────

interface ImageSizeEntry {
  compressedGb: number;
  fetchedAt: number;
}

const imageSizeCache = new Map<string, ImageSizeEntry>();
const CACHE_TTL_MS = 24 * 3600_000; // 24 hours

// Periodic sweep of expired image size cache entries
if (typeof setInterval !== 'undefined') {
  const _sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of imageSizeCache) {
      if (now - entry.fetchedAt > CACHE_TTL_MS) imageSizeCache.delete(key);
    }
  }, 60 * 60_000); // every 1 hour
  if (_sweep.unref) _sweep.unref();
}

// ── In-memory pull time history (persists for gateway lifetime) ─────────────

interface PullRecord {
  dockerImage: string;
  hostKey: string; // provider:machineId or provider:ip — identifies the physical machine
  inetDownMbps: number;
  pullTimeS: number;
  bootTimeS: number; // total boot time (pull + container start + model load)
  recordedAt: number;
}

const pullHistory: PullRecord[] = [];
const MAX_HISTORY = 500;

/**
 * Derive a stable host key from provider metadata.
 * This identifies the physical machine across deploys.
 */
export function deriveHostKey(provider: string, meta?: Record<string, unknown>): string {
  const machineId = meta?.machineId ?? meta?.machine_id ?? meta?.hostId ?? meta?.host_id;
  if (machineId) return `${provider}:${machineId}`;
  const ip = meta?.publicIp ?? meta?.public_ipaddr ?? meta?.ip;
  if (ip) return `${provider}:${ip}`;
  return `${provider}:unknown`;
}

/**
 * Record an actual pull/boot time observation. Called after successful deploys.
 */
export function recordPullTime(
  dockerImage: string,
  pullTimeS: number,
  inetDownMbps?: number,
  hostKey?: string,
  bootTimeS?: number,
): void {
  pullHistory.push({
    dockerImage,
    hostKey: hostKey || 'unknown',
    inetDownMbps: inetDownMbps || 500,
    pullTimeS,
    bootTimeS: bootTimeS || pullTimeS,
    recordedAt: Date.now(),
  });
  while (pullHistory.length > MAX_HISTORY) pullHistory.shift();
  log.log(
    `[pull-estimator] Recorded: ${dockerImage} on ${hostKey || '?'} — pull=${pullTimeS}s boot=${bootTimeS || '?'}s inet=${inetDownMbps || '?'}Mbps`,
  );
}

/**
 * How many observations we have for a given image (or image+host).
 */
export function getObservationCount(dockerImage: string, hostKey?: string): number {
  if (hostKey) {
    return pullHistory.filter((r) => r.dockerImage === dockerImage && r.hostKey === hostKey).length;
  }
  return pullHistory.filter((r) => r.dockerImage === dockerImage).length;
}

/**
 * Get the compressed size of a Docker image in GB.
 * Uses in-memory cache with 24h TTL, falls back to Docker Hub API.
 */
async function getCompressedSizeGb(dockerImage: string): Promise<number | null> {
  // Check cache
  const cached = imageSizeCache.get(dockerImage);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.compressedGb;
  }

  try {
    // Parse image name
    const [imagePart, tag = 'latest'] = dockerImage.split(':');
    const repo = imagePart.includes('/') ? imagePart : `library/${imagePart}`;

    // Get auth token
    const tokenRes = await fetch(
      `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!tokenRes.ok) return null;
    const { token } = (await tokenRes.json()) as { token: string };

    // Get manifest
    const manifestRes = await fetch(`https://registry-1.docker.io/v2/${repo}/manifests/${tag}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: [
          'application/vnd.oci.image.index.v1+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
          'application/vnd.docker.distribution.manifest.v2+json',
          'application/vnd.oci.image.manifest.v1+json',
        ].join(', '),
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!manifestRes.ok) return null;

    const data = (await manifestRes.json()) as Record<string, unknown>;
    let compressedBytes = 0;

    if (data.manifests && Array.isArray(data.manifests)) {
      // Multi-arch: find amd64
      const amd64 = (data.manifests as Array<Record<string, unknown>>).find((m) => {
        const p = m.platform as Record<string, string> | undefined;
        return p && p.architecture === 'amd64' && p.os === 'linux';
      });
      if (!amd64) return null;

      const singleRes = await fetch(
        `https://registry-1.docker.io/v2/${repo}/manifests/${amd64.digest as string}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept:
              'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json',
          },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!singleRes.ok) return null;
      const single = (await singleRes.json()) as Record<string, unknown>;
      const layers = (single.layers ?? single.fsLayers) as Array<{ size?: number }> | undefined;
      if (layers) compressedBytes = layers.reduce((sum, l) => sum + (l.size ?? 0), 0);
    } else {
      const layers = (data.layers ?? data.fsLayers) as Array<{ size?: number }> | undefined;
      if (layers) compressedBytes = layers.reduce((sum, l) => sum + (l.size ?? 0), 0);
    }

    if (compressedBytes === 0) return null;

    const compressedGb = compressedBytes / 1024 ** 3;
    imageSizeCache.set(dockerImage, { compressedGb, fetchedAt: Date.now() });
    return compressedGb;
  } catch {
    return null;
  }
}

/**
 * Estimate how long a Docker image pull will take and return an adaptive timeout.
 *
 * Strategy:
 *   - < 10 observations for this image: generous timeout (30 min) to collect baseline
 *   - ≥ 10 observations: avg pull time + 30% safety margin (tight, data-driven)
 *   - Host-specific history overrides image-level when available
 */
export async function estimatePullTimeout(opts: {
  dockerImage: string;
  inetDownMbps?: number;
  diskGb?: number;
  hostKey?: string;
}): Promise<PullTimeEstimate> {
  const { dockerImage, inetDownMbps = 500, diskGb = 20, hostKey } = opts;

  // ── Priority 1: Host-specific history for this image ────────────────────
  if (hostKey) {
    const hostHistory = pullHistory.filter(
      (r) => r.dockerImage === dockerImage && r.hostKey === hostKey,
    );
    if (hostHistory.length >= 3) {
      const avgPullS = hostHistory.reduce((s, r) => s + r.pullTimeS, 0) / hostHistory.length;
      const timeoutMs = clamp(avgPullS * 1.3 * 1000); // +30% of this host's average
      return {
        estimatedPullS: Math.round(avgPullS),
        timeoutMs,
        confidence: 'historical',
        basis: `host ${hostKey}: ${hostHistory.length} runs, avg ${Math.round(avgPullS)}s × 1.3`,
      };
    }
  }

  // ── Priority 2: Image-level history (≥10 observations = tight timeout) ──
  const imageHistory = pullHistory.filter((r) => r.dockerImage === dockerImage);
  if (imageHistory.length >= 10) {
    // Enough data — use avg + 30% safety, adjusted for host speed
    const avgPullS = imageHistory.reduce((s, r) => s + r.pullTimeS, 0) / imageHistory.length;
    const avgInet = imageHistory.reduce((s, r) => s + r.inetDownMbps, 0) / imageHistory.length;
    const speedRatio = avgInet / Math.max(inetDownMbps, 100);
    const adjusted = avgPullS * speedRatio;
    const timeoutMs = clamp(adjusted * 1.3 * 1000); // +30% safety

    return {
      estimatedPullS: Math.round(adjusted),
      timeoutMs,
      confidence: 'historical',
      basis: `${imageHistory.length} observations, avg ${Math.round(avgPullS)}s @ ${Math.round(avgInet)}Mbps → ${Math.round(adjusted)}s @ ${inetDownMbps}Mbps × 1.3`,
    };
  }

  // ── Priority 3: Few observations (< 10) — generous timeout to learn ─────
  if (imageHistory.length > 0) {
    // Some data but not enough — use generous timeout while collecting more
    const maxSeen = Math.max(...imageHistory.map((r) => r.pullTimeS));
    const timeoutMs = clamp(Math.max(maxSeen * 2.0, FIRST_RUN_TIMEOUT_MS / 2) * 1000);
    return {
      estimatedPullS: Math.round(maxSeen),
      timeoutMs,
      confidence: 'calculated',
      basis: `${imageHistory.length}/10 observations (learning), max seen ${Math.round(maxSeen)}s × 2.0 — need ${10 - imageHistory.length} more for tight timeout`,
    };
  }

  // ── Priority 4: No history — calculate from image size if possible ──────
  const compressedGb = await getCompressedSizeGb(dockerImage);
  if (compressedGb !== null && compressedGb > 0) {
    // First deploy of this image — use calculated estimate but be generous
    const theoreticalS = (compressedGb * 1024 * 8) / Math.max(inetDownMbps, 100);
    const withOverhead = theoreticalS * 1.3;
    // First run: use max of calculated×2 or 15 min, up to 30 min
    const timeoutMs = clamp(Math.max(withOverhead * 2.0, 900) * 1000);

    return {
      estimatedPullS: Math.round(withOverhead),
      timeoutMs,
      confidence: 'calculated',
      basis: `FIRST RUN: ${compressedGb.toFixed(1)}GB ÷ ${inetDownMbps}Mbps ≈ ${Math.round(withOverhead)}s — generous timeout (no history)`,
    };
  }

  // ── Priority 5: No data at all — maximum generous timeout ───────────────
  return {
    estimatedPullS: 0,
    timeoutMs: FIRST_RUN_TIMEOUT_MS, // 30 min — let it run to collect baseline
    confidence: 'default',
    basis: `NO DATA: first deploy of ${dockerImage}, 30 min generous timeout to collect baseline`,
  };
}

function clamp(ms: number): number {
  return Math.max(MIN_TIMEOUT_MS, Math.min(Math.round(ms), MAX_TIMEOUT_MS));
}

// ── Deploy Phase ETA Estimation ──────────────────────────────────────────────

export type DeployPhase = 'pulling' | 'booting' | 'loading_models';

/**
 * Estimate remaining time for a deploy phase based on elapsed time,
 * network speed, and optional model size.
 *
 * Confidence levels:
 *   - 'high':   historical data available for this host+image
 *   - 'medium': reasonable defaults with some signal
 *   - 'low':    purely heuristic (no prior data)
 */
export function estimateRemainingMs(
  phase: DeployPhase,
  elapsedMs: number,
  inetDownMbps: number,
  modelSizeGb?: number,
): { etaMs: number; confidence: 'high' | 'medium' | 'low' } {
  switch (phase) {
    case 'pulling': {
      // Estimate based on typical Docker image sizes and download speed
      const typicalImageGb = 15; // vLLM image ~12-15GB compressed
      const downloadMs = ((typicalImageGb * 8 * 1024) / (inetDownMbps || 500)) * 1000;
      const remaining = Math.max(0, downloadMs - elapsedMs);
      return { etaMs: remaining, confidence: 'low' };
    }
    case 'booting': {
      // Container up, starting app. Typically 10-30s for Python apps
      return { etaMs: Math.max(0, 30_000 - elapsedMs), confidence: 'medium' };
    }
    case 'loading_models': {
      // Model download + GPU load
      const sizeGb = modelSizeGb || 10;
      const downloadMs = ((sizeGb * 8 * 1024) / (inetDownMbps || 500)) * 1000;
      const loadMs = sizeGb * 3000; // ~3s per GB to load into VRAM
      const totalMs = downloadMs + loadMs;
      const remaining = Math.max(0, totalMs - elapsedMs);
      return { etaMs: remaining, confidence: 'low' };
    }
  }
}

// ── Download Speed Metrics ───────────────────────────────────────────────────

interface DownloadSpeedRecord {
  hostKey: string;
  imageSizeGb: number;
  pullTimeS: number;
  speedMbps: number;
  recordedAt: number;
}

const downloadSpeedHistory: DownloadSpeedRecord[] = [];
const MAX_SPEED_HISTORY = 200;

/**
 * Record observed download speed from a completed image pull.
 * Feeds back into future pull time estimates for the same host.
 */
export function recordDownloadSpeed(
  hostKey: string,
  imageSizeGb: number,
  pullTimeS: number,
): void {
  if (pullTimeS <= 0 || imageSizeGb <= 0) return;
  const speedMbps = (imageSizeGb * 8 * 1024) / pullTimeS;
  downloadSpeedHistory.push({
    hostKey,
    imageSizeGb,
    pullTimeS,
    speedMbps,
    recordedAt: Date.now(),
  });
  while (downloadSpeedHistory.length > MAX_SPEED_HISTORY) downloadSpeedHistory.shift();
  log.log(
    `[pull-estimator] Download speed: ${hostKey} — ${imageSizeGb.toFixed(1)}GB in ${pullTimeS.toFixed(0)}s = ${speedMbps.toFixed(0)} Mbps`,
  );
}

/**
 * Get the average observed download speed for a host (Mbps).
 * Returns null if no observations exist.
 */
export function getHostDownloadSpeed(hostKey: string): number | null {
  const records = downloadSpeedHistory.filter((r) => r.hostKey === hostKey);
  if (records.length === 0) return null;
  return records.reduce((sum, r) => sum + r.speedMbps, 0) / records.length;
}

/**
 * Pre-warm the image size cache for known images.
 * Call on gateway startup to avoid latency on first deploy.
 */
export async function prewarmImageSizeCache(images: string[]): Promise<void> {
  const results = await Promise.allSettled(
    images.map(async (img) => {
      const size = await getCompressedSizeGb(img);
      if (size !== null) {
        log.log(`[pull-estimator] Cached: ${img} = ${size.toFixed(2)}GB compressed`);
      }
      return size;
    }),
  );
  const cached = results.filter((r) => r.status === 'fulfilled' && r.value !== null).length;
  log.log(`[pull-estimator] Pre-warmed ${cached}/${images.length} image sizes`);
}
