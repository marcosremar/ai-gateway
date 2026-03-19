// ── Provider types and constants adapted from Cabeção NPM ──

export interface PipelineChainEntry {
  provider: string;
  model: string;
  enabled?: boolean;  // default true — set false to skip this provider
  sttType?: 'streaming' | 'batch';  // only relevant for STT stage
}

export type Latency = 'realtime' | 'low' | 'batch'

export type ServiceKind = 'cloud' | 'gpu-pod'

export interface ProfileService {
  id: string
  name: string
  kind: ServiceKind
  // if cloud:
  cloudProvider?: string   // 'groq' | 'openai' | 'modal' | 'deepgram' | 'tensordock' | etc.
  // if gpu-pod:
  dockerImage?: string
  gpuTypes?: string[]
  gpuCloudProvider?: string  // 'vast' | 'runpod' | 'tensordock' | 'modal'
  // models provided by this GPU pod (optional, per stage)
  sttModel?: string          // e.g. 'faster-whisper-large-v3'
  llmModel?: string          // e.g. 'mistral-7b'
  ttsModel?: string          // e.g. 'qwen3-tts'
}

export interface ProviderProfile {
  id: string;
  name: string;
  latency: Latency;
  enabled?: boolean;
  stt?: PipelineChainEntry[];
  llm: PipelineChainEntry[];
  tts?: PipelineChainEntry[];
  services: ProfileService[];
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
      { id: 'groq',        label: 'Groq',              streaming: false },
      { id: 'openai',      label: 'OpenAI',             streaming: false },
      { id: 'deepgram',    label: 'Deepgram',           streaming: false },
      { id: 'elevenlabs',  label: 'ElevenLabs',         streaming: false },
      { id: 'fireworks',   label: 'Fireworks',          streaming: true  },
      { id: 'gpu',         label: 'GPU (self-hosted)',  streaming: true  },
    ],
    models: {
      groq:       [{ id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo', streaming: false }, { id: 'whisper-large-v3', label: 'Whisper Large v3', streaming: false }],
      openai:     [{ id: 'whisper-1', label: 'Whisper v2', streaming: false }],
      deepgram:   [{ id: 'nova-2', label: 'Nova-2', streaming: false }, { id: 'nova-3', label: 'Nova-3', streaming: false }],
      elevenlabs: [{ id: 'scribe_v2', label: 'Scribe v2', streaming: false }, { id: 'scribe_v1', label: 'Scribe v1', streaming: false }],
      fireworks:  [{ id: 'whisper-large-v3', label: 'Whisper Large v3 (streaming)', streaming: true }],
      gpu:        [{ id: 'faster-whisper-large-v3', label: 'Faster Whisper Large v3', streaming: true }, { id: 'faster-whisper-large-v3-turbo', label: 'Faster Whisper Turbo', streaming: true }, { id: 'whisper', label: 'Faster Whisper', streaming: true }],
    } as Record<string, { id: string; label: string; streaming?: boolean }[]>,
  },
  llm: {
    label: 'LLM',
    subtitle: 'Translation',
    providers: [
      { id: 'groq',       label: 'Groq'              },
      { id: 'openai',     label: 'OpenAI'            },
      { id: 'openrouter', label: 'OpenRouter'        },
      { id: 'gpu',        label: 'GPU (self-hosted)' },
    ],
    models: {
      groq:       [{ id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' }, { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B' }, { id: 'moonsong-labs/moonlight-16b-a3b-instruct', label: 'Moonlight 16B' }],
      openai:     [{ id: 'gpt-4o-mini', label: 'GPT-4o Mini' }, { id: 'gpt-4o', label: 'GPT-4o' }],
      openrouter: [{ id: 'openai/gpt-4o-mini', label: 'GPT-4o Mini' }, { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' }, { id: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' }, { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' }],
      gpu:        [{ id: 'translategemma', label: 'TranslateGemma 12B' }, { id: 'mistral-7b', label: 'Mistral 7B' }, { id: 'gemma-3-4b', label: 'Gemma 3 4B' }, { id: 'gemma3-12b', label: 'Gemma 3 12B' }],
    } as Record<string, { id: string; label: string }[]>,
  },
  tts: {
    label: 'TTS',
    subtitle: 'Text-to-Speech',
    providers: [
      { id: 'gpu',        label: 'GPU (self-hosted)' },
      { id: 'groq',       label: 'Groq'             },
      { id: 'modal',      label: 'Modal'            },
      { id: 'modal-moss', label: 'Modal MOSS'       },
      { id: 'openai',     label: 'OpenAI'           },
    ],
    models: {
      gpu:        [{ id: 'qwen3-tts', label: 'Qwen3 TTS 0.6B' }, { id: 'kokoro-82m', label: 'Kokoro 82M' }],
      groq:       [{ id: 'orpheus-v1-english', label: 'Orpheus v1 (EN)' }],
      modal:      [{ id: 'qwen3-tts', label: 'Qwen3-TTS 0.6B' }, { id: 'kokoro-82m', label: 'Kokoro 82M' }],
      'modal-moss': [{ id: 'moss-tts', label: 'MOSS-TTS' }],
      openai:     [{ id: 'tts-1', label: 'TTS-1' }, { id: 'tts-1-hd', label: 'TTS-1 HD' }],
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
  /** Models provided by this image — auto-fills service form */
  sttModel?: string;
  llmModel?: string;
  ttsModel?: string;
}

export const DEFAULT_DOCKER_IMAGES: DockerImage[] = [
  {
    url: 'marcosremar/babelcast-translategemma:latest',
    label: 'TranslateGemma',
    description: 'Full pipeline: Faster Whisper STT + TranslateGemma 12B LLM + Qwen3 TTS.',
    sttModel: 'faster-whisper-large-v3', llmModel: 'translategemma-12b', ttsModel: 'qwen3-tts',
  },
  {
    url: 'marcosremar/babelcast-mistral:latest',
    label: 'Mistral',
    description: 'Full pipeline: Faster Whisper STT + Mistral 7B LLM + Qwen3 TTS.',
    sttModel: 'faster-whisper-large-v3', llmModel: 'mistral-7b', ttsModel: 'qwen3-tts',
  },
  {
    url: 'marcosremar/babelcast-groq:latest',
    label: 'Groq Cloud',
    description: 'Cloud-only, no local LLM. Fastest boot (~30s). Routes to Groq API.',
  },
  {
    url: 'marcosremar/babelcast-qwen3-tts:latest',
    label: 'Qwen3 TTS',
    description: 'Standalone TTS server with Qwen3 0.6B.',
    ttsModel: 'qwen3-tts',
  },
];

// ── GPU types ──

export const GPU_TYPES = [
  { id: 'NVIDIA GeForce RTX 5090',     label: 'RTX 5090',   vram: '32GB' },
  { id: 'NVIDIA GeForce RTX 5080',     label: 'RTX 5080',   vram: '16GB' },
  { id: 'NVIDIA L40S',                 label: 'L40S',       vram: '48GB' },
  { id: 'NVIDIA GeForce RTX 4090',     label: 'RTX 4090',   vram: '24GB' },
  { id: 'NVIDIA GeForce RTX 4080',     label: 'RTX 4080',   vram: '16GB' },
  { id: 'NVIDIA RTX A6000',            label: 'RTX A6000',  vram: '48GB' },
  { id: 'NVIDIA A100-SXM4-80GB',       label: 'A100 SXM4',  vram: '80GB' },
  { id: 'NVIDIA A100 80GB PCIe',       label: 'A100 PCIe',  vram: '80GB' },
  { id: 'NVIDIA H100 80GB HBM3',       label: 'H100',       vram: '80GB' },
  { id: 'NVIDIA A40',                  label: 'A40',        vram: '48GB' },
  { id: 'NVIDIA RTX A5000',            label: 'RTX A5000',  vram: '24GB' },
  { id: 'NVIDIA GeForce RTX 3090',     label: 'RTX 3090',   vram: '24GB' },
  { id: 'Tesla T4',                    label: 'T4',         vram: '16GB' },
] as const;

// Per-provider GPU lists — matches deploy-settings.ts DEFAULT_GPU_PRIORITY_BY_PROVIDER
export const GPU_TYPES_BY_PROVIDER: Record<string, string[]> = {
  vast: [
    'NVIDIA GeForce RTX 5090',
    'NVIDIA GeForce RTX 5080',
    'NVIDIA L40S',
    'NVIDIA GeForce RTX 4090',
    'NVIDIA GeForce RTX 4080',
    'NVIDIA RTX A6000',
    'NVIDIA A100-SXM4-80GB',
    'NVIDIA A100 80GB PCIe',
    'NVIDIA H100 80GB HBM3',
    'NVIDIA A40',
    'NVIDIA RTX A5000',
    'NVIDIA GeForce RTX 3090',
    'Tesla T4',
  ],
  runpod: [
    'NVIDIA RTX A6000',
    'NVIDIA L40S',
    'NVIDIA A100-SXM4-80GB',
    'NVIDIA A100 80GB PCIe',
    'NVIDIA GeForce RTX 5090',
    'NVIDIA GeForce RTX 4090',
    'NVIDIA A40',
  ],
  tensordock: [
    'NVIDIA GeForce RTX 4090',
    'NVIDIA GeForce RTX 4080',
    'NVIDIA RTX A6000',
    'NVIDIA A40',
    'NVIDIA L40S',
    'NVIDIA A100 80GB PCIe',
    'Tesla T4',
  ],
};
