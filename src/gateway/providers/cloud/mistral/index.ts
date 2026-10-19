/**
 * Mistral Provider — STT (Voxtral) on Mistral's EU endpoint: the audio is processed in the EU, so an app whose students'
 * audio must stay in the EU (parle) has a cloud fallback for a cold GPU that keeps that rule. OpenAI-compatible
 * `/audio/transcriptions` (multipart, `language`, `prompt`, `temperature`, `response_format`).
 */

import { OpenAICompatSTTProvider } from '../openai-compat/openai-compat-stt';

const BASE_URL = process.env.MISTRAL_API_BASE || 'https://api.eu.mistral.ai/v1';

export const MISTRAL_STT_MODELS = [
  { id: 'voxtral-mini-latest', name: 'Voxtral Mini Transcribe (Mistral EU)', description: 'Voxtral Mini transcription on api.eu.mistral.ai', capability: 'stt' as const, isDefault: true },
];

export const mistralSTT = new OpenAICompatSTTProvider({
  providerId: 'mistral',
  baseURL: BASE_URL,
  envKey: 'MISTRAL_API_KEY',
  models: MISTRAL_STT_MODELS,
  defaultModel: 'voxtral-mini-latest',
});
