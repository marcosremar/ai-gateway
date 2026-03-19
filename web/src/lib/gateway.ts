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
  region?: string;
  ipLocation?: { country: string; countryCode: string; city: string; flag: string };
  machineInfo?: {
    instanceId: string | null;
    ramGb: number | null;
    gpuVramGb: number | null;
    diskGb: number | null;
    numGpus: number | null;
    inetDownMbps: number | null;
    inetUpMbps: number | null;
    cpuCores: number | null;
  };
}

export async function getGpuStatus(): Promise<GpuStatusResponse> {
  return gwJson('/v1/gpu/status');
}

export interface GpuInstanceItem {
  provider: string;
  instanceId: string;
  instanceName?: string;
  endpoint: string;
  status: string;
  gpuType?: string;
  costPerHr?: number;
  elapsedSec?: number;
  dockerImage?: string;
  isActive: boolean;
}

export async function getGpuList(): Promise<{ instances: GpuInstanceItem[] }> {
  return gwJson('/v1/gpu/list');
}

export interface DeployGpuOpts {
  dockerImage: string;
  gpuTypes?: string[];
  autoSelectGpu?: boolean;
  provider?: string;
  interruptible?: boolean;
  raceCount?: number;
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
  tier?: 'gold' | 'silver' | 'bronze';
  blacklisted?: boolean;
}

export async function getGpuReputation(provider?: string): Promise<{ hosts: ReputationHost[]; count: number }> {
  return gwJson(`/v1/gpu/reputation${provider ? `?provider=${provider}` : ''}`);
}

export async function getGpuLogs(): Promise<{ logs: string; endpoint: string | null; podId: string | null; provider: string | null; status: string }> {
  return gwJson('/v1/gpu/logs');
}

// ── AI Pipeline ──

export type SpeechTransport = 'http' | 'sse' | 'ws' | 'webrtc';

export interface SpeechPipelineResponse {
  transcription: string;
  response: string;
  audioBase64: string;
  contentType: string;
  transport: SpeechTransport;
  timing: {
    totalMs: number;
    sttMs: number; llmMs: number; ttsMs: number;
    ttfacMs?: number;
    sttProvider?: string; llmProvider?: string; ttsProvider?: string;
    usedGpu: boolean;
  };
}

export interface SpeechPipelineOpts {
  source?: string;
  target?: string;
  speaker?: string;
  /** Transport to use. Default: 'http'. */
  transport?: SpeechTransport;
  /** Timeout in ms. Default: 10000. */
  timeoutMs?: number;
}

/**
 * Run the speech pipeline via the specified transport.
 * Uses the AI Gateway SDK client (SpeechClient) for SSE and WS transports.
 * All transports return the same response shape — no fallbacks.
 */
export async function speechPipeline(
  audio: Blob | ArrayBuffer,
  opts: SpeechPipelineOpts = {},
): Promise<SpeechPipelineResponse> {
  const transport = opts.transport ?? 'http';
  const timeoutMs = opts.timeoutMs ?? 10_000;

  if (transport === 'sse' || transport === 'ws' || transport === 'webrtc') {
    return speechPipelineViaSdkClient(audio, opts, transport, timeoutMs);
  }
  return speechPipelineViaHTTP(audio, opts, timeoutMs);
}

// ── HTTP transport (direct fetch — lightweight, no SDK overhead) ──

async function speechPipelineViaHTTP(
  audio: Blob | ArrayBuffer, opts: SpeechPipelineOpts, timeoutMs: number,
): Promise<SpeechPipelineResponse> {
  const qs = new URLSearchParams({ source: opts.source ?? 'fr', target: opts.target ?? 'en' });
  if (opts.speaker) qs.set('speaker', opts.speaker);
  const contentType = audio instanceof Blob ? (audio.type || 'audio/wav') : 'audio/wav';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await gw(`/v1/speech?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: audio instanceof Blob ? await audio.arrayBuffer() : audio,
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`Pipeline ${res.status}: ${await res.text()}`);
    const d = await res.json();
    return {
      transcription: d.transcription ?? '',
      response: d.response ?? '',
      audioBase64: d.audio_base64 ?? '',
      contentType: d.content_type ?? 'audio/wav',
      transport: 'http',
      timing: {
        totalMs: d.timing?.total_ms ?? 0,
        sttMs: d.timing?.stt_ms ?? 0,
        llmMs: d.timing?.llm_ms ?? 0,
        ttsMs: d.timing?.tts_ms ?? 0,
        sttProvider: d.timing?.stt_provider,
        llmProvider: d.timing?.llm_provider,
        ttsProvider: d.timing?.tts_provider,
        usedGpu: d.timing?.used_gpu ?? false,
      },
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error(`HTTP timeout (${timeoutMs}ms)`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── SSE & WS transports via AI Gateway SDK SpeechClient ──

import type { ProtocolId, SpeechResponse } from '../../../src/browser/types';

/**
 * Run pipeline via the AI Gateway SDK SpeechClient.
 * Forces a single transport (no fallback) — if it fails, it errors.
 */
async function speechPipelineViaSdkClient(
  audio: Blob | ArrayBuffer, opts: SpeechPipelineOpts,
  transport: 'sse' | 'ws' | 'webrtc', timeoutMs: number,
): Promise<SpeechPipelineResponse> {
  const gwHost = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const gwOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4000';

  const protocolMap: Record<string, ProtocolId> = { sse: 'sse', ws: 'websocket', webrtc: 'webrtc' };
  const protocol = protocolMap[transport];

  // Dynamic import to avoid pulling in WebRTC dependency at build time
  const { SpeechClient } = await import('../../../src/browser/speech-client');

  const transportConfig: Record<string, unknown> = {};
  if (transport === 'sse') {
    transportConfig.sse = {
      endpoint: gwOrigin,
      audioPath: `/v1/speech/stream?source=${opts.source ?? 'fr'}&target=${opts.target ?? 'en'}`,
      healthPath: '/health',
    };
  } else if (transport === 'ws') {
    transportConfig.websocket = {
      url: `ws://${gwHost}:4001/v1/speech/ws`,
      connectionTimeoutMs: timeoutMs,
      systemPrompt: JSON.stringify({ source: opts.source ?? 'fr', target: opts.target ?? 'en', speaker: opts.speaker }),
    };
  } else if (transport === 'webrtc') {
    // WebRTC requires a Pipecat signaling server — point at gateway's /api/offer endpoint
    transportConfig.webrtc = {
      signalingUrl: `${gwOrigin}/api/offer`,
      clusterName: 'babelcast',
    };
  }

  const client = new SpeechClient({
    fallbackOrder: [protocol], // Force single transport — no fallback
    fallbackTimeoutMs: timeoutMs,
    responseTimeoutMs: timeoutMs,
    autoReconnect: false,
    ...transportConfig,
  });

  try {
    const connected = await client.connect();
    if (!connected) throw new Error(`${transport.toUpperCase()} connection failed`);

    // Convert audio to Float32Array PCM (SDK expects this)
    const arrayBuf = audio instanceof Blob ? await audio.arrayBuffer() : audio;
    const float32 = wavToFloat32(arrayBuf);

    // Wait for response via event
    const result = await new Promise<SpeechResponse>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${transport.toUpperCase()} timeout (${timeoutMs}ms)`)), timeoutMs);
      client.on('response', (r) => { clearTimeout(timer); resolve(r); });
      client.on('error', (e) => { clearTimeout(timer); reject(new Error(e.message)); });
      client.sendAudio(float32).catch(reject);
    });

    return {
      transcription: result.userText ?? '',
      response: result.text ?? '',
      audioBase64: result.audio ?? '',
      contentType: 'audio/wav',
      transport,
      timing: {
        totalMs: result.timing?.total_ms ?? 0,
        sttMs: result.timing?.stt_ms ?? 0,
        llmMs: result.timing?.llm_ms ?? 0,
        ttsMs: result.timing?.tts_ms ?? 0,
        ttfacMs: (result.timing as Record<string, unknown>)?.tts_ttfac_ms as number | undefined,
        sttProvider: (result.timing as Record<string, unknown>)?.stt_provider as string | undefined,
        llmProvider: (result.timing as Record<string, unknown>)?.llm_provider as string | undefined,
        ttsProvider: (result.timing as Record<string, unknown>)?.tts_provider as string | undefined,
        usedGpu: (result.timing as Record<string, unknown>)?.used_gpu === true,
      },
    };
  } finally {
    client.disconnect();
    client.destroy();
  }
}

/** Convert WAV ArrayBuffer to Float32Array PCM samples (what SDK transports expect). */
function wavToFloat32(wav: ArrayBuffer): Float32Array {
  const view = new DataView(wav);
  // Find 'data' chunk
  let offset = 12; // skip RIFF header
  while (offset < wav.byteLength - 8) {
    const chunkId = String.fromCharCode(view.getUint8(offset), view.getUint8(offset+1), view.getUint8(offset+2), view.getUint8(offset+3));
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 'data') {
      const samples = new Float32Array(chunkSize / 2);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = view.getInt16(offset + 8 + i * 2, true) / 32768;
      }
      return samples;
    }
    offset += 8 + chunkSize;
  }
  // Fallback: treat entire buffer as 16-bit PCM after 44-byte header
  const dataSize = wav.byteLength - 44;
  const samples = new Float32Array(dataSize / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(44 + i * 2, true) / 32768;
  }
  return samples;
}

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
  latency?: 'realtime' | 'low' | 'batch';
  stt: PipelineChainEntry[];
  llm: PipelineChainEntry[];
  tts: PipelineChainEntry[];
  lastActivatedAt?: number;
  lastRequestAt?: number;
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

export interface GpuTypeInfo {
  name: string;
  shortName: string;
  type?: string;
  label?: string;
  vram: number;
  vramGb?: number;
  bestLatencyMs?: number | null;
  bestRegion?: string | null;
  minPricePerHr?: number | null;
  avgLatencyMs?: number;
  samples?: number;
  count?: number;
}

export async function getGpuTypes(provider?: string): Promise<{ gpuTypes: GpuTypeInfo[] }> {
  return gwJson(`/v1/gpu/types${provider ? `?provider=${encodeURIComponent(provider)}` : ""}`);
}

// ── Docker Image Inspection ──

export interface DockerManifest {
  image: string;
  /** Declared services: 'stt' | 'llm' | 'tts' */
  services: string[];
  sttModel?: string;
  llmModel?: string;
  ttsModel?: string;
  /** Transport protocol declared by image */
  protocol: string;
  version?: string;
  rawLabels: Record<string, string>;
}

export async function inspectDockerImage(image: string): Promise<DockerManifest> {
  return gwJson(`/v1/docker/inspect?image=${encodeURIComponent(image)}`);
}

// ── Latency Settings & Probe Schedule ──

export type GpuSortBy = 'price' | 'balanced' | 'latency';

export interface LatencySettings {
  intervalMin: number;
  maxLatencyMs: number;
  running: boolean;
  lastRunAt: number;
  nextRunAt: number;
  gpuPriorityList: string[];
  gpuPriorityByProvider: Record<string, string[]>;
  gpuSortBy: GpuSortBy;
  dbStats: { totalHosts: number; monitoredHosts: number; historyRows: number; unstable: number; failing: number } | null;
  sttTargetLatencyMs: number | null;
  llmTargetLatencyMs: number | null;
  ttsTargetLatencyMs: number | null;
  benchmarkMaxRuns: number | null;
  benchmarkMarginPct: number | null;
  shadowRuns: number | null;
  p95DemotionMultiplier: number | null;
  repechageMaxAttempts: number | null;
  deployTimeoutMin: number | null;
  deployRaceCount: number | null;
  deployRegion: string | null;
  deployDockerImage: string | null;
  minVramGb: number | null;
  preferSsd: boolean | null;
  standbyEnabled: boolean | null;
  standbyTriggerHours: number | null;
  standbyDrainTimeoutMs: number | null;
}

export async function getLatencySettings(): Promise<LatencySettings> {
  return gwJson('/v1/gpu/latency/settings');
}

export async function patchLatencySettings(patch: Partial<LatencySettings>): Promise<LatencySettings> {
  return gwPost('/v1/gpu/latency/settings', patch);
}

export async function triggerLatencyRun(): Promise<{ ok: boolean }> {
  return gwPost('/v1/gpu/latency/run');
}

export interface LatencyHost {
  host_id: string;
  provider: string;
  gpu_type: string;
  gpu_name: string;
  region: string | null;
  geolocation: string | null;
  host_ip: string | null;
  avg_latency_ms: number | null;
  median_ms: number | null;
  p90_ms: number | null;
  stddev_ms: number | null;
  monitored: 0 | 1;
  error_count: number;
  consecutive_failures: number;
  success_rate: number;
  last_probed_at: number | null;
  price_usd: number;
}

export async function getLatencyHosts(opts?: { region?: string }): Promise<{ hosts: LatencyHost[]; from: { city: string; country: string; flag: string } | null }> {
  const qs = opts?.region ? '?region=' + encodeURIComponent(opts.region) : '';
  return gwJson('/v1/gpu/latency/hosts' + qs);
}

export async function patchLatencyHosts(hostIds: string[], monitored: boolean): Promise<{ ok: boolean }> {
  return gwPost('/v1/gpu/latency/hosts', { hostIds, monitored });
}

export async function getGpuDefaults(): Promise<{ defaults: string[] }> {
  return gwJson('/v1/gpu/defaults');
}

// ── GPU Readiness ──

export interface ServiceReadinessState {
  phase: 'idle' | 'benchmarking' | 'ready' | 'degraded' | 'failed' | 'repechage' | 'condemned';
  completedRuns: number;
  bestLatencyMs: number | null;
  targetMs: number;
  latencySamples: number[];
}

export interface GpuReadinessState {
  stt: ServiceReadinessState;
  llm: ServiceReadinessState;
  tts: ServiceReadinessState;
  repechageAttempts: number;
  shadowCompletedRuns: number;
  shadowPhase: boolean;
  condemned?: boolean;
}

export interface ReadinessHistoryRun {
  ts: number;
  stage: 'stt' | 'llm' | 'tts';
  samples: number[];
  bestLatencyMs: number;
  targetMs: number;
  passed: boolean;
  runsUsed: number;
}

export interface ReadinessHistoryRecord {
  runs: ReadinessHistoryRun[];
  lastRunAt: number;
  avgPassedMs: Partial<Record<'stt' | 'llm' | 'tts', number>>;
}

export interface GpuReadinessHistoryResponse {
  history: Record<string, ReadinessHistoryRecord>;
  currentState: GpuReadinessState;
}

export interface ReadinessStatusResponse {
  gpuReadyForProduction: boolean;
  gpuShadowMode: boolean;
  readinessState: GpuReadinessState;
  perStageP95: { stt: number | null; llm: number | null; tts: number | null };
  targets: { stt: number; llm: number; tts: number };
  p95DemotionMultiplier: number;
  repechageMaxAttempts: number;
}

export async function getReadinessStatus(): Promise<ReadinessStatusResponse> {
  return gwJson('/v1/gpu/readiness/status');
}

export async function getGpuReadinessHistory(): Promise<GpuReadinessHistoryResponse> {
  return gwJson('/v1/gpu/readiness/history');
}

export async function resetGpuReadiness(): Promise<{ ok: boolean }> {
  return gwPost('/v1/gpu/readiness/reset');
}

// ── GPU Standby ──

export interface StandbyStatus {
  status: 'idle' | 'deploying' | 'benchmarking' | 'ready' | 'handover' | 'error';
  endpoint: string | null;
  podId: string | null;
  gpuType: string | null;
  provider: string | null;
  triggeredReason: string | null;
  message: string | null;
}

export async function triggerStandbyDeploy(): Promise<{ ok: boolean; error?: string }> {
  return gwPost('/v1/gpu/standby/deploy');
}

export async function initiateStandbyHandover(): Promise<{ ok: boolean; error?: string }> {
  return gwPost('/v1/gpu/standby/handover');
}

export async function cancelStandbyDeploy(): Promise<{ ok: boolean }> {
  return gwPost('/v1/gpu/standby/cancel');
}

// ── GPU Offers ──

export interface GpuOffer {
  id: string;
  provider: string;
  gpuType: string;
  gpuName?: string;
  gpuCount: number;
  vramGb: number | null;
  pricePerHr: number;
  region: string | null;
  reliability: number | null;
  // ranked fields
  networkRttMs?: number | null;
  inferenceMs?: number | null;
  totalMs?: number | null;
  distanceKm?: number | null;
  countryCode?: string | null;
  canDeploy?: boolean;
}

export interface RankedGpuOffersResponse {
  offers: GpuOffer[];
  clientLat: number;
  clientLon: number;
  providers: Record<string, { count: number; error?: string }>;
  balances: Record<string, { balance: number | null; canDeploy: boolean }>;
  hostRttsCached: number;
}

export async function getGpuOffers(opts?: { gpuType?: string; provider?: string }): Promise<{ offers: GpuOffer[] }> {
  const qs = new URLSearchParams();
  if (opts?.gpuType) qs.set('gpuType', opts.gpuType);
  if (opts?.provider) qs.set('provider', opts.provider);
  const q = qs.toString();
  return gwJson('/v1/gpu/offers' + (q ? '?' + q : ''));
}

export async function getRankedGpuOffers(opts?: { gpuTypes?: string[]; provider?: string; limit?: number }): Promise<RankedGpuOffersResponse> {
  const qs = new URLSearchParams();
  if (opts?.gpuTypes?.length) qs.set('gpuTypes', opts.gpuTypes.join(','));
  if (opts?.provider) qs.set('provider', opts.provider);
  if (opts?.limit) qs.set('limit', String(opts.limit));
  const q = qs.toString();
  return gwJson('/v1/gpu/offers/ranked' + (q ? '?' + q : ''));
}

// ── Voice Profile ──

export interface VoiceProfileStatus {
  hasProfile: boolean;
  totalDurationSec: number;
  minDurationSec: number;
  sampleCount: number;
  ready: boolean;
  state?: 'available' | 'unavailable' | 'error';
  samplesCount?: number;
  gender?: string;
}

export async function getVoiceProfileStatus(): Promise<VoiceProfileStatus> {
  return gwJson('/v1/voice/profile');
}

export async function uploadVoiceReference(file: File): Promise<{ ok: boolean; message?: string }> {
  const formData = new FormData();
  formData.append('file', file);
  return gwJson('/v1/voice/reference', { method: 'POST', body: formData });
}

export async function resetVoiceProfile(): Promise<{ ok: boolean }> {
  return gwPost('/v1/voice/profile/reset');
}
