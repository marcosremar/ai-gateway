/**
 * OpenAI-compatible LLM base class.
 * Any provider with an OpenAI-compatible /chat/completions endpoint
 * can use this by providing { providerId, baseURL, envKey, defaultHeaders? }.
 */

import OpenAI from 'openai';
import type { ProviderId, LLMProvider, ChatRequest, ChatMessage, ChatResponse } from '../types';
import { getOrCreateClient } from './client-cache';
import { buildSamplingParams } from './chat-params';

/**
 * Shared timeout marker symbol (#372). Must match `fallback.ts`'s
 * `Symbol.for('__parle_fallback_timeout')` so `isTimeoutError()` recognizes
 * abort-derived timeouts thrown here. Using the registry symbol (Symbol.for)
 * keeps the two modules in sync without an import cycle.
 */
const TIMEOUT_MARKER = Symbol.for('__parle_fallback_timeout');

/** Tag an error as a timeout + give it a 408 status for reliable classification. */
export function markTimeout(err: Error): Error & { status?: number } {
  (err as Error & { [k: symbol]: boolean })[TIMEOUT_MARKER] = true;
  (err as Error & { status?: number }).status = 408;
  return err as Error & { status?: number };
}

/**
 * Rough token estimate from a character count (#377).
 *
 * When a provider omits the `usage` block, formatResponse defaulted token
 * counts to 0, which silently breaks cost accounting / budget tracking. A
 * ~4-chars-per-token heuristic (OpenAI's published rule of thumb) gives a
 * usable approximation instead of zero. Intentionally coarse — used only as a
 * fallback when real usage is unavailable.
 */
export function estimateTokensFromChars(chars: number): number {
  if (chars <= 0) return 0;
  return Math.max(1, Math.ceil(chars / 4));
}

/** Flatten a chat message's content (string or multimodal parts) to plain text. */
function messageText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.map((p) => (p.type === 'text' ? p.text ?? '' : '')).join(' ');
}

/**
 * Estimate prompt/completion/total tokens for a request+response when the
 * provider returned no usage (#377). Prompt tokens come from the request
 * messages, completion tokens from the response content.
 */
export function estimateUsage(
  messages: ChatMessage[],
  completion: string,
): { promptTokens: number; completionTokens: number; totalTokens: number } {
  const promptChars = messages.reduce((n, m) => n + messageText(m.content).length, 0);
  const promptTokens = estimateTokensFromChars(promptChars);
  const completionTokens = estimateTokensFromChars(completion.length);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

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

  protected getClient(): OpenAI {
    if (!this.client) {
      const apiKey = process.env[this.config.envKey];
      if (!apiKey) throw new Error(`[${this.config.providerId} LLM] ${this.config.envKey} is not set`);
      this.client = getOrCreateClient(this.config.baseURL, apiKey, this.config.defaultHeaders);
    }
    return this.client;
  }

  withApiKey(apiKey: string): OpenAICompatLLMProvider {
    const provider = new OpenAICompatLLMProvider(this.config);
    provider.client = new OpenAI({
      apiKey,
      baseURL: this.config.baseURL,
      ...(this.config.defaultHeaders && { defaultHeaders: this.config.defaultHeaders }),
    });
    return provider;
  }

  withConfig(opts: { apiKey: string; baseURL?: string }): OpenAICompatLLMProvider {
    const provider = new OpenAICompatLLMProvider(this.config);
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

    try {
    const completion = await client.chat.completions.create({
      model: request.model || this.config.defaultModel || '',
      messages: request.messages as OpenAI.ChatCompletionMessageParam[],
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
      ...(request.responseFormat && { response_format: request.responseFormat }),
      ...buildSamplingParams(request),
      ...(request.stream && { stream: request.stream }),
    } as OpenAI.ChatCompletionCreateParamsNonStreaming, { signal: controller.signal }) as OpenAI.ChatCompletion;

    const content = completion.choices[0]?.message?.content || '';
    return {
      content,
      model: completion.model,
      // When the provider omits usage, estimate it (#377) instead of reporting
      // zero tokens, which would silently zero out cost accounting.
      usage: completion.usage ? {
        promptTokens: completion.usage.prompt_tokens,
        completionTokens: completion.usage.completion_tokens,
        totalTokens: completion.usage.total_tokens,
      } : estimateUsage(request.messages, content),
      raw: completion,
    };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Mark the rethrown timeout so the fallback layer classifies it as a
        // timeout (move-on, no retry) rather than an opaque Error (#372).
        throw markTimeout(new Error(`[openai-compat] chat() timed out after ${timeoutMs}ms`));
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

    let stream: AsyncIterable<OpenAI.ChatCompletionChunk> | null = null;
    try {
      stream = await client.chat.completions.create({
        model: request.model || this.config.defaultModel || '',
        messages: request.messages as OpenAI.ChatCompletionMessageParam[],
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
        ...(request.responseFormat && { response_format: request.responseFormat }),
        ...buildSamplingParams(request),
        stream: true,
        stream_options: { include_usage: true },
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
        // Mark so the fallback layer treats it as a timeout (#372).
        throw markTimeout(new Error(`[openai-compat] chatStream() timed out after ${timeoutMs}ms`));
      }
      throw err;
    } finally {
      clearTimeout(timer);
      // Best-effort signal abort so caller-side early-termination (consumer
      // breaks out of for-await) also cancels in-flight HTTP request.
      try { controller.abort(); } catch { /* no-op */ }
    }
  }
}
