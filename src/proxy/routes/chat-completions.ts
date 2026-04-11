/**
 * POST /v1/chat/completions — chat completion with provider fallback.
 *
 * When Groq returns 429, transparently falls back to Fireworks → Ollama.
 * The client never sees a 429 — the gateway absorbs rate limits internally.
 */

import type { LLMProvider, ChatMessage, ChatRequest } from '../../providers/types';
import type { ResponseCache } from '../../caching/response-cache';
import type { GatewayHooks } from '../../hooks';
import { emitHook } from '../../hooks';
import type { ProxyRequest, ProxyResponse, ChatFallbackEntry } from '../types';
import { withProviderFallback, type FallbackEntry, type FallbackOptions, CooldownTracker } from '../../providers/fallback';
import { RequestCoalescer } from '../middleware/request-coalescer';
import { ProviderSemaphores } from '../middleware/semaphore';

/** Shared cooldown tracker for LLM proxy route */
const llmCooldownTracker = new CooldownTracker();
/** Deduplicates identical in-flight requests */
const coalescer = new RequestCoalescer();
/** Limits concurrent calls per upstream provider */
const providerSemaphores = new ProviderSemaphores(150);

export async function handleChatCompletions(
  req: ProxyRequest,
  chatProviders: Record<string, LLMProvider>,
  cache?: ResponseCache,
  hooks?: GatewayHooks,
  fallbackChain?: ChatFallbackEntry[],
): Promise<ProxyResponse> {
  const body = req.body as {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
    response_format?: { type: 'json_object' | 'text' };
  };

  if (!body.model || typeof body.model !== 'string') {
    return { status: 400, body: { error: { message: 'model is required', type: 'invalid_request_error' } } };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { status: 400, body: { error: { message: 'messages array is required', type: 'invalid_request_error' } } };
  }
  if (body.temperature !== undefined && (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 2)) {
    return { status: 400, body: { error: { message: 'temperature must be between 0 and 2', type: 'invalid_request_error' } } };
  }
  if (body.max_tokens !== undefined && (typeof body.max_tokens !== 'number' || body.max_tokens < 1 || body.max_tokens > 128000)) {
    return { status: 400, body: { error: { message: 'max_tokens must be between 1 and 128000', type: 'invalid_request_error' } } };
  }

  // Build fallback chain: use the configured chain, or fall back to single-provider lookup
  const chain = buildChain(body.model, chatProviders, fallbackChain);
  if (chain.length === 0) {
    return { status: 404, body: { error: { message: `Model "${body.model}" not found`, type: 'invalid_request_error' } } };
  }

  const startTs = Date.now();
  const primaryProvider = chain[0].provider;
  const primaryModel = chain[0].model;

  const chatOpts: ChatRequest = {
    model: primaryModel,
    messages: body.messages,
    temperature: body.temperature,
    maxTokens: body.max_tokens,
    responseFormat: body.response_format,
  };

  emitHook(hooks, 'onRequestStart', {
    userId: 'proxy',
    stage: 'llm',
    provider: primaryProvider,
    model: primaryModel,
    timestamp: startTs,
  });

  // ── Streaming path ─────────────────────────────────────────────────────────
  if (body.stream) {
    const instance = chain[0].instance;
    const completionId = `chatcmpl-${Date.now()}`;
    const stream = buildSSEStream(instance, chatOpts, primaryModel, completionId);
    return {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
      body: null,
      stream,
    };
  }

  // ── Non-streaming path ─────────────────────────────────────────────────────
  try {
    // Build cache key once (reused for get and set)
    const isDeterministic = body.temperature === undefined || body.temperature === 0;
    const cacheKey = cache && isDeterministic ? cache.buildKey({
      provider: primaryProvider,
      model: primaryModel,
      messages: body.messages,
      temperature: body.temperature,
    }) : null;

    // Check cache
    if (cacheKey) {
      const cached = await cache!.get<{ content: string; model: string; usage?: unknown }>(cacheKey);
      if (cached) {
        return {
          status: 200,
          body: formatResponse(cached.content, cached.model, cached.usage),
        };
      }
    }

    // Build fallback entries for withProviderFallback
    const fallbackEntries: FallbackEntry[] = chain.map(e => ({
      provider: e.provider,
      model: e.model,
    }));

    const opts: FallbackOptions = {
      logPrefix: process.env.NODE_ENV === 'production' ? '' : '[proxy:llm]',
      timeoutMs: 15_000,
      retriesPerProvider: 1,
      retryBaseDelayMs: 200,
      cooldownTracker: llmCooldownTracker,
    };

    // Map from FallbackEntry to the actual provider instance for each attempt
    const providerMap = new Map<string, LLMProvider>();
    for (const entry of chain) {
      providerMap.set(entry.provider, entry.instance);
    }

    // Request coalescing key (deduplicates identical in-flight requests)
    const coalescingKey = coalescer.buildKey({
      provider: primaryProvider,
      model: primaryModel,
      messages: body.messages,
      temperature: body.temperature,
    });

    // Execute with coalescing + per-provider semaphore
    const { result, usedProvider, usedModel } = await coalescer.execute(
      coalescingKey,
      () => providerSemaphores.withLimit(primaryProvider, () =>
        withProviderFallback(
          fallbackEntries,
          async (entry) => {
            const instance = providerMap.get(entry.provider);
            if (!instance) throw new Error(`Provider ${entry.provider} not found`);
            // Use each entry's own model — allows transparent fallback to a different model
            return instance.chat({ ...chatOpts, model: entry.model });
          },
          opts,
        ),
      ),
    );

    // Store in cache (key already computed above)
    if (cacheKey) {
      await cache!.set(cacheKey, result);
    }

    emitHook(hooks, 'onRequestEnd', {
      userId: 'proxy',
      stage: 'llm',
      provider: usedProvider,
      model: usedModel || body.model,
      latencyMs: Date.now() - startTs,
      success: true,
      timestamp: Date.now(),
    });

    return {
      status: 200,
      body: formatResponse(result.content, result.model, result.usage),
    };
  } catch (err) {
    emitHook(hooks, 'onRequestEnd', {
      userId: 'proxy',
      stage: 'llm',
      provider: primaryProvider,
      model: body.model,
      latencyMs: Date.now() - startTs,
      success: false,
      error: err instanceof Error ? err.message.replace(/https?:\/\/[^\s]+/g, '[redacted-url]') : 'Internal error',
      timestamp: Date.now(),
    });

    const status = extractStatus(err);
    console.error(`[chat-completions] All providers failed for model ${body.model}:`, err);
    return {
      status: status || 500,
      body: { error: { message: 'Chat completion failed', type: 'server_error' } },
    };
  }
}

/** Build a provider chain: requested model first, then fallbacks with compatible models. */
function buildChain(
  requestedModel: string,
  chatProviders: Record<string, LLMProvider>,
  fallbackChain?: ChatFallbackEntry[],
): Array<{ provider: string; model: string; instance: LLMProvider }> {
  const chain: Array<{ provider: string; model: string; instance: LLMProvider }> = [];
  const seen = new Set<string>();

  // 1. Try the exact requested model first (direct lookup)
  const direct = chatProviders[requestedModel];
  if (direct) {
    const pid = direct.providerId;
    chain.push({ provider: pid, model: requestedModel, instance: direct });
    seen.add(pid);
  }

  // 2. Append fallback providers (different providers with their own models)
  if (fallbackChain) {
    for (const entry of fallbackChain) {
      if (!seen.has(entry.providerId)) {
        chain.push({ provider: entry.providerId, model: entry.model, instance: entry.provider });
        seen.add(entry.providerId);
      }
    }
  }

  return chain;
}

/**
 * Wraps a provider's chatStream() generator into a ReadableStream of SSE-encoded
 * Uint8Array chunks compatible with the OpenAI streaming format.
 * Falls back to a single non-streaming call if chatStream is not supported.
 */
function buildSSEStream(
  provider: LLMProvider,
  opts: ChatRequest,
  model: string,
  id: string,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const sse = (data: unknown) => enc.encode(`data: ${JSON.stringify(data)}\n\n`);
  const created = Math.floor(Date.now() / 1000);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (!provider.chatStream) {
          // Provider doesn't support streaming — emit full response as one chunk
          const res = await provider.chat(opts);
          controller.enqueue(sse({ id, object: 'chat.completion.chunk', created, model: res.model || model,
            choices: [{ index: 0, delta: { role: 'assistant', content: res.content }, finish_reason: 'stop' }] }));
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }

        // Role delta (first chunk)
        controller.enqueue(sse({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }));

        // Content delta chunks
        for await (const token of provider.chatStream(opts)) {
          controller.enqueue(sse({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { content: token }, finish_reason: null }] }));
        }

        // Finish chunk
        controller.enqueue(sse({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Streaming error';
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: msg, type: 'server_error' } })}\n\n`));
        controller.close();
      }
    },
  });
}

function extractStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;
  if (typeof e.status === 'number') return e.status;
  return null;
}

function formatResponse(content: string, model: string, usage?: unknown) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
