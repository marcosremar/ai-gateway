/**
 * withCache — wrapper that checks cache before calling the underlying LLM provider.
 */

import type { LLMProvider, ChatRequest, ChatResponse } from '../providers/types';
import type { ResponseCache } from './response-cache';

export interface WithCacheOptions {
  ttlMs?: number;
  /** Only cache if condition returns true. Default: cache when temperature is 0 or undefined. */
  condition?: (req: ChatRequest) => boolean;
}

/**
 * Wrap an LLMProvider with caching.
 * Returns a new provider that checks the cache before calling `chat()`.
 */
export function withCache(
  provider: LLMProvider,
  cache: ResponseCache,
  opts?: WithCacheOptions,
): LLMProvider {
  const shouldCache = opts?.condition ?? ((req: ChatRequest) =>
    req.temperature === undefined || req.temperature === 0
  );

  return {
    providerId: provider.providerId,
    isConfigured: () => provider.isConfigured(),
    withApiKey: provider.withApiKey ? (key: string) => withCache(provider.withApiKey!(key), cache, opts) : undefined,
    withConfig: provider.withConfig ? (o: { apiKey: string; baseURL?: string }) => withCache(provider.withConfig!(o), cache, opts) : undefined,

    async chat(request: ChatRequest): Promise<ChatResponse> {
      if (!shouldCache(request)) {
        return provider.chat(request);
      }

      const key = cache.buildKey({
        provider: provider.providerId,
        model: request.model,
        messages: request.messages,
        temperature: request.temperature,
      });

      const cached = await cache.get<ChatResponse>(key);
      if (cached) return cached;

      const response = await provider.chat(request);
      await cache.set(key, response, opts?.ttlMs);
      return response;
    },
  };
}
