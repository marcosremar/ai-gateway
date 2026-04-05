/**
 * POST /v1/embeddings
 */

import type { EmbeddingProvider } from '../../providers/openai-compat/openai-compat-embedding';
import type { ResponseCache } from '../../caching/response-cache';
import type { ProxyRequest, ProxyResponse } from '../types';
import { withProxyRetry } from './retry';

export async function handleEmbeddings(
  req: ProxyRequest,
  embeddingProviders: Record<string, EmbeddingProvider>,
  cache?: ResponseCache,
): Promise<ProxyResponse> {
  const body = req.body as {
    model: string;
    input: string | string[];
    dimensions?: number;
  };

  if (!body.model) {
    return { status: 400, body: { error: { message: 'model is required', type: 'invalid_request_error' } } };
  }

  const provider = embeddingProviders[body.model];
  if (!provider) {
    return { status: 404, body: { error: { message: `Embedding model "${body.model}" not found`, type: 'invalid_request_error' } } };
  }

  try {
    // Embeddings are always deterministic — cache aggressively
    if (cache) {
      const cacheKey = cache.buildKey({ provider: provider.providerId, model: body.model, input: body.input, dimensions: body.dimensions });
      const cached = await cache.get<{ embeddings: number[][]; model: string; usage: { promptTokens: number; totalTokens: number } }>(cacheKey);
      if (cached) {
        return {
          status: 200,
          body: {
            object: 'list',
            data: cached.embeddings.map((embedding, i) => ({ object: 'embedding', index: i, embedding })),
            model: cached.model,
            usage: { prompt_tokens: cached.usage.promptTokens, total_tokens: cached.usage.totalTokens },
          },
        };
      }
    }

    const result = await withProxyRetry(
      provider.providerId,
      body.model,
      () => provider.embed(body.input, {
        model: body.model,
        dimensions: body.dimensions,
      }),
      'Embedding',
    );

    // Cache the result
    if (cache) {
      const cacheKey = cache.buildKey({ provider: provider.providerId, model: body.model, input: body.input, dimensions: body.dimensions });
      await cache.set(cacheKey, result);
    }

    return {
      status: 200,
      body: {
        object: 'list',
        data: result.embeddings.map((embedding, i) => ({
          object: 'embedding',
          index: i,
          embedding,
        })),
        model: result.model,
        usage: {
          prompt_tokens: result.usage.promptTokens,
          total_tokens: result.usage.totalTokens,
        },
      },
    };
  } catch (err) {
    console.error(`[embeddings] Error for model ${body.model}:`, err);
    const safeMessage = err instanceof Error ? err.message.replace(/https?:\/\/[^\s]+/g, '[redacted-url]') : 'Internal error';
    return {
      status: 500,
      body: { error: { message: safeMessage, type: 'server_error' } },
    };
  }
}
