/**
 * AI Handlers Types
 */

import type { IncomingMessage, ServerResponse } from 'http';

export interface TranscribeRequest {
  audio: Buffer;
  language?: string;
  prompt?: string;
  hotwords?: string[];
  wordTimestamps?: boolean;
}

export interface TranscribeResponse {
  text: string;
  language?: string;
  confidence?: number;
  words?: Array<{
    word: string;
    start: number;
    end: number;
  }>;
}

export interface TranslateRequest {
  text: string;
  sourceLang: string;
  targetLang: string;
  context?: string;
  glossary?: string[];
}

export interface TranslateResponse {
  text: string;
  model?: string;
  tokens?: number;
}

export interface TtsPreviewRequest {
  text: string;
  voice?: string;
  speed?: number;
  language?: string;
}

export interface TtsPreviewResponse {
  audio: Buffer;
  format: string;
  duration?: number;
}

export interface PipelineRequest {
  audio?: Buffer;
  text?: string;
  sourceLang?: string;
  targetLangs?: string[];
  options?: {
    stt?: boolean;
    translate?: boolean;
    tts?: boolean;
  };
}

export interface PipelineResponse {
  transcription?: string;
  translations?: Record<string, string>;
  audio?: Buffer;
  metadata?: {
    sttProvider?: string;
    llmProvider?: string;
    ttsProvider?: string;
    durationMs?: number;
  };
}

export interface ChatCompletionRequest {
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finishReason?: string;
  }>;
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface VoiceProfile {
  id: string;
  name: string;
  voiceId: string;
  referenceAudio?: Buffer;
  settings?: {
    speed?: number;
    pitch?: number;
  };
}

export interface AutoSwapConfig {
  enabled: boolean;
  benchmarkInterval?: number;
  threshold?: number;
}

export interface AnalyticsResponse {
  totalRequests: number;
  avgLatency: number;
  p95Latency: number;
  errorRate: number;
  providerDistribution: Record<string, number>;
  stageMetrics: {
    stt: { avgLatency: number; errorRate: number };
    llm: { avgLatency: number; errorRate: number };
    tts: { avgLatency: number; errorRate: number };
  };
}

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface TimeoutConfig {
  stt: number;
  llm: number;
  tts: number;
  pipeline: number;
}
