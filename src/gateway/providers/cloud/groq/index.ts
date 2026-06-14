/**
 * Groq Provider — STT, TTS, LLM via OpenAI-compatible API.
 * Uses LPU inference engine for ultra-fast responses.
 */

import { OpenAICompatSTTProvider } from '../openai-compat/openai-compat-stt';
import { OpenAICompatTTSProvider } from '../openai-compat/openai-compat-tts';
import { OpenAICompatLLMProvider } from '../openai-compat/openai-compat-llm';
import { GROQ_STT_MODELS, GROQ_TTS_MODELS, GROQ_TTS_VOICES } from './models';

const BASE_URL = process.env.GROQ_API_BASE || 'https://api.groq.com/openai/v1';
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
  // Groq orpheus models only accept wav — silently downgrade mp3/opus/etc. requests
  allowedFormats: ['wav'],
});

export const groqLLM = new OpenAICompatLLMProvider({
  providerId: 'groq',
  baseURL: BASE_URL,
  envKey: ENV_KEY,
  defaultModel: llmModel,
});

/**
 * The default Groq TTS model (canopylabs/orpheus-v1-english) is English-only.
 * In a multilingual pipeline (e.g. a `language:'fr'` translation chain) a
 * fallback to Groq TTS would produce wrong-language audio — the right move is
 * to skip the Groq TTS fallback entirely when the target language isn't
 * English (#374). This pure predicate lets the chain builder / fallback decide
 * whether a Groq TTS entry is language-compatible.
 *
 * A Groq TTS entry is compatible when EITHER:
 *   - the target language is English (or unspecified — assume English-safe), OR
 *   - the model is not one of Groq's English-only orpheus models (future
 *     multilingual Groq voices won't be gated).
 *
 * @param language target language code/name (e.g. 'en', 'en-US', 'English', 'fr')
 * @param model    the Groq TTS model id that would be used
 */
export function isGroqTtsLanguageCompatible(language?: string, model?: string): boolean {
  const m = (model ?? 'canopylabs/orpheus-v1-english').toLowerCase();
  // Only the English-only orpheus family is gated; anything else is allowed.
  const englishOnly = m.includes('english') || m.includes('orpheus-v1-english');
  if (!englishOnly) return true;
  if (!language) return true; // unspecified → assume English path is fine
  const lang = language.trim().toLowerCase();
  return lang === 'en' || lang.startsWith('en-') || lang === 'english';
}

export { GROQ_STT_MODELS, GROQ_TTS_MODELS, GROQ_TTS_VOICES, GROQ_LLM_MODELS } from './models';
