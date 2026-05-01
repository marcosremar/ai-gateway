// ── GPU Auto-Select — rank and pick cheapest/fastest GPU offers ──────────────

import type { GpuOffer } from '../src/gpu-providers/types';
import type { GpuTier } from '../src/gpu-providers/deploy-orchestrator';
import { getGpuPriorityList, getGpuSortBy, isGpuFilterDisabled } from '../src/gpu-providers/deploy-settings';
import { prisma, deployState } from './state';
import { getBestLatencyByGpuModel } from './latency-db';
import { loadReputationsByGpuType } from './metrics';
import { createLogger } from '../src/logger';

const log = createLogger('gpu-deploy');

/**
 * Query available GPU offers from a tier's provider and pick the cheapest with adequate VRAM.
 * Returns an array of unique GPU type strings sorted by price (cheapest first), or empty array if none found.
 */
export async function autoSelectCheapestGpu(
  tiers: GpuTier[],
  opts: {
    region?: string;
    minVramGb?: number;
    preferSsd?: boolean;
    maxResults?: number;
    allowedTypes?: Set<string>;
    /**
     * Minimum NVIDIA driver major version. When snapshot-eligible deploys
     * are requested, pass `570` so only hosts with CRIUgpu-capable drivers
     * survive. Offers that don't report a driver version are kept (we can't
     * prove they fail) unless stricter gating is needed at a higher layer.
     */
    minDriverVersion?: number;
  } = {},
): Promise<string[]> {
  const minVram = opts.minVramGb ?? 16;
  const preferSsd = opts.preferSsd ?? false;
  const maxResults = opts.maxResults ?? 8;
  const allowed = opts.allowedTypes ?? new Set(getGpuPriorityList());
  const minDriverMajor = opts.minDriverVersion ?? 0;
  const allOffers: GpuOffer[] = [];

  await Promise.allSettled(
    tiers.map(async (tier) => {
      if (!tier.client.listOffers) return;
      try {
        const offers = await Promise.race([
          tier.client.listOffers(
            { region: opts.region, limit: 50 },
            { apiKey: tier.apiKey, authId: tier.authId },
          ),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${tier.label} listOffers timed out`)), 15_000)),
        ]);
        allOffers.push(...offers);
      } catch (err) {
        log.warn(`[gpu] autoSelectGpu: failed to query ${tier.label}: ${err instanceof Error ? err.message : err}`);
      }
    }),
  );

  // Filter by minimum VRAM
  // Note: available === -1 means "unknown" (e.g. RunPod GraphQL doesn't report stock)
  // so we treat -1 as "probably available" and only exclude available === 0
  let base = allOffers.filter((o) => o.vram >= minVram && o.available !== 0 && o.pricePerHr > 0);

  // Driver pinning — drop offers whose reported driver major is below the
  // requested minimum. Offers that don't report a driver are kept (can't prove
  // exclusion). Used by snapshot-eligible deploys (CRIUgpu needs 570+).
  if (minDriverMajor > 0) {
    const before = base.length;
    base = base.filter((o) => {
      const driver = (o as unknown as Record<string, unknown>).driverVersion as string | undefined;
      if (!driver) return true;
      const major = parseInt(String(driver).split('.')[0] ?? '0', 10);
      return Number.isFinite(major) && major >= minDriverMajor;
    });
    if (before !== base.length) {
      log.log(`[gpu] autoSelectGpu: driver pin ${minDriverMajor}+ filtered ${before - base.length} offers`);
    }
  }

  // Internet speed filter: prefer machines with fast download (>500 Mbps) for quick image pulls.
  // Fall back to all offers if none qualify (some providers don't report speed).
  const MIN_INET_MBPS = 500;
  const fastInet = base.filter(o => {
    const dl = (o as unknown as Record<string, unknown>).inetDown as number | undefined;
    return !dl || dl >= MIN_INET_MBPS; // 0/undefined = unknown (allow), >= 500 = fast enough
  });
  const inetFiltered = fastInet.length > 0 ? fastInet : base;
  if (fastInet.length < base.length && fastInet.length > 0) {
    log.log(`[gpu] autoSelectGpu: filtered ${base.length - fastInet.length} slow hosts (<${MIN_INET_MBPS} Mbps), keeping ${fastInet.length}`);
  }

  // SSD preference: keep offers where diskBwReadMbps > 200 MB/s (SSD/NVMe) or unknown.
  // Fall back to all offers if none qualify (provider may not report disk speed).
  const ssdFiltered = preferSsd ? inetFiltered.filter(o => {
    const bw = (o as unknown as Record<string, unknown>).diskBwReadMbps as number | undefined;
    return !bw || bw > 200;
  }) : inetFiltered;
  const suitable = preferSsd && ssdFiltered.length === 0 ? inetFiltered : ssdFiltered;

  // ── Blacklist: hosts with 3+ crashes in 7 days
  let blacklistedHosts: Set<string> | null = null;
  try {
    const rows = await prisma.hostReputation.findMany({
      where: { crashCount: { gte: 3 }, lastDeployAt: { gt: Date.now() - 7 * 24 * 60 * 60 * 1000 } },
      select: { hostKey: true },
    });
    blacklistedHosts = new Set(rows.map((r: { hostKey: string }) => r.hostKey));
    if (blacklistedHosts.size > 0) {
      log.log(`[gpu] autoSelectGpu: ${blacklistedHosts.size} host(s) blacklisted (3+ crashes in 7d)`);
    }
  } catch { /* best-effort: cleanup or optional side-effect */ }

  // ── Reputation floor: skip hosts with score < 0.3 (proven unreliable)
  let lowRepHosts: Set<string> | null = null;
  try {
    const rows = await prisma.hostReputation.findMany({
      where: { reputationScore: { lt: 0.3 }, deployCount: { gte: 2 } }, // at least 2 deploys to avoid penalizing new hosts
      select: { hostKey: true, reputationScore: true },
    });
    lowRepHosts = new Set(rows.map((r: { hostKey: string }) => r.hostKey));
    if (lowRepHosts.size > 0) {
      log.log(`[gpu] autoSelectGpu: ${lowRepHosts.size} host(s) below reputation floor (<0.3)`);
    }
  } catch { /* best-effort: cleanup or optional side-effect */ }

  // ── Compatibility filter: skip GPU+image combos that have failed tests
  let incompatibleGpuTypes: Set<string> | null = null;
  try {
    const currentImage = deployState.dockerImage || '';
    if (currentImage) {
      const failedTests = await prisma.gpuCompatibilityTest.findMany({
        where: {
          dockerImage: currentImage,
          passed: false,
          testedAt: { gt: new Date(Date.now() - 14 * 86400_000) }, // last 14 days
        },
        select: { gpuType: true },
      });
      if (failedTests.length > 0) {
        incompatibleGpuTypes = new Set(failedTests.map((t: { gpuType: string }) => t.gpuType));
        log.log(`[gpu] autoSelectGpu: ${incompatibleGpuTypes.size} GPU type(s) incompatible with ${currentImage}: ${[...incompatibleGpuTypes].join(', ')}`);
      }
    }
  } catch { /* best-effort: cleanup or optional side-effect */ }

  // ── Deploy session history: boost GPU types with recent success on same image
  let sessionSuccessRates: Map<string, number> | null = null;
  try {
    const currentImage = deployState.dockerImage || '';
    if (currentImage) {
      const recentSessions = await prisma.gpuDeploySession.findMany({
        where: {
          dockerImage: currentImage,
          createdAt: { gt: new Date(Date.now() - 7 * 86400_000) },
          status: { in: ['ready', 'failed'] },
        },
        select: { gpuType: true, status: true },
      });
      if (recentSessions.length > 0) {
        const grouped = new Map<string, { success: number; total: number }>();
        for (const s of recentSessions) {
          if (!s.gpuType) continue;
          const g = grouped.get(s.gpuType) || { success: 0, total: 0 };
          g.total++;
          if (s.status === 'ready') g.success++;
          grouped.set(s.gpuType, g);
        }
        sessionSuccessRates = new Map();
        for (const [gpu, { success, total }] of grouped) {
          if (total >= 2) sessionSuccessRates.set(gpu, success / total);
        }
        if (sessionSuccessRates.size > 0) {
          const rates = [...sessionSuccessRates.entries()].map(([g, r]) => `${g}=${(r * 100).toFixed(0)}%`).join(', ');
          log.log(`[gpu] autoSelectGpu: session success rates (7d): ${rates}`);
        }
      }
    }
  } catch { /* best-effort: cleanup or optional side-effect */ }

  // Apply all filters (blacklist + low reputation + incompatible)
  const filtered = suitable.filter(o => {
    const hostKey = `${o.provider}:${o.hostId || o.offerId || o.gpuName}`;
    if (blacklistedHosts?.has(hostKey)) return false;
    if (lowRepHosts?.has(hostKey)) return false;
    if (incompatibleGpuTypes?.has(o.gpuType) || incompatibleGpuTypes?.has(o.gpuName)) return false;
    return true;
  });
  // Use filtered list (fallback to full list if all filtered out)
  const ranked = filtered.length > 0 ? filtered : suitable;

  if (ranked.length === 0) {
    log.warn(`[gpu] autoSelectGpu: ${allOffers.length} total offers, 0 suitable (minVram=${minVram}GB). Sample: ${allOffers.slice(0, 5).map(o => `${o.gpuName}(${o.vram}GB,$${o.pricePerHr},avail=${o.available})`).join(', ')}`);
    return [];
  }

  // Load reputation data grouped by provider+gpuType.
  // Since offers are grouped (we don't know specific hosts yet), we use aggregate
  // reputation per GPU type to rank. This captures historical latency, reliability,
  // and consistency across all hosts we've used with that GPU type on that provider.
  const gpuTypeReps = await loadReputationsByGpuType();
  const getRepScore = (o: GpuOffer): number => {
    const key = `${o.provider}:${o.gpuName || o.gpuType}`;
    return gpuTypeReps.get(key)?.avgScore ?? 0.5;
  };

  // Sort based on user-configured criteria: price, latency, or balanced (default)
  const sortBy = getGpuSortBy();
  const normalize_name = (s: string) => s.replace(/nvidia|geforce/gi, '').replace(/\s+/g, '').toLowerCase();
  const latencyMap = sortBy !== 'price' ? await getBestLatencyByGpuModel() : {};

  const getLatencyMs = (o: GpuOffer): number | null => {
    const key = normalize_name(o.gpuName || o.gpuType);
    const entry = (latencyMap as Record<string, { bestMs: number; region: string }>)[key];
    return entry?.bestMs ?? null;
  };

  // Unified latency score: normalize TCP RTT (0-1) — <30ms=1.0, 150ms=0.5, 300ms+=0.0
  // This puts TCP latency on the same 0-1 scale as reputationScore (which embeds pipeline latency)
  const tcpLatencyScore = (o: GpuOffer): number => {
    const ms = getLatencyMs(o);
    if (ms == null) return 0.5; // neutral for unknown
    return Math.max(0, Math.min(1, 1 - (ms - 30) / 270));
  };

  if (sortBy === 'price') {
    // Pure price sort — cheapest first
    ranked.sort((a, b) => a.pricePerHr - b.pricePerHr);
  } else if (sortBy === 'latency') {
    // Sort by measured TCP latency (closest datacenter first); unknown latency goes last
    ranked.sort((a, b) => {
      const latA = getLatencyMs(a) ?? Infinity;
      const latB = getLatencyMs(b) ?? Infinity;
      return latA - latB;
    });
  } else if (sortBy === 'realtime') {
    // Real-time mode: optimized for minimum pipeline latency.
    //
    // 1. Filter out offers with TCP latency > 150ms — too far for real-time
    //    speech translation where every 50ms matters. Unknown latency offers
    //    are kept but deprioritized (scored as 0.3 instead of 0.5).
    //
    // 2. Score: latency × 0.60 + reputation × 0.30 + session × 0.10
    //    Latency dominates because a $0.50/hr host at 30ms TCP beats a
    //    $0.30/hr host at 200ms TCP for real-time use cases.
    //
    // 3. Price is tiebreaker only — among equal-quality offers, pick cheapest.
    const REALTIME_MAX_LATENCY_MS = 150;
    const beforeFilter = ranked.length;
    const filtered = ranked.filter(o => {
      const ms = getLatencyMs(o);
      return ms === null || ms <= REALTIME_MAX_LATENCY_MS;
    });
    if (filtered.length === 0) {
      log.warn(`[gpu] realtime mode: all ${beforeFilter} offers exceed ${REALTIME_MAX_LATENCY_MS}ms — using all offers with latency sort`);
      // Keep ranked as-is, the sort below still prioritizes low latency
    } else {
      // Replace ranked with the filtered set
      ranked.length = 0;
      ranked.push(...filtered);
    }

    ranked.sort((a, b) => {
      const tcpA = tcpLatencyScore(a);
      const tcpB = tcpLatencyScore(b);
      const repA = getRepScore(a);
      const repB = getRepScore(b);
      const sessA = sessionSuccessRates?.get(a.gpuType) ?? sessionSuccessRates?.get(a.gpuName) ?? 0.5;
      const sessB = sessionSuccessRates?.get(b.gpuType) ?? sessionSuccessRates?.get(b.gpuName) ?? 0.5;
      // Unknown TCP latency gets a low score (0.3) instead of neutral (0.5)
      // to deprioritize unprobed hosts for real-time workloads.
      const adjTcpA = getLatencyMs(a) === null ? 0.3 : tcpA;
      const adjTcpB = getLatencyMs(b) === null ? 0.3 : tcpB;
      const qualityA = adjTcpA * 0.60 + repA * 0.30 + sessA * 0.10;
      const qualityB = adjTcpB * 0.60 + repB * 0.30 + sessB * 0.10;
      // Higher quality first; price as tiebreaker
      if (Math.abs(qualityA - qualityB) > 0.05) return qualityB - qualityA;
      return a.pricePerHr - b.pricePerHr;
    });
  } else {
    // Balanced (default): combine reputation, TCP latency, session history, and price.
    // qualityScore components (all 0-1 scale):
    //   repScore   × 0.50 — host reputation (embeds pipeline latency, reliability)
    //   tcpScore   × 0.30 — network proximity
    //   sessionBonus × 0.20 — recent deploy success rate with same image
    // effectivePrice = price / max(qualityScore, 0.1)
    ranked.sort((a, b) => {
      const repA = getRepScore(a);
      const repB = getRepScore(b);
      const tcpA = tcpLatencyScore(a);
      const tcpB = tcpLatencyScore(b);
      // Session history bonus: prefer GPU types with proven success on this image
      const sessA = sessionSuccessRates?.get(a.gpuType) ?? sessionSuccessRates?.get(a.gpuName) ?? 0.5;
      const sessB = sessionSuccessRates?.get(b.gpuType) ?? sessionSuccessRates?.get(b.gpuName) ?? 0.5;
      const qualityA = Math.max(repA * 0.50 + tcpA * 0.30 + sessA * 0.20, 0.1);
      const qualityB = Math.max(repB * 0.50 + tcpB * 0.30 + sessB * 0.20, 0.1);
      const effectiveA = a.pricePerHr / qualityA;
      const effectiveB = b.pricePerHr / qualityB;
      return effectiveA - effectiveB;
    });
  }

  // Log sort criteria and top offers
  {
    const topOffers = ranked.slice(0, 5).map(o => {
      const key = `${o.provider}:${o.gpuName || o.gpuType}`;
      const rep = gpuTypeReps.get(key);
      const score = rep?.avgScore ?? 0.5;
      const latMs = getLatencyMs(o);
      const latStr = latMs != null ? `,lat=${latMs}ms` : '';
      const hostStr = rep ? `,${rep.hostCount}hosts` : '';
      return `${o.gpuName}($${o.pricePerHr.toFixed(2)},rep=${score.toFixed(2)}${latStr}${hostStr})`;
    });
    log.log(`[gpu] autoSelectGpu: sort=${sortBy}, top 5: ${topOffers.join(', ')}`);
  }

  // GPU type filtering — disabled when priority list is empty (show all GPUs)
  let prioritized = ranked;
  let allowedOfferCount = ranked.length;
  if (isGpuFilterDisabled()) {
    log.log(`[gpu] autoSelectCheapestGpu: GPU filter disabled — showing all GPU types`);
  } else {
    // Prefer allowlisted GPUs, then fall back to any suitable GPU.
    // Providers use varying naming formats (e.g. "RTX 4090" vs "NVIDIA GeForce RTX 4090")
    // so we normalize names for comparison: strip "NVIDIA", "GeForce", spaces, and lowercase.
    const normalize = (s: string) => s.replace(/nvidia|geforce/gi, '').replace(/\s+/g, '').toLowerCase();
    const allowedNormalized = new Set([...allowed].map(normalize));
    const isAllowed = (o: GpuOffer) =>
      allowed.has(o.gpuType) || allowed.has(o.gpuName) ||
      allowedNormalized.has(normalize(o.gpuType)) || allowedNormalized.has(normalize(o.gpuName));
    const allowedOffers = ranked.filter(isAllowed);
    allowedOfferCount = allowedOffers.length;
    prioritized = allowedOffers.length > 0 ? allowedOffers : ranked;
    if (allowedOffers.length === 0) {
      log.warn(`[gpu] autoSelectGpu: no offers match allowlist, using best available. Sample types: ${ranked.slice(0, 5).map(o => `${o.gpuName}(${o.gpuType})`).join(', ')}`);
    }
  }

  // Deduplicate by gpuName (full name), keeping best effective-price offer for each type.
  // Return gpuName (not gpuType) so it matches provider createInstance expectations.
  const seen = new Set<string>();
  const uniqueTypes: string[] = [];
  for (const offer of prioritized) {
    const key = offer.gpuName || offer.gpuType;
    if (!seen.has(key)) {
      seen.add(key);
      // Use gpuName if it's a full name (e.g. "NVIDIA RTX A6000"), otherwise gpuType
      uniqueTypes.push(offer.gpuName || offer.gpuType);
      if (uniqueTypes.length >= maxResults) break;
    }
  }

  log.log(`[gpu] autoSelectGpu: ${ranked.length} suitable offers (${allowedOfferCount} in allowlist, ${gpuTypeReps.size} with reputation) → ${uniqueTypes.length} GPU types: ${uniqueTypes.join(', ')}`);
  return uniqueTypes;
}
