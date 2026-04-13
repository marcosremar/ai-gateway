import type { IncomingMessage, ServerResponse } from 'http';
import type { GpuProviderClient, GpuOffer, ListOffersOptions, ProviderCredentials } from '../src/gpu-providers/types';
import { prisma } from './state';
import { runpod, vast, tensordock, modal } from './providers';
import { getOrCreateRequestId, setRequestIdHeader, validateGpuCredentials } from './http-utils';
import { PORT, LOW_BALANCE_THRESHOLD_USD } from './config';
import { fetchMyLocation } from './ip-location';
import { rankOffers, scheduleBackgroundProbes, probeAndSaveOffers } from './gpu-latency';
import { upsertHostMeta, getHostRttMap, getBestLatencyByGpuModel } from './latency-db';

/** Build provider query list from API keys, optionally filtered to a single provider. */
export function buildProviderQueries(opts: {
  runpodApiKey?: string;
  vastApiKey?: string;
  tensordockApiKey?: string;
  tensordockAuthId?: string;
  modalApiKey?: string;
  providerFilter?: string;
}): Array<{ name: string; client: GpuProviderClient; credentials: ProviderCredentials }> {
  const queries: Array<{ name: string; client: GpuProviderClient; credentials: ProviderCredentials }> = [];
  if (opts.runpodApiKey && (!opts.providerFilter || opts.providerFilter === 'runpod'))
    queries.push({ name: 'runpod', client: runpod, credentials: { apiKey: opts.runpodApiKey } });
  if (opts.vastApiKey && (!opts.providerFilter || opts.providerFilter === 'vast'))
    queries.push({ name: 'vast', client: vast, credentials: { apiKey: opts.vastApiKey } });
  if (opts.tensordockApiKey && opts.tensordockAuthId && (!opts.providerFilter || opts.providerFilter === 'tensordock'))
    queries.push({ name: 'tensordock', client: tensordock, credentials: { apiKey: opts.tensordockApiKey, authId: opts.tensordockAuthId } });
  if (opts.modalApiKey && (!opts.providerFilter || opts.providerFilter === 'modal'))
    queries.push({ name: 'modal', client: modal, credentials: { apiKey: opts.modalApiKey } });
  return queries;
}

// ── Shared offer+balance fetcher ─────────────────────────────────────────────

interface ProviderBalanceInfo {
  balance: number | null;
  canDeploy: boolean;       // false when balance is below LOW_BALANCE_THRESHOLD_USD
  balanceNote?: string;     // human-readable reason when balance is unavailable
  cachedAt?: number;        // timestamp of last successful check
}

// Balance cache — refreshed in background every 90s so offer endpoints don't block.
// TensorDock takes ~10s to respond, making caching essential.
const _offerBalanceCache = new Map<string, ProviderBalanceInfo>();
const OFFER_BALANCE_CACHE_TTL_MS = 90_000;
let _balanceRefreshPromise: Promise<void> | null = null;

/** Fetch balance for a single provider and update the cache. */
async function refreshProviderBalance(
  name: string,
  client: GpuProviderClient,
  credentials: ProviderCredentials,
): Promise<void> {
  try {
    // Modal: no credit balance API — validate credentials via HTTP health check.
    // Uses /v1/apps?limit=1 as a lightweight auth probe (returns 401 on bad creds).
    if (name === 'modal') {
      const [tokenId, tokenSecret] = (credentials.apiKey || '').split(':');
      const b64 = Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64');
      const r = await fetch('https://api.modal.com/v1/apps?limit=1', {
        headers: { Authorization: `Basic ${b64}` },
        signal: AbortSignal.timeout(5000),
      });
      _offerBalanceCache.set(name, {
        balance: null,
        canDeploy: r.ok,
        balanceNote: r.ok
          ? 'Modal does not expose a credit balance API — check modal.com/settings/billing'
          : `Modal credentials invalid (HTTP ${r.status})`,
        cachedAt: Date.now(),
      });
      return;
    }
    if (!client || !('checkBalance' in client)) return;
    const checkBalanceFn = (client as { checkBalance?: (creds: ProviderCredentials) => Promise<{ balance: number } | null> }).checkBalance;
    if (!checkBalanceFn) return;
    const result = await Promise.race([
      checkBalanceFn(credentials),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${name} checkBalance timed out`)), 10_000)),
    ]);
    if (result === null) {
      console.warn(`[balance-cache] ${name} returned null — keeping previous cache`);
      return;
    }
    _offerBalanceCache.set(name, {
      balance: result.balance,
      canDeploy: result.balance >= LOW_BALANCE_THRESHOLD_USD,
      cachedAt: Date.now(),
    });
    console.log(`[balance-cache] ${name}: $${result.balance.toFixed(2)} canDeploy=${result.balance >= LOW_BALANCE_THRESHOLD_USD}`);
  } catch (e) {
    console.warn(`[balance-cache] ${name} check failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Return cached balances, triggering a background refresh if stale. */
function getCachedOfferBalances(
  providerQueries: Array<{ name: string; client: GpuProviderClient; credentials: ProviderCredentials }>,
): Record<string, ProviderBalanceInfo> {
  const now = Date.now();
  const stale = providerQueries.some(({ name }) => {
    const cached = _offerBalanceCache.get(name);
    return !cached || (now - (cached.cachedAt ?? 0)) > OFFER_BALANCE_CACHE_TTL_MS;
  });

  if (stale && !_balanceRefreshPromise) {
    _balanceRefreshPromise = Promise.allSettled(
      providerQueries.map(({ name, client, credentials }) =>
        refreshProviderBalance(name, client, credentials),
      ),
    ).then(() => { _balanceRefreshPromise = null; }) as Promise<void>;
  }

  // Return whatever is cached (may be stale on first call — returns empty = assume OK)
  const result: Record<string, ProviderBalanceInfo> = {};
  for (const { name } of providerQueries) {
    const cached = _offerBalanceCache.get(name);
    if (cached) result[name] = cached;
  }
  return result;
}

/**
 * Fetch GPU offers from all providers AND their account balances in parallel.
 * Balance checks add zero latency because they run concurrently with listOffers.
 * Each offer gets annotated with canDeploy=false when the provider has insufficient funds.
 */
async function fetchOffersWithBalances(
  providerQueries: Array<{ name: string; client: GpuProviderClient; credentials: ProviderCredentials }>,
  options: ListOffersOptions,
): Promise<{
  allOffers: GpuOffer[];
  providerResults: Array<{ name: string; count: number; error?: string }>;
  providerBalances: Record<string, ProviderBalanceInfo>;
}> {
  // Balance check uses a background-refresh cache (90s TTL).
  // TensorDock takes ~10s per call — caching prevents blocking offer responses.
  const providerBalances = getCachedOfferBalances(providerQueries);

  const OFFER_FETCH_TIMEOUT_MS = 20_000;
  const offerResults = await Promise.allSettled(
    providerQueries.map(async ({ name, client, credentials }) => {
      if (!client.listOffers) return { name, offers: [] as GpuOffer[], error: 'listOffers not supported' };
      try {
        const offers = await Promise.race([
          client.listOffers(options, credentials),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${name} listOffers timed out after ${OFFER_FETCH_TIMEOUT_MS}ms`)), OFFER_FETCH_TIMEOUT_MS),
          ),
        ]);
        return { name, offers, error: undefined };
      } catch (err) {
        return { name, offers: [] as GpuOffer[], error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  // Collect offers
  const allOffers: GpuOffer[] = [];
  const providerResults: Array<{ name: string; count: number; error?: string }> = [];
  for (const r of offerResults) {
    if (r.status === 'fulfilled') {
      providerResults.push({ name: r.value.name, count: r.value.offers.length, error: r.value.error });
      allOffers.push(...r.value.offers);
    } else {
      providerResults.push({ name: 'unknown', count: 0, error: r.reason?.message ?? String(r.reason) });
    }
  }

  return { allOffers, providerResults, providerBalances };
}

/**
 * Handle GET /v1/gpu/offers — fetch available GPU offers from all configured providers.
 *
 * Queries RunPod, Vast.ai, TensorDock, and Modal for current GPU availability
 * and pricing. Optionally filters by GPU types, region, provider, and minimum
 * VRAM. Checks provider balances and annotates each offer with `canDeploy` status.
 *
 * Credentials must come from environment variables — API keys in query params
 * are rejected for security.
 *
 * @param req - Incoming HTTP request; query params: gpuTypes, region, provider, limit, minVramGb, preferSsd
 * @param res - Outgoing HTTP response; returns 200 with { offers, providers, balances }
 * @returns Promise<void>
 *
 * @example
 * ```bash
 * GET /v1/gpu/offers?gpuTypes=RTX+4090&region=EU&limit=50
 * # → { offers: [{ provider: "vast", gpuType: "RTX 4090", pricePerHr: 0.42, ... }], ... }
 * ```
 */
export async function handleGpuOffers(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);
  console.log(`[req=${requestId}] GPU offers query`);
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // Reject API keys in query params — credentials must come from env vars or POST body
  const sensitiveParams = ['runpodApiKey', 'vastApiKey', 'tensordockApiKey', 'tensordockAuthId', 'modalTokenId', 'modalTokenSecret'];
  const foundInQuery = sensitiveParams.filter(p => url.searchParams.has(p));
  if (foundInQuery.length > 0) {
    console.warn(`[security] Rejected request with API keys in query params: ${foundInQuery.join(', ')}`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `API keys must not be passed via query params (found: ${foundInQuery.join(', ')}). Use environment variables instead.` }));
    return;
  }
  const gpuTypesParam = url.searchParams.get('gpuTypes');
  const gpuTypes = gpuTypesParam ? gpuTypesParam.split(',').map(s => s.trim()).filter(Boolean) : undefined;
  const region = url.searchParams.get('region') || undefined;
  const limit = parseInt(url.searchParams.get('limit') || '100', 10);
  const providerFilter = url.searchParams.get('provider') || undefined;
  const minVramGbParam = parseInt(url.searchParams.get('minVramGb') || '0', 10);
  const preferSsdParam = url.searchParams.get('preferSsd') === '1';

  // Credentials from env only (query params are rejected above)
  const runpodApiKey = process.env.RUNPOD_API_KEY || '';
  const vastApiKey = process.env.VAST_API_KEY || '';
  const tensordockApiKey = process.env.TENSORDOCK_API_KEY || '';
  const tensordockAuthId = process.env.TENSORDOCK_AUTH_ID || '';
  const modalTokenId = process.env.MODAL_TOKEN_ID || '';
  const modalTokenSecret = process.env.MODAL_TOKEN_SECRET || '';
  const modalApiKey = modalTokenId && modalTokenSecret ? `${modalTokenId}:${modalTokenSecret}` : '';

  // Validate credential format
  const credError = validateGpuCredentials({
    runpodApiKey,
    vastApiKey,
    tensordockApiKey,
    tensordockAuthId,
    modalTokenId,
    modalTokenSecret,
  });
  if (credError) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: credError }));
    return;
  }

  const options: ListOffersOptions = { gpuTypes, region, limit };

  // Build provider→credentials map for configured providers
  const providerQueries: Array<{ name: string; client: GpuProviderClient; credentials: ProviderCredentials }> = [];
  if (runpodApiKey && (!providerFilter || providerFilter === 'runpod')) {
    providerQueries.push({ name: 'runpod', client: runpod, credentials: { apiKey: runpodApiKey } });
  }
  if (vastApiKey && (!providerFilter || providerFilter === 'vast')) {
    providerQueries.push({ name: 'vast', client: vast, credentials: { apiKey: vastApiKey } });
  }
  if (tensordockApiKey && (!providerFilter || providerFilter === 'tensordock')) {
    providerQueries.push({ name: 'tensordock', client: tensordock, credentials: { apiKey: tensordockApiKey, authId: tensordockAuthId } });
  }
  if (modalApiKey && (!providerFilter || providerFilter === 'modal')) {
    providerQueries.push({ name: 'modal', client: modal, credentials: { apiKey: modalApiKey } });
  }

  if (providerQueries.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No provider API keys configured. Set API keys via environment variables.' }));
    return;
  }

  // Fetch offers + balances in parallel — no extra latency
  const { allOffers, providerResults, providerBalances } = await fetchOffersWithBalances(providerQueries, options);

  // Apply hardware filters (same logic as autoSelectCheapestGpu)
  let filteredOffers = allOffers;
  if (minVramGbParam > 0) {
    filteredOffers = filteredOffers.filter(o => o.vram >= minVramGbParam);
  }
  if (preferSsdParam) {
    const ssdOnly = filteredOffers.filter(o => {
      const bw = (o as unknown as Record<string, unknown>).diskBwReadMbps as number | undefined;
      return !bw || bw > 200;
    });
    if (ssdOnly.length > 0) filteredOffers = ssdOnly;
  }

  // Sort by price, canDeploy=false offers sink to bottom
  filteredOffers.sort((a, b) => {
    const aOk = providerBalances[a.provider]?.canDeploy !== false;
    const bOk = providerBalances[b.provider]?.canDeploy !== false;
    if (aOk !== bOk) return aOk ? -1 : 1;
    return a.pricePerHr - b.pricePerHr;
  });

  const annotated = filteredOffers.map(o => ({
    ...o,
    canDeploy: providerBalances[o.provider]?.canDeploy !== false,
    providerBalance: providerBalances[o.provider]?.balance ?? null,
  }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    offers: annotated.slice(0, limit),
    providers: providerResults,
    balances: providerBalances,
  }));
}

/**
 * Handle GET /v1/gpu/types — return cached GPU type information from the database.
 *
 * Returns GPU types previously discovered and cached by the periodic
 * `refreshGpuTypeCache()` background job. Much faster than querying
 * provider APIs in real time. Optionally filters by provider.
 *
 * @param _req - Incoming HTTP request; optional query param: provider
 * @param res - Outgoing HTTP response; returns 200 with { types, count }
 * @returns Promise<void>
 *
 * @example
 * ```bash
 * GET /v1/gpu/types?provider=vast
 * # → { types: [{ provider: "vast", gpuName: "RTX 4090", pricePerHr: 0.42, vram: 24, ... }], count: 12 }
 * ```
 */
export async function handleGpuTypes(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(_req.url || '/', `http://localhost:${PORT}`);
  const providerFilter = url.searchParams.get('provider') || undefined;
  const where = providerFilter ? { provider: providerFilter } : {};
  const cached = await prisma.gpuTypeCache.findMany({ where, orderBy: [{ provider: 'asc' }, { pricePerHr: 'asc' }] });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ types: cached, count: cached.length }));
}

export async function handleGpuOffersRanked(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = getOrCreateRequestId(req);
  setRequestIdHeader(res, requestId);
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // Client coordinates — provided or auto-detected
  let clientLat = parseFloat(url.searchParams.get('clientLat') || 'NaN');
  let clientLon = parseFloat(url.searchParams.get('clientLon') || 'NaN');

  if (isNaN(clientLat) || isNaN(clientLon)) {
    const loc = await fetchMyLocation();
    if (!loc) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not determine location. Provide clientLat/clientLon params.' }));
      return;
    }
    clientLat = loc.lat;
    clientLon = loc.lon;
  }

  const gpuTypesParam = url.searchParams.get('gpuTypes');
  const gpuTypes = gpuTypesParam ? gpuTypesParam.split(',').map(s => s.trim()).filter(Boolean) : undefined;
  const region = url.searchParams.get('region') || undefined;
  const limit = parseInt(url.searchParams.get('limit') || '100', 10);
  const providerFilter = url.searchParams.get('provider') || undefined;

  const runpodApiKey = process.env.RUNPOD_API_KEY || '';
  const vastApiKey = process.env.VAST_API_KEY || '';
  const tensordockApiKey = process.env.TENSORDOCK_API_KEY || '';
  const tensordockAuthId = process.env.TENSORDOCK_AUTH_ID || '';
  const modalTokenId = process.env.MODAL_TOKEN_ID || '';
  const modalTokenSecret = process.env.MODAL_TOKEN_SECRET || '';
  const modalApiKey = modalTokenId && modalTokenSecret ? `${modalTokenId}:${modalTokenSecret}` : '';

  const options = { gpuTypes, region, limit };
  const providerQueries: Array<{ name: string; client: GpuProviderClient; credentials: ProviderCredentials }> = [];
  if (runpodApiKey && (!providerFilter || providerFilter === 'runpod'))
    providerQueries.push({ name: 'runpod', client: runpod, credentials: { apiKey: runpodApiKey } });
  if (vastApiKey && (!providerFilter || providerFilter === 'vast'))
    providerQueries.push({ name: 'vast', client: vast, credentials: { apiKey: vastApiKey } });
  if (tensordockApiKey && tensordockAuthId && (!providerFilter || providerFilter === 'tensordock'))
    providerQueries.push({ name: 'tensordock', client: tensordock, credentials: { apiKey: tensordockApiKey, authId: tensordockAuthId } });
  if (modalApiKey && (!providerFilter || providerFilter === 'modal'))
    providerQueries.push({ name: 'modal', client: modal, credentials: { apiKey: modalApiKey } });

  if (providerQueries.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No provider API keys configured.' }));
    return;
  }

  const { allOffers, providerResults, providerBalances } = await fetchOffersWithBalances(providerQueries, options);

  // Upsert metadata for all hosts so the scheduler can re-probe them later
  for (const offer of allOffers) {
    if (offer.hostId && offer.hostIp) {
      upsertHostMeta(offer.hostId, {
        hostIp:      offer.hostIp,
        provider:    offer.provider    ?? '',
        gpuName:     offer.gpuName     ?? '',
        geolocation: offer.geolocation ?? '',
        priceUsd:    offer.pricePerHr  ?? 0,
      }).catch(() => {});
    }
  }

  // ?probe=true → synchronous TCP probe of all hosts, saves to DB, blocks ~3-8s
  // default     → fire-and-forget background probes, use whatever is already in DB
  const hostIds = allOffers.map(o => o.hostId).filter(Boolean) as string[];
  let hostRtts: Record<string, number>;

  if (url.searchParams.get('probe') === 'true') {
    hostRtts = await probeAndSaveOffers(allOffers).catch(() => ({}));
  } else {
    scheduleBackgroundProbes(allOffers);
    hostRtts = await getHostRttMap(hostIds);
  }

  const ranked = rankOffers(allOffers, clientLat, clientLon, {}, hostRtts).map(o => ({
    ...o,
    canDeploy: providerBalances[o.provider]?.canDeploy !== false,
    providerBalance: providerBalances[o.provider]?.balance ?? null,
  }));

  // Sink no-credit offers to bottom while preserving latency order within each group
  const deployable = ranked.filter(o => o.canDeploy);
  const blocked = ranked.filter(o => !o.canDeploy);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    offers:         [...deployable, ...blocked].slice(0, limit),
    clientLat,
    clientLon,
    providers:      providerResults,
    balances:       providerBalances,
    hostRttsCached: Object.keys(hostRtts).length,
  }));
}

/**
 * GET /v1/gpu/types?provider=vast|runpod|tensordock
 * Returns available GPU types for a provider, enriched with latency data from the local DB.
 * Each entry: { name, shortName, vram, count, minPricePerHr, bestLatencyMs, bestRegion }
 */
export async function handleGetGpuTypes(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const providerFilter = url.searchParams.get('provider') || '';

  const runpodApiKey        = process.env.RUNPOD_API_KEY || '';
  const vastApiKey          = process.env.VAST_API_KEY || '';
  const tensordockApiKey    = process.env.TENSORDOCK_API_KEY || '';
  const tensordockAuthId    = process.env.TENSORDOCK_AUTH_ID || '';

  type ProviderEntry = { name: string; client: typeof vast; credentials: Record<string, string> };
  const queries: ProviderEntry[] = [];
  if (vastApiKey      && (!providerFilter || providerFilter === 'vast'))
    queries.push({ name: 'vast',       client: vast,       credentials: { apiKey: vastApiKey } });
  if (runpodApiKey    && (!providerFilter || providerFilter === 'runpod'))
    queries.push({ name: 'runpod',     client: runpod as unknown as typeof vast,     credentials: { apiKey: runpodApiKey } });
  if (tensordockApiKey && tensordockAuthId && (!providerFilter || providerFilter === 'tensordock'))
    queries.push({ name: 'tensordock', client: tensordock as unknown as typeof vast, credentials: { apiKey: tensordockApiKey, authId: tensordockAuthId } });

  const latencyMap = await getBestLatencyByGpuModel();

  // Aggregate GPU types across all queried providers
  const byType = new Map<string, { name: string; vram: number; count: number; minPrice: number }>();

  await Promise.allSettled(queries.map(async q => {
    try {
      const offers = await (q.client.listOffers as Function)({ limit: 500 }, q.credentials);
      for (const offer of (offers as Array<{ gpuType?: string; gpuName?: string; vram?: number; pricePerHr?: number }>) ) {
        const name = offer.gpuType || offer.gpuName || '';
        if (!name) continue;
        const existing = byType.get(name);
        if (existing) {
          existing.count++;
          if ((offer.pricePerHr ?? 999) < existing.minPrice) existing.minPrice = offer.pricePerHr ?? 999;
        } else {
          byType.set(name, { name, vram: offer.vram ?? 0, count: 1, minPrice: offer.pricePerHr ?? 0 });
        }
      }
    } catch (err) { console.warn(`[gpu-types] Provider offer fetch failed: ${err instanceof Error ? err.message : err}`); }
  }));

  const gpuTypes = [...byType.values()]
    .sort((a, b) => b.count - a.count)
    .map(g => {
      const key = g.name.replace(/nvidia\s*/gi, '').replace(/geforce\s*/gi, '').trim().toLowerCase();
      const latency = latencyMap[key];
      return {
        name:          g.name,
        shortName:     g.name.replace('NVIDIA ', '').replace('GeForce ', ''),
        vram:          g.vram,
        count:         g.count,
        minPricePerHr: g.minPrice,
        bestLatencyMs: latency?.bestMs ?? null,
        bestRegion:    latency?.region ?? null,
      };
    });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ provider: providerFilter || 'all', gpuTypes }));
}
