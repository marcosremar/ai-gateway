import type { ModelRoutesSpec } from '../../../src/config/serve-providers';

/**
 * The parle app's own aliases, as parle PUTs them (`PUT /v1/apps/parle/routes`). They used to be built into the
 * gateway (defaultAliasRoutes); the tests that exercise a real chain mount this the way serve.ts mounts every
 * app's routes (`appRoutes`).
 */
export function parleRoutes(opts: { speech?: string; tts?: string } = {}): ModelRoutesSpec {
  const speech = opts.speech ?? 'parle-speech';
  const noReasoning = { reasoning: { enabled: false } };
  const ttsChain = [
    { provider: 'deployment', deployment: opts.tts ?? 'parle-qwen-tts', model: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base' },
    { provider: 'openrouter', model: 'microsoft/mai-voice-2.1-flash', voice: 'pt-BR-Luana:MAI-Voice-2-Flash' },
    { provider: 'openrouter', model: 'hexgrad/kokoro-82m', voice: 'pf_dora', fixedVoice: true },
  ];
  return {
    stt: { 'parle-stt': [
      { provider: 'deployment', deployment: speech, model: 'whisper-large-v3-turbo' },
      { provider: 'openrouter', model: 'openai/whisper-large-v3-turbo' },
      { provider: 'groq', model: 'whisper-large-v3-turbo' },
    ] },
    chat: { 'parle-llm': [
      { provider: 'deployment', deployment: speech, model: 'qwen3.5-9b' },
      { provider: 'openrouter', model: 'qwen/qwen3.5-9b', extraBody: noReasoning },
      { provider: 'openrouter', model: 'google/gemini-2.5-flash-lite', extraBody: noReasoning },
    ] },
    tts: { 'parle-tts': ttsChain },
  };
}
