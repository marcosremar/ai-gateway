import type { ModelInfo, VoiceInfo } from '../types';

export const GROQ_STT_MODELS: ModelInfo[] = [
  {
    id: 'whisper-large-v3-turbo',
    name: 'Whisper Large V3 Turbo',
    description: 'Fast multilingual transcription (Groq-optimized)',
    capability: 'stt',
    isDefault: true,
  },
  {
    id: 'whisper-large-v3',
    name: 'Whisper Large V3',
    description: 'High-accuracy multilingual transcription',
    capability: 'stt',
  },
];

export const GROQ_TTS_MODELS: ModelInfo[] = [
  {
    id: 'canopylabs/orpheus-v1-english',
    name: 'Orpheus v1 English',
    description: 'High-quality English TTS by Canopy Labs via Groq',
    capability: 'tts',
    isDefault: true,
  },
  {
    id: 'canopylabs/orpheus-arabic-saudi',
    name: 'Orpheus Arabic (Saudi)',
    description: 'Arabic-optimized TTS by Canopy Labs via Groq',
    capability: 'tts',
  },
];

export const GROQ_TTS_VOICES: VoiceInfo[] = [
  { id: 'autumn', name: 'Autumn', description: 'Female voice' },
  { id: 'diana', name: 'Diana', description: 'Female voice' },
  { id: 'hannah', name: 'Hannah', description: 'Female voice' },
  { id: 'austin', name: 'Austin', description: 'Male voice' },
  { id: 'daniel', name: 'Daniel', description: 'Male voice' },
  { id: 'troy', name: 'Troy', description: 'Male voice' },
];

export const GROQ_LLM_MODELS: ModelInfo[] = [
  {
    id: 'llama-3.3-70b-versatile',
    name: 'Llama 3.3 70B Versatile',
    description: 'High-quality general-purpose model',
    capability: 'llm',
    isDefault: true,
  },
  {
    id: 'llama-3.1-8b-instant',
    name: 'Llama 3.1 8B Instant',
    description: 'Fast, cost-effective model',
    capability: 'llm',
  },
  {
    id: 'gemma2-9b-it',
    name: 'Gemma 2 9B IT',
    description: 'Google Gemma 2, instruction-tuned',
    capability: 'llm',
  },
  {
    id: 'mixtral-8x7b-32768',
    name: 'Mixtral 8x7B',
    description: 'Mistral MoE model, 32K context',
    capability: 'llm',
  },
];
