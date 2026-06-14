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
  /** Opt in to transparently calling Groq directly when the gateway is
   *  unreachable (#839). This bills Groq and bypasses gateway routing / cost
   *  tracking, so it is **off by default** even when a `groqApiKey`/`GROQ_API_KEY`
   *  is present. Set `true` to restore the legacy auto-fallback behaviour. */
  fallbackToGroq?: boolean;
  /** Per-endpoint timeout overrides (milliseconds) */
  timeouts?: {
    stt?: number;
    translate?: number;
    pipeline?: number;
    tts?: number;
    health?: number;
    deploy?: number;
  };
  /** Max retry attempts for connection-level failures (gateway restart tolerance).
   *  Default: 4. Set 0 to disable retries (HTTP errors and timeouts are never retried). */
  maxRetries?: number;
  /** Per-attempt backoff delays in ms. The last entry is reused for further attempts.
   *  Default: [500, 1000, 2000, 4000]. */
  retryBackoffMs?: number[];
  /** Emit an `X-Request-ID` header on every request (#837) so calls can be
   *  cross-correlated with gateway logs. Default: true. The id of the most recent
   *  request is readable via `sdk.lastRequestId()`. */
  requestId?: boolean;
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

/** Per-stage + total timing for a pipeline run. Per-stage fields (#828) mirror
 *  the Python/`sdk/node` clients so latency debugging works from this client too.
 *  Stage fields are optional — the gateway may omit them on a cache hit. */
export interface PipelineTiming {
  /** End-to-end wall time for the whole pipeline (ms). */
  totalMs: number;
  /** Whether a GPU tier served the request. */
  usedGpu: boolean;
  /** Speech-to-text stage time (ms), when reported. */
  sttMs?: number;
  /** LLM/translation stage time (ms), when reported. */
  llmMs?: number;
  /** Text-to-speech stage time (ms), when reported. */
  ttsMs?: number;
}

export interface PipelineResponse {
  transcription: string;
  response: string;
  audioBase64: string;
  contentType: string;
  timing: PipelineTiming;
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
  deployId: string;
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
  /** Region hint passed through to the provider (e.g. "US"). */
  region?: string;
  /** Per-deploy hourly cost ceiling (USD). The gateway rejects the deploy if the
   *  cheapest matching offer exceeds this — prevents a fat-fingered expensive GPU. */
  maxCostUsd?: number;
  /** Container disk size in GB (0–100). */
  containerDiskInGb?: number;
  /** Request a cheaper interruptible/spot instance. */
  interruptible?: boolean;
}

export interface DeployResponse {
  deployId: string;
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

/** A single streamed chat token/usage delta (#831). The async-iterator from
 *  `chatStream()` yields these so SDK consumers get the same token-by-token UX
 *  as the CLI. `done` marks the final `[DONE]` sentinel. */
export interface ChatStreamChunk {
  /** Incremental content delta, when present. */
  content?: string;
  /** Token usage, emitted on the final chunk by some providers. */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** True for the terminal sentinel chunk. */
  done?: boolean;
}

// ── Ensemble transcription (#877) ────────────────────────────────────────────

/** One provider's contribution to an ensemble transcription. */
export interface EnsembleProviderResult {
  provider: string;
  text: string;
  latencyMs?: number;
}

/** Rich ensemble-transcription result (#877) — mirrors the Python SDK's
 *  `EnsembleTranscribeResponse` (consensus + per-provider + correction) so the
 *  TS client returns more than a flat text string. */
export interface EnsembleTranscribeResponse {
  /** Consensus (best) transcription text. */
  consensus: string;
  /** Per-provider results keyed by provider name. */
  providers: Record<string, EnsembleProviderResult>;
  /** How many providers contributed to the consensus. */
  usedProviders: number;
  /** End-to-end ensemble latency (ms). */
  latencyMs: number;
  /** Optional LLM-corrected text (when `llmCorrect` was requested). */
  corrected?: string;
  /** Whether an LLM correction pass was applied. */
  correctionApplied: boolean;
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
  deployId?: string;
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

// ── Workload types ────────────────────────────────────────────────────────

export type WorkloadType = 'gpu' | 'bot' | 'db';
export type WorkloadStatus = 'idle' | 'deploying' | 'running' | 'stopped' | 'error';

export interface WorkloadInfo {
  id: string;
  type: WorkloadType;
  name: string;
  status: WorkloadStatus;
  provider: string;
  endpoint?: string;
  costPerHr: number;
  instanceId?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface WorkloadDeployOptions {
  name: string;
  type: WorkloadType;
  config?: Record<string, unknown>;
}

export interface PaginationOptions {
  /** Max items to return (default: 100) */
  limit?: number;
  /** Offset for pagination (default: 0) */
  offset?: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
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
    /** Structured error code from the gateway body (e.g. "CREDIT_EXHAUSTED",
     *  "PROVIDER_TIMEOUT"), when the server returned one. Lets callers branch on
     *  the code instead of guessing from the HTTP status. (#826) */
    public readonly code?: string,
    /** Whether the gateway flagged the error as retryable, when present. (#826) */
    public readonly retryable?: boolean,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}
