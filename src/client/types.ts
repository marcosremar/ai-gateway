/**
 * AIClient Types — Profile-based unified client for STT, LLM, TTS, and pipeline.
 */

import type { TTSAudioFormat, ChatMessage, ProviderId } from '../providers/types';
import type { AIProviderRegistry } from '../providers/registry';
import type { FallbackOptions } from '../providers/fallback';
import type { Autoscaler } from '../factory';
import type { AutoScalerConfig } from '../types';
import type { Logger } from '../deps';

// ---------------------------------------------------------------------------
// Stage Config
// ---------------------------------------------------------------------------

/** A single provider+model entry in a fallback chain */
export interface StageConfig {
  provider: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// AI Profile
// ---------------------------------------------------------------------------

export type PresetName = 'voice' | 'chat' | 'stt' | 'tts' | 'llm' | 'system' | 'image';

export interface AIProfile {
  preset?: PresetName;

  // Fallback chains per stage (ordered by priority)
  stt?: StageConfig[];
  llm?: StageConfig[];
  tts?: StageConfig[];
  image?: StageConfig[];
  omni?: StageConfig[];
  realtime?: StageConfig[];

  // API keys per provider
  keys?: Record<string, string>;

  // TTS options
  voice?: string;
  audioFormat?: TTSAudioFormat;
  voiceInstructions?: string;

  // LLM options
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' | 'text' };

  // STT options
  language?: string;

  // Image options
  imageWidth?: number;
  imageHeight?: number;
  imageSteps?: number;

  // GPU endpoint (explicit override — skips autoscaler)
  gpuEndpoint?: string;

  // Fallback tuning
  fallbackOptions?: Partial<FallbackOptions>;

  // Declarative fallback chains (overrides per-stage arrays)
  fallbackChains?: import('../providers/declarative-chain').FallbackChainConfig[];
}

// ---------------------------------------------------------------------------
// Client Options
// ---------------------------------------------------------------------------

export interface AIClientOptions {
  registry: AIProviderRegistry;
  autoscaler?: Autoscaler;
  userId?: string;
  defaultProfile?: AIProfile | PresetName;
  loadAutoscalerConfig?: () => Promise<AutoScalerConfig | null>;
  logger?: Logger;
  spendTracker?: import('../tracking/spend-tracker').SpendTracker;
}

// ---------------------------------------------------------------------------
// Result Types
// ---------------------------------------------------------------------------

interface BaseResult {
  provider: string;
  model?: string;
  fallbackUsed: boolean;
  latencyMs: number;
}

export interface TranscribeResult extends BaseResult {
  text: string;
  language?: string;
  duration?: number;
}

export interface ChatResult extends BaseResult {
  content: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface SynthesizeResult extends BaseResult {
  audio: Buffer;
  contentType: string;
}

export interface ImageResult extends BaseResult {
  image: Buffer;
  contentType: string;
  revisedPrompt?: string;
}

export interface OmniResult extends BaseResult {
  text: string;
  audio: Buffer;
  audioBase64: string;
  contentType: string;
  userTranscript?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface RealtimeResult {
  clientSecret: string;
  expiresAt: number;
  provider: string;
  model: string;
}

export interface PipelineResult {
  stt: TranscribeResult;
  chat: ChatResult;
  tts: SynthesizeResult;
  totalLatencyMs: number;
  usedGpu: boolean;
}
