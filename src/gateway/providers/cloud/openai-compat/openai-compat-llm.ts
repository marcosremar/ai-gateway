/**
 * OpenAI-compatible LLM base class.
 * Any provider with an OpenAI-compatible /chat/completions endpoint
 * can use this by providing { providerId, baseURL, envKey, defaultHeaders? }.
 */

import OpenAI from 'openai';
import type { ProviderId, LLMProvider, ChatRequest, ChatResponse } from '../types';
import { getOrCreateClient } from './client-cache';

export interface OpenAICompatLLMConfig {
  providerId: ProviderId;
  baseURL: string;
  envKey: string;
  defaultModel?: string;
  defaultHeaders?: Record<string, string>;
}

export class OpenAICompatLLMProvider implements LLMProvider {
  readonly providerId: ProviderId;
  protected client: OpenAI | null = null;
  private readonly config: OpenAICompatLLMConfig;

  constructor(config: OpenAICompatLLMConfig) {
    this.config = config;
    this.providerId = config.providerId;
  }

  /** True when the client was built from an explicit key (withApiKey/withConfig): never swapped for the env key. */
  private pinnedClient = false;

  /**
   * The key is read from the environment on EVERY call, so a key rotated at runtime (KeyManager reload) is used by
   * the next request. Clients are shared per baseURL + key hash (client-cache), so this costs a hash lookup.
   */
  protected getClient(): OpenAI {
    if (this.client && this.pinnedClient) return this.client;
    const apiKey = process.env[this.config.envKey];
    if (!apiKey) throw new Error(`[${this.config.providerId} LLM] ${this.config.envKey} is not set`);
    this.client = getOrCreateClient(this.config.baseURL, apiKey, this.config.defaultHeaders);
    return this.client;
  }

  withApiKey(apiKey: string): OpenAICompatLLMProvider {
    const provider = new OpenAICompatLLMProvider(this.config);
    provider.pinnedClient = true;
    provider.client = new OpenAI({
      apiKey,
      baseURL: this.config.baseURL,
      ...(this.config.defaultHeaders && { defaultHeaders: this.config.defaultHeaders }),
    });
    return provider;
  }

  withConfig(opts: { apiKey: string; baseURL?: string }): OpenAICompatLLMProvider {
    const provider = new OpenAICompatLLMProvider(this.config);
    provider.pinnedClient = true;
    provider.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL || this.config.baseURL,
      ...(this.config.defaultHeaders && { defaultHeaders: this.config.defaultHeaders }),
    });
    return provider;
  }

  isConfigured(): boolean { return !!process.env[this.config.envKey]; }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const client = this.getClient();
    const timeoutMs = request.timeoutMs || 120_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;

    try {
    const completion = await client.chat.completions.create({
      model: request.model || this.config.defaultModel || '',
      messages: request.messages as OpenAI.ChatCompletionMessageParam[],
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
      ...(request.responseFormat && { response_format: request.responseFormat }),
      ...(request.stream && { stream: request.stream }),
      ...request.extraBody,
    }, { signal }) as OpenAI.ChatCompletion;

    return {
      content: completion.choices[0]?.message?.content || '',
      model: completion.model,
      ...(completion.choices[0]?.finish_reason ? { finishReason: completion.choices[0].finish_reason } : {}),
      usage: completion.usage ? {
        promptTokens: completion.usage.prompt_tokens,
        completionTokens: completion.usage.completion_tokens,
        totalTokens: completion.usage.total_tokens,
      } : undefined,
      raw: completion,
    };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`[openai-compat] chat() timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Streaming chat completion — yields content tokens as they arrive.
   * Used by StreamingOverlap to start TTS before the full LLM response is ready.
   */
  async *chatStream(request: ChatRequest): AsyncGenerator<string, void, undefined> {
    const client = this.getClient();
    // Match non-streaming chat() timeout behaviour. Without abort wiring, a
    // stalled provider stream hangs the consumer indefinitely; the for-await
    // loop only releases on normal stream end. AbortSignal.timeout fires the
    // signal after `timeoutMs` of inactivity at the OpenAI SDK layer, which
    // the SDK propagates to the underlying fetch.
    const timeoutMs = request.timeoutMs || 120_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });

    let stream: AsyncIterable<OpenAI.ChatCompletionChunk> | null = null;
    try {
      stream = await client.chat.completions.create({
        model: request.model || this.config.defaultModel || '',
        messages: request.messages as OpenAI.ChatCompletionMessageParam[],
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
        ...(request.responseFormat && { response_format: request.responseFormat }),
        stream: true,
        stream_options: { include_usage: true },
        ...request.extraBody,
      } as OpenAI.ChatCompletionCreateParamsStreaming, { signal: controller.signal });

      for await (const chunk of stream) {
        if (chunk.usage) {
          yield `__usage__:${JSON.stringify({
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
            total_tokens: chunk.usage.total_tokens,
          })}`;
          continue;
        }
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield delta;
      }
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message?.includes('aborted'))) {
        throw new Error(`[openai-compat] chatStream() timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      // Best-effort signal abort so caller-side early-termination (consumer
      // breaks out of for-await) also cancels in-flight HTTP request.
      try { controller.abort(); } catch { /* no-op */ }
    }
  }
}
