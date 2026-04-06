/**
 * OpenAI STT Provider — gpt-4o-transcribe via OpenAI-compatible API.
 */

import { OpenAICompatSTTProvider } from '../openai-compat/openai-compat-stt';
import type { ModelInfo } from '../types';

const BASE_URL = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
const ENV_KEY = 'OPENAI_API_KEY';

const OPENAI_STT_MODELS: ModelInfo[] = [
  { id: 'gpt-4o-transcribe', name: 'GPT-4o Transcribe', description: 'OpenAI GPT-4o — best WER for FR+EN', capability: 'stt', isDefault: true },
  { id: 'gpt-4o-mini-transcribe', name: 'GPT-4o Mini Transcribe', description: 'OpenAI GPT-4o Mini — fast + cheap', capability: 'stt' },
  { id: 'whisper-1', name: 'Whisper-1', description: 'OpenAI Whisper-1 legacy', capability: 'stt' },
];

const sttModel = process.env.OPENAI_STT_MODEL || 'gpt-4o-transcribe';

export const openaiSTT = new OpenAICompatSTTProvider({
  providerId: 'openai',
  baseURL: BASE_URL,
  envKey: ENV_KEY,
  models: OPENAI_STT_MODELS,
  defaultModel: sttModel,
  defaultResponseFormat: 'json',  // gpt-4o-transcribe doesn't support verbose_json
});
