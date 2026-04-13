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
  if (!req.body || typeof req.body !== 'object') {
    return { status: 400, body: { error: { message: 'request body is required', type: 'invalid_request_error' } } };
  }
  const body = req.body as Record<string, unknown>;
  const model = typeof body.model === 'string' ? body.model : null;
  const messages = Array.isArray(body.messages) ? body.messages : null;
  const temperature = typeof body.temperature === 'number' && !Number.isNaN(body.temperature) ? body.temperature : undefined;
  const max_tokens = typeof body.max_tokens === 'number' && !Number.isNaN(body.max_tokens) ? body.max_tokens : undefined;
  const stream = body.stream === true;
  const response_format = typeof body.response_format === 'object' && body.response_format !== null ? body.response_format : undefined;
  const stream_options = typeof body.stream_options === 'object' && body.stream_options !== null ? body.stream_options : undefined;

  if (!model) {
    return { status: 400, body: { error: { message: 'model is required', type: 'invalid_request_error' } } };
  }
  if (!messages || messages.length === 0) {
    return { status: 400, body: { error: { message: 'messages array is required', type: 'invalid_request_error' } } };
  }
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object' || typeof msg.role !== 'string' || typeof msg.content !== 'string') {
      return { status: 400, body: { error: { message: `messages[${i}] must have non-empty string role and content`, type: 'invalid_request_error' } } };
    }
  }
  if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
    return { status: 400, body: { error: { message: 'temperature must be between 0 and 2', type: 'invalid_request_error' } } };
  }
  if (max_tokens !== undefined && (max_tokens < 1 || max_tokens > 128000)) {
    return { status: 400, body: { error: { message: 'max_tokens must be between 1 and 128000', type: 'invalid_request_error' } } };
  }

  // Build fallback chain: use the configured chain, or fall back to single-provider lookup
  const chain = buildChain(model, chatProviders, fallbackChain);
  if (chain.length === 0) {
    return { status: 404, body: { error: { message: `Model "${model}" not found`, type: 'invalid_request_error' } } };
  }

  const startTs = Date.now();
  const primaryProvider = chain[0].provider;
  const primaryModel = chain[0].model;

  const chatOpts: ChatRequest = {
    model: primaryModel,
    messages: messages as ChatMessage[],
    temperature,
    maxTokens: max_tokens,
    responseFormat: response_format as { type: 'json_object' | 'text' } | undefined,
  };

  emitHook(hooks, 'onRequestStart', {
    userId: 'proxy',
    stage: 'llm',
    provider: primaryProvider,
    model: primaryModel,
    timestamp: startTs,
  });

  // ── Streaming path ─────────────────────────────────────────────────────────
  if (stream) {
    const instance = chain[0].instance;
    const completionId = `chatcmpl-${Date.now()}`;
    const includeUsage = stream_options && typeof stream_options === 'object' && 'include_usage' in stream_options && stream_options.include_usage === true;
    const stream = buildSSEStream(instance, chatOpts, primaryModel, completionId, includeUsage, (latencyMs, success, error) => {
      emitHook(hooks, 'onRequestEnd', {
        userId: 'proxy',
        stage: 'llm',
        provider: primaryProvider,
        model: primaryModel,
        latencyMs,
        success,
        ...(error ? { error } : {}),
        timestamp: Date.now(),
      });
    });
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
    const isDeterministic = temperature === undefined || temperature === 0;
    const cacheKey = cache && isDeterministic ? cache.buildKey({
      provider: primaryProvider,
      model: primaryModel,
      messages: messages as ChatMessage[],
      temperature,
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
      messages: messages as ChatMessage[],
      temperature,
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
            return instance.chat({ ...chatOpts, model: entry.model ?? chatOpts.model });
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
      model: usedModel || model,
      latencyMs: Date.now() - startTs,
      success: true,
      timestamp: Date.now(),
    });

    const upstreamMs = Date.now() - startTs;
    return {
      status: 200,
      headers: { 'X-Upstream-Duration-Ms': String(upstreamMs) },
      body: formatResponse(result.content, result.model, result.usage),
    };
  } catch (err) {
    emitHook(hooks, 'onRequestEnd', {
      userId: 'proxy',
      stage: 'llm',
      provider: primaryProvider,
      model: model,
      latencyMs: Date.now() - startTs,
      success: false,
      error: err instanceof Error ? err.message.replace(/https?:\/\/[^\s]+/g, '[redacted-url]') : 'Internal error',
      timestamp: Date.now(),
    });

    const status = extractStatus(err);
    console.error(`[chat-completions] All providers failed for model ${model}:`, err);
    // Propagate upstream Retry-After if the fallback chain captured one from a 429.
    const retryAfterSec = (err as { retryAfterSec?: number })?.retryAfterSec;
    const headers: Record<string, string> = {};
    if (retryAfterSec) headers['Retry-After'] = String(retryAfterSec);
    // Propagate the upstream provider's error message so clients can understand
    // what went wrong (e.g. "invalid role 'hacker'", "context length exceeded").
    // Redact URLs to avoid leaking internal endpoints.
    const errMsg = err instanceof Error
      ? err.message.replace(/https?:\/\/[^\s]+/g, '[url]').slice(0, 200)
      : 'Chat completion failed';
    return {
      status: status || 500,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: { error: { message: errMsg, type: status && status < 500 ? 'invalid_request_error' : 'server_error' } },
    };
  }
}

/**
 * Build a provider chain: requested model first, then fallbacks.
 *
 * IMPORTANT: the fallback chain is ONLY used when the requested model is
 * found in chatProviders. If the model doesn't exist (e.g. gpt-4o on a
 * gateway that only has Groq), the chain is empty and the caller returns
 * 404 "Model not found". This prevents silently substituting a cheap
 * open-source model when the client specifically requested a proprietary
 * one — the client should know and decide, not get a surprise.
 *
 * The fallback chain kicks in for the SAME model across providers: if the
 * client asks for llama-3.3-70b-versatile and Groq is down, the chain
 * tries the next provider that can serve that class of model.
 */
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

    // 2. Append fallback providers — ONLY when the primary model was found.
    // This ensures fallback is provider-level resilience (same model class,
    // different backend) not model substitution (gpt-4o → llama).
    if (fallbackChain) {
      for (const entry of fallbackChain) {
        if (!seen.has(entry.providerId)) {
          chain.push({ provider: entry.providerId, model: entry.model, instance: entry.provider });
          seen.add(entry.providerId);
        }
      }
    }
  }

  return chain;
}

const STREAM_TIMEOUT_MS = 30_000;

/**
 * Wraps a provider's chatStream() generator into a ReadableStream of SSE-encoded
 * Uint8Array chunks compatible with the OpenAI streaming format.
 * Falls back to a single non-streaming call if chatStream is not supported.
 * Enforces a 30-second timeout to prevent hung connections.
 */
function buildSSEStream(
  provider: LLMProvider,
  opts: ChatRequest,
  model: string,
  id: string,
  includeUsage: boolean,
  onEnd?: (latencyMs: number, success: boolean, error?: string) => void,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const sse = (data: unknown) => enc.encode(`data: ${JSON.stringify(data)}\n\n`);
  const created = Math.floor(Date.now() / 1000);
  const startMs = Date.now();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      // Races any async step against the 30s wall-clock timeout
      const withTimeout = <T>(p: Promise<T>): Promise<T> => {
        if (timeoutId) clearTimeout(timeoutId);
        return new Promise<T>((resolve, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Streaming timeout')), STREAM_TIMEOUT_MS);
          p.then(v => { clearTimeout(timeoutId!); resolve(v); },
                 e => { clearTimeout(timeoutId!); reject(e); });
        });
      };

      const finish = (success: boolean, errorMsg?: string) => {
        if (timeoutId) clearTimeout(timeoutId);
        onEnd?.(Date.now() - startMs, success, errorMsg);
      };

      // Usage data extracted from the __usage__: sentinel emitted by the
      // provider's chatStream(). Kept here so we can emit it as the last
      // chunk before [DONE] when the client requested stream_options.include_usage.
      let usageData: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;

      try {
        if (!provider.chatStream) {
          // Provider doesn't support streaming — emit full response as one chunk
          const res = await withTimeout(provider.chat(opts));
          controller.enqueue(sse({ id, object: 'chat.completion.chunk', created, model: res.model || model,
            choices: [{ index: 0, delta: { role: 'assistant', content: res.content }, finish_reason: 'stop' }] }));
          // Usage chunk for non-streaming fallback
          if (includeUsage && res.usage) {
            controller.enqueue(sse({ id, object: 'chat.completion.chunk', created, model: res.model || model,
              choices: [], usage: { prompt_tokens: res.usage.promptTokens, completion_tokens: res.usage.completionTokens, total_tokens: res.usage.totalTokens } }));
          }
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
          finish(true);
          return;
        }

        // Role delta (first chunk)
        controller.enqueue(sse({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }));

        // Content delta chunks — each next() is raced against the timeout
        const gen = provider.chatStream(opts);
        for (;;) {
          const { done, value } = await withTimeout(gen.next());
          if (done) break;
          // Detect the __usage__: sentinel from the provider. This is how
          // the upstream's usage data flows through the generator without
          // changing the AsyncGenerator<string> contract.
          if (typeof value === 'string' && value.startsWith('__usage__:')) {
            try { usageData = JSON.parse(value.slice('__usage__:'.length)); } catch { /* malformed — skip */ }
            continue;
          }
          controller.enqueue(sse({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { content: value }, finish_reason: null }] }));
        }

        // Finish chunk
        controller.enqueue(sse({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));

        // Usage chunk — emitted after the finish_reason:stop chunk, before
        // [DONE], matching the OpenAI spec for stream_options.include_usage.
        if (includeUsage && usageData) {
          controller.enqueue(sse({ id, object: 'chat.completion.chunk', created, model,
            choices: [], usage: usageData }));
        }

        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
        finish(true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Streaming error';
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: msg, type: 'server_error' } })}\n\n`));
        controller.close();
        finish(false, msg);
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
  // ChatResponse.usage uses camelCase internally; OpenAI wire format requires snake_case
  const u = usage as { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
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
    usage: {
      prompt_tokens: u?.promptTokens ?? 0,
      completion_tokens: u?.completionTokens ?? 0,
      total_tokens: u?.totalTokens ?? 0,
    },
  };
}
