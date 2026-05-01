import type { ModelInfo } from '../types';

export const OPENROUTER_IMAGE_MODELS: ModelInfo[] = [
  {
    id: 'google/gemini-2.5-flash-image',
    name: 'Gemini 2.5 Flash Image',
    description: 'Fast image generation via Gemini multimodal (via OpenRouter)',
    capability: 'image',
    isDefault: true,
  },
  {
    id: 'google/gemini-3.1-flash-image-preview',
    name: 'Gemini 3.1 Flash Image Preview',
    description: 'Next-gen image generation via Gemini (via OpenRouter)',
    capability: 'image',
  },
];

export const OPENROUTER_LLM_MODELS: ModelInfo[] = [
  {
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o Mini',
    description: 'Fast and cost-effective (via OpenRouter)',
    capability: 'llm',
    isDefault: true,
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    description: 'High-quality reasoning (via OpenRouter)',
    capability: 'llm',
  },
  {
    id: 'google/gemini-2.0-flash-001',
    name: 'Gemini 2.0 Flash',
    description: 'Fast multimodal model (via OpenRouter)',
    capability: 'llm',
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    name: 'Llama 3.3 70B',
    description: 'Open-source high-quality (via OpenRouter)',
    capability: 'llm',
  },
];
