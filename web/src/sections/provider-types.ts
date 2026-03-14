// ── Provider types and constants adapted from Cabeção NPM ──

export interface PipelineChainEntry {
  provider: string;
  model: string;
  enabled?: boolean;  // default true — set false to skip this provider
}

export interface ProviderProfile {
  id: string;
  name: string;
  mode: 'pipeline' | 'gpu';
  enabled?: boolean;  // default true — set false to skip this profile
  // Pipeline mode
  stt: PipelineChainEntry[];
  llm: PipelineChainEntry[];
  tts: PipelineChainEntry[];
  // GPU deploy mode
  gpuImage?: string;
  gpuTypes?: string[];
  gpuProvider?: string;  // '' = auto
}

// ── Provider button configs ──

export const CLOUD_API_PROVIDERS = [
  { id: 'groq',      name: 'Groq',       iconName: 'Zap',    color: '#7ba896' },
  { id: 'openai',    name: 'OpenAI',     iconName: 'Zap',    color: '#8b8fc7' },
  { id: 'deepgram',  name: 'Deepgram',   iconName: 'Zap',    color: '#6366f1' },
  { id: 'fireworks', name: 'Fireworks',  iconName: 'Zap',    color: '#e07a3a' },
] as const;

export const GPU_PROVIDERS = [
  { id: 'vast',       name: 'Vast.ai',    iconName: 'HardDrive', color: '#7a9fb5' },
  { id: 'tensordock', name: 'TensorDock', iconName: 'HardDrive', color: '#4db6ac' },
  { id: 'runpod',     name: 'RunPod',     iconName: 'HardDrive', color: '#9b8db8' },
] as const;

// ── Pipeline catalog — models/providers per stage ──

export const PIPELINE_CATALOG = {
  stt: {
    label: 'STT',
    subtitle: 'Speech-to-Text',
    providers: [
      { id: 'groq',     label: 'Groq' },
      { id: 'openai',   label: 'OpenAI' },
      { id: 'deepgram', label: 'Deepgram' },
      { id: 'gpu',      label: 'GPU (self-hosted)' },
    ],
    models: {
      groq:     [{ id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo' }, { id: 'whisper-large-v3', label: 'Whisper Large v3' }],
      openai:   [{ id: 'whisper-1', label: 'Whisper v2' }],
      deepgram: [{ id: 'nova-2', label: 'Nova-2' }],
      gpu:      [{ id: 'faster-whisper-large-v3', label: 'Faster Whisper Large v3' }, { id: 'faster-whisper-large-v3-turbo', label: 'Faster Whisper Turbo' }],
    } as Record<string, { id: string; label: string }[]>,
  },
  llm: {
    label: 'LLM',
    subtitle: 'Translation',
    providers: [
      { id: 'groq',   label: 'Groq' },
      { id: 'openai', label: 'OpenAI' },
      { id: 'gpu',    label: 'GPU (self-hosted)' },
    ],
    models: {
      groq:   [{ id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' }, { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B' }],
      openai: [{ id: 'gpt-4o-mini', label: 'GPT-4o Mini' }, { id: 'gpt-4o', label: 'GPT-4o' }],
      gpu:    [{ id: 'mistral-7b', label: 'Mistral 7B' }, { id: 'gemma-3-4b', label: 'Gemma 3 4B' }],
    } as Record<string, { id: string; label: string }[]>,
  },
  tts: {
    label: 'TTS',
    subtitle: 'Text-to-Speech',
    providers: [
      { id: 'gpu',    label: 'GPU (self-hosted)' },
      { id: 'groq',   label: 'Groq' },
      { id: 'openai', label: 'OpenAI' },
    ],
    models: {
      gpu:    [{ id: 'qwen3-tts', label: 'Qwen3 TTS 0.6B' }, { id: 'kokoro-82m', label: 'Kokoro 82M' }],
      groq:   [{ id: 'orpheus-v1-english', label: 'Orpheus v1 (EN)' }],
      openai: [{ id: 'tts-1', label: 'TTS-1' }, { id: 'tts-1-hd', label: 'TTS-1 HD' }],
    } as Record<string, { id: string; label: string }[]>,
  },
} as const;

// ── Stage accent colors ──

export const STAGE_ACCENTS = {
  stt: {
    iconBg: 'background: color-mix(in srgb, #0ea5e9 15%, transparent)',
    iconColor: '#0ea5e9',
    dot: '#0ea5e9',
  },
  llm: {
    iconBg: 'background: color-mix(in srgb, #8b5cf6 15%, transparent)',
    iconColor: '#8b5cf6',
    dot: '#8b5cf6',
  },
  tts: {
    iconBg: 'background: color-mix(in srgb, #f59e0b 15%, transparent)',
    iconColor: '#f59e0b',
    dot: '#f59e0b',
  },
} as const;

// ── Docker images ──

export interface DockerImage {
  url: string;
  label: string;
  description: string;
}

export const DEFAULT_DOCKER_IMAGES: DockerImage[] = [
  {
    url: 'marcosremar/babelcast-mistral:latest',
    label: 'Mistral',
    description: 'Full pipeline with Mistral 7B LLM + Faster Whisper STT + Qwen3 TTS. Hybrid mode: uses Groq as fallback when GPU is busy.',
  },
  {
    url: 'marcosremar/babelcast-groq:latest',
    label: 'Groq Cloud',
    description: 'Cloud-only image, no local LLM. Fastest boot time (~30s). Routes all requests to Groq API.',
  },
  {
    url: 'marcosremar/babelcast-qwen3-tts:latest',
    label: 'Qwen3 TTS',
    description: 'Standalone TTS server with Qwen3 0.6B. Use when you only need text-to-speech on GPU.',
  },
];

/** @deprecated Use DockerImage[] state instead */
export const DOCKER_IMAGES = DEFAULT_DOCKER_IMAGES.map(d => ({ value: d.url, label: d.label }));

// ── GPU types ──

export const GPU_TYPES = [
  { id: 'NVIDIA RTX A6000',            label: 'RTX A6000',  vram: '48GB' },
  { id: 'NVIDIA L40S',                 label: 'L40S',       vram: '48GB' },
  { id: 'NVIDIA A100-SXM4-80GB',       label: 'A100 SXM4',  vram: '80GB' },
  { id: 'NVIDIA A100-PCIE-80GB',       label: 'A100 PCIe',  vram: '80GB' },
  { id: 'NVIDIA GeForce RTX 5090',     label: 'RTX 5090',   vram: '32GB' },
  { id: 'NVIDIA GeForce RTX 5080',     label: 'RTX 5080',   vram: '16GB' },
  { id: 'NVIDIA GeForce RTX 4090',     label: 'RTX 4090',   vram: '24GB' },
  { id: 'NVIDIA A40',                  label: 'A40',        vram: '48GB' },
] as const;
