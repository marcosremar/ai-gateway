/**
 * Groq Provider — STT, TTS, LLM via OpenAI-compatible API.
 * Uses LPU inference engine for ultra-fast responses.
 */

import { OpenAICompatSTTProvider } from '../openai-compat/openai-compat-stt';
import { OpenAICompatTTSProvider } from '../openai-compat/openai-compat-tts';
import { OpenAICompatLLMProvider } from '../openai-compat/openai-compat-llm';
import { GROQ_STT_MODELS, GROQ_TTS_MODELS, GROQ_TTS_VOICES, GROQ_LLM_MODELS } from './models';

const BASE_URL = 'https://api.groq.com/openai/v1';
const ENV_KEY = 'GROQ_API_KEY';

const sttModel = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
const llmModel = process.env.GROQ_LLM_MODEL || 'llama-3.3-70b-versatile';

export const groqSTT = new OpenAICompatSTTProvider({
  providerId: 'groq',
  baseURL: BASE_URL,
  envKey: ENV_KEY,
  models: GROQ_STT_MODELS,
  defaultModel: sttModel,
});

export const groqTTS = new OpenAICompatTTSProvider({
  providerId: 'groq',
  baseURL: BASE_URL,
  envKey: ENV_KEY,
  models: GROQ_TTS_MODELS,
  voices: GROQ_TTS_VOICES,
  defaultModel: 'canopylabs/orpheus-v1-english',
  defaultVoice: 'autumn',
  defaultFormat: 'wav',
});

export const groqLLM = new OpenAICompatLLMProvider({
  providerId: 'groq',
  baseURL: BASE_URL,
  envKey: ENV_KEY,
  defaultModel: llmModel,
});

export { GROQ_STT_MODELS, GROQ_TTS_MODELS, GROQ_TTS_VOICES, GROQ_LLM_MODELS } from './models';
