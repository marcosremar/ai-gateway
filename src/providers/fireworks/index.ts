/**
 * Fireworks AI Provider — STT (Whisper-v3), LLM, and Image generation.
 */

import { OpenAICompatSTTProvider } from '../openai-compat/openai-compat-stt';
import { OpenAICompatLLMProvider } from '../openai-compat/openai-compat-llm';
import { FIREWORKS_STT_MODELS, FIREWORKS_LLM_MODELS, FIREWORKS_IMAGE_MODELS } from './models';

// Re-export models and image provider
export { FIREWORKS_STT_MODELS, FIREWORKS_LLM_MODELS, FIREWORKS_IMAGE_MODELS } from './models';
export { FireworksImageProvider, fireworksImage } from './fireworks-image';

// Fireworks endpoint (OpenAI-compatible)
const BASE_URL = 'https://api.fireworks.ai/inference/v1';
const ENV_KEY = 'FIREWORKS_API_KEY';

const sttModel = process.env.FIREWORKS_STT_MODEL || 'whisper-v3';

export const fireworksSTT = new OpenAICompatSTTProvider({
  providerId: 'fireworks',
  baseURL: BASE_URL,
  envKey: ENV_KEY,
  models: FIREWORKS_STT_MODELS,
  defaultModel: sttModel,
});

export const fireworksLLM = new OpenAICompatLLMProvider({
  providerId: 'fireworks',
  baseURL: BASE_URL,
  envKey: ENV_KEY,
  defaultModel: FIREWORKS_LLM_MODELS[0]?.id ?? 'accounts/fireworks/models/llama-v3p1-70b-instruct',
});
