/**
 * OpenAI-compatible Embedding base class.
 * Any provider with an OpenAI-compatible /embeddings endpoint can extend this.
 */

import OpenAI from 'openai';
import type { ProviderId } from '../types';

export interface EmbeddingRequest {
  input: string | string[];
  model?: string;
  dimensions?: number;
}

export interface EmbeddingResponse {
  embeddings: number[][];
  model: string;
  usage: { promptTokens: number; totalTokens: number };
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly providerId: ProviderId;
  embed(input: string | string[], opts?: { model?: string; dimensions?: number }): Promise<EmbeddingResponse>;
  isConfigured(): boolean;
}

export interface OpenAICompatEmbeddingConfig {
  providerId: ProviderId;
  name: string;
  baseURL: string;
  envKey: string;
  defaultModel: string;
  defaultHeaders?: Record<string, string>;
}

export class OpenAICompatEmbeddingProvider implements EmbeddingProvider {
  readonly providerId: ProviderId;
  readonly name: string;
  protected client: OpenAI | null = null;
  private readonly config: OpenAICompatEmbeddingConfig;

  constructor(config: OpenAICompatEmbeddingConfig) {
    this.config = config;
    this.providerId = config.providerId;
    this.name = config.name;
  }

  protected getClient(): OpenAI {
    if (!this.client) {
      const apiKey = process.env[this.config.envKey];
      if (!apiKey) throw new Error(`[${this.config.name}] ${this.config.envKey} is not set`);
      this.client = new OpenAI({
        apiKey,
        baseURL: this.config.baseURL,
        ...(this.config.defaultHeaders && { defaultHeaders: this.config.defaultHeaders }),
      });
    }
    return this.client;
  }

  isConfigured(): boolean {
    return !!process.env[this.config.envKey];
  }

  async embed(input: string | string[], opts?: { model?: string; dimensions?: number }): Promise<EmbeddingResponse> {
    const client = this.getClient();
    const model = opts?.model || this.config.defaultModel;

    const response = await client.embeddings.create({
      input,
      model,
      ...(opts?.dimensions !== undefined && { dimensions: opts.dimensions }),
    });

    return {
      embeddings: response.data.map((d) => d.embedding),
      model: response.model,
      usage: {
        promptTokens: response.usage.prompt_tokens,
        totalTokens: response.usage.total_tokens,
      },
    };
  }
}
