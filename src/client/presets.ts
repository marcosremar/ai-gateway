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
 * Speech-to-Speech profile — voice conversation with 3-tier fallback.
 *
 * Tier 1: OpenAI Realtime (WebRTC, ~300-500ms round-trip)
 *   Browser connects directly to OpenAI Realtime API via WebRTC.
 *   Lowest latency, handles STT+LLM+TTS in one connection.
 *
 * Tier 2: OpenAI Omni (single API call, ~1-2s)
 *   gpt-4o-mini-audio-preview handles audio-in → audio+text-out.
 *   Used when Realtime is unavailable or for server-side pipeline.
 *
 * Tier 3: Sequential pipeline (STT → LLM → TTS, ~2-3s)
 *   Groq for STT/LLM (fast), OpenAI tts-1 for TTS.
 *   Self-hosted GPU as final fallback.
 */
export const SPEECH_TO_SPEECH_PROFILE: AIProfile = {
  preset: 'speech-to-speech',
  // Tier 1: OpenAI Realtime — lowest latency (~300-500ms)
  realtime: [
    { provider: 'openai', model: 'gpt-4o-mini-realtime-preview' },
    { provider: 'openai', model: 'gpt-4o-realtime-preview' },
  ],
  // Tier 2: OpenAI Omni — single call STT+LLM+TTS (~1-2s)
  omni: [
    { provider: 'openai', model: 'gpt-4o-mini-audio-preview' },
  ],
  // Tier 3: Sequential pipeline — fast cloud providers with self-hosted fallback
  stt: [
    { provider: 'groq', model: 'whisper-large-v3-turbo' },
    { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
    { provider: 'self-hosted', model: 'whisper-small', selfHosted: true },
  ],
  llm: [
    { provider: 'groq', model: 'llama-3.1-8b-instant' },
    { provider: 'openai', model: 'gpt-4o-mini' },
    { provider: 'self-hosted', model: 'gemma-3-4b-it', selfHosted: true },
  ],
  tts: [
    // tts-1: fastest cloud TTS (~0.5-1.5s), multilingual incl. Portuguese.
    { provider: 'openai', model: 'tts-1' },
    // Groq Orpheus: fallback (~1-2.5s), English-only.
    { provider: 'groq', model: 'canopylabs/orpheus-v1-english' },
    { provider: 'self-hosted', model: 'kokoro-82m', selfHosted: true },
  ],
  voice: 'nova',
  // mp3 is 10x smaller than wav → faster transfer with negligible decode overhead.
  // Browser AudioContext.decodeAudioData() handles mp3 natively.
  audioFormat: 'mp3',
  language: 'pt',
  temperature: 0.7,
  // Cap response length — shorter text = faster TTS synthesis (Tier 3 only).
  // 60 tokens ≈ 30–40 words ≈ 2 short sentences. Keeps TTS under 2.5s.
  maxTokens: 60,
  fallbackOptions: {
    timeoutMs: 5_000,
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
  // Sequential fallback with fast Groq providers (if realtime + omni both fail)
  stt: [
    { provider: 'groq', model: 'whisper-large-v3-turbo' },
    { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
  ],
  llm: [
    { provider: 'groq', model: 'llama-3.1-8b-instant' },
    { provider: 'openai', model: 'gpt-4o-mini' },
  ],
  tts: [
    { provider: 'openai', model: 'tts-1' },
    { provider: 'groq', model: 'canopylabs/orpheus-v1-english' },
  ],
  voice: 'nova',
  audioFormat: 'mp3',
  language: 'pt',
  temperature: 0.7,
  maxTokens: 60,
  fallbackOptions: {
    timeoutMs: 5_000,
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
