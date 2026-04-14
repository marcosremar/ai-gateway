import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenRouterRerankProvider } from '../src/providers/rerank/openrouter-rerank';
import { FireworksRerankProvider } from '../src/providers/rerank/fireworks-rerank';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Reranking Providers', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-or-key';
    process.env.FIREWORKS_API_KEY = 'test-fw-key';
    mockFetch.mockReset();
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.FIREWORKS_API_KEY;
  });

  describe('OpenRouterRerankProvider', () => {
    it('reranks documents', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            { index: 1, relevance_score: 0.95 },
            { index: 0, relevance_score: 0.82 },
          ],
          model: 'cohere/rerank-v3.5',
        }),
      });

      const provider = new OpenRouterRerankProvider();
      const result = await provider.rerank({
        query: 'what is AI?',
        documents: ['AI is cool', 'Artificial intelligence is the future'],
      });

      expect(result.results).toHaveLength(2);
      expect(result.results[0].relevanceScore).toBe(0.95);
      expect(result.results[0].index).toBe(1);
      expect(result.model).toBe('cohere/rerank-v3.5');
    });

    it('passes topN parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{ index: 0, relevance_score: 0.9 }],
          model: 'cohere/rerank-v3.5',
        }),
      });

      const provider = new OpenRouterRerankProvider();
      await provider.rerank({ query: 'test', documents: ['a', 'b'], topN: 1 });

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.top_n).toBe(1);
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const provider = new OpenRouterRerankProvider();
      await expect(provider.rerank({ query: 'test', documents: ['a'] }))
        .rejects.toThrow('401');
    });

    it('isConfigured reflects env key', () => {
      const provider = new OpenRouterRerankProvider();
      expect(provider.isConfigured()).toBe(true);
      delete process.env.OPENROUTER_API_KEY;
      expect(provider.isConfigured()).toBe(false);
    });
  });

  describe('FireworksRerankProvider', () => {
    it('reranks documents', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            { index: 0, relevance_score: 0.88 },
            { index: 1, relevance_score: 0.72 },
          ],
          model: 'accounts/fireworks/models/rerank-v1',
        }),
      });

      const provider = new FireworksRerankProvider();
      const result = await provider.rerank({
        query: 'search query',
        documents: ['doc 1', 'doc 2'],
      });

      expect(result.results).toHaveLength(2);
      expect(result.results[0].relevanceScore).toBe(0.88);
    });

    it('throws when API key missing', async () => {
      delete process.env.FIREWORKS_API_KEY;
      const provider = new FireworksRerankProvider();
      await expect(provider.rerank({ query: 'test', documents: ['a'] }))
        .rejects.toThrow('FIREWORKS_API_KEY is not set');
    });
  });
});
