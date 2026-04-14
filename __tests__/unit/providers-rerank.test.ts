import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FireworksRerankProvider } from '../../src/providers/rerank/fireworks-rerank';
import { OpenRouterRerankProvider } from '../../src/providers/rerank/openrouter-rerank';
import type { RerankRequest } from '../../src/providers/rerank/types';

describe.each([
  { Provider: FireworksRerankProvider, name: 'FireworksRerankProvider', envKey: 'FIREWORKS_API_KEY', url: 'https://api.fireworks.ai/inference/v1/rerank' },
  { Provider: OpenRouterRerankProvider, name: 'OpenRouterRerankProvider', envKey: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/api/v1/rerank' },
])('$name', ({ Provider, envKey, url }) => {
  let provider: InstanceType<typeof Provider>;
  let originalEnv: string | undefined;

  beforeEach(() => {
    provider = new Provider() as any;
    originalEnv = process.env[envKey];
    delete process.env[envKey];
  });

  afterEach(() => {
    if (originalEnv !== undefined) process.env[envKey] = originalEnv;
    else delete process.env[envKey];
    vi.restoreAllMocks();
  });

  it('isConfigured returns false when env key not set', () => {
    expect(provider.isConfigured()).toBe(false);
  });

  it('isConfigured returns true when env key is set', () => {
    process.env[envKey] = 'test-key';
    expect(provider.isConfigured()).toBe(true);
  });

  it('rerank throws when env key not set', async () => {
    await expect(provider.rerank({ query: 'q', documents: ['a'] })).rejects.toThrow(`${envKey} is not set`);
  });

  it('rerank sends correct POST body and returns parsed results', async () => {
    process.env[envKey] = 'test-key';
    const mockResponse = {
      ok: true,
      json: async () => ({
        results: [
          { index: 0, relevance_score: 0.95, document: { text: 'doc a' } },
          { index: 1, relevance_score: 0.5, document: { text: 'doc b' } },
        ],
        model: 'test-model',
      }),
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as any);

    const req: RerankRequest = { query: 'hello', documents: ['doc a', 'doc b'], topN: 2 };
    const result = await provider.rerank(req);

    expect(fetchSpy).toHaveBeenCalledWith(url, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key',
      }),
    }));
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as any).body);
    expect(body.query).toBe('hello');
    expect(body.documents).toEqual(['doc a', 'doc b']);
    expect(body.top_n).toBe(2);

    expect(result.results).toHaveLength(2);
    expect(result.results[0].index).toBe(0);
    expect(result.results[0].relevanceScore).toBe(0.95);
    expect(result.results[0].document).toBe('doc a');
  });

  it('rerank throws on non-ok response', async () => {
    process.env[envKey] = 'test-key';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as any);

    await expect(provider.rerank({ query: 'q', documents: ['a'] })).rejects.toThrow(/500/);
  });
});
