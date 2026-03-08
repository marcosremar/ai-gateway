/**
 * POST /v1/chat/completions — chat completion (streaming & non-streaming).
 */

import type { LLMProvider, ChatMessage } from '../../providers/types';
import type { ResponseCache } from '../../caching/response-cache';
import type { GatewayHooks } from '../../hooks';
import { emitHook } from '../../hooks';
import type { ProxyRequest, ProxyResponse } from '../types';
import { withProxyRetry } from './retry';

export async function handleChatCompletions(
  req: ProxyRequest,
  chatProviders: Record<string, LLMProvider>,
  cache?: ResponseCache,
  hooks?: GatewayHooks,
): Promise<ProxyResponse> {
  const body = req.body as {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
    response_format?: { type: 'json_object' | 'text' };
  };

  if (!body.model) {
    return { status: 400, body: { error: { message: 'model is required', type: 'invalid_request_error' } } };
  }

  const provider = chatProviders[body.model];
  if (!provider) {
    return { status: 404, body: { error: { message: `Model "${body.model}" not found`, type: 'invalid_request_error' } } };
  }

  const startTs = Date.now();
  emitHook(hooks, 'onRequestStart', {
    userId: 'proxy',
    stage: 'llm',
    provider: provider.providerId,
    model: body.model,
    timestamp: startTs,
  });

  try {
    // Check cache
    if (cache && (body.temperature === undefined || body.temperature === 0)) {
      const key = cache.buildKey({
        provider: provider.providerId,
        model: body.model,
        messages: body.messages,
        temperature: body.temperature,
      });
      const cached = await cache.get<{ content: string; model: string; usage?: unknown }>(key);
      if (cached) {
        return {
          status: 200,
          body: formatResponse(cached.content, cached.model, cached.usage),
        };
      }
    }

    const result = await withProxyRetry(
      provider.providerId,
      body.model,
      () => provider.chat({
        model: body.model,
        messages: body.messages,
        temperature: body.temperature,
        maxTokens: body.max_tokens,
        responseFormat: body.response_format,
      }),
      'LLM',
    );

    // Store in cache
    if (cache && (body.temperature === undefined || body.temperature === 0)) {
      const key = cache.buildKey({
        provider: provider.providerId,
        model: body.model,
        messages: body.messages,
        temperature: body.temperature,
      });
      await cache.set(key, result);
    }

    emitHook(hooks, 'onRequestEnd', {
      userId: 'proxy',
      stage: 'llm',
      provider: provider.providerId,
      model: body.model,
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
      provider: provider.providerId,
      model: body.model,
      latencyMs: Date.now() - startTs,
      success: false,
      error: String(err),
      timestamp: Date.now(),
    });

    return {
      status: 500,
      body: { error: { message: String(err), type: 'server_error' } },
    };
  }
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
