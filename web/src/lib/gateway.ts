const GATEWAY = typeof window !== 'undefined'
  ? (process.env.NEXT_PUBLIC_GATEWAY_URL || window.location.origin)
  : 'http://localhost:4000';

async function gw(path: string, opts?: RequestInit): Promise<Response> {
  return fetch(`${GATEWAY}${path}`, opts);
}

async function gwJson<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await gw(path, opts);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gateway ${res.status}: ${body}`);
  }
  return res.json();
}

async function gwPost<T>(path: string, body?: unknown): Promise<T> {
  return gwJson<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ── Health & Metrics ──

export interface HealthResponse {
  status: string;
  uptime_sec: number;
  gpu: string;
  providers: Record<string, boolean>;
  components: Record<string, { status: string; provider?: string; endpoint?: string; healthy?: boolean; idle_sec?: number }>;
  latency: { p50_ms: number; p95_ms: number; p99_ms: number; samples: number };
  budget: { dailySpendUsd: number; dailyLimitUsd: number | null; exceeded: boolean };
  providerMetrics: Record<string, { avgLatencyMs: number; requests: number; errorRate: number }>;
  pendingDbWrites: number;
  reason?: string;
}

export async function getHealth(): Promise<HealthResponse> {
  return gwJson('/health');
}

export interface MetricsResponse {
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

export async function getMetrics(): Promise<MetricsResponse> {
  return gwJson('/metrics');
}

export interface RequestLogEntry {
  id: number;
  timestamp: number;
  stage: string;
  provider: string;
  model: string | null;
  latencyMs: number;
  success: boolean;
  error: string | null;
  inputSize: number | null;
  outputPreview: string | null;
}

export interface RequestLogResponse {
  entries: RequestLogEntry[];
  stats: {
    totalRequests: number;
    gpuRequests: number;
    cloudRequests: number;
    avgLatencyMs: number;
    gpuPercent: number;
    errors: number;
    byStage: Record<string, number>;
  };
}

export async function getRequestLog(sinceId = 0, limit = 50): Promise<RequestLogResponse> {
  return gwJson(`/v1/requests/log?since_id=${sinceId}&limit=${limit}`);
}

// ── GPU ──

export interface GpuStatusResponse {
  status: string;
  message: string;
  podId: string | null;
  endpoint: string | null;
  provider: string | null;
  gpuType: string | null;
  dockerImage: string | null;
  costPerHr: number | null;
  elapsedSec: number;
  gpuHealthy: boolean;
  activeTier: string;
  idleSec: number;
  idleTimeoutSec: number;
  alert: string | null;
  hasRemoteLogs: boolean;
  deployDurationMs: number | null;
  pipelineRouting?: { stt: string; llm: string; tts: string; mode: string };
  modelWarmth?: Record<string, { requests: number; avgLatencyMs: number }>;
}

export async function getGpuStatus(): Promise<GpuStatusResponse> {
  return gwJson('/v1/gpu/status');
}

export interface DeployGpuOpts {
  dockerImage: string;
  gpuTypes?: string[];
  autoSelectGpu?: boolean;
  provider?: string;
  interruptible?: boolean;
}

export async function deployGpu(opts: DeployGpuOpts): Promise<{ status: string; message: string }> {
  return gwPost('/v1/gpu/deploy', opts);
}

export async function terminateGpu(): Promise<{ ok: boolean }> {
  return gwPost('/v1/gpu/terminate', {});
}

export async function getGpuCatalog(): Promise<unknown> {
  return gwJson('/v1/gpu/catalog');
}

export interface ReputationHost {
  hostKey: string;
  provider: string;
  gpuType: string;
  deployCount: number;
  successCount: number;
  failCount: number;
  crashCount: number;
  reputationScore: number;
  avgBootTimeS: number;
  avgLatencyMs: number;
  totalCostUsd: number;
  lastDeployAt: number;
}

export async function getGpuReputation(provider?: string): Promise<{ hosts: ReputationHost[]; count: number }> {
  return gwJson(`/v1/gpu/reputation${provider ? `?provider=${provider}` : ''}`);
}

export async function getGpuLogs(): Promise<{ logs: string; endpoint: string | null; podId: string | null; provider: string | null; status: string }> {
  return gwJson('/v1/gpu/logs');
}

// ── AI Pipeline ──

export async function translate(opts: { text: string; source_lang?: string; target_lang?: string }): Promise<{ translated_text: string; used_gpu: boolean }> {
  return gwPost('/v1/translate', opts);
}

export async function ttsPreview(opts: { text: string; speaker?: string; language?: string }): Promise<Blob> {
  const res = await gw('/v1/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts) });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
  return res.blob();
}

// ── Bot ──

export interface BotStatusResponse {
  status: string;
  podId: string;
  endpoint: string;
  message: string;
  startedAt: number;
  elapsedSec: number;
  botId: string;
  meetingUrl: string;
}

export async function getBotStatus(): Promise<BotStatusResponse> {
  return gwJson('/v1/bot/status');
}

export async function deployBot(opts?: { cpuOnly?: boolean; local?: boolean; enableAvatar?: boolean }): Promise<{ status: string; message: string }> {
  return gwPost('/v1/bot/deploy', opts || {});
}

export async function joinMeeting(opts: { meetingUrl: string; botName?: string; source?: string; target?: string }): Promise<{ ok: boolean; botId: string }> {
  return gwPost('/v1/bot/join', opts);
}

export async function leaveBot(): Promise<{ ok: boolean }> {
  return gwPost('/v1/bot/leave', {});
}

export async function terminateBot(): Promise<{ ok: boolean }> {
  return gwPost('/v1/bot/terminate', {});
}

// ── Language Detection ──

export interface DetectLanguageRequest {
  text: string;
  source: string;
  target: string;
  minConfidence?: number;
}

export interface DetectLanguageResponse {
  language: string;
  confidence: number;
  shouldSwap: boolean;
  source: string;
  target: string;
  latencyMs: number;
  supported: string[];
}

export async function detectLanguage(opts: DetectLanguageRequest): Promise<DetectLanguageResponse> {
  return gwPost('/v1/detect-language?force=true', opts);
}

// ── Auto-Swap ──

export interface AutoSwapStatusResponse {
  enabled: boolean;
}

export async function getAutoSwapStatus(): Promise<AutoSwapStatusResponse> {
  return gwJson('/v1/auto-swap/status');
}

export async function toggleAutoSwap(enabled: boolean): Promise<AutoSwapStatusResponse> {
  return gwPost('/v1/auto-swap/toggle', { enabled });
}

export interface AutoSwapBenchmarkRequest {
  phrases: Array<{ text: string; expectedLang: string }>;
  source: string;
  target: string;
  minConfidence?: number;
}

export interface AutoSwapBenchmarkResult {
  text: string;
  expectedLang: string;
  detectedLang: string;
  confidence: number;
  shouldSwap: boolean;
  correct: boolean;
  latencyMs: number;
}

export interface AutoSwapBenchmarkResponse {
  totalPhrases: number;
  relevantPhrases: number;
  correctCount: number;
  accuracy: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  totalMs: number;
  swapDetections: number;
  falsePositives: number;
  falseNegatives: number;
  source: string;
  target: string;
  results: AutoSwapBenchmarkResult[];
}

export async function runAutoSwapBenchmark(opts: AutoSwapBenchmarkRequest): Promise<AutoSwapBenchmarkResponse> {
  return gwPost('/v1/auto-swap/benchmark', opts);
}

// ── Path Benchmark ──

export interface BenchmarkPathsRequest {
  iterations?: number;
  pipelineIterations?: number;
  warmupIterations?: number;
  source?: string;
  target?: string;
  speaker?: string;
  testText?: string;
  includeGpu?: boolean;
  includeCloud?: boolean;
}

export interface ProviderBenchResult {
  available: boolean;
  warm: boolean;
  latencies: number[];
  avg: number;
  p95: number;
  min: number;
  errors: number;
  errorMessages?: string[];
  // TTS only: Time to First Audio Chunk
  ttfacLatencies?: number[];
  ttfacAvg?: number;
  ttfacP95?: number;
  ttfacMin?: number;
}

export interface StageBenchResult {
  providers: Partial<Record<string, ProviderBenchResult>>;
  fastest: string | null;
  recommendation: string | null;
}

export interface PathOption {
  totalAvg: number;
  ttfacAvg?: number;
  description: string;
  stt?: string;
  llm?: string;
  tts?: string;
}

export interface PipelineIteration {
  index: number;
  totalMs: number;
  sttMs: number;
  llmMs: number;
  ttsMs: number;
  ttfacMs: number;
  usedGpu: boolean;
  transcription: string;
  translation: string;
  hasAudio: boolean;
  error?: string;
}

export interface ProgressionResult {
  warmupIterations: PipelineIteration[];
  measuredIterations: PipelineIteration[];
  trend: { firstHalfAvg: number; secondHalfAvg: number; improvementPct: number };
  coldStartPenalty: { firstCallMs: number; warmAvgMs: number; penaltyMs: number };
  perStageTrend: Record<string, { first: number; last: number; delta: number }>;
}

export interface BenchmarkPathsResponse {
  timestamp: string;
  gpuStatus: {
    available: boolean;
    endpoint: string;
    gpuType: string;
    dockerImage: string;
    provider: string;
    warmth: Record<string, { warm: boolean; requests: number; avgLatencyMs: number | null }>;
  };
  stages: Partial<Record<string, StageBenchResult>>;
  paths: Record<string, PathOption>;
  recommendation: {
    path: string;
    reason: string;
    estimatedTotalMs: number;
    estimatedTtfacMs: number;
    routing: Partial<Record<string, string>>;
  };
  progression: ProgressionResult | null;
  durationMs: number;
  notes?: string[];
}

export async function benchmarkPaths(opts?: BenchmarkPathsRequest): Promise<BenchmarkPathsResponse> {
  return gwPost('/v1/benchmark/paths', opts || {});
}

// ── Provider Config ──

export interface PipelineChainEntry {
  provider: string;
  model: string;
}

export interface ProviderProfile {
  id: string;
  name: string;
  stt: PipelineChainEntry[];
  llm: PipelineChainEntry[];
  tts: PipelineChainEntry[];
}

export interface ProviderConfigResponse {
  profiles: ProviderProfile[];
  activeProfileId: string | null;
  pipelineStt: PipelineChainEntry[];
  pipelineLlm: PipelineChainEntry[];
  pipelineTts: PipelineChainEntry[];
  updatedAt: number;
}

export async function getProviderConfig(): Promise<ProviderConfigResponse> {
  return gwJson('/v1/config/providers');
}

export async function patchProviderConfig(partial: Partial<ProviderConfigResponse>): Promise<ProviderConfigResponse> {
  return gwPost('/v1/config/providers', partial);
}

// ── API Keys ──

export interface ApiKeyEntry {
  id: string;
  name: string;
  envVar: string;
  category: 'cloud' | 'gpu';
  configured: boolean;
  masked: string;
}

export async function getApiKeys(): Promise<{ keys: ApiKeyEntry[] }> {
  return gwJson('/v1/config/api-keys');
}

export async function setApiKeys(keys: Record<string, string>): Promise<{ keys: ApiKeyEntry[]; saved: boolean }> {
  return gwPost('/v1/config/api-keys', { keys });
}

// ── Playground ──

export interface PlaygroundCatalogProvider {
  id: string;
  name: string;
  description: string;
  available: boolean;
  capabilities: string[];
}

export interface PlaygroundCatalogModel {
  id: string;
  name: string;
  description: string;
  providerId: string;
  isDefault?: boolean;
}

export interface PlaygroundCatalogVoice {
  id: string;
  name: string;
  description?: string;
  providerId: string;
}

export interface PlaygroundCatalogCapability {
  models: PlaygroundCatalogModel[];
  voices?: PlaygroundCatalogVoice[];
}

export interface PlaygroundCatalog {
  providers: PlaygroundCatalogProvider[];
  capabilities: Record<string, PlaygroundCatalogCapability>;
  gpu: { available: boolean; endpoint: string | null; status: string; gpuType: string | null; warmth: Record<string, unknown> };
  defaults: Record<string, { provider: string; model: string; voice?: string }>;
  languages: Array<{ code: string; name: string }>;
}

export async function getPlaygroundCatalog(): Promise<PlaygroundCatalog> {
  return gwJson('/v1/playground/catalog');
}

export interface PlaygroundLlmRequest {
  messages: Array<{ role: string; content: string }>;
  provider?: string;
  model?: string;
  system_prompt?: string;
  temperature?: number;
  max_tokens?: number;
}

export interface PlaygroundLlmResponse {
  content: string;
  provider: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  fallbackUsed: boolean;
  latencyMs: number;
}

export async function playgroundLlm(opts: PlaygroundLlmRequest): Promise<PlaygroundLlmResponse> {
  return gwPost('/v1/playground/llm', opts);
}

export interface PlaygroundTtsRequest {
  text: string;
  provider?: string;
  model?: string;
  voice?: string;
  audio_format?: string;
  instructions?: string;
  return_audio?: boolean;
}

export interface PlaygroundTtsResponse {
  provider: string;
  model: string;
  contentType: string;
  audioSizeBytes: number;
  audioBase64?: string;
  fallbackUsed: boolean;
  latencyMs: number;
}

export async function playgroundTts(opts: PlaygroundTtsRequest): Promise<PlaygroundTtsResponse> {
  return gwPost('/v1/playground/tts', opts);
}

export interface PlaygroundSttResponse {
  text: string;
  language?: string;
  duration?: number;
  provider: string;
  model?: string;
  fallbackUsed: boolean;
  latencyMs: number;
}

export async function playgroundStt(audio: Blob, opts?: { provider?: string; model?: string; language?: string }): Promise<PlaygroundSttResponse> {
  const params = new URLSearchParams();
  if (opts?.provider) params.set('provider', opts.provider);
  if (opts?.model) params.set('model', opts.model);
  if (opts?.language) params.set('language', opts.language);
  const qs = params.toString();
  const res = await gw(`/v1/playground/stt${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': audio.type || 'audio/wav' },
    body: audio,
  });
  if (!res.ok) throw new Error(`Playground STT ${res.status}: ${await res.text()}`);
  return res.json();
}
