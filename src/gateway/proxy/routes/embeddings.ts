/**
 * POST /v1/embeddings
 */

import type { EmbeddingProvider } from '../../providers/cloud/openai-compat/openai-compat-embedding';
import type { ResponseCache } from '../../../caching/response-cache';
import type { ProxyRequest, ProxyResponse } from '../types';
import { withProxyRetry } from './retry';
import { createLogger } from '../../../logger';

const log = createLogger('embeddings');

const MAX_EMBEDDING_INPUTS = 100;
const MAX_INPUT_LENGTH = 8192;

/**
 * Per-input embedding cache plumbing (#331).
 *
 * The previous cache keyed on the WHOLE input array, so two requests sharing
 * 99/100 strings got 0% reuse. These pure helpers let the handler cache each
 * input string individually and only embed the miss subset. They also guard
 * against memoizing a truncated provider response (validate count == inputs).
 */

/** Build a per-input cache key for one embedding string. */
export function embeddingInputKey(
  cache: { buildCustomKey(k: string): string },
  providerId: string,
  model: string,
  input: string,
  dimensions?: number,
): string {
  return cache.buildCustomKey(`emb:${providerId}:${model}:${dimensions ?? 0}:${input}`);
}

/**
 * Split inputs into per-index cache hits and the still-needed miss list.
 * `getHit(index)` returns a cached vector or null. Returns the indices that
 * missed (in order) plus a sparse results array pre-filled with hits.
 */
export function partitionEmbeddingInputs(
  inputs: string[],
  getHit: (index: number) => number[] | null,
): { missIndices: number[]; results: (number[] | null)[] } {
  const results: (number[] | null)[] = new Array(inputs.length).fill(null);
  const missIndices: number[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const hit = getHit(i);
    if (hit) results[i] = hit;
    else missIndices.push(i);
  }
  return { missIndices, results };
}

/**
 * Merge freshly-embedded vectors (in miss order) back into the sparse results.
 * Throws when the provider returned a different count than was requested (#331)
 * — a truncated response must not be partially merged or cached.
 */
export function assembleEmbeddings(
  results: (number[] | null)[],
  missIndices: number[],
  fresh: number[][],
): number[][] {
  if (fresh.length !== missIndices.length) {
    throw new Error(`embedding count mismatch: expected ${missIndices.length}, got ${fresh.length}`);
  }
  const out = [...results];
  for (let j = 0; j < missIndices.length; j++) out[missIndices[j]] = fresh[j];
  // After filling, no slot may remain null.
  return out.map((v, i) => {
    if (v === null) throw new Error(`embedding missing for index ${i}`);
    return v;
  });
}

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
    // Per-input caching (#331): look up each string individually so a request
    // sharing most inputs with a prior one reuses those vectors and only embeds
    // the misses, instead of all-or-nothing on the whole-array key.
    const perInputKeys = cache
      ? inputs.map((s) => embeddingInputKey(cache, provider.providerId, model, s, dimensions))
      : null;

    let cachedHits: (number[] | null)[] = new Array(inputs.length).fill(null);
    if (cache && perInputKeys) {
      cachedHits = await Promise.all(
        perInputKeys.map((k) => cache.get<number[]>(k).catch(() => null)),
      );
    }

    const { missIndices, results } = partitionEmbeddingInputs(inputs, (i) => cachedHits[i]);

    let usage = { promptTokens: 0, totalTokens: 0 };
    let resolvedModel = model;
    let finalEmbeddings: number[][];

    if (missIndices.length === 0) {
      // Full cache hit — no provider call.
      finalEmbeddings = results.map((v) => v as number[]);
    } else {
      const missInputs = missIndices.map((i) => inputs[i]);
      const result = await withProxyRetry(
        provider.providerId,
        model,
        () => provider.embed(missInputs, { model, dimensions }),
        'Embedding',
      );
      // assembleEmbeddings throws if the provider returned a truncated count,
      // so a partial response is never cached or returned (#331).
      finalEmbeddings = assembleEmbeddings(results, missIndices, result.embeddings);
      usage = result.usage;
      resolvedModel = result.model;

      if (cache && perInputKeys) {
        await Promise.all(
          missIndices.map((idx, j) =>
            cache.set(perInputKeys[idx], result.embeddings[j]).catch((cacheErr) => {
              log.error(`Cache set failed:`, cacheErr);
            }),
          ),
        );
      }
    }

    return {
      status: 200,
      body: {
        object: 'list',
        data: finalEmbeddings.map((embedding, i) => ({
          object: 'embedding',
          index: i,
          embedding,
        })),
        model: resolvedModel,
        usage: {
          prompt_tokens: usage.promptTokens,
          total_tokens: usage.totalTokens,
        },
      },
    };
  } catch (err) {
    log.error(`Error for model ${model}:`, err);
    const safeMessage = err instanceof Error ? err.message.replace(/https?:\/\/[^\s]+/g, '[redacted-url]') : 'Internal error';
    return {
      status: 500,
      body: { error: { message: safeMessage, type: 'server_error' } },
    };
  }
}