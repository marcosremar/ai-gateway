// ── GPU Type Cache — refresh & validation against provider offers ────────────

import type { GpuProviderClient, GpuOffer, ProviderCredentials } from '../src/gpu-providers/types';
import { prisma } from './state';
import { runpod, vast, tensordock, modal } from './providers';
import { createLogger } from '../src/logger';

const log = createLogger('gpu-deploy');

export const GPU_TYPE_CACHE_TTL_MS = 30 * 60_000; // refresh GPU type cache every 30 min
export let gpuTypeCacheRefreshTimer: Timer | null = null;

export interface CacheProviderQuery {
  name: string;
  client: GpuProviderClient;
  credentials: ProviderCredentials;
}

/** Minimal env shape consumed by `buildGpuCacheProviderQueries` (for tests). */
export type GpuCacheEnv = Record<string, string | undefined>;

/**
 * Decide which providers to query for the GPU-type cache from available
 * credentials (#188).
 *
 * The refresh previously only queried runpod/vast/tensordock/modal, so
 * Hyperstack and Vast-VM GPU names could never be validated and silently passed.
 * This pure helper adds them (Vast-VM shares the Vast key; Hyperstack uses its
 * own key) so `validateGpuTypesFromCache` covers every configured provider.
 * Pure: env + clients are injected so it can be unit-tested without network.
 */
export function buildGpuCacheProviderQueries(
  env: GpuCacheEnv,
  clients: Partial<Record<string, GpuProviderClient>>,
): CacheProviderQuery[] {
  const queries: CacheProviderQuery[] = [];
  const rpKey = env.RUNPOD_API_KEY || '';
  const vastKey = env.VAST_API_KEY || '';
  const tdKey = env.TENSORDOCK_API_KEY || '';
  const tdAuth = env.TENSORDOCK_AUTH_ID || '';
  const modalId = env.MODAL_TOKEN_ID || '';
  const modalSecret = env.MODAL_TOKEN_SECRET || '';
  const hsKey = env.HYPERSTACK_API_KEY || '';

  const push = (name: string, credentials: ProviderCredentials) => {
    const client = clients[name];
    if (client) queries.push({ name, client, credentials });
  };

  if (rpKey) push('runpod', { apiKey: rpKey });
  if (vastKey) push('vast', { apiKey: vastKey });
  // Vast-VM mode reuses the Vast key but reports VM-mode GPU names separately.
  if (vastKey) push('vast-vm', { apiKey: vastKey });
  if (tdKey && tdAuth) push('tensordock', { apiKey: tdKey, authId: tdAuth });
  if (modalId && modalSecret) push('modal', { apiKey: `${modalId}:${modalSecret}` });
  if (hsKey) push('hyperstack', { apiKey: hsKey });

  return queries;
}

/** Refresh GPU type cache from all providers and save to DB. */
export async function refreshGpuTypeCache(): Promise<void> {
  const { vastVm, hyperstack } = await import('./providers');
  const providerQueries = buildGpuCacheProviderQueries(process.env, {
    runpod, vast, 'vast-vm': vastVm, tensordock, modal, hyperstack,
  });

  if (providerQueries.length === 0) {
    log.log('[gpu-cache] No provider API keys configured — skipping GPU type cache refresh');
    return;
  }

  log.log(`[gpu-cache] Refreshing GPU types from ${providerQueries.length} provider(s)...`);
  let totalUpserted = 0;

  const results = await Promise.allSettled(
    providerQueries.map(async ({ name, client, credentials }) => {
      if (!client.listOffers) return { name, offers: [] as GpuOffer[] };
      // Single attempt — cache refresh is a background operation; retrying on timeout
      // just floods logs (especially for consistently slow providers like TensorDock).
      try {
        const offers = await Promise.race([
          client.listOffers({ limit: 200 }, credentials),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${name} listOffers timed out`)), 15_000)),
        ]);
        return { name, offers };
      } catch (err) {
        log.warn(`[gpu-cache] ${name} listOffers failed: ${err instanceof Error ? err.message : err}`);
        return { name, offers: [] as GpuOffer[] };
      }
    }),
  );

  // Collect all upserts across providers before writing to DB
  type UpsertEntry = { name: string; gpuName: string; offer: GpuOffer };
  const allUpserts: UpsertEntry[] = [];

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { name, offers } = result.value;
    // Deduplicate by gpuName within this provider
    const seen = new Map<string, GpuOffer>();
    for (const offer of offers) {
      const key = offer.gpuName || offer.gpuType;
      if (!seen.has(key) || offer.pricePerHr < (seen.get(key)!.pricePerHr || Infinity)) {
        seen.set(key, offer);
      }
    }
    for (const [gpuName, offer] of seen) {
      allUpserts.push({ name, gpuName, offer });
    }
  }

  // Write all upserts in a single transaction so partial writes don't occur if the process is killed mid-loop
  try {
    await prisma.$transaction(async (tx: any) => {
      for (const { name, gpuName, offer } of allUpserts) {
        await tx.gpuTypeCache.upsert({
          where: { provider_gpuName: { provider: name, gpuName } },
          update: {
            gpuType: offer.gpuType || gpuName,
            vram: offer.vram || 0,
            pricePerHr: offer.pricePerHr || 0,
            available: offer.available ?? -1,
            region: offer.region || '',
          },
          create: {
            provider: name,
            gpuName,
            gpuType: offer.gpuType || gpuName,
            vram: offer.vram || 0,
            pricePerHr: offer.pricePerHr || 0,
            available: offer.available ?? -1,
            region: offer.region || '',
          },
        });
      }
    }, { timeout: 30_000 });
    totalUpserted = allUpserts.length;
  } catch (err) {
    // Transaction failed — log but don't crash the cache refresh
    log.warn(`[gpu-cache] Transaction failed during cache write: ${err instanceof Error ? err.message : err}`);
  }
  log.log(`[gpu-cache] Cached ${totalUpserted} GPU types from ${providerQueries.length} provider(s)`);
}

/** Why `validateGpuTypesFromCache` returned without an error (#189). */
export type CacheValidationOutcome = 'no-filter' | 'cache-empty' | 'validated';

/**
 * Classify a cache-validation run for observability (#189).
 *
 * Returning `null` (valid) on an empty cache silently skips GPU-name validation
 * on the first deploy after a restart. This pure helper distinguishes the three
 * no-error cases so callers can warn when validation was skipped due to an
 * empty cache rather than a real pass.
 */
export function cacheValidationOutcome(requestedCount: number, cachedCount: number): CacheValidationOutcome {
  if (requestedCount === 0) return 'no-filter';
  if (cachedCount === 0) return 'cache-empty';
  return 'validated';
}

/** Validate GPU types against the DB cache. Returns null if valid, or a descriptive error string. */
export async function validateGpuTypesFromCache(gpuTypes: string[], provider?: string): Promise<string | null> {
  if (gpuTypes.length === 0) return null; // no filter = any GPU

  // Fetch all cached GPU types (optionally filtered by provider)
  const where = provider ? { provider } : {};
  const cached = await prisma.gpuTypeCache.findMany({ where, orderBy: { pricePerHr: 'asc' } });
  if (cacheValidationOutcome(gpuTypes.length, cached.length) === 'cache-empty') {
    // Skip validation but make it visible — the operator should know the very
    // first deploy after a restart got no GPU-name validation (#189).
    log.warn(`[gpu-cache] GPU-type validation skipped: cache empty (provider=${provider ?? 'any'}). A background refresh will populate it shortly.`);
    return null; // no cache yet = skip validation
  }

  // Build lookup sets: full names and short names (case-insensitive)
  const validFullNames = new Set(cached.map((g: any) => g.gpuName.toLowerCase()));
  const validShortNames = new Set(cached.map((g: any) => g.gpuType.toLowerCase()));

  const invalid: string[] = [];
  for (const requested of gpuTypes) {
    const lower = requested.toLowerCase();
    if (!validFullNames.has(lower) && !validShortNames.has(lower)) {
      // Also check with NVIDIA prefix for partial matches
      const withNvidia = `nvidia ${lower}`.toLowerCase();
      const withNvidiaGeforce = `nvidia geforce ${lower}`.toLowerCase();
      if (!validFullNames.has(withNvidia) && !validFullNames.has(withNvidiaGeforce)) {
        invalid.push(requested);
      }
    }
  }

  if (invalid.length === 0) return null;

  // Build descriptive error with valid options
  const providerLabel = provider ? ` on ${provider}` : '';
  const validList = cached
    .filter((g: any, i: number, arr: any[]) => arr.findIndex((x: any) => x.gpuName === g.gpuName) === i) // deduplicate
    .slice(0, 15)
    .map((g: any) => {
      const price = g.pricePerHr > 0 ? ` ($${g.pricePerHr.toFixed(2)}/h)` : '';
      const vram = g.vram > 0 ? ` ${g.vram}GB` : '';
      return `${g.gpuType}${vram}${price}`;
    })
    .join(', ');

  return `GPU type(s) not found${providerLabel}: ${invalid.join(', ')}. Valid options: ${validList}`;
}

export function startGpuTypeCacheRefresh() {
  // Initial refresh (non-blocking)
  refreshGpuTypeCache().catch(err => log.warn(`[gpu-cache] Initial refresh failed: ${err}`));
  // Periodic refresh
  gpuTypeCacheRefreshTimer = setInterval(() => {
    refreshGpuTypeCache().catch(err => log.warn(`[gpu-cache] Periodic refresh failed: ${err}`));
  }, GPU_TYPE_CACHE_TTL_MS);
}
