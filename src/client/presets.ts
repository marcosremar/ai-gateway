/**
 * AIClient Preset Profiles
 *
 * Each preset defines sensible defaults for a common use case:
 * fallback chains, timeouts, temperature, etc.
 */

import type { AIProfile, PresetName } from './types';

// ---------------------------------------------------------------------------
// Preset Profiles
// ---------------------------------------------------------------------------

export const VOICE_PROFILE: AIProfile = {
  preset: 'voice',
  stt: [
    { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
    { provider: 'groq', model: 'whisper-large-v3-turbo' },
  ],
  llm: [
    { provider: 'openai', model: 'gpt-4o-mini' },
    { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  ],
  tts: [
    { provider: 'openai', model: 'gpt-4o-mini-tts' },
    { provider: 'groq', model: 'canopylabs/orpheus-v1-english' },
    { provider: 'modal', model: 'moss-tts-realtime' },
  ],
  omni: [
    { provider: 'openai', model: 'gpt-audio-mini' },
  ],
  realtime: [
    { provider: 'openai', model: 'gpt-4o-mini-realtime-preview' },
  ],
  voice: 'nova',
  audioFormat: 'wav',
  fallbackOptions: { timeoutMs: 8_000, retriesPerProvider: 0 },
};

export const CHAT_PROFILE: AIProfile = {
  preset: 'chat',
  llm: [
    { provider: 'openai', model: 'gpt-4o' },
    { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  ],
  fallbackOptions: {
    timeoutMs: 30_000,
    retriesPerProvider: 1,
    contextWindowFallbacks: {
      'gpt-4o-mini': 'gpt-4o',
      'llama-3.1-8b-instant': 'llama-3.3-70b-versatile',
    },
  },
};

export const STT_PROFILE: AIProfile = {
  preset: 'stt',
  stt: [
    { provider: 'groq', model: 'whisper-large-v3-turbo' },
    { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
  ],
  fallbackOptions: { timeoutMs: 8_000, retriesPerProvider: 0 },
};

export const TTS_PROFILE: AIProfile = {
  preset: 'tts',
  tts: [
    { provider: 'groq', model: 'canopylabs/orpheus-v1-english' },
    { provider: 'openai', model: 'gpt-4o-mini-tts' },
    { provider: 'modal', model: 'moss-tts-realtime' },
  ],
  voice: 'nova',
  audioFormat: 'wav',
  fallbackOptions: { timeoutMs: 8_000, retriesPerProvider: 0 },
};

export const LLM_PROFILE: AIProfile = {
  preset: 'llm',
  llm: [
    { provider: 'openai', model: 'gpt-4o' },
    { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  ],
  fallbackOptions: {
    timeoutMs: 30_000,
    retriesPerProvider: 1,
    contextWindowFallbacks: {
      'gpt-4o-mini': 'gpt-4o',
      'llama-3.1-8b-instant': 'llama-3.3-70b-versatile',
    },
  },
};

export const IMAGE_PROFILE: AIProfile = {
  preset: 'image',
  image: [
    { provider: 'fireworks', model: 'flux-1-dev-fp8' },
    { provider: 'openai', model: 'gpt-image-1' },
    { provider: 'openrouter', model: 'google/gemini-2.5-flash-image' },
  ],
  imageWidth: 1280,
  imageHeight: 720,
  imageSteps: 25,
  fallbackOptions: { timeoutMs: 60_000, retriesPerProvider: 1 },
};

export const SYSTEM_PROFILE: AIProfile = {
  preset: 'system',
  stt: [
    { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
    { provider: 'groq', model: 'whisper-large-v3-turbo' },
  ],
  llm: [
    { provider: 'openai', model: 'gpt-4o' },
    { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  ],
  temperature: 0.3,
  maxTokens: 2000,
  fallbackOptions: {
    timeoutMs: 30_000,
    retriesPerProvider: 2,
    contextWindowFallbacks: {
      'gpt-4o-mini': 'gpt-4o',
      'llama-3.1-8b-instant': 'llama-3.3-70b-versatile',
    },
  },
};

/**
 * Speech-to-Speech profile — full STT → LLM → TTS pipeline.
 *
 * Primary: self-hosted GPU (TensorDock RTX 3090) running
 *   Whisper (STT) → Gemma 3 4B (LLM) → Kokoro 82M (TTS)
 * Fallback: cloud providers (Groq → OpenAI)
 *
 * The self-hosted entries require a GPU endpoint to be set at runtime
 * via the autoscaler or gpuEndpoint override.
 */
export const SPEECH_TO_SPEECH_PROFILE: AIProfile = {
  preset: 'speech-to-speech',
  // Primary: OpenAI omni (single call handles STT+LLM+TTS, ~500ms)
  omni: [
    { provider: 'openai', model: 'gpt-4o-mini-audio-preview' },
  ],
  // Fallback: sequential pipeline (STT → LLM → TTS) — OpenAI first, Groq as fallback
  stt: [
    { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
    { provider: 'groq', model: 'whisper-large-v3-turbo' },
    { provider: 'self-hosted', model: 'whisper-small', selfHosted: true },
  ],
  llm: [
    { provider: 'openai', model: 'gpt-4o-mini' },
    { provider: 'groq', model: 'llama-3.1-8b-instant' },
    { provider: 'self-hosted', model: 'gemma-3-4b-it', selfHosted: true },
  ],
  tts: [
    { provider: 'openai', model: 'gpt-4o-mini-tts' },
    { provider: 'groq', model: 'canopylabs/orpheus-v1-english' },
    { provider: 'self-hosted', model: 'kokoro-82m', selfHosted: true },
  ],
  voice: 'nova',
  audioFormat: 'wav',
  language: 'pt',
  temperature: 0.7,
  fallbackOptions: {
    timeoutMs: 15_000,
    retriesPerProvider: 0,
  },
};

/**
 * OpenAI Realtime Speech-to-Speech — single-call audio-in → audio-out.
 *
 * Uses OpenAI's Realtime API (WebRTC) which handles STT + LLM + TTS
 * in one round-trip, ~300-500ms latency. No separate pipeline stages.
 * Falls back to omni (gpt-audio-mini) then to the sequential pipeline.
 */
export const OPENAI_REALTIME_PROFILE: AIProfile = {
  preset: 'openai-realtime',
  realtime: [
    { provider: 'openai', model: 'gpt-4o-mini-realtime-preview' },
    { provider: 'openai', model: 'gpt-4o-realtime-preview' },
  ],
  omni: [
    { provider: 'openai', model: 'gpt-audio-mini' },
    { provider: 'openai', model: 'gpt-audio' },
  ],
  // Sequential fallback if realtime + omni both fail
  stt: [
    { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
  ],
  llm: [
    { provider: 'openai', model: 'gpt-4o-mini' },
  ],
  tts: [
    { provider: 'openai', model: 'gpt-4o-mini-tts' },
  ],
  voice: 'nova',
  audioFormat: 'wav',
  language: 'pt',
  temperature: 0.7,
  fallbackOptions: {
    timeoutMs: 10_000,
    retriesPerProvider: 0,
  },
};

// ---------------------------------------------------------------------------
// Preset Map
// ---------------------------------------------------------------------------

const PRESETS: Record<PresetName, AIProfile> = {
  voice: VOICE_PROFILE,
  chat: CHAT_PROFILE,
  stt: STT_PROFILE,
  tts: TTS_PROFILE,
  llm: LLM_PROFILE,
  image: IMAGE_PROFILE,
  system: SYSTEM_PROFILE,
  'openai-realtime': OPENAI_REALTIME_PROFILE,
  'speech-to-speech': SPEECH_TO_SPEECH_PROFILE,
};

// ---------------------------------------------------------------------------
// Resolution & Merging
// ---------------------------------------------------------------------------

/**
 * Resolve a profile input to a concrete AIProfile.
 * Accepts a preset name string or a full AIProfile object.
 * If the profile references a preset, the preset is used as the base.
 */
export function resolveProfile(input: AIProfile | PresetName): AIProfile {
  if (typeof input === 'string') {
    const preset = PRESETS[input];
    if (!preset) throw new Error(`Unknown profile preset: "${input}"`);
    return { ...preset };
  }

  // If the object has a preset field, merge on top of that preset
  if (input.preset) {
    const base = PRESETS[input.preset];
    if (!base) throw new Error(`Unknown profile preset: "${input.preset}"`);
    return mergeProfiles(base, input);
  }

  return { ...input };
}

/**
 * Deep-merge two profiles. `override` fields take precedence over `base`.
 * Array fields (stt, llm, tts chains) are replaced entirely if present in override.
 */
export function mergeProfiles(base: AIProfile, override: AIProfile): AIProfile {
  return {
    ...base,
    ...override,
    // Keys are merged (override wins per-provider)
    keys: base.keys || override.keys
      ? { ...base.keys, ...override.keys }
      : undefined,
    // Fallback options are shallow-merged
    fallbackOptions: base.fallbackOptions || override.fallbackOptions
      ? { ...base.fallbackOptions, ...override.fallbackOptions }
      : undefined,
  };
}
