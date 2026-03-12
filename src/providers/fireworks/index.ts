/**
 * Fireworks AI STT Provider — Whisper-v3 via OpenAI-compatible batch API.
 * ~20x faster than OpenAI-hosted Whisper, WER within 3% of Whisper Large V3.
 */

import { OpenAICompatSTTProvider } from '../openai-compat/openai-compat-stt';
import type { ModelInfo } from '../types';

// Fireworks batch transcription endpoint (OpenAI-compatible)
const BASE_URL = 'https://api.fireworks.ai/inference/v1';
const ENV_KEY = 'FIREWORKS_API_KEY';

const FIREWORKS_STT_MODELS: ModelInfo[] = [
  { id: 'whisper-v3', name: 'Whisper V3', description: 'Fireworks Whisper Large V3 — fast + accurate', capability: 'stt', isDefault: true },
  { id: 'whisper-v3-turbo', name: 'Whisper V3 Turbo', description: 'Fireworks Whisper V3 Turbo — fastest', capability: 'stt' },
];

const sttModel = process.env.FIREWORKS_STT_MODEL || 'whisper-v3';

export const fireworksSTT = new OpenAICompatSTTProvider({
  providerId: 'fireworks',
  baseURL: BASE_URL,
  envKey: ENV_KEY,
  models: FIREWORKS_STT_MODELS,
  defaultModel: sttModel,
});
