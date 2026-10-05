/**
 * GET /v1/models — list available models.
 */

import type { ProviderMapping, ProxyResponse } from '../types';

export function handleModels(providers: ProviderMapping): ProxyResponse {
  return buildModelsResponse(collectStaticModels(providers));
}

export async function handleModelsWithDynamic(providers: ProviderMapping): Promise<ProxyResponse> {
  const models = collectStaticModels(providers);
  const seen = new Set(models.map((model) => model.id));
  const warnings: string[] = [];
  const now = Math.floor(Date.now() / 1000);

  for (const catalog of providers.dynamicModelCatalogs ?? []) {
    try {
      const ids = await catalog.listModels();
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

type ModelEntry = { id: string; object: string; created: number; owned_by: string };
type Servable = { isConfigured(): boolean } | Array<{ provider: { isConfigured(): boolean } }>;

/** A model is listed only when at least one of its providers is configured (has its key) right now. */
function servable(value: Servable | undefined): boolean {
  if (!value) return false;
  if (Array.isArray(value)) return value.some((t) => t.provider.isConfigured());
  return value.isConfigured();
}

function collectStaticModels(providers: ProviderMapping): ModelEntry[] {
  const models: ModelEntry[] = [];
  const seen = new Set<string>();
  const now = Math.floor(Date.now() / 1000);
  const add = (map: Record<string, Servable> | undefined) => {
    for (const [id, value] of Object.entries(map ?? {})) {
      if (seen.has(id) || !servable(value)) continue;
      seen.add(id);
      models.push({ id, object: 'model', created: now, owned_by: 'ai-gateway' });
    }
  };
  add(providers.chatRoutes);
  add(providers.chat);
  add(providers.embedding);
  add(providers.stt);
  add(providers.tts);
  return models;
}

function buildModelsResponse(models: Array<{ id: string; object: string; created: number; owned_by: string }>): ProxyResponse {
  return {
    status: 200,
    body: { object: 'list', data: models },
  };
}
