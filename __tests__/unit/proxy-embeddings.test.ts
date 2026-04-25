import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleEmbeddings } from '../../src/proxy/routes/embeddings';
import type { ProxyRequest } from '../../src/proxy/types';

function makeReq(body: Record<string, unknown>): ProxyRequest {
  return { method: 'POST', url: '/v1/embeddings', headers: {}, body, rawBody: Buffer.alloc(0) };
}

const mockEmbeddingProvider = {
  providerId: 'test' as const,
  name: 'test-embedding',
  embed: vi.fn().mockResolvedValue({
    embeddings: [[0.1, 0.2, 0.3]],
    model: 'test-model',
    usage: { promptTokens: 5, totalTokens: 5 },
  }),
  isConfigured: () => true,
};

const providers = { 'test-model': mockEmbeddingProvider } as any;

describe('handleEmbeddings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when model is missing', async () => {
    const res = await handleEmbeddings(makeReq({ input: 'hello' }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 404 when model not found', async () => {
    const res = await handleEmbeddings(makeReq({ model: 'nonexistent', input: 'hello' }), providers);
    expect(res.status).toBe(404);
  });

  it('returns 200 with embedding array on valid request', async () => {
    const res = await handleEmbeddings(makeReq({ model: 'test-model', input: 'hello' }), providers);
    expect(res.status).toBe(200);
    const body = res.body as {
      object: string;
      data: Array<{ object: string; index: number; embedding: number[] }>;
      model: string;
    };
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(1);
    expect(body.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect(body.data[0].index).toBe(0);
    expect(body.data[0].object).toBe('embedding');
    expect(body.model).toBe('test-model');
  });

  it('calls provider.embed with input and options', async () => {
    await handleEmbeddings(makeReq({ model: 'test-model', input: 'hello', dimensions: 256 }), providers);
    // String input is normalized to an array before being passed to the provider
    expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith(
      ['hello'],
      { model: 'test-model', dimensions: 256 },
    );
  });

  it('handles array input', async () => {
    mockEmbeddingProvider.embed.mockResolvedValueOnce({
      embeddings: [[0.1, 0.2], [0.3, 0.4]],
      model: 'test-model',
      usage: { promptTokens: 10, totalTokens: 10 },
    });
    const res = await handleEmbeddings(makeReq({ model: 'test-model', input: ['hello', 'world'] }), providers);
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[] };
    expect(body.data).toHaveLength(2);
  });

  it('returns usage in response', async () => {
    const res = await handleEmbeddings(makeReq({ model: 'test-model', input: 'hello' }), providers);
    const body = res.body as { usage: { prompt_tokens: number; total_tokens: number } };
    expect(body.usage.prompt_tokens).toBe(5);
    expect(body.usage.total_tokens).toBe(5);
  });

  it('returns 500 when provider throws', async () => {
    mockEmbeddingProvider.embed.mockRejectedValueOnce(new Error('embed fail'));
    const res = await handleEmbeddings(makeReq({ model: 'test-model', input: 'hello' }), providers);
    expect(res.status).toBe(500);
  });
});
