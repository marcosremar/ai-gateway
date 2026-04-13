/**
 * POST /v1/embeddings
 */

import type { EmbeddingProvider } from '../../providers/openai-compat/openai-compat-embedding';
import type { ResponseCache } from '../../caching/response-cache';
import type { ProxyRequest, ProxyResponse } from '../types';
import { withProxyRetry } from './retry';

const MAX_EMBEDDING_INPUTS = 100;
const MAX_INPUT_LENGTH = 8192;

export async function handleEmbeddings(
  req: ProxyRequest,
  embeddingProviders: Record<string, EmbeddingProvider>,
  cache?: ResponseCache,
): Promise<ProxyResponse> {
  if (!req.body || typeof req.body !== 'object') {
    return { status: 400, body: { error: { message: 'request body is required', type: 'invalid_request_error' } } };
  }
  const body = req.body as Record<string, unknown>;

  const model = typeof body.model === 'string' ? body.model : null;
  if (!model) {
    return { status: 400, body: { error: { message: 'model is required', type: 'invalid_request_error' } } };
  }

  const input = body.input;
  let inputs: string[];
  if (typeof input === 'string') {
    inputs = [input];
  } else if (Array.isArray(input) && input.every((x): x is string => typeof x === 'string')) {
    inputs = input;
  } else {
    return { status: 400, body: { error: { message: 'input must be a string or array of strings', type: 'invalid_request_error' } } };
  }

  if (inputs.length > MAX_EMBEDDING_INPUTS) {
    return { status: 400, body: { error: { message: `input array exceeds ${MAX_EMBEDDING_INPUTS} maximum`, type: 'invalid_request_error' } } };
  }

  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i].length > MAX_INPUT_LENGTH) {
      return { status: 400, body: { error: { message: `input[${i}] exceeds ${MAX_INPUT_LENGTH} characters`, type: 'invalid_request_error' } } };
    }
  }

  const provider = embeddingProviders[model];
  if (!provider) {
    return { status: 404, body: { error: { message: `Embedding model "${model}" not found`, type: 'invalid_request_error' } } };
  }

  const dimensions = typeof body.dimensions === 'number' ? body.dimensions : undefined;

  try {
    const cacheKey = cache ? cache.buildKey({ provider: provider.providerId, model, input: inputs, dimensions }) : null;

    if (cacheKey) {
      const cached = await cache!.get<{ embeddings: number[][]; model: string; usage: { promptTokens: number; totalTokens: number } }>(cacheKey);
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
      model,
      () => provider.embed(inputs, {
        model,
        dimensions,
      }),
      'Embedding',
    );

    if (cacheKey) {
      try {
        await cache!.set(cacheKey, result);
      } catch (cacheErr) {
        console.error(`[embeddings] Cache set failed:`, cacheErr);
      }
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
    console.error(`[embeddings] Error for model ${model}:`, err);
    const safeMessage = err instanceof Error ? err.message.replace(/https?:\/\/[^\s]+/g, '[redacted-url]') : 'Internal error';
    return {
      status: 500,
      body: { error: { message: safeMessage, type: 'server_error' } },
    };
  }
}