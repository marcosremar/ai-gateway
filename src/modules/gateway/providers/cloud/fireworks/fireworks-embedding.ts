/**
 * Fireworks Embedding Provider
 */

import { OpenAICompatEmbeddingProvider } from '../openai-compat/openai-compat-embedding';

export const fireworksEmbedding = new OpenAICompatEmbeddingProvider({
  providerId: 'fireworks',
  name: 'Fireworks Embedding',
  baseURL: 'https://api.fireworks.ai/inference/v1',
  envKey: 'FIREWORKS_API_KEY',
  defaultModel: 'nomic-ai/nomic-embed-text-v1.5',
});
