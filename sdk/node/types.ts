/**
 * Types for the GatewayHttpClient — mirrors gateway_sdk/types.py.
 */

// ── Config types ────────────────────────────────────────────────────────────

export interface RetryConfig {
  /** Max connection-level retries (NOT for HTTP errors). Default: 4 */
  maxRetries: number;
  /** Backoff delays in ms. Default: [500, 1000, 2000, 4000] */
  backoffMs: number[];
}

export interface CircuitBreakerConfig {
  /** Consecutive failures before opening. Default: 5 */
  failureThreshold: number;
  /** Time in ms before trying half-open. Default: 30000 */
  recoveryTimeoutMs: number;
  /** Successes in half-open before closing. Default: 2 */
  successThreshold: number;
}

export interface GatewayHttpClientConfig {
  baseUrl: string;
  apiKey?: string;
  /** Groq API key for direct fallback when gateway is unreachable. Falls back to GROQ_API_KEY env var. */
  groqApiKey?: string;
  timeouts?: Partial<TimeoutConfig>;
  retry?: Partial<RetryConfig>;
  circuitBreaker?: Partial<CircuitBreakerConfig>;
}

export interface TimeoutConfig {
  sttMs: number;
  translateMs: number;
  pipelineMs: number;
  healthMs: number;
  deployMs: number;
}

export const DEFAULT_TIMEOUTS: TimeoutConfig = {
  sttMs: 15_000,
  translateMs: 15_000,
  pipelineMs: 30_000,
  healthMs: 8_000,
  deployMs: 30_000,
};

export const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 4,
  backoffMs: [500, 1000, 2000, 4000],
};

export const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerConfig = {
  failureThreshold: 5,
  recoveryTimeoutMs: 30_000,
  successThreshold: 2,
};

// ── Response types ──────────────────────────────────────────────────────────

export interface TranscribeResult {
  text: string;
  usedGpu: boolean;
}

export interface ChatCompletionResult {
  content: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface TranslateResult {
  translatedText: string;
  usedGpu: boolean;
}

export interface PipelineTiming {
  totalMs: number;
  sttMs: number;
  llmMs: number;
  ttsMs: number;
  usedGpu: boolean;
}

export interface PipelineResult {
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

export interface DeployOptions {
  apiKey: string;
  dockerImage?: string;
  gpuTypes?: string[];
}

export interface GpuStatus {
  status: string;
  podId: string;
  endpoint: string;
  gpuType: string;
  message: string;
  step: string;
  stepDetail: string;
  elapsedSec: number;
  gpuHealthy: boolean;
  activeTier: string;
  idleSec: number;
  idleTimeoutSec: number;
  startedAt: number;
  retryCount: number;
}

// ── Health types ────────────────────────────────────────────────────────────

export interface ComponentHealth {
  status: 'ok' | 'degraded' | 'unavailable';
  provider?: string;
  reason?: string;
  endpoint?: string;
  healthy?: boolean;
  idleSec?: number;
}

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  uptimeSec: number;
  components: Record<string, ComponentHealth>;
  /** Convenience: true when status is 'ok' or 'degraded' */
  isHealthy: boolean;
}

// ── Metrics types ───────────────────────────────────────────────────────────

export interface GatewayMetrics {
  requestsTotal: number;
  requestsByStage: Record<string, number>;
  requestsByProvider: Record<string, number>;
  errorsTotal: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  gpuStatus: string;
  uptimeSec: number;
}
