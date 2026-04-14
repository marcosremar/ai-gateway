import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatEmbeddingProvider } from '../../src/providers/openai-compat/openai-compat-embedding';

// Mock OpenAI
vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      embeddings = {
        create: vi.fn().mockResolvedValue({
          data: [
            { embedding: [0.1, 0.2, 0.3], index: 0 },
            { embedding: [0.4, 0.5, 0.6], index: 1 },
          ],
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: 10, total_tokens: 10 },
        }),
      };
      constructor() {}
    },
  };
});

describe('OpenAICompatEmbeddingProvider', () => {
  let provider: OpenAICompatEmbeddingProvider;

  beforeEach(() => {
    process.env.TEST_EMBED_KEY = 'test-key';
    provider = new OpenAICompatEmbeddingProvider({
      providerId: 'openai',
      name: 'Test Embedding',
      baseURL: 'https://api.openai.com/v1',
      envKey: 'TEST_EMBED_KEY',
      defaultModel: 'text-embedding-3-small',
    });
  });

  it('returns embeddings for single input', async () => {
    const result = await provider.embed('hello world');
    expect(result.embeddings).toHaveLength(2); // mock returns 2
    expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
    expect(result.model).toBe('text-embedding-3-small');
    expect(result.usage.promptTokens).toBe(10);
  });

  it('returns embeddings for array input', async () => {
    const result = await provider.embed(['hello', 'world']);
    expect(result.embeddings).toHaveLength(2);
  });

  it('passes model and dimensions options', async () => {
    const result = await provider.embed('test', {
      model: 'text-embedding-3-large',
      dimensions: 256,
    });
    expect(result).toBeDefined();
  });

  it('isConfigured returns true when env key is set', () => {
    expect(provider.isConfigured()).toBe(true);
  });

  it('isConfigured returns false when env key is missing', () => {
    delete process.env.TEST_EMBED_KEY;
    const p = new OpenAICompatEmbeddingProvider({
      providerId: 'openai',
      name: 'Test',
      baseURL: 'https://api.openai.com/v1',
      envKey: 'MISSING_KEY',
      defaultModel: 'text-embedding-3-small',
    });
    expect(p.isConfigured()).toBe(false);
  });

  it('throws when env key is missing on embed', async () => {
    delete process.env.TEST_EMBED_KEY;
    const p = new OpenAICompatEmbeddingProvider({
      providerId: 'openai',
      name: 'Test',
      baseURL: 'https://api.openai.com/v1',
      envKey: 'MISSING_KEY',
      defaultModel: 'text-embedding-3-small',
    });
    await expect(p.embed('test')).rejects.toThrow('MISSING_KEY is not set');
  });
});
