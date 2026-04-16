import { describe, it, expect } from 'vitest';
import { handleModels } from '../src/proxy/routes/models';
import type { ProviderMapping } from '../src/proxy/types';

describe('handleModels', () => {
  it('returns 200 with empty list when no providers', () => {
    const res = handleModels({});
    expect(res.status).toBe(200);
    const body = res.body as { object: string; data: unknown[] };
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(0);
  });

  it('lists chat models', () => {
    const providers: ProviderMapping = {
      chat: { 'llama-3': { providerId: 'test', isConfigured: () => true } as any },
    };
    const res = handleModels(providers);
    const body = res.body as { data: Array<{ id: string; object: string; owned_by: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('llama-3');
    expect(body.data[0].object).toBe('model');
    expect(body.data[0].owned_by).toBe('ai-gateway');
  });

  it('lists embedding models', () => {
    const providers: ProviderMapping = {
      embedding: { 'text-embedding-3': { providerId: 'test', isConfigured: () => true } as any },
    };
    const res = handleModels(providers);
    const body = res.body as { data: Array<{ id: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('text-embedding-3');
  });

  it('lists STT models', () => {
    const providers: ProviderMapping = {
      stt: { 'whisper-small': { providerId: 'test', isConfigured: () => true } as any },
    };
    const res = handleModels(providers);
    const body = res.body as { data: Array<{ id: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('whisper-small');
  });

  it('lists TTS models', () => {
    const providers: ProviderMapping = {
      tts: { 'tts-1': { providerId: 'test', isConfigured: () => true } as any },
    };
    const res = handleModels(providers);
    const body = res.body as { data: Array<{ id: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('tts-1');
  });

  it('lists models from all provider types', () => {
    const providers: ProviderMapping = {
      chat: { 'model-a': { providerId: 't', isConfigured: () => true } as any },
      embedding: { 'model-b': { providerId: 't', isConfigured: () => true } as any },
      stt: { 'model-c': { providerId: 't', isConfigured: () => true } as any },
      tts: { 'model-d': { providerId: 't', isConfigured: () => true } as any },
    };
    const res = handleModels(providers);
    const body = res.body as { data: Array<{ id: string }> };
    expect(body.data).toHaveLength(4);
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain('model-a');
    expect(ids).toContain('model-b');
    expect(ids).toContain('model-c');
    expect(ids).toContain('model-d');
  });

  it('each model has id, object, created, and owned_by', () => {
    const providers: ProviderMapping = {
      chat: { 'm1': { providerId: 't', isConfigured: () => true } as any, 'm2': { providerId: 't', isConfigured: () => true } as any },
    };
    const res = handleModels(providers);
    const body = res.body as { data: Array<{ id: string; object: string; created: number; owned_by: string }> };
    for (const model of body.data) {
      expect(model.id).toBeDefined();
      expect(model.object).toBe('model');
      expect(model.created).toBeTypeOf('number');
      expect(model.owned_by).toBe('ai-gateway');
    }
  });

  it('lists multiple models within same provider type', () => {
    const providers: ProviderMapping = {
      chat: {
        'gpt-4o': { providerId: 't', isConfigured: () => true } as any,
        'gpt-4o-mini': { providerId: 't', isConfigured: () => true } as any,
        'llama-3': { providerId: 't', isConfigured: () => true } as any,
      },
    };
    const res = handleModels(providers);
    const body = res.body as { data: Array<{ id: string }> };
    expect(body.data).toHaveLength(3);
  });
});
