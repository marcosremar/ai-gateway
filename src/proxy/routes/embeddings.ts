/**
 * POST /v1/embeddings
 */

import type { EmbeddingProvider } from '../../providers/openai-compat/openai-compat-embedding';
import type { ProxyRequest, ProxyResponse } from '../types';
import { withProxyRetry } from './retry';

export async function handleEmbeddings(
  req: ProxyRequest,
  embeddingProviders: Record<string, EmbeddingProvider>,
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
    const result = await withProxyRetry(
      provider.providerId,
      body.model,
      () => provider.embed(body.input, {
        model: body.model,
        dimensions: body.dimensions,
      }),
      'Embedding',
    );

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
    return {
      status: 500,
      body: { error: { message: String(err), type: 'server_error' } },
    };
  }
}
