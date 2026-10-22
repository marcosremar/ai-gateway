import { OpenAICompatTTSProvider } from '../openai-compat/openai-compat-tts';

export const kokoroStreamTTS = new OpenAICompatTTSProvider({
  providerId: 'self-hosted',
  baseURL: process.env.KOKORO_STREAM_URL ?? 'http://127.0.0.1:8899/v1',
  envKey: 'KOKORO_STREAM_API_KEY',
  models: [],
  voices: [],
  defaultFormat: 'pcm',
  allowedFormats: ['pcm'],
  passthroughVoices: true,
  pcmAsWavRate: 24_000,
  streamAudio: true,
});
