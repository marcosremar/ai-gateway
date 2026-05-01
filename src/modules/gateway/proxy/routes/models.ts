/**
 * GET /v1/models — list available models.
 */

import type { ProviderMapping, ProxyResponse } from '../types';

export function handleModels(providers: ProviderMapping): ProxyResponse {
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

  return {
    status: 200,
    body: { object: 'list', data: models },
  };
}
