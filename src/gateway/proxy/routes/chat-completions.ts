/**
 * POST /v1/chat/completions — chat completion with provider fallback.
 *
 * When Groq returns 429, transparently falls back to Fireworks → Ollama.
 * The client never sees a 429 — the gateway absorbs rate limits internally.
 */

import type { LLMProvider, ChatMessage, ChatRequest, ChatResponse } from '../../providers/cloud/types';
import type { ResponseCache } from '../../../caching/response-cache';
import type { GatewayHooks } from '../../../hooks';
import { createLogger } from '../../../logger';

const log = createLogger('chat-completions');
import { emitHook } from '../../../hooks';
import type { ProxyRequest, ProxyResponse, ChatFallbackEntry, ChatDynamicRoute, RouteTarget } from '../types';
import { CooldownTracker } from '../../providers/cloud/fallback';
import type { CircuitBreakerRegistry } from '../../providers/cloud/circuit-breaker';
import {
  describeFailure, errorResponse, failureCode, isClientErrorStatus, originHeaders, proxyCircuitBreakers, ProviderUnavailableError, providerUnavailableResponse,
  redactSecrets, runTargets, selectTargets,
} from '../provider-routing';
import { RequestCoalescer } from '../middleware/request-coalescer';
import { ProviderSemaphores } from '../middleware/semaphore';
import type { GuardrailEngine } from '../../guardrails';

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
  guardrails?: GuardrailEngine,
  dynamicRoutes?: ChatDynamicRoute[],
  routing: ChatRoutingOptions = {},
): Promise<ProxyResponse> {
  const breakers = routing.circuitBreakers ?? proxyCircuitBreakers;
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
    if (!msg || typeof msg !== 'object' || typeof msg.role !== 'string') {
      return { status: 400, body: { error: { message: `messages[${i}] must have a string role`, type: 'invalid_request_error' } } };
    }
    // Content may be a plain string OR an array of parts (OpenAI multimodal
    // format: { type: 'text' | 'image_url', ... }). Anything else is invalid.
    const validString = typeof msg.content === 'string';
    const validArray = Array.isArray(msg.content) && msg.content.every((p: unknown) =>
      p !== null && typeof p === 'object' && typeof (p as { type?: unknown }).type === 'string'
    );
    if (!validString && !validArray) {
      return { status: 400, body: { error: { message: `messages[${i}].content must be a string or an array of content parts`, type: 'invalid_request_error' } } };
    }
  }
  if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
    return { status: 400, body: { error: { message: 'temperature must be between 0 and 2', type: 'invalid_request_error' } } };
  }
  if (max_tokens !== undefined && (max_tokens < 1 || max_tokens > 128000)) {
    return { status: 400, body: { error: { message: 'max_tokens must be between 1 and 128000', type: 'invalid_request_error' } } };
  }
  const requestTimeoutMs = messagesContainImage(messages as unknown[]) ? 90_000 : 15_000;

  // ── beforeRequest guardrails ───────────────────────────────────────────────
  if (guardrails) {
    const gr = await guardrails.runBeforeRequest(body, model);
    if (!gr.pass) {
      if (guardrails.action === 'block') {
        return {
          status: 400,
          body: { error: { message: gr.reason ?? 'Request blocked by guardrail', type: 'invalid_request_error' } },
        };
      }
      // audit — log and continue
      log.warn({ rule: gr.failedRule, reason: gr.reason, model }, 'guardrail audit (beforeRequest)');
    }
  }

  // Ordered provider chain for this model; providers without a key or with an open circuit are left out.
  const candidates = buildChain(model, chatProviders, fallbackChain, dynamicRoutes, routing.chatRoutes);
  if (candidates.length === 0) {
    const reasons = routing.unavailable?.[model];
    if (reasons) return providerUnavailableResponse('chat', model, reasons);
    return { status: 404, body: { error: { message: `Model "${model}" not found`, type: 'invalid_request_error' } } };
  }
  const candidateTargets = candidates.map(toTarget);
  const { usable, skipped, codes: skippedCodes } = selectTargets(candidateTargets, breakers);
  if (usable.length === 0) return providerUnavailableResponse('chat', model, skipped);
  const chain = usable.map(t => ({ provider: t.providerId, model: t.model ?? model, instance: t.provider }));

  const startTs = Date.now();
  const primaryProvider = chain[0].provider;
  const primaryModel = chain[0].model;

  const chatOpts: ChatRequest = {
    model: primaryModel,
    messages: messages as ChatMessage[],
    temperature,
    maxTokens: max_tokens,
    responseFormat: response_format as { type: 'json_object' | 'text' } | undefined,
    timeoutMs: requestTimeoutMs,
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
    const completionId = `chatcmpl-${Date.now()}`;
    const includeUsage = stream_options !== undefined && (stream_options as Record<string, unknown>).include_usage === true;
    let opened: OpenedStream;
    try {
      opened = await openStream(chain, chatOpts, breakers);
    } catch (err) {
      log.error(`All providers failed (stream) for model ${model}: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
      return errorResponse(withSkipped(err, skipped), 'chat', model);
    }
    const stream = buildSSEStream(opened, completionId, includeUsage, (latencyMs, success, error) => {
      emitHook(hooks, 'onRequestEnd', {
        userId: 'proxy',
        stage: 'llm',
        provider: opened.entry.provider,
        model: opened.entry.model,
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
        ...originHeaders(candidateTargets, toTarget(opened.entry), new Map([...skippedCodes, ...opened.codes])),
      },
      body: null,
      stream,
    };
  }

  // ── Non-streaming path ─────────────────────────────────────────────────────
  try {
    // Build cache key once (reused for get and set)
    const isDeterministic = temperature === undefined || temperature === 0;
    let cacheKey: string | null = null;
    if (cache && isDeterministic) {
      cacheKey = cache.buildKey({
        provider: primaryProvider,
        model: primaryModel,
        messages: messages as ChatMessage[],
        temperature,
      });
    }

    // Check cache
    if (cache && cacheKey) {
      const cached = await cache.get<{ content: string; model: string; usage?: unknown }>(cacheKey);
      if (cached) {
        return {
          status: 200,
          body: formatResponse(cached.content, cached.model, cached.usage),
        };
      }
    }

    // Request coalescing key (deduplicates identical in-flight requests).
    // Pass every output-affecting field — coalescing on partial keys would
    // serve req-A's response to req-B when only e.g. tools or response_format
    // differ.
    const coalescingKey = coalescer.buildKey({
      provider: primaryProvider,
      model: primaryModel,
      messages: messages as ChatMessage[],
      temperature,
      tools: (body as Record<string, unknown>).tools,
      response_format,
      max_tokens,
      top_p: typeof (body as Record<string, unknown>).top_p === 'number' ? (body as Record<string, unknown>).top_p as number : undefined,
      seed: typeof (body as Record<string, unknown>).seed === 'number' ? (body as Record<string, unknown>).seed as number : undefined,
      stop: (body as Record<string, unknown>).stop,
    });

    // Execute with coalescing + per-provider semaphore
    const { result, target: usedTarget, codes } = await coalescer.execute(
      coalescingKey,
      () => providerSemaphores.withLimit(primaryProvider, () =>
        runTargets(
          usable,
          // Each target carries its own upstream model — the same gateway model has different ids per provider.
          (t) => t.provider.chat({ ...chatOpts, model: t.model ?? model }),
          { stage: 'llm', timeoutMs: requestTimeoutMs, retriesPerProvider: 1, cooldownTracker: routing.cooldownTracker ?? llmCooldownTracker, breakers },
        ),
      ),
    );
    const usedProvider = usedTarget.providerId;
    const usedModel = usedTarget.model;

    // ── afterResponse guardrails ─────────────────────────────────────────────
    if (guardrails) {
      const responseBody = formatResponse(result.content, result.model, result.usage);
      const gr = await guardrails.runAfterResponse(responseBody, result.model || model);
      if (!gr.pass) {
        if (guardrails.action === 'block') {
          return {
            status: 400,
            body: { error: { message: gr.reason ?? 'Response blocked by guardrail', type: 'invalid_request_error' } },
          };
        }
        log.warn({ rule: gr.failedRule, reason: gr.reason, model }, 'guardrail audit (afterResponse)');
      }
    }

    // Store in cache (key already computed above)
    if (cache && cacheKey) {
      await cache.set(cacheKey, result);
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
      headers: {
        'X-Upstream-Duration-Ms': String(upstreamMs),
        ...originHeaders(candidateTargets, usedTarget, new Map([...skippedCodes, ...codes])),
      },
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
      error: err instanceof Error ? redactSecrets(err.message) : 'Internal error',
      timestamp: Date.now(),
    });

    log.error(`All providers failed for model ${model}: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
    return errorResponse(withSkipped(err, skipped), 'chat', model);
  }
}

/** Adds the providers skipped up front (no key, open circuit) to a "nobody answered" error. */
function withSkipped(err: unknown, skipped: string[]): unknown {
  return err instanceof ProviderUnavailableError && skipped.length
    ? new ProviderUnavailableError([...skipped, ...err.reasons], err.retryAfterSec) : err;
}

function messagesContainImage(messages: unknown[]): boolean {
  return messages.some((message) => {
    const content = (message as { content?: unknown } | null)?.content;
    return Array.isArray(content) && content.some((part) => (
      (part as { type?: unknown } | null)?.type === 'image_url'
    ));
  });
}

export interface ChatRoutingOptions {
  /** Per-model ordered provider lists (see `ProviderMapping.chatRoutes`). */
  chatRoutes?: Record<string, Array<RouteTarget<LLMProvider>>>;
  /** Known models with no configured provider → reasons for the 503. */
  unavailable?: Record<string, string[]>;
  /** Inject for tests. Default: the registry shared by every proxy route. */
  circuitBreakers?: CircuitBreakerRegistry;
  /** Inject for tests. Default: the chat route's own tracker. */
  cooldownTracker?: CooldownTracker;
}

interface ChainEntry { provider: string; model: string; instance: LLMProvider }

function toTarget(e: ChainEntry): RouteTarget<LLMProvider> {
  return { providerId: e.provider, provider: e.instance, model: e.model };
}

/**
 * Build the candidate chain for a model: its own providers first, then the generic fallbacks.
 *
 * 1. `chatRoutes[model]` (ordered, e.g. deployment → openrouter → groq), else `chat[model]`, else the first dynamic
 *    route that accepts the id (OpenRouter passthrough for `org/model`).
 * 2. `fallbackChain` is appended ONLY when step 1 found something. An unknown model (e.g. gpt-4o on a gateway
 *    without OpenAI) gets an empty chain → 404, never a silent substitution.
 *
 * Entries are deduplicated by provider + model, so the same provider can appear twice with different models
 * (e.g. OpenRouter for the exact model, then OpenRouter for a generic fallback). Key/circuit filtering happens in
 * `selectTargets`, so the caller can tell "unknown model" (404) from "no provider available" (503).
 */
function buildChain(
  requestedModel: string,
  chatProviders: Record<string, LLMProvider>,
  fallbackChain?: ChatFallbackEntry[],
  dynamicRoutes?: ChatDynamicRoute[],
  chatRoutes?: Record<string, Array<RouteTarget<LLMProvider>>>,
): ChainEntry[] {
  const chain: ChainEntry[] = [];
  const seen = new Set<string>();
  const push = (provider: string, model: string, instance: LLMProvider) => {
    const key = `${provider}\u0000${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    chain.push({ provider, model, instance });
  };

  const routed = chatRoutes?.[requestedModel];
  const direct = chatProviders[requestedModel];
  if (routed?.length) {
    for (const t of routed) push(t.providerId, t.model ?? requestedModel, t.provider);
  } else if (direct) {
    push(direct.providerId, requestedModel, direct);
  } else {
    const route = (dynamicRoutes ?? []).find(r => r.acceptsModel(requestedModel));
    if (route) push(route.providerId, route.upstreamModel?.(requestedModel) ?? requestedModel, route.provider);
  }
  if (chain.length === 0) return chain;

  for (const entry of fallbackChain ?? []) push(entry.providerId, entry.model, entry.provider);
  return chain;
}

const STREAM_TIMEOUT_MS = 30_000;

/** The provider that will serve a stream, with its first step already received. */
interface OpenedStream {
  entry: ChainEntry;
  /** Streaming provider: the generator and its first step. */
  gen?: AsyncGenerator<string, void, undefined>;
  first?: IteratorResult<string, void>;
  /** Provider without chatStream: its whole answer. */
  full?: ChatResponse;
  codes: Map<string, string>;
}

function withStreamTimeout<T>(p: Promise<T>): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error('Streaming timeout')), STREAM_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(t));
}

/**
 * Picks the provider that serves a stream: walks the chain until one yields its first step (or, without chatStream,
 * its full answer). A provider failing before its first token (cold replica, 401, 429, timeout…) is skipped, so the
 * response headers can already say who answers. Throws `ProviderUnavailableError` when none does, or a client error.
 */
async function openStream(entries: ChainEntry[], opts: ChatRequest, breakers: CircuitBreakerRegistry): Promise<OpenedStream> {
  const failures: string[] = [];
  const codes = new Map<string, string>();
  for (const entry of entries) {
    const breaker = breakers.get(entry.provider);
    const request = { ...opts, model: entry.model };
    try {
      if (!entry.instance.chatStream) {
        const full = await withStreamTimeout(entry.instance.chat(request));
        breaker.recordSuccess();
        return { entry, full, codes };
      }
      const gen = entry.instance.chatStream(request);
      try {
        const first = await withStreamTimeout(gen.next());
        breaker.recordSuccess();
        return { entry, gen, first, codes };
      } catch (err) {
        try { void gen.return?.(undefined); } catch { /* no-op */ }
        throw err;
      }
    } catch (err) {
      const status = (err as { status?: unknown })?.status;
      if (isClientErrorStatus(typeof status === 'number' ? status : null)) throw err;
      breaker.recordFailure();
      failures.push(describeFailure(entry.provider, err));
      codes.set(entry.provider, failureCode(err));
      log.warn(`stream: ${describeFailure(entry.provider, err)} → next provider`);
    }
  }
  throw new ProviderUnavailableError(failures);
}

/**
 * Turns an opened stream into a ReadableStream of SSE-encoded chunks compatible with the OpenAI streaming format.
 * Once a token was sent, an error ends the stream with an error event (switching provider mid-answer would splice
 * two different answers). Enforces a 30-second silence timeout to prevent hung connections.
 */
function buildSSEStream(
  opened: OpenedStream,
  id: string,
  includeUsage: boolean,
  onEnd?: (latencyMs: number, success: boolean, error?: string) => void,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const sse = (data: unknown) => enc.encode(`data: ${JSON.stringify(data)}\n\n`);
  const created = Math.floor(Date.now() / 1000);
  const startMs = Date.now();
  const model = opened.entry.model;

  // Track the active generator from outside `start()` so cancel() (fired when the consumer disconnects) can stop
  // it. Without this, a client that drops mid-stream leaves the upstream generator running and the gateway keeps
  // consuming (and billing) tokens until the 30s silence timeout fires.
  let activeGen: AsyncGenerator<string, void, undefined> | null = opened.gen ?? null;
  let ended = false;
  const finish = (success: boolean, errorMsg?: string) => {
    if (ended) return;
    ended = true;
    onEnd?.(Date.now() - startMs, success, errorMsg);
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (opened.full) {
          // Provider doesn't support streaming — emit full response as one chunk
          const res = opened.full;
          controller.enqueue(sse({ id, object: 'chat.completion.chunk', created, model: res.model || model,
            choices: [{ index: 0, delta: { role: 'assistant', content: res.content }, finish_reason: 'stop' }] }));
          if (includeUsage && res.usage) {
            controller.enqueue(sse({ id, object: 'chat.completion.chunk', created, model: res.model || model,
              choices: [], usage: { prompt_tokens: res.usage.promptTokens, completion_tokens: res.usage.completionTokens, total_tokens: res.usage.totalTokens } }));
          }
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
          finish(true);
          return;
        }

        // Usage data from the __usage__: sentinel emitted by the provider's chatStream(), sent as the last chunk
        // before [DONE] when the client requested stream_options.include_usage.
        let usageData: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;

        // Role delta (first chunk)
        controller.enqueue(sse({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }));

        let step = opened.first!;
        while (!step.done) {
          const value = step.value;
          if (typeof value === 'string' && value.startsWith('__usage__:')) {
            try { usageData = JSON.parse(value.slice('__usage__:'.length)); } catch { /* malformed — skip */ }
          } else {
            controller.enqueue(sse({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { content: value }, finish_reason: null }] }));
          }
          if (!activeGen) return; // consumer disconnected
          step = await withStreamTimeout(activeGen.next());
        }

        // Finish chunk, then usage (OpenAI spec for stream_options.include_usage), then [DONE]
        controller.enqueue(sse({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
        if (includeUsage && usageData) {
          controller.enqueue(sse({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageData }));
        }
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
        finish(true);
      } catch (err) {
        const msg = redactSecrets(err instanceof Error ? err.message : 'Streaming error');
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: msg, type: 'server_error' } })}\n\n`));
          controller.close();
        } catch { /* stream already cancelled */ }
        finish(false, msg);
      } finally {
        activeGen = null;
      }
    },
    cancel() {
      // Consumer disconnected. Stop the upstream generator so we stop consuming (and billing) tokens.
      if (activeGen) {
        try { void activeGen.return?.(undefined); } catch { /* no-op */ }
        activeGen = null;
      }
      finish(false, 'client_disconnected');
    },
  });
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
