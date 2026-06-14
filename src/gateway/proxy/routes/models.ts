/**
 * GET /v1/models — list available models.
 */

import type { ProviderMapping, ProxyResponse } from '../types';

/** Minimal shape of a dynamic model catalog (e.g. live OpenRouter listing). */
interface DynamicModelCatalog {
  providerId: string;
  listModels(): Promise<string[]>;
}

/**
 * TTL memo around live model-catalog HTTP calls (#340).
 *
 * `handleModelsWithDynamic` called `catalog.listModels()` (a live OpenRouter
 * fetch) on *every* `/v1/models` request, adding latency and outbound calls to
 * a list that changes at most a few times a day. This caches each provider's id
 * list for a multi-minute window. On an in-window hit the cached ids are
 * returned with no network call; a failed refresh transparently serves the
 * last good value (stale-on-error) so a transient provider blip doesn't drop
 * models from the catalog.
 */
export class ModelCatalogCache {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, { ids: string[]; expiresAt: number }>();
  private readonly now: () => number;

  constructor(ttlMs = 5 * 60_000, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** Get the catalog's model ids, fetching only when the cache is cold/stale. */
  async getModels(catalog: DynamicModelCatalog): Promise<string[]> {
    const cached = this.entries.get(catalog.providerId);
    if (cached && cached.expiresAt > this.now()) return cached.ids;
    try {
      const ids = await catalog.listModels();
      this.entries.set(catalog.providerId, { ids, expiresAt: this.now() + this.ttlMs });
      return ids;
    } catch (err) {
      // Stale-on-error: serve the last good list rather than dropping models.
      if (cached) return cached.ids;
      throw err;
    }
  }

  /** Drop all cached catalogs (tests / forced refresh). */
  clear(): void { this.entries.clear(); }
}

/** Module-level catalog cache shared across /v1/models requests. */
const defaultCatalogCache = new ModelCatalogCache();

export function handleModels(providers: ProviderMapping): ProxyResponse {
  return buildModelsResponse(collectStaticModels(providers));
}

export async function handleModelsWithDynamic(
  providers: ProviderMapping,
  catalogCache: ModelCatalogCache = defaultCatalogCache,
): Promise<ProxyResponse> {
  const models = collectStaticModels(providers);
  const seen = new Set(models.map((model) => model.id));
  const warnings: string[] = [];
  const now = Math.floor(Date.now() / 1000);

  for (const catalog of providers.dynamicModelCatalogs ?? []) {
    try {
      const ids = await catalogCache.getModels(catalog);
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        models.push({ id, object: 'model', created: now, owned_by: catalog.providerId });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${catalog.providerId}: ${message.slice(0, 120)}`);
    }
  }

  const response = buildModelsResponse(models);
  if (warnings.length > 0) {
    return {
      ...response,
      headers: { 'X-Gateway-Model-Catalog-Warnings': warnings.join('; ') },
    };
  }
  return response;
}

function collectStaticModels(providers: ProviderMapping): Array<{ id: string; object: string; created: number; owned_by: string }> {
  const models: Array<{ id: string; object: string; created: number; owned_by: string }> = [];
  const now = Math.floor(Date.now() / 1000);

  if (providers.chat) {
    for (const id of Object.keys(providers.chat)) {
      models.push({ id, object: 'model', created: now, owned_by: 'ai-gateway' });
    }
  }
  if (providers.embedding) {
    for (const id of Object.keys(providers.embedding)) {
      models.push({ id, object: 'model', created: now, owned_by: 'ai-gateway' });
    }
  }
  if (providers.stt) {
    for (const id of Object.keys(providers.stt)) {
      models.push({ id, object: 'model', created: now, owned_by: 'ai-gateway' });
    }
  }
  if (providers.tts) {
    for (const id of Object.keys(providers.tts)) {
      models.push({ id, object: 'model', created: now, owned_by: 'ai-gateway' });
    }
  }
  return models;
}

function buildModelsResponse(models: Array<{ id: string; object: string; created: number; owned_by: string }>): ProxyResponse {
  return {
    status: 200,
    body: { object: 'list', data: models },
  };
}
