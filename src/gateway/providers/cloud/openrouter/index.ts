/**
 * OpenRouter Provider — LLM, STT, TTS + Image.
 * Aggregator with access to 100+ models via a single API key.
 * STT (`/audio/transcriptions`, OpenAI multipart) and TTS (`/audio/speech`, mp3|pcm) use the OpenAI shapes.
 */

import { OpenAICompatLLMProvider } from '../openai-compat/openai-compat-llm';
import { OpenAICompatSTTProvider } from '../openai-compat/openai-compat-stt';
import { OpenAICompatTTSProvider } from '../openai-compat/openai-compat-tts';

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

export const openrouterSTT = new OpenAICompatSTTProvider({
  providerId: 'openrouter',
  baseURL: BASE_URL,
  envKey: 'OPENROUTER_API_KEY',
  models: [
    { id: 'openai/whisper-large-v3', name: 'Whisper Large V3 (OpenRouter)', description: 'Whisper Large V3 via OpenRouter', capability: 'stt', isDefault: true },
    { id: 'openai/whisper-large-v3-turbo', name: 'Whisper Large V3 Turbo (OpenRouter)', description: 'Whisper Large V3 Turbo via OpenRouter', capability: 'stt' },
  ],
  defaultModel: 'openai/whisper-large-v3',
});

/** Voices are model-specific on OpenRouter, so the requested voice is passed through untouched. */
export const openrouterTTS = new OpenAICompatTTSProvider({
  providerId: 'openrouter',
  baseURL: BASE_URL,
  envKey: 'OPENROUTER_API_KEY',
  models: [],
  voices: [],
  defaultFormat: 'mp3',
  allowedFormats: ['mp3', 'pcm'],
  passthroughVoices: true,
  pcmAsWavRate: 24_000,
});

export { openrouterImage, OpenRouterImageProvider } from './openrouter-image';
export { OPENROUTER_LLM_MODELS, OPENROUTER_IMAGE_MODELS } from './models';
