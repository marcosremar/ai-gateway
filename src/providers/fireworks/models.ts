import type { ModelInfo } from '../types';

export const FIREWORKS_STT_MODELS: ModelInfo[] = [
  {
    id: 'whisper-v3',
    name: 'Whisper V3',
    description: 'Multilingual transcription (Fireworks)',
    capability: 'stt',
    isDefault: true,
  },
];

export const FIREWORKS_LLM_MODELS: ModelInfo[] = [
  {
    id: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    name: 'Llama 3.3 70B Instruct',
    description: 'High-quality open-source model',
    capability: 'llm',
    isDefault: true,
  },
];

export const FIREWORKS_IMAGE_MODELS: ModelInfo[] = [
  {
    id: 'flux-1-dev-fp8',
    name: 'Flux 1 Dev FP8',
    description: 'High-quality image generation (1280x720 default)',
    capability: 'image',
    isDefault: true,
  },
];
