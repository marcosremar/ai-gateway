/**
 * OpenAI Audio Models Catalog
 *
 * Comprehensive listing of all OpenAI audio models available for STT and TTS.
 * Source: https://platform.openai.com/docs/models
 */

import type { ModelInfo, VoiceInfo } from '../types';

// ---------------------------------------------------------------------------
// STT (Speech-to-Text) Models
// ---------------------------------------------------------------------------

export const OPENAI_STT_MODELS: ModelInfo[] = [
  {
    id: 'gpt-4o-transcribe',
    name: 'GPT-4o Transcribe',
    description: 'High-quality speech-to-text powered by GPT-4o. Supports streaming, prompts, and logprobs.',
    capability: 'stt',
    isDefault: true,
    metadata: {
      supportedFormats: ['json', 'text'],
      supportsStreaming: true,
      supportsPrompt: true,
      maxFileSize: '25MB',
      supportedInputFormats: ['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm'],
    },
  },
  {
    id: 'gpt-4o-mini-transcribe',
    name: 'GPT-4o Mini Transcribe',
    description: 'Cost-efficient speech-to-text powered by GPT-4o mini. Supports streaming.',
    capability: 'stt',
    metadata: {
      supportedFormats: ['json', 'text'],
      supportsStreaming: true,
      supportsPrompt: true,
      maxFileSize: '25MB',
      supportedInputFormats: ['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm'],
    },
  },
  {
    id: 'whisper-1',
    name: 'Whisper V1',
    description: 'General-purpose speech recognition model. Supports transcription and translation to English.',
    capability: 'stt',
    metadata: {
      supportedFormats: ['json', 'text', 'srt', 'verbose_json', 'vtt'],
      supportsStreaming: false,
      supportsPrompt: true,
      supportsTranslation: true,
      supportsTimestamps: true,
      maxFileSize: '25MB',
      supportedInputFormats: ['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm'],
    },
  },
  {
    id: 'gpt-4o-transcribe-diarize',
    name: 'GPT-4o Transcribe Diarize',
    description: 'Transcription with speaker diarization - identifies who is speaking when.',
    capability: 'stt',
    metadata: {
      supportedFormats: ['json', 'text', 'diarized_json'],
      supportsStreaming: true,
      supportsPrompt: false,
      supportsDiarization: true,
      maxKnownSpeakers: 4,
      maxFileSize: '25MB',
      supportedInputFormats: ['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm'],
    },
  },
];

// ---------------------------------------------------------------------------
// TTS (Text-to-Speech) Models
// ---------------------------------------------------------------------------

export const OPENAI_TTS_MODELS: ModelInfo[] = [
  {
    id: 'gpt-4o-mini-tts-2025-03-20',
    name: 'GPT-4o Mini TTS (Estavel)',
    description: 'Snapshot estavel do TTS. Suporta instrucoes de voz para sotaque, tom, emocao e velocidade.',
    capability: 'tts',
    isDefault: true,
    metadata: {
      supportsInstructions: true,
      supportsStreaming: true,
      supportedFormats: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'],
      voiceCount: 13,
    },
  },
  {
    id: 'tts-1',
    name: 'TTS-1',
    description: 'Text-to-speech optimized for speed and low latency. Good for real-time applications.',
    capability: 'tts',
    metadata: {
      supportsInstructions: false,
      supportsStreaming: true,
      supportedFormats: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'],
      voiceCount: 9,
    },
  },
  {
    id: 'tts-1-hd',
    name: 'TTS-1 HD',
    description: 'Text-to-speech optimized for quality. Best for pre-rendered audio content.',
    capability: 'tts',
    metadata: {
      supportsInstructions: false,
      supportsStreaming: true,
      supportedFormats: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'],
      voiceCount: 9,
    },
  },
];

// ---------------------------------------------------------------------------
// Omni Audio Models (audio-in → audio-out in a single API call)
// ---------------------------------------------------------------------------

export const OPENAI_OMNI_MODELS: ModelInfo[] = [
  {
    id: 'gpt-audio-mini',
    name: 'GPT Audio Mini',
    description: 'Cost-efficient omni model. Accepts audio input and returns both text and audio in one call (~2s).',
    capability: 'omni',
    isDefault: true,
    metadata: {
      supportsAudioInput: true,
      supportsAudioOutput: true,
      outputFormats: ['wav', 'mp3', 'flac', 'opus', 'pcm16'],
    },
  },
  {
    id: 'gpt-audio',
    name: 'GPT Audio',
    description: 'Full-size omni model. Higher quality audio understanding and generation.',
    capability: 'omni',
    metadata: {
      supportsAudioInput: true,
      supportsAudioOutput: true,
      outputFormats: ['wav', 'mp3', 'flac', 'opus', 'pcm16'],
    },
  },
];

// ---------------------------------------------------------------------------
// Realtime / Audio Models (for reference/future use)
// ---------------------------------------------------------------------------

export const OPENAI_REALTIME_MODELS: ModelInfo[] = [
  {
    id: 'gpt-4o-realtime-preview',
    name: 'GPT-4o Realtime',
    description: 'Realtime model for speech-to-speech interactions via WebRTC/WebSocket.',
    capability: 'realtime',
    metadata: {
      transport: ['webrtc', 'websocket'],
      supportsVAD: true,
    },
  },
  {
    id: 'gpt-4o-mini-realtime-preview',
    name: 'GPT-4o Mini Realtime',
    description: 'Cost-efficient realtime model for speech-to-speech. Recebe audio e responde com audio diretamente.',
    capability: 'realtime',
    isDefault: true,
    metadata: {
      transport: ['webrtc', 'websocket'],
      supportsVAD: true,
      supportsSemanticVAD: true,
    },
  },
];

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

/** All voices available on gpt-4o-mini-tts (the full set) */
const ALL_VOICES: VoiceInfo[] = [
  { id: 'alloy', name: 'Alloy', description: 'Neutral and balanced', supportedModels: ['gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] },
  { id: 'ash', name: 'Ash', description: 'Clear and articulate', supportedModels: ['gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] },
  { id: 'ballad', name: 'Ballad', description: 'Warm and expressive', supportedModels: ['gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts'] },
  { id: 'coral', name: 'Coral', description: 'Friendly and approachable', supportedModels: ['gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] },
  { id: 'echo', name: 'Echo', description: 'Clear and resonant', supportedModels: ['gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] },
  { id: 'fable', name: 'Fable', description: 'Storytelling quality', supportedModels: ['gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] },
  { id: 'nova', name: 'Nova', description: 'Energetic and bright', supportedModels: ['gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] },
  { id: 'onyx', name: 'Onyx', description: 'Deep and authoritative', supportedModels: ['gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] },
  { id: 'sage', name: 'Sage', description: 'Calm and thoughtful', supportedModels: ['gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] },
  { id: 'shimmer', name: 'Shimmer', description: 'Soft and gentle', supportedModels: ['gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] },
  { id: 'verse', name: 'Verse', description: 'Poetic and measured', supportedModels: ['gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts'] },
  { id: 'marin', name: 'Marin', description: 'Recommended - natural and clear', supportedModels: ['gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts'] },
  { id: 'cedar', name: 'Cedar', description: 'Recommended - warm and natural', supportedModels: ['gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts'] },
];

// ---------------------------------------------------------------------------
// Image Models
// ---------------------------------------------------------------------------

export const OPENAI_IMAGE_MODELS: ModelInfo[] = [
  {
    id: 'gpt-image-1',
    name: 'GPT Image 1',
    description: 'High-quality image generation with prompt rewriting. Supports 1024x1024, 1792x1024, 1024x1792.',
    capability: 'image',
    isDefault: true,
  },
  {
    id: 'dall-e-3',
    name: 'DALL-E 3',
    description: 'Creative image generation with automatic prompt enhancement.',
    capability: 'image',
  },
];

export const OPENAI_VOICES = ALL_VOICES;

/**
 * Get voices available for a specific model.
 */
export function getVoicesForModel(modelId: string): VoiceInfo[] {
  return ALL_VOICES.filter(
    (v) => !v.supportedModels || v.supportedModels.includes(modelId)
  );
}
