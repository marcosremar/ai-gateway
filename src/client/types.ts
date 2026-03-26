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

  // ── Self-hosted options ─────────────────────────────────────────────────
  // These fields only apply to self-hosted providers (Ollama, faster-whisper,
  // llama.cpp, RunPod GPU, etc.) that need to be running before they can
  // serve requests. Cloud API providers (Groq, OpenAI, Fireworks) are always
  // available and ignore these fields.

  /**
   * Mark this entry as a self-hosted provider.
   * When true, the gateway will health-check the endpoint on startup
   * and manage its lifecycle (warmup, replicas, keep-alive).
   */
  selfHosted?: boolean;

  /**
   * Base URL for the self-hosted service (e.g. "http://localhost:8000").
   * Used for health checks and to configure the provider's endpoint.
   * Required when selfHosted is true.
   */
  endpoint?: string;

  /**
   * Keep this self-hosted provider always active — health-check on startup
   * and prevent idle shutdown by the autoscaler watchdog.
   * Only effective when selfHosted is true. Cloud APIs ignore this.
   * Default: false (on-demand)
   */
  alwaysActive?: boolean;

  /**
   * Number of active instances to maintain for redundancy.
   * When > 1, the provider appears multiple times in the fallback chain —
   * if instance 1 fails, instance 2 handles the request automatically.
   * Only effective when selfHosted is true and alwaysActive is true.
   * Default: 1
   */
  replicas?: number;
}

// ---------------------------------------------------------------------------
// AI Profile
// ---------------------------------------------------------------------------

export type PresetName = 'voice' | 'chat' | 'stt' | 'tts' | 'llm' | 'system' | 'image' | 'speech-to-speech' | 'openai-realtime';

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
  referenceAudio?: string;  // base64 WAV for voice cloning (MOSS-TTS/Qwen3-TTS)
  refText?: string;         // transcription of reference audio (Qwen3-TTS Base cloning)

  // LLM options
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' | 'text' };

  // STT options
  language?: string;
  sttPrompt?: string;  // Previous transcription context (Whisper initial_prompt)
  sttWordTimestamps?: boolean;  // Request per-word timestamps from STT provider

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
  /** GPU infrastructure registry for deploy/destroy operations. */
  gpuRegistry?: import('../gpu-providers/registry').GpuProviderRegistry;
  /** Performance ranker for reordering fallback chains by observed latency. */
  performanceRanker?: import('../providers/performance-ranker').PerformanceRanker;
  /** Adaptive timeout calculator for per-provider timeout tuning. */
  adaptiveTimeout?: import('../providers/adaptive-timeout').AdaptiveTimeoutCalculator;
  /** TTFAC tracker for TTS routing by time-to-first-audio-chunk. */
  ttfacTracker?: import('../providers/ttfac-tracker').TtfacTracker;
  /** Budget guard for spend enforcement with graceful degradation. */
  budgetGuard?: import('../tracking/budget-guard').BudgetGuard;
  /** Daily spend limit in USD (used with budgetGuard). */
  dailyLimitUsd?: number;
  /** Enable chain auto-diversification (inject backup from different provider family). */
  diversifyChains?: boolean;
}

/** Result of deploying a GPU instance via AIClient.deploy(). */
export interface DeployResult {
  instanceId: string;
  endpoint: string;
  gpuType?: string;
  status: string;
  provider: string;
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
  words?: Array<{ word: string; start: number; end: number }>;
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

// ---------------------------------------------------------------------------
// Warmup Types
// ---------------------------------------------------------------------------

export interface WarmupEntry {
  id: string;
  stage: string;
  provider: string;
  model?: string;
  status: 'ok' | 'error';
  latencyMs: number;
  error?: string;
}

export interface WarmupResult {
  entries: WarmupEntry[];
  totalMs: number;
}
