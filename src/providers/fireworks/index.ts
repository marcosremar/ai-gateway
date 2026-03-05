/**
 * Fireworks AI Provider — STT + LLM + Image via OpenAI-compatible API.
 * Optimized inference for open-source models.
 */

import { OpenAICompatSTTProvider } from '../openai-compat/openai-compat-stt';
import { OpenAICompatLLMProvider } from '../openai-compat/openai-compat-llm';
import { FIREWORKS_STT_MODELS, FIREWORKS_LLM_MODELS } from './models';
import { FireworksImageProvider } from './fireworks-image';

const BASE_URL = 'https://api.fireworks.ai/inference/v1';
const ENV_KEY = 'FIREWORKS_API_KEY';

export const fireworksSTT = new OpenAICompatSTTProvider({
  providerId: 'fireworks',
  baseURL: BASE_URL,
  envKey: ENV_KEY,
  models: FIREWORKS_STT_MODELS,
  defaultModel: 'whisper-v3-turbo',
});

export const fireworksLLM = new OpenAICompatLLMProvider({
  providerId: 'fireworks',
  baseURL: BASE_URL,
  envKey: ENV_KEY,
  defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
});

export const fireworksImage = new FireworksImageProvider();

export { FireworksImageProvider } from './fireworks-image';
export { FIREWORKS_STT_MODELS, FIREWORKS_LLM_MODELS, FIREWORKS_IMAGE_MODELS } from './models';
