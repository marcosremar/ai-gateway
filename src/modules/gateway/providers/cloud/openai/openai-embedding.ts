/**
 * OpenAI Embedding Provider — text-embedding-3-small / text-embedding-3-large
 */

import { OpenAICompatEmbeddingProvider } from '../openai-compat/openai-compat-embedding';

export const OPENAI_EMBEDDING_MODELS = [
  'text-embedding-3-small',
  'text-embedding-3-large',
  'text-embedding-ada-002',
] as const;

export const openaiEmbedding = new OpenAICompatEmbeddingProvider({
  providerId: 'openai',
  name: 'OpenAI Embedding',
  baseURL: 'https://api.openai.com/v1',
  envKey: 'OPENAI_API_KEY',
  defaultModel: 'text-embedding-3-small',
});
