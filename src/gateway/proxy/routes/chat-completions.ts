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
  describeFailure, errorResponse, failureCode, type FailureCodes, isClientErrorStatus, originHeaders, proxyCircuitBreakers, ProviderUnavailableError, providerUnavailableResponse,
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
  const candidateTargets = candidates;
  const { usable, skipped: skippedNow, codes: skippedCodes } = selectTargets(candidateTargets, breakers);
  // Entries that were never mounted (e.g. OpenRouter without key) belong in the 503 explanation too.
  const skipped = [...skippedNow, ...(routing.unavailable?.[model] ?? []).filter(r => !skippedNow.includes(r))];
  if (usable.length === 0) return providerUnavailableResponse('chat', model, skipped);

  const startTs = Date.now();
  const primaryProvider = usable[0].providerId;
  const primaryModel = usable[0].model ?? model;

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
      opened = await openStream(usable, chatOpts, breakers);
    } catch (err) {
      log.error(`All providers failed (stream) for model ${model}: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
      return errorResponse(withSkipped(err, skipped), 'chat', model);
    }
    const stream = buildSSEStream(opened, completionId, includeUsage, (latencyMs, success, error) => {
      emitHook(hooks, 'onRequestEnd', {
        userId: 'proxy',
        stage: 'llm',
        provider: opened.target.providerId,
        model: opened.target.model ?? model,
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
        ...originHeaders(candidateTargets, opened.target, new Map([...skippedCodes, ...opened.codes])),
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
      const cached = await cache.get<{ content: string; model: string; usage?: unknown; finishReason?: string }>(cacheKey);
      if (cached) {
        return {
          status: 200,
          body: formatResponse(cached.content, cached.model, cached.usage, cached.finishReason),
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
          (t, signal) => t.provider.chat({ ...chatOpts, model: t.model ?? model, signal, ...(t.extraBody ? { extraBody: t.extraBody } : {}) }),
          {
            stage: 'llm', timeoutMs: requestTimeoutMs, retriesPerProvider: 1,
            cooldownTracker: routing.cooldownTracker ?? llmCooldownTracker, breakers,
            // An empty answer (e.g. a reasoning model that spent max_tokens thinking) is a failure: try the next one.
            validate: (r) => (emptyAnswer(r as ChatResponse) ? `empty answer (finish_reason: ${(r as ChatResponse).finishReason ?? 'unknown'})` : null),
          },
        ),
      ),
    );
    const usedProvider = usedTarget.providerId;
    const usedModel = usedTarget.model;

    // ── afterResponse guardrails ─────────────────────────────────────────────
    if (guardrails) {
      const responseBody = formatResponse(result.content, result.model, result.usage, result.finishReason);
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
      body: formatResponse(result.content, result.model, result.usage, result.finishReason),
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
    ? new ProviderUnavailableError([...err.reasons, ...skipped], err.retryAfterSec) : err;
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
): Array<RouteTarget<LLMProvider>> {
  const chain: Array<RouteTarget<LLMProvider>> = [];
  const seen = new Set<string>();
  const push = (providerId: string, model: string, provider: LLMProvider, extra?: Partial<RouteTarget<LLMProvider>>) => {
    const key = `${providerId}\u0000${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    chain.push({ ...extra, providerId, model, provider });
  };

  const routed = chatRoutes?.[requestedModel];
  const direct = chatProviders[requestedModel];
  if (routed?.length) {
    for (const t of routed) push(t.providerId, t.model ?? requestedModel, t.provider, t);
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

/** The provider that will serve a stream, with its first content step already received. */
interface OpenedStream {
  target: RouteTarget<LLMProvider>;
  /** Streaming provider: the generator, its first content step, and sentinels read before it. */
  gen?: AsyncGenerator<string, void, undefined>;
  first?: IteratorResult<string, void>;
  prefetched?: string[];
  /** Provider without chatStream: its whole answer. */
  full?: ChatResponse;
  codes: FailureCodes;
}

function withStreamTimeout<T>(p: Promise<T>, ms = STREAM_TIMEOUT_MS, onTimeout?: () => void): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => {
        onTimeout?.();
        reject(Object.assign(new Error(`Streaming timeout after ${ms}ms`), { gatewayCode: 'timeout' }));
      }, ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/**
 * Picks the provider that serves a stream: walks the chain until one yields its first content (or, without
 * chatStream, a non-empty full answer). A provider failing before that (cold replica, 401, 429, timeout, empty
 * answer…) is skipped and its call aborted, so the response headers can already say who answers. Throws
 * `ProviderUnavailableError` when none does, or a client error.
 */
async function openStream(targets: Array<RouteTarget<LLMProvider>>, opts: ChatRequest, breakers: CircuitBreakerRegistry): Promise<OpenedStream> {
  const failures: string[] = [];
  const codes: FailureCodes = new Map();
  for (const target of targets) {
    const breaker = breakers.get(target.providerId);
    const abort = new AbortController();
    const request: ChatRequest = { ...opts, model: target.model ?? opts.model, signal: abort.signal, ...(target.extraBody ? { extraBody: target.extraBody } : {}) };
    const firstWaitMs = target.timeoutMs ?? STREAM_TIMEOUT_MS;
    try {
      if (!target.provider.chatStream) {
        const full = await withStreamTimeout(target.provider.chat(request), firstWaitMs, () => abort.abort());
        if (emptyAnswer(full)) throw Object.assign(new Error(`empty answer (finish_reason: ${full.finishReason ?? 'unknown'})`), { gatewayCode: 'empty' });
        breaker.recordSuccess();
        return { target, full, codes };
      }
      const gen = target.provider.chatStream(request);
      try {
        const prefetched: string[] = [];
        for (;;) {
          const step = await withStreamTimeout(gen.next(), firstWaitMs, () => abort.abort());
          if (step.done) throw Object.assign(new Error('empty answer (stream ended without content)'), { gatewayCode: 'empty' });
          if (typeof step.value === 'string' && step.value.startsWith('__usage__:')) { prefetched.push(step.value); continue; }
          breaker.recordSuccess();
          return { target, gen, first: step, prefetched, codes };
        }
      } catch (err) {
        try { void gen.return?.(undefined); } catch { /* no-op */ }
        throw err;
      }
    } catch (err) {
      abort.abort();
      const status = (err as { status?: unknown })?.status;
      if (isClientErrorStatus(typeof status === 'number' ? status : null)) throw err;
      breaker.recordFailure();
      failures.push(describeFailure(target.providerId, err));
      codes.set(target, failureCode(err));
      log.warn(`stream: ${describeFailure(target.providerId, err)} → next provider`);
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
  const model = opened.target.model ?? 'unknown';

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
            choices: [{ index: 0, delta: { role: 'assistant', content: res.content }, finish_reason: res.finishReason ?? 'stop' }] }));
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

        for (const v of opened.prefetched ?? []) {
          try { usageData = JSON.parse(v.slice('__usage__:'.length)); } catch { /* malformed — skip */ }
        }
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

/** No text at all — a provider that answered nothing has failed this request. */
function emptyAnswer(r: ChatResponse): boolean {
  return !r.content || !r.content.trim();
}

function formatResponse(content: string, model: string, usage?: unknown, finishReason?: string) {
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
      // The upstream value is passed through (a 'length' must not become 'stop').
      finish_reason: finishReason ?? 'stop',
    }],
    usage: {
      prompt_tokens: u?.promptTokens ?? 0,
      completion_tokens: u?.completionTokens ?? 0,
      total_tokens: u?.totalTokens ?? 0,
    },
  };
}
