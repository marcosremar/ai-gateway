/**
 * OpenRouter Provider — LLM + Image.
 * Aggregator with access to 100+ models via a single API key.
 */

import { OpenAICompatLLMProvider } from '../openai-compat/openai-compat-llm';
import { OPENROUTER_LLM_MODELS } from './models';

export const openrouterLLM = new OpenAICompatLLMProvider({
  providerId: 'openrouter',
  baseURL: 'https://openrouter.ai/api/v1',
  envKey: 'OPENROUTER_API_KEY',
  defaultModel: 'openai/gpt-4o-mini',
  defaultHeaders: {
    'HTTP-Referer': 'https://parle.app',
    'X-Title': 'PARLE',
  },
});

export { openrouterImage, OpenRouterImageProvider } from './openrouter-image';
export { OPENROUTER_LLM_MODELS, OPENROUTER_IMAGE_MODELS } from './models';
