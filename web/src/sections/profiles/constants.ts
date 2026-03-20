import {
  Mic, Bot, Volume2, ClipboardCheck, Sparkles, Brain, Clock, Gauge, Timer,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  type PipelineChainEntry, type ProviderProfile,
} from '../provider-types';

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

// ── Stage types ──

export interface ProfileStage {
  id: string;
  key: string;          // 'stt' | 'llm' | 'tts' | 'eval' | custom
  label: string;
  chain: PipelineChainEntry[];
  enabled: boolean;
  input?: string;       // 'audio' | 'text' | 'vector' | custom
  output?: string;
}

export interface StageCatalogEntry {
  key: string;
  label: string;
  subtitle: string;
  icon: LucideIcon;
  color: string;
  defaultChain: PipelineChainEntry[];
  input: string;
  output: string;
}

// ── Defaults ──

export const DEFAULT_STT: PipelineChainEntry[] = [{ provider: 'groq', model: 'whisper-large-v3-turbo' }];
export const DEFAULT_LLM: PipelineChainEntry[] = [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }];
export const DEFAULT_TTS: PipelineChainEntry[] = [{ provider: 'gpu', model: 'qwen3-tts' }];

export const STAGE_CATALOG: StageCatalogEntry[] = [
  { key: 'stt', label: 'STT', subtitle: 'Speech-to-Text', icon: Mic, color: '#0ea5e9', defaultChain: DEFAULT_STT, input: 'audio', output: 'text' },
  { key: 'llm', label: 'LLM', subtitle: 'Translation', icon: Bot, color: '#8b5cf6', defaultChain: DEFAULT_LLM, input: 'text', output: 'text' },
  { key: 'tts', label: 'TTS', subtitle: 'Text-to-Speech', icon: Volume2, color: '#f59e0b', defaultChain: DEFAULT_TTS, input: 'text', output: 'audio' },
  { key: 'eval', label: 'Eval', subtitle: 'Quality Evaluation', icon: ClipboardCheck, color: '#10b981', defaultChain: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }], input: 'text', output: 'text' },
  { key: 'postprocess', label: 'Post', subtitle: 'Post-processing', icon: Sparkles, color: '#ec4899', defaultChain: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }], input: 'text', output: 'text' },
  { key: 'embedding', label: 'Embed', subtitle: 'Embedding', icon: Brain, color: '#06b6d4', defaultChain: [{ provider: 'openai', model: 'text-embedding-3-small' }], input: 'text', output: 'vector' },
];

export const STAGE_ACCENT: Record<string, { color: string; Icon: LucideIcon }> = {};
for (const s of STAGE_CATALOG) STAGE_ACCENT[s.key] = { color: s.color, Icon: s.icon };

/** Default stages for a new profile */
export const DEFAULT_STAGES: ProfileStage[] = [
  { id: uid(), key: 'stt', label: 'STT', chain: [...DEFAULT_STT], enabled: true },
  { id: uid(), key: 'llm', label: 'LLM', chain: [...DEFAULT_LLM], enabled: true },
  { id: uid(), key: 'tts', label: 'TTS', chain: [...DEFAULT_TTS], enabled: true },
];

// ── Conversion helpers ──

/** Convert legacy stt/llm/tts fields to stages array */
export function profileToStages(p: ProviderProfile): ProfileStage[] {
  const stages: ProfileStage[] = [];
  if (p.stt !== undefined) stages.push({ id: uid(), key: 'stt', label: 'STT', chain: p.stt.length ? p.stt : DEFAULT_STT, enabled: true });
  stages.push({ id: uid(), key: 'llm', label: 'LLM', chain: p.llm?.length ? p.llm : DEFAULT_LLM, enabled: true });
  if (p.tts !== undefined) stages.push({ id: uid(), key: 'tts', label: 'TTS', chain: p.tts.length ? p.tts : DEFAULT_TTS, enabled: true });
  // Load custom stages if present
  if ((p as any).customStages) {
    for (const cs of (p as any).customStages) {
      stages.push({ id: uid(), key: cs.key, label: cs.label, chain: cs.chain || [], enabled: cs.enabled !== false });
    }
  }
  return stages;
}

/** Convert stages array back to profile fields */
export function stagesToProfileFields(stages: ProfileStage[]): {
  stt?: PipelineChainEntry[]; llm: PipelineChainEntry[]; tts?: PipelineChainEntry[];
  customStages?: { key: string; label: string; chain: PipelineChainEntry[]; enabled: boolean }[];
} {
  const sttStage = stages.find(s => s.key === 'stt' && s.enabled);
  const llmStage = stages.find(s => s.key === 'llm' && s.enabled);
  const ttsStage = stages.find(s => s.key === 'tts' && s.enabled);
  const custom = stages.filter(s => !['stt', 'llm', 'tts'].includes(s.key));
  return {
    // Only include stage if it has at least one chain entry; empty chains are omitted
    stt: sttStage?.chain.length ? sttStage.chain : undefined,
    llm: llmStage?.chain.length ? llmStage.chain : DEFAULT_LLM,
    tts: ttsStage?.chain.length ? ttsStage.chain : undefined,
    ...(custom.length > 0 ? { customStages: custom.map(s => ({ key: s.key, label: s.label, chain: s.chain, enabled: s.enabled })) } : {}),
  };
}

// ── Latency ──

import type { Latency } from '../provider-types';

export const LATENCY_OPTIONS: { value: Latency; label: string; sub: string; color: string; Icon: typeof Clock }[] = [
  { value: 'realtime', label: 'realtime', sub: '<300ms', color: '#10b981', Icon: Gauge },
  { value: 'low', label: 'low', sub: '<1s', color: '#3b82f6', Icon: Timer },
  { value: 'batch', label: 'batch', sub: 'no limit', color: '#6b7280', Icon: Clock },
];

// ── Provider metadata ──

export const PROVIDER_META: Record<string, { label: string; color: string; type: string }> = {
  gpu:          { label: 'GPU Pod',    color: '#f59e0b', type: 'Self-hosted' },
  groq:         { label: 'Groq',       color: '#7ba896', type: 'Cloud API'   },
  modal:        { label: 'Modal',      color: '#a78bfa', type: 'Serverless'  },
  'modal-moss': { label: 'Modal MOSS', color: '#c084fc', type: 'Serverless'  },
  openai:       { label: 'OpenAI',     color: '#8b8fc7', type: 'Cloud API'   },
  deepgram:     { label: 'Deepgram',   color: '#6366f1', type: 'Cloud API'   },
  elevenlabs:   { label: 'ElevenLabs', color: '#f43f5e', type: 'Cloud API'   },
  fireworks:    { label: 'Fireworks',  color: '#e07a3a', type: 'Cloud API'   },
  openrouter:   { label: 'OpenRouter', color: '#34d399', type: 'Cloud API'   },
  ollama:       { label: 'Ollama',     color: '#94a3b8', type: 'Self-hosted' },
};

export function pMeta(provider: string) {
  return PROVIDER_META[provider] ?? { label: provider, color: '#8b949e', type: 'API' };
}

// ── Inline pipeline test types ──

export type TestStageState = 'idle' | 'active' | 'done' | 'error';

export interface TestStageStatus {
  key: string;
  state: TestStageState;
  latencyMs?: number;
  provider?: string;
  ttfacMs?: number;
}

export interface TestResult {
  transcription?: string;
  translation?: string;
  audioBase64?: string;
  contentType?: string;
  totalMs?: number;
  usedGpu?: boolean;
  stages: TestStageStatus[];
  error?: string;
  ttfacMs?: number;
}

export type TestTransport = 'http' | 'sse' | 'ws' | 'webrtc';

export interface TransportLatency {
  transport: TestTransport;
  totalMs?: number;
  ttfacMs?: number;
  audioDurationSec?: number;
  error?: string;
  running: boolean;
  audioBase64?: string;
  contentType?: string;
}

export interface FlowStage {
  key: string;
  label: string;
  sublabel: string;
  chain: PipelineChainEntry[];
  enabled: boolean;
  color: string;
  input: string;
  output: string;
}

export interface RaceResult {
  raceCount: number;
  winnerMs: number;
  gpuType?: string;
  provider?: string;
  completedAt: number;
}

export function fmtBootTime(ms: number) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

export const IO_OPTIONS = ['audio', 'text', 'vector', 'image'];
