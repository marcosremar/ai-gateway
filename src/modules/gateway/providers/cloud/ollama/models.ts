import type { ModelInfo } from '../types';

/**
 * Default Ollama models for STT and LLM.
 * Users can pull any model with `ollama pull <model>` — these are just
 * the pre-configured defaults shown in the gateway.
 */

export const OLLAMA_STT_MODELS: ModelInfo[] = [
  {
    id: 'whisper-large-v3-turbo',
    name: 'Whisper Large V3 Turbo',
    description: 'Fast multilingual transcription (local via faster-whisper-server)',
    capability: 'stt',
    isDefault: true,
  },
  {
    id: 'whisper-large-v3',
    name: 'Whisper Large V3',
    description: 'High-accuracy multilingual transcription (local)',
    capability: 'stt',
  },
];

export const OLLAMA_LLM_MODELS: ModelInfo[] = [
  {
    id: 'llama3.2',
    name: 'Llama 3.2 (3B)',
    description: 'Compact local model, good for translation',
    capability: 'llm',
    isDefault: true,
  },
  {
    id: 'llama3.1',
    name: 'Llama 3.1 (8B)',
    description: 'Larger local model, better quality',
    capability: 'llm',
  },
  {
    id: 'mistral',
    name: 'Mistral 7B',
    description: 'Fast general-purpose model',
    capability: 'llm',
  },
  {
    id: 'gemma2',
    name: 'Gemma 2 (9B)',
    description: 'Google Gemma 2, instruction-tuned',
    capability: 'llm',
  },
  {
    id: 'qwen2.5',
    name: 'Qwen 2.5 (7B)',
    description: 'Alibaba Qwen, strong multilingual',
    capability: 'llm',
  },
];
