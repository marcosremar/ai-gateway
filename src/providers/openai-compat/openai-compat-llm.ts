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

    const completion = await client.chat.completions.create({
      model: request.model || this.config.defaultModel || '',
      messages: request.messages as OpenAI.ChatCompletionMessageParam[],
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
      ...(request.responseFormat && { response_format: request.responseFormat }),
    });

    return {
      content: completion.choices[0]?.message?.content || '',
      model: completion.model,
      usage: completion.usage ? {
        promptTokens: completion.usage.prompt_tokens,
        completionTokens: completion.usage.completion_tokens,
        totalTokens: completion.usage.total_tokens,
      } : undefined,
      raw: completion,
    };
  }
}
