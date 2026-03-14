/**
 * @ai-gateway/sdk — Typed HTTP client for the BabelCast AI Gateway REST API.
 *
 * Response types shared between TypeScript and Python SDKs.
 * Keep in sync with: ai-gateway/sdk/python/gateway_sdk/types.py
 */

// ── Configuration ───────────────────────────────────────────────────────────

export interface GatewayConfig {
  /** Gateway base URL, e.g. "http://localhost:4000" */
  baseUrl: string;
  /** Optional Bearer token for authenticated endpoints */
  apiKey?: string;
  /** Per-endpoint timeout overrides (milliseconds) */
  timeouts?: {
    stt?: number;
    translate?: number;
    pipeline?: number;
    tts?: number;
    health?: number;
    deploy?: number;
  };
}

// ── Inference responses ─────────────────────────────────────────────────────

export interface TranscribeResponse {
  text: string;
  usedGpu: boolean;
}

export interface TranslateResponse {
  translatedText: string;
  usedGpu: boolean;
}

export interface PipelineResponse {
  transcription: string;
  response: string;
  audioBase64: string;
  contentType: string;
  timing: {
    totalMs: number;
    usedGpu: boolean;
  };
}

export interface PipelineOptions {
  source?: string;
  target?: string;
  speaker?: string;
}

export interface GenerateAudioOptions {
  /** Voice/speaker name (default: "Ryan"). */
  speaker?: string;
  /** Language name, e.g. "English", "French" (default: "English"). */
  language?: string;
  /** Playback speed multiplier, e.g. 0.8 (slower) or 1.5 (faster). Default: 1.0. */
  speed?: number;
}

export interface GenerateAudioResponse {
  /** Raw WAV audio bytes. */
  audio: Uint8Array;
  /** Always "audio/wav". */
  contentType: string;
  /** True if the GPU pod was used. */
  usedGpu: boolean;
}

export interface TtsVoice {
  id: string;
  name: string;
  language: string;
  gender: 'male' | 'female';
}

export interface ListVoicesResponse {
  voices: TtsVoice[];
}

// ── GPU management responses ────────────────────────────────────────────────

export interface GpuStatus {
  status: 'idle' | 'creating' | 'booting' | 'installing' | 'ready' | 'error';
  podId: string;
  endpoint: string;
  gpuType: string;
  message: string;
  step: string;
  stepDetail: string;
  gpuHealthy: boolean;
  activeTier: 'gpu' | 'cloud';
  idleSec: number;
  idleTimeoutSec: number;
  elapsedSec: number;
  startedAt: number;
  retryCount: number;
}

export interface DeployOptions {
  apiKey: string;
  dockerImage?: string;
  gpuTypes?: string[];
}

export interface DeployResponse {
  status: string;
  message: string;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}
