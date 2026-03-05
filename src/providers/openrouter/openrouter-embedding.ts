/**
 * OpenRouter Embedding Provider
 */

import { OpenAICompatEmbeddingProvider } from '../openai-compat/openai-compat-embedding';

export const openrouterEmbedding = new OpenAICompatEmbeddingProvider({
  providerId: 'openrouter',
  name: 'OpenRouter Embedding',
  baseURL: 'https://openrouter.ai/api/v1',
  envKey: 'OPENROUTER_API_KEY',
  defaultModel: 'openai/text-embedding-3-small',
});
