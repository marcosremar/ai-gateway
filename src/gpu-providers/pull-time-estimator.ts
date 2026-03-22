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

export interface PullTimeEstimate {
  estimatedPullS: number;
  timeoutMs: number;
  confidence: 'historical' | 'calculated' | 'default';
  basis: string;
}

/** Minimum pull timeout — even cached images need time for layer extraction. */
const MIN_TIMEOUT_MS = 120_000;  // 2 min
/** Maximum pull timeout — if it takes this long, the host is too slow. */
const MAX_TIMEOUT_MS = 1_800_000; // 30 min
/** Default safety multiplier applied to estimated pull time. */
const DEFAULT_SAFETY = 2.0;

// ── In-memory image size cache (avoids repeated Docker Hub API calls) ──────

interface ImageSizeEntry {
  compressedGb: number;
  fetchedAt: number;
}

const imageSizeCache = new Map<string, ImageSizeEntry>();
const CACHE_TTL_MS = 24 * 3600_000; // 24 hours

// ── In-memory pull time history (persists for gateway lifetime) ─────────────

interface PullRecord {
  dockerImage: string;
  inetDownMbps: number;
  pullTimeS: number;
  recordedAt: number;
}

const pullHistory: PullRecord[] = [];
const MAX_HISTORY = 200;

/**
 * Record an actual pull time observation. Called after successful deploys.
 */
export function recordPullTime(dockerImage: string, pullTimeS: number, inetDownMbps?: number): void {
  pullHistory.push({
    dockerImage,
    inetDownMbps: inetDownMbps || 500,
    pullTimeS,
    recordedAt: Date.now(),
  });
  // Trim old entries
  while (pullHistory.length > MAX_HISTORY) pullHistory.shift();
  console.log(`[pull-estimator] Recorded: ${dockerImage} pulled in ${pullTimeS}s (inet=${inetDownMbps || '?'}Mbps)`);
}

/**
 * Get the compressed size of a Docker image in GB.
 * Uses in-memory cache with 24h TTL, falls back to Docker Hub API.
 */
async function getCompressedSizeGb(dockerImage: string): Promise<number | null> {
  // Check cache
  const cached = imageSizeCache.get(dockerImage);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
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
    const manifestRes = await fetch(
      `https://registry-1.docker.io/v2/${repo}/manifests/${tag}`,
      {
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
      },
    );
    if (!manifestRes.ok) return null;

    const data = (await manifestRes.json()) as Record<string, unknown>;
    let compressedBytes = 0;

    if (data.manifests && Array.isArray(data.manifests)) {
      // Multi-arch: find amd64
      const amd64 = (data.manifests as Array<Record<string, unknown>>).find(m => {
        const p = m.platform as Record<string, string> | undefined;
        return p && p.architecture === 'amd64' && p.os === 'linux';
      });
      if (!amd64) return null;

      const singleRes = await fetch(
        `https://registry-1.docker.io/v2/${repo}/manifests/${amd64.digest as string}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json',
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

    const compressedGb = compressedBytes / (1024 ** 3);
    imageSizeCache.set(dockerImage, { compressedGb, fetchedAt: Date.now() });
    return compressedGb;
  } catch {
    return null;
  }
}

/**
 * Estimate how long a Docker image pull will take and return an adaptive timeout.
 */
export async function estimatePullTimeout(opts: {
  dockerImage: string;
  inetDownMbps?: number;
  diskGb?: number;
  safetyMultiplier?: number;
}): Promise<PullTimeEstimate> {
  const { dockerImage, inetDownMbps = 500, diskGb = 20 } = opts;
  const safety = opts.safetyMultiplier ?? DEFAULT_SAFETY;

  // ── Priority 1: Historical pull times for this exact image ──────────────
  const imageHistory = pullHistory.filter(r => r.dockerImage === dockerImage);
  if (imageHistory.length >= 2) {
    // Adjust for host speed difference
    const avgPullS = imageHistory.reduce((s, r) => s + r.pullTimeS, 0) / imageHistory.length;
    const avgInet = imageHistory.reduce((s, r) => s + r.inetDownMbps, 0) / imageHistory.length;
    const speedRatio = avgInet / Math.max(inetDownMbps, 100);
    const adjusted = avgPullS * speedRatio;
    const timeoutMs = clamp(adjusted * safety * 1000);

    return {
      estimatedPullS: Math.round(adjusted),
      timeoutMs,
      confidence: 'historical',
      basis: `${imageHistory.length} observations, avg ${Math.round(avgPullS)}s @ ${Math.round(avgInet)}Mbps → adjusted ${Math.round(adjusted)}s @ ${inetDownMbps}Mbps`,
    };
  }

  // ── Priority 2: Calculate from compressed image size + host speed ───────
  const compressedGb = await getCompressedSizeGb(dockerImage);
  if (compressedGb !== null && compressedGb > 0) {
    // Pull time ≈ compressed_size / download_speed
    // Add overhead: registry throttling, decompression, layer extraction (~30%)
    const theoreticalS = (compressedGb * 1024 * 8) / Math.max(inetDownMbps, 100);
    const withOverhead = theoreticalS * 1.3;
    const timeoutMs = clamp(withOverhead * safety * 1000);

    return {
      estimatedPullS: Math.round(withOverhead),
      timeoutMs,
      confidence: 'calculated',
      basis: `${compressedGb.toFixed(1)}GB compressed ÷ ${inetDownMbps}Mbps = ${Math.round(theoreticalS)}s + 30% overhead`,
    };
  }

  // ── Priority 3: Fallback based on estimated disk size ───────────────────
  const fallbackS = diskGb < 15 ? 90
    : diskGb < 40 ? 180
    : diskGb < 80 ? 420
    : 600;
  const timeoutMs = clamp(fallbackS * safety * 1000);

  return {
    estimatedPullS: fallbackS,
    timeoutMs,
    confidence: 'default',
    basis: `disk=${diskGb}GB → default ${fallbackS}s`,
  };
}

function clamp(ms: number): number {
  return Math.max(MIN_TIMEOUT_MS, Math.min(Math.round(ms), MAX_TIMEOUT_MS));
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
        console.log(`[pull-estimator] Cached: ${img} = ${size.toFixed(2)}GB compressed`);
      }
      return size;
    }),
  );
  const cached = results.filter(r => r.status === 'fulfilled' && r.value !== null).length;
  console.log(`[pull-estimator] Pre-warmed ${cached}/${images.length} image sizes`);
}
