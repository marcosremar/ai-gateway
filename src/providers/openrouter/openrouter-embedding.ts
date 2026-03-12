/**
 * OpenRouter Embedding Providers
 */

import { OpenAICompatEmbeddingProvider } from '../openai-compat/openai-compat-embedding';

const BASE_URL = 'https://openrouter.ai/api/v1';
const ENV_KEY = 'OPENROUTER_API_KEY';

/** Default: OpenAI text-embedding-3-small via OpenRouter */
export const openrouterEmbedding = new OpenAICompatEmbeddingProvider({
  providerId: 'openrouter',
  name: 'OpenRouter Embedding',
  baseURL: BASE_URL,
  envKey: ENV_KEY,
  defaultModel: 'openai/text-embedding-3-small',
});

/**
 * Qwen3-Embedding-0.6b via OpenRouter — recommended for STT Verifier fallback.
 * #1 MTEB multilingual (100+ langs), 25ms API latency, $0.01/1M tokens.
 * Batch-embeds 3-5 short texts in a single call — ideal for consensus detection.
 */
export const openrouterQwen3Embedding = new OpenAICompatEmbeddingProvider({
  providerId: 'openrouter',
  name: 'OpenRouter Qwen3-Embedding-0.6b',
  baseURL: BASE_URL,
  envKey: ENV_KEY,
  defaultModel: 'qwen/qwen3-embedding-0.6b',
});

/**
 * Qwen3-Embedding-8b via OpenRouter — higher quality fallback.
 * #1 MTEB multilingual score (70.58), 41ms API latency, same price as 0.6b.
 */
export const openrouterQwen3EmbeddingLarge = new OpenAICompatEmbeddingProvider({
  providerId: 'openrouter',
  name: 'OpenRouter Qwen3-Embedding-8b',
  baseURL: BASE_URL,
  envKey: ENV_KEY,
  defaultModel: 'qwen/qwen3-embedding-8b',
});
