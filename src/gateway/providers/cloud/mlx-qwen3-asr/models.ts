import type { ModelInfo } from '../types';

export const MLX_QWEN3_ASR_MODELS: ModelInfo[] = [
  {
    id: 'qwen3-asr-0.6b-4bit',
    name: 'Qwen3-ASR 0.6B (4-bit)',
    description: 'Ultra-fast local ASR — 55x realtime on Apple Silicon (quantized)',
    capability: 'stt',
    isDefault: true,
  },
  {
    id: 'qwen3-asr-0.6b',
    name: 'Qwen3-ASR 0.6B (fp16)',
    description: 'High-quality local ASR — ~12x realtime on Apple Silicon',
    capability: 'stt',
  },
  {
    id: 'qwen3-asr-1.7b',
    name: 'Qwen3-ASR 1.7B (fp16)',
    description: 'Best quality local ASR — 3.9% WER on Portuguese FLEURS',
    capability: 'stt',
  },
];
