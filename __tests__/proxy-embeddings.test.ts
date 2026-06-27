import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleEmbeddings } from '../src/proxy/routes/embeddings';
import type { ProxyRequest } from '../src/proxy/types';

function makeReq(body: Record<string, unknown>): ProxyRequest {
  return { method: 'POST', url: '/v1/embeddings', headers: {}, body, rawBody: Buffer.alloc(0) };
}

const DEFAULT_EMBED_RESULT = {
  embeddings: [[0.1, 0.2, 0.3]],
  model: 'test-model',
  usage: { promptTokens: 5, totalTokens: 5 },
};

const mockEmbeddingProvider = {
  providerId: 'test' as const,
  name: 'test-embedding',
  embed: vi.fn().mockResolvedValue(DEFAULT_EMBED_RESULT),
  isConfigured: () => true,
};

const providers = { 'test-model': mockEmbeddingProvider } as any;

describe('handleEmbeddings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbeddingProvider.embed.mockResolvedValue(DEFAULT_EMBED_RESULT);
  });

  it('returns 400 when model is missing', async () => {
    const res = await handleEmbeddings(makeReq({ input: 'hello' }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when input is missing', async () => {
    const res = await handleEmbeddings(makeReq({ model: 'test-model' }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when input is a number (not string/array)', async () => {
    const res = await handleEmbeddings(makeReq({ model: 'test-model', input: 42 }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when input is an array of non-strings', async () => {
    const res = await handleEmbeddings(makeReq({ model: 'test-model', input: [1, 2, 3] }), providers);
    expect(res.status).toBe(400);
  });

  it('returns 400 when input array exceeds 100 items', async () => {
    const inputs = Array.from({ length: 101 }, (_, i) => `text-${i}`);
    const res = await handleEmbeddings(makeReq({ model: 'test-model', input: inputs }), providers);
    expect(res.status).toBe(400);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toMatch(/100/);
  });

  it('returns 400 when a single input string exceeds 8192 characters', async () => {
    const longInput = 'x'.repeat(8193);
    const res = await handleEmbeddings(makeReq({ model: 'test-model', input: longInput }), providers);
    expect(res.status).toBe(400);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toMatch(/8192/);
  });

  it('returns 400 when an array element exceeds 8192 characters', async () => {
    const inputs = ['short', 'x'.repeat(8193)];
    const res = await handleEmbeddings(makeReq({ model: 'test-model', input: inputs }), providers);
    expect(res.status).toBe(400);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toMatch(/input\[1\]/);
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

  it('accepts exactly 100 inputs (boundary)', async () => {
    const inputs = Array.from({ length: 100 }, (_, i) => `text-${i}`);
    mockEmbeddingProvider.embed.mockResolvedValueOnce({
      embeddings: inputs.map(() => [0.1]),
      model: 'test-model',
      usage: { promptTokens: 100, totalTokens: 100 },
    });
    const res = await handleEmbeddings(makeReq({ model: 'test-model', input: inputs }), providers);
    expect(res.status).toBe(200);
  });

  it('accepts exactly 8192-character input (boundary)', async () => {
    const input = 'x'.repeat(8192);
    const res = await handleEmbeddings(makeReq({ model: 'test-model', input }), providers);
    expect(res.status).toBe(200);
  });
});

describe('handleEmbeddings — ResponseCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbeddingProvider.embed.mockResolvedValue(DEFAULT_EMBED_RESULT);
  });

  function makeCache(overrides: { get?: () => unknown; set?: () => void } = {}) {
    return {
      buildKey: vi.fn().mockReturnValue('cache-key-123'),
      get: vi.fn().mockResolvedValue(overrides.get ? overrides.get() : null),
      set: vi.fn().mockResolvedValue(undefined),
    } as any;
  }

  it('calls provider when cache returns null (MISS)', async () => {
    const cache = makeCache();
    const res = await handleEmbeddings(makeReq({ model: 'test-model', input: 'hello' }), providers, cache);
    expect(res.status).toBe(200);
    expect(mockEmbeddingProvider.embed).toHaveBeenCalledOnce();
    expect(cache.set).toHaveBeenCalledWith('cache-key-123', DEFAULT_EMBED_RESULT);
  });

  it('returns cached result without calling provider on HIT', async () => {
    const cached = {
      embeddings: [[0.9, 0.8]],
      model: 'test-model',
      usage: { promptTokens: 3, totalTokens: 3 },
    };
    const cache = makeCache({ get: () => cached });
    const res = await handleEmbeddings(makeReq({ model: 'test-model', input: 'hello' }), providers, cache);
    expect(res.status).toBe(200);
    expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled();
    const body = res.body as { data: Array<{ embedding: number[] }>; usage: { prompt_tokens: number } };
    expect(body.data[0].embedding).toEqual([0.9, 0.8]);
    expect(body.usage.prompt_tokens).toBe(3);
  });

  it('builds cache key with provider, model, input, and dimensions', async () => {
    const cache = makeCache();
    await handleEmbeddings(makeReq({ model: 'test-model', input: 'hello', dimensions: 512 }), providers, cache);
    expect(cache.buildKey).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'test', model: 'test-model', input: ['hello'], dimensions: 512 }),
    );
  });

  it('still returns provider result when cache.set throws', async () => {
    const cache = makeCache();
    cache.set.mockRejectedValueOnce(new Error('storage full'));
    const res = await handleEmbeddings(makeReq({ model: 'test-model', input: 'hello' }), providers, cache);
    expect(res.status).toBe(200);
    const body = res.body as { data: Array<{ embedding: number[] }> };
    expect(body.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
  });
});
