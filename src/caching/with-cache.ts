/**
 * withCache — wrapper that checks cache before calling the underlying LLM provider.
 */

import type { LLMProvider, ChatRequest, ChatResponse } from '../providers/types';
import type { ResponseCache } from './response-cache';

export interface WithCacheOptions {
  ttlMs?: number;
  /** Only cache if condition returns true. Default: cache when temperature is 0 or undefined. */
  condition?: (req: ChatRequest) => boolean;
  /** Logger for cache errors */
  logger?: { log?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
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
  const log = opts?.logger ?? { log: () => {}, warn: () => {} };

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
        maxTokens: request.maxTokens,
        topP: request.topP,
        seed: request.seed,
        tools: request.tools,
        responseFormat: request.responseFormat,
        stop: request.stop,
      });

      try {
        const cached = await cache.get<ChatResponse>(key);
        if (cached) return cached;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn?.(`[withCache] cache.get failed: ${msg}`);
      }

      const response = await provider.chat(request);
      // Never cache empty/refusal responses: a transient empty body would
      // otherwise be memoized and replayed for the full TTL, masking the issue
      // and starving the caller of a real answer on retry.
      if (response && typeof response.content === 'string' && response.content.trim() !== '') {
        try {
          await cache.set(key, response, opts?.ttlMs);
        } catch (setErr) {
          const msg = setErr instanceof Error ? setErr.message : String(setErr);
          log.warn?.(`[withCache] cache.set failed: ${msg}`);
        }
      }
      return response;
    },
  };
}
