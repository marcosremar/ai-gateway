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
  defaultMs: number;
}

export const DEFAULT_TIMEOUTS: TimeoutConfig = {
  sttMs: 15_000,
  translateMs: 15_000,
  pipelineMs: 30_000,
  healthMs: 8_000,
  deployMs: 30_000,
  defaultMs: 15_000,
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

// ── STT types ────────────────────────────────────────────────────────────────

export interface TranscribeResult {
  text: string;
  usedGpu: boolean;
}

export interface EnsembleTranscribeResult {
  text: string;
  provider: string;
  allResults: Array<{ provider: string; text: string; latencyMs: number }>;
}

// ── Chat / LLM types ─────────────────────────────────────────────────────────

export interface ChatCompletionResult {
  content: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ── Translation types ────────────────────────────────────────────────────────

export interface TranslateResult {
  translatedText: string;
  usedGpu: boolean;
}

// ── TTS types ────────────────────────────────────────────────────────────────

export interface TtsOptions {
  voice?: string;
  model?: string;
  speed?: number;
  /** Return raw audio buffer instead of base64. Default false. */
  raw?: boolean;
}

export interface TtsResult {
  audioBuffer: Uint8Array;
  contentType: string;
}

// ── Image generation types ───────────────────────────────────────────────────

export interface ImageOptions {
  model?: string;
  size?: string;
  quality?: string;
  n?: number;
}

export interface ImageResult {
  url?: string;
  base64?: string;
  revisedPrompt?: string;
}

// ── Models types ─────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  provider: string;
  type: string;
  contextLength?: number;
}

export interface ModelsResult {
  models: ModelInfo[];
}

// ── Pipeline types ───────────────────────────────────────────────────────────

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

// ── GPU deploy types ─────────────────────────────────────────────────────────

export interface DeployOptions {
  apiKey: string;
  dockerImage?: string;
  gpuTypes?: string[];
  maxCostUsd?: number;
  containerDiskInGb?: number;
  interruptible?: boolean;
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

export interface GpuInstance {
  podId: string;
  provider: string;
  status: string;
  gpuType: string;
  endpoint?: string;
  costPerHr?: number;
  label?: string;
  createdAt?: string;
}

export interface GpuOffer {
  id: string;
  provider: string;
  gpuType: string;
  gpuCount: number;
  vramGb: number;
  pricePerHr: number;
  region?: string;
  score?: number;
}

export interface GpuPreflightResult {
  canAfford: boolean;
  estimatedHourlyCost: number;
  balanceUsd: number;
  warnings: string[];
  errors: string[];
}

export interface GpuSnapshotResult {
  snapshotId?: string;
  status: string;
  createdAt?: string;
}

export interface GpuReadinessResult {
  ready: boolean;
  phase: string;
  benchmarkScore?: number;
  lastCheckedAt?: string;
  detail?: string;
}

export interface GpuLatencyHost {
  host: string;
  rttMs: number;
  gpuType?: string;
  provider?: string;
  reputation?: number;
  lastProbed?: string;
}

export interface CanaryStatus {
  active: boolean;
  deployId?: string;
  trafficPct: number;
  errorRate?: number;
  rolledBack?: boolean;
}

// ── Docker types ─────────────────────────────────────────────────────────────

export interface DockerBuildOptions {
  name: string;
  tag?: string;
  platforms?: string;
  public?: boolean;
  wait?: boolean;
}

export interface DockerBuild {
  buildId: string;
  name: string;
  status: string;
  imageUrl?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface DockerImage {
  name: string;
  imageUrl: string;
  builtAt: string;
  platform?: string;
}

// ── Bot types ────────────────────────────────────────────────────────────────

export interface BotDeployOptions {
  meetingUrl?: string;
  platform?: 'zoom' | 'teams' | 'meet';
  targetLang?: string;
}

export interface BotJoinOptions {
  meetingUrl: string;
  platform?: 'zoom' | 'teams' | 'meet';
}

export interface BotStatus {
  status: string;
  botId?: string;
  meetingUrl?: string;
  platform?: string;
  joinedAt?: string;
}

// ── Workload types ───────────────────────────────────────────────────────────

export interface WorkloadOptions {
  type: 'gpu' | 'bot' | 'db';
  name?: string;
  config?: Record<string, unknown>;
}

export interface Workload {
  workloadId: string;
  type: string;
  name?: string;
  status: string;
  createdAt: string;
}

// ── Observability types ──────────────────────────────────────────────────────

export interface RequestLog {
  requestId: string;
  stage: string;
  provider: string;
  latencyMs: number;
  success: boolean;
  inputSize?: number;
  outputSize?: number;
  tokenCount?: number;
  timestamp: string;
}

export interface RequestLogsResult {
  logs: RequestLog[];
  total: number;
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

// ── Tools discovery types ────────────────────────────────────────────────────

export interface ToolDescriptor {
  name: string;
  description: string;
  category?: string;
  parameters?: Record<string, unknown>;
}

export interface ToolsResult {
  tools: ToolDescriptor[];
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

// ── Lightning AI types ───────────────────────────────────────────────────────

export type LightningStudioPhase =
  | 'CLOUD_SPACE_INSTANCE_STATE_RUNNING'
  | 'CLOUD_SPACE_INSTANCE_STATE_PENDING'
  | 'STOPPED';

export interface LightningStudioStatus {
  phase: LightningStudioPhase | string;
  running: boolean;
  sshUser?: string;
  sshHost?: string;
  instanceId?: string;
  startedAt?: string;
  activeSessions?: number;
}
