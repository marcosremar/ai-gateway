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
  /** Groq API key for direct fallback when the gateway is unreachable.
   *  Falls back to GROQ_API_KEY env var if not provided. */
  groqApiKey?: string;
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

// ── Chat completions ────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatCompletionResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// ── GPU extended responses ──────────────────────────────────────────────────

export interface GpuOffer {
  id: string | number;
  provider: string;
  gpuName: string;
  vramGb: number;
  pricePerHr: number;
  region?: string;
  available: boolean;
  [key: string]: unknown;
}

export interface GpuInstance {
  instanceId: string;
  instanceName?: string;
  endpoint: string;
  status: string;
  gpuType?: string;
  provider?: string;
}

export interface GpuEventLog {
  type: string;
  lines: number;
  entries: Array<Record<string, unknown>>;
}

export interface StopResumeResponse {
  ok: boolean;
  podId?: string;
  provider?: string;
  message?: string;
}

// ── Config types ───────────────────────────────────────────────────────────

export interface ProviderConfig {
  pipelineStt?: string[];
  pipelineLlm?: string[];
  pipelineTts?: string[];
  [key: string]: unknown;
}

export interface ApiKeyInfo {
  provider: string;
  hint: string;
  set: boolean;
}

// ── Bot types ──────────────────────────────────────────────────────────────

export interface BotDeployOptions {
  meetingUrl: string;
  botName?: string;
  [key: string]: unknown;
}

export interface BotStatus {
  status: string;
  meetingUrl?: string;
  botId?: string;
  [key: string]: unknown;
}

// ── Transcribe options ─────────────────────────────────────────────────────

export interface TranscribeOptions {
  language?: string;
  prompt?: string;
  /** Use ensemble mode — race multiple STT providers, return best result */
  ensemble?: boolean;
}

// ── Profile management ─────────────────────────────────────────────────────

export interface CreateProfileOptions {
  id: string;
  name: string;
  stt?: Array<{ provider: string; model?: string }>;
  llm?: Array<{ provider: string; model?: string }>;
  tts?: Array<{ provider: string; model?: string }>;
  gpuDeploy?: {
    dockerImage: string;
    gpuTypes: string[];
    region?: string;
    timeoutMin?: number;
    raceCount?: number;
  };
  voice?: string;
  language?: string;
  [key: string]: unknown;
}

// ── GPU readiness ──────────────────────────────────────────────────────────

export interface GpuReadinessStatus {
  readinessState: Record<string, unknown>;
  gpuReadyForProduction: boolean;
  gpuShadowMode: boolean;
  perStageP95: { stt: number | null; llm: number | null; tts: number | null };
  targets: { stt: number; llm: number; tts: number };
  [key: string]: unknown;
}

export interface GpuReadinessHistory {
  history: Record<string, unknown>;
  currentState: Record<string, unknown>;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly endpoint: string,
    /** True when the error is a network-level connection failure (gateway unreachable),
     *  as opposed to an HTTP error or timeout. Used to decide whether to fall back to Groq. */
    public readonly isNetworkError: boolean = false,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}
