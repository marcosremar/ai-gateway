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
