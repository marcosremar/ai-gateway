/**
 * OpenRouter Provider — LLM + Image.
 * Aggregator with access to 100+ models via a single API key.
 */

import { OpenAICompatLLMProvider } from '../openai-compat/openai-compat-llm';

const BASE_URL = process.env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1';

const APP_URL = process.env.APP_URL || 'https://parle.app';
const APP_NAME = process.env.APP_NAME || 'PARLE';

export const openrouterLLM = new OpenAICompatLLMProvider({
  providerId: 'openrouter',
  baseURL: BASE_URL,
  envKey: 'OPENROUTER_API_KEY',
  defaultModel: process.env.OPENROUTER_DEFAULT_MODEL || 'openai/gpt-4o-mini',
  defaultHeaders: {
    'HTTP-Referer': APP_URL,
    'X-Title': APP_NAME,
  },
});

export { openrouterImage, OpenRouterImageProvider } from './openrouter-image';
export { OPENROUTER_LLM_MODELS, OPENROUTER_IMAGE_MODELS } from './models';
