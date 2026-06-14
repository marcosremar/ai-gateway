/**
 * GatewaySDK — Typed HTTP client for the BabelCast AI Gateway REST API.
 *
 * Usage:
 *   import { GatewaySDK } from '@ai-gateway/sdk';
 *
 *   const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });
 *   const { text } = await gw.transcribe(audioBuffer, 'fr');
 *   const { translatedText } = await gw.translate(text, 'fr', 'en');
 *   await gw.close();
 *
 * Mirror SDK: ai-gateway/sdk/python/gateway_sdk/client.py
 */

import type {
  GatewayConfig,
  TranscribeResponse,
  TranscribeOptions,
  TranslateResponse,
  PipelineResponse,
  PipelineOptions,
  GenerateAudioOptions,
  GenerateAudioResponse,
  ListVoicesResponse,
  GpuStatus,
  GpuOffer,
  GpuInstance,
  GpuEventLog,
  StopResumeResponse,
  DeployOptions,
  DeployResponse,
  ProviderConfig,
  ApiKeyInfo,
  BotDeployOptions,
  BotStatus,
  CreateProfileOptions,
  GpuReadinessStatus,
  GpuReadinessHistory,
  ChatMessage,
  ChatCompletionOptions,
  ChatCompletionResponse,
  WorkloadInfo,
  WorkloadDeployOptions,
} from './types';
import { GatewayError } from './types';

const GROQ_API_BASE = 'https://api.groq.com/openai/v1';
/** Groq model IDs used when the gateway is unreachable. */
const GROQ_FALLBACK_STT_MODEL = 'whisper-large-v3-turbo';
const GROQ_FALLBACK_LLM_MODEL = 'llama-3.3-70b-versatile';

const DEFAULT_TIMEOUTS = {
  stt: 15_000,
  translate: 15_000,
  pipeline: 30_000,
  tts: 30_000,
  health: 8_000,
  deploy: 30_000,
};

/** Default retry config for connection-level errors (gateway restart tolerance).
 *  Override per-instance via GatewayConfig.maxRetries / retryBackoffMs. */
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_RETRY_BACKOFF_MS = [500, 1000, 2000, 4000];

/** Check if an error is a connection-level failure (retryable). */
function isRetryableError(err: unknown): boolean {
  // Timeouts (AbortError) are NOT retried — they indicate the server was reached but slow
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  // TypeError = network failure (ECONNREFUSED, DNS, etc.)
  if (err instanceof TypeError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  // Match broader set of network error patterns case-insensitively
  return /ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|network|failed to fetch/i.test(msg);
}

function validatePositiveInt(value: number, name: string, defaultVal: number, max = Infinity): number {
  if (!Number.isFinite(value) || value <= 0 || value > max) return defaultVal;
  return Math.floor(value);
}

export class GatewaySDK {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeouts: Required<NonNullable<GatewayConfig['timeouts']>>;
  private readonly groqApiKey: string;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number[];

  constructor(config: GatewayConfig) {
    if (!config.baseUrl) {
      throw new TypeError('GatewaySDK: baseUrl is required');
    }
    let baseUrl = config.baseUrl.trim();
    if (!/^https?:\/\/[^/\s]+/i.test(baseUrl)) {
      throw new TypeError(`GatewaySDK: invalid baseUrl "${baseUrl}" - must be a valid HTTP(S) URL`);
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.headers = config.apiKey
      ? { Authorization: `Bearer ${config.apiKey}` }
      : {};
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
    this.groqApiKey = config.groqApiKey ?? (typeof process !== 'undefined' ? (process.env.GROQ_API_KEY ?? '') : '');
    // Retry tuning — clamp to non-negative integer; fall back to defaults on bad input.
    this.maxRetries = Number.isFinite(config.maxRetries) && (config.maxRetries as number) >= 0
      ? Math.floor(config.maxRetries as number)
      : DEFAULT_MAX_RETRIES;
    this.retryBackoffMs = Array.isArray(config.retryBackoffMs) && config.retryBackoffMs.length > 0
      ? config.retryBackoffMs
      : DEFAULT_RETRY_BACKOFF_MS;
  }

  // ── Inference ───────────────────────────────────────────────────────────

  /** Transcribe audio to text (GPU-aware: gateway routes to GPU or cloud).
   *  Falls back to Groq Whisper directly when the gateway is unreachable.
   *  @param options.ensemble — race multiple STT providers, return best result */
  async transcribe(audio: Uint8Array, languageOrOpts: string | TranscribeOptions = 'fr', prompt = ''): Promise<TranscribeResponse> {
    const opts: TranscribeOptions = typeof languageOrOpts === 'string'
      ? { language: languageOrOpts, prompt }
      : languageOrOpts;
    const language = opts.language ?? 'fr';
    const params = new URLSearchParams({ language });
    if (opts.prompt) params.set('prompt', opts.prompt);
    const endpoint = opts.ensemble ? '/v1/transcribe/ensemble' : '/v1/transcribe';
    try {
      const res = await this.fetch(`${endpoint}?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: audio,
        timeout: this.timeouts.stt,
      });
      const data = await this.parseJson(res, endpoint);
      return { text: (data.text as string) ?? '', usedGpu: (data.used_gpu as boolean) ?? false };
    } catch (err) {
      if (err instanceof GatewayError && err.isNetworkError && this.groqApiKey) {
        return this.groqTranscribeFallback(audio, language, opts.prompt ?? '');
      }
      throw err;
    }
  }

  /** Send a chat completion request through the gateway.
   *  Falls back to Groq directly when the gateway is unreachable. */
  async chat(messages: ChatMessage[], options: ChatCompletionOptions = {}): Promise<ChatCompletionResponse> {
    const body: Record<string, unknown> = {
      model: options.model ?? GROQ_FALLBACK_LLM_MODEL,
      messages,
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    try {
      const res = await this.fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: this.timeouts.translate,
      });
      const data = await this.parseJson(res, '/v1/chat/completions');
      const choices = (data.choices as Array<{ message: { content: string } }>) ?? [];
      const content = choices[0]?.message?.content ?? '';
      const usage = data.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
      return {
        content,
        model: (data.model as string) ?? (options.model ?? GROQ_FALLBACK_LLM_MODEL),
        usage: usage ? {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        } : undefined,
      };
    } catch (err) {
      if (err instanceof GatewayError && err.isNetworkError && this.groqApiKey) {
        return this.groqChatFallback(messages, options);
      }
      throw err;
    }
  }

  /** Translate text (GPU-aware: gateway routes to GPU or cloud LLM). */
  async translate(text: string, sourceLang: string, targetLang: string, glossary = ''): Promise<TranslateResponse> {
    if (!text.trim()) return { translatedText: '', usedGpu: false };
    const body: Record<string, string> = { text, source_lang: sourceLang, target_lang: targetLang };
    if (glossary) body.glossary = glossary;
    const res = await this.fetch('/v1/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: this.timeouts.translate,
    });
    const data = await this.parseJson(res, '/v1/translate');
    return { translatedText: (data.translated_text as string) ?? '', usedGpu: (data.used_gpu as boolean) ?? false };
  }

  /** Full pipeline: audio → STT → LLM → TTS (GPU-aware routing). */
  async pipeline(audio: Uint8Array, options: PipelineOptions = {}): Promise<PipelineResponse> {
    const params = new URLSearchParams();
    params.set('source', options.source ?? 'fr');
    params.set('target', options.target ?? 'en');
    if (options.speaker) params.set('speaker', options.speaker);
    const qs = params.toString();

    const res = await this.fetch(`/v1/speech${qs ? `?${qs}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: audio,
      timeout: this.timeouts.pipeline,
    });
    const data = await this.parseJson(res, '/v1/speech');
    const timing = data.timing as Record<string, unknown> | undefined;
    return {
      transcription: (data.transcription as string) ?? '',
      response: (data.response as string) ?? '',
      audioBase64: (data.audio_base64 as string) ?? '',
      contentType: (data.content_type as string) ?? '',
      timing: {
        totalMs: (timing?.total_ms as number) ?? 0,
        usedGpu: (timing?.used_gpu as boolean) ?? false,
      },
    };
  }

  /** Generate speech from text via the GPU pod's TTS engine. Returns WAV bytes.
   *
   * @example
   * const { audio } = await gw.generateAudio('Hello world', { speaker: 'Ryan', speed: 0.9 });
   * await Bun.write('out.wav', audio);
   */
  async generateAudio(text: string, options: GenerateAudioOptions = {}): Promise<GenerateAudioResponse> {
    const body: Record<string, unknown> = {
      text,
      speaker: options.speaker ?? 'Ryan',
      language: options.language ?? 'English',
    };
    if (options.speed !== undefined && options.speed !== 1.0) body.speed = options.speed;
    const res = await this.fetch('/v1/tts/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: this.timeouts.tts,
    });
    let audio: Uint8Array;
    try {
      const buf = await res.arrayBuffer();
      audio = new Uint8Array(buf);
    } catch (err) {
      throw new GatewayError(
        `Failed to read audio response: ${err instanceof Error ? err.message : String(err)}`,
        res.status,
        '/v1/tts/preview',
      );
    }
    return { audio, contentType: 'audio/wav', usedGpu: true };
  }

  /** List available preset TTS voices. */
  async listVoices(): Promise<ListVoicesResponse> {
    const res = await this.fetch('/v1/tts/voices', {
      method: 'GET',
      timeout: this.timeouts.health,
    });
    const data = await this.parseJson(res, '/v1/tts/voices');
    return { voices: (data.voices as ListVoicesResponse['voices']) ?? [] };
  }

  // ── GPU management ──────────────────────────────────────────────────────

  /** Deploy a GPU pod (non-blocking — returns immediately, poll gpuStatus()).
   *  Pass `maxCostUsd` to cap the hourly spend — the gateway rejects the deploy
   *  if the cheapest matching offer exceeds it. */
  async deployGpu(options: DeployOptions): Promise<DeployResponse> {
    if (!options.apiKey?.trim()) {
      throw new TypeError('deployGpu: options.apiKey is required');
    }
    if (options.maxCostUsd !== undefined && (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0)) {
      throw new TypeError('deployGpu: maxCostUsd must be a positive number');
    }
    const body: Record<string, unknown> = {
      apiKey: options.apiKey,
      dockerImage: options.dockerImage,
      gpuTypes: options.gpuTypes,
    };
    if (options.region !== undefined) body.region = options.region;
    if (options.maxCostUsd !== undefined) body.maxCostUsd = options.maxCostUsd;
    if (options.containerDiskInGb !== undefined) body.containerDiskInGb = options.containerDiskInGb;
    if (options.interruptible !== undefined) body.interruptible = options.interruptible;
    const res = await this.fetch('/v1/gpu/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: this.timeouts.deploy,
      allowedStatuses: [202, 409], // 409 = deploy already in progress
    });
    const data = await this.parseJson(res, '/v1/gpu/deploy');
    return { deployId: (data.deployId as string) ?? '', status: (data.status as string) ?? '', message: (data.message as string) ?? '' };
  }

  /** Get current GPU deployment status, health, and active tier. */
  async gpuStatus(): Promise<GpuStatus> {
    const res = await this.fetch('/v1/gpu/status', {
      method: 'GET',
      timeout: this.timeouts.health,
    });
    const d = await this.parseJson(res, '/v1/gpu/status');
    return {
      status: (d.status as GpuStatus['status']) ?? 'idle',
      deployId: (d.deployId as string) ?? '',
      podId: (d.podId as string) ?? '',
      endpoint: (d.endpoint as string) ?? '',
      gpuType: (d.gpuType as string) ?? '',
      message: (d.message as string) ?? '',
      step: (d.step as string) ?? '',
      stepDetail: (d.stepDetail as string) ?? '',
      gpuHealthy: (d.gpuHealthy as boolean) ?? false,
      activeTier: (d.activeTier as GpuStatus['activeTier']) ?? 'cloud',
      idleSec: (d.idleSec as number) ?? 0,
      idleTimeoutSec: (d.idleTimeoutSec as number) ?? 0,
      elapsedSec: (d.elapsedSec as number) ?? 0,
      startedAt: (d.startedAt as number) ?? 0,
      retryCount: (d.retryCount as number) ?? 0,
    };
  }

  /** Terminate the GPU pod. */
  async terminateGpu(apiKey: string): Promise<void> {
    await this.fetch('/v1/gpu/terminate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
      timeout: this.timeouts.deploy,
    });
  }

  /** Wait for GPU to reach 'ready' status (polls gpuStatus). */
  async waitForGpu(pollIntervalMs = 5_000, timeoutMs = 20 * 60_000): Promise<GpuStatus> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = await this.gpuStatus();
      if (status.status === 'ready') return status;
      if (status.status === 'error') throw new GatewayError(status.message, 0, '/v1/gpu/status');
      if (status.status === 'idle') throw new GatewayError('Deploy cancelled', 0, '/v1/gpu/status');
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
    throw new GatewayError(`GPU deploy timed out after ${Math.round(timeoutMs / 60_000)} min`, 0, '/v1/gpu/status');
  }

  // ── GPU extended ────────────────────────────────────────────────────────

  /** Stop (pause) the GPU pod — preserves disk, no charges. */
  async stopGpu(): Promise<StopResumeResponse> {
    const res = await this.fetch('/v1/gpu/stop', { method: 'POST', timeout: this.timeouts.deploy });
    return await this.parseJson(res, '/v1/gpu/stop') as unknown as StopResumeResponse;
  }

  /** Resume a previously stopped GPU pod. */
  async resumeGpu(podId?: string, provider?: string): Promise<StopResumeResponse> {
    const body: Record<string, string> = {};
    if (podId) body.podId = podId;
    if (provider) body.provider = provider;
    const res = await this.fetch('/v1/gpu/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: this.timeouts.deploy,
    });
    return await this.parseJson(res, '/v1/gpu/resume') as unknown as StopResumeResponse;
  }

  /** List available GPU offers from providers (sorted by price). */
  async gpuOffers(): Promise<GpuOffer[]> {
    const res = await this.fetch('/v1/gpu/offers', { method: 'GET', timeout: this.timeouts.deploy });
    const data = await this.parseJson(res, '/v1/gpu/offers');
    return (data.offers as GpuOffer[]) ?? [];
  }

  /** List verified GPU types. */
  async gpuTypes(): Promise<Record<string, unknown>[]> {
    const res = await this.fetch('/v1/gpu/types', { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/gpu/types');
    return (data.types ?? data) as Record<string, unknown>[];
  }

  /** List all active GPU instances across providers. */
  async gpuList(): Promise<GpuInstance[]> {
    const res = await this.fetch('/v1/gpu/list', { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/gpu/list');
    return (data.instances ?? data) as GpuInstance[];
  }

  /** Fetch GPU deployment logs (container stdout from running pod). Pass `filter` to grep-filter lines. Default max 512KB response. */
  async gpuLogs(filter?: string, maxBytes = 512 * 1024): Promise<string> {
    const qs = filter ? `?filter=${encodeURIComponent(filter)}` : '';
    const res = await this.fetch(`/v1/gpu/logs${qs}`, { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/gpu/logs');
    const logs = (data.logs as string) ?? '';
    return logs.slice(0, maxBytes);
  }

  /** Fetch persistent GPU event logs (JSONL file-based). */
  async gpuEventLogs(lines = 100): Promise<GpuEventLog> {
    const res = await this.fetch(`/v1/gpu/logs/events?lines=${lines}`, { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/gpu/logs/events') as unknown as GpuEventLog;
  }

  /** Get GPU catalog (available Docker images). */
  async gpuCatalog(): Promise<Record<string, unknown>> {
    const res = await this.fetch('/v1/gpu/catalog', { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/gpu/catalog') as Record<string, unknown>;
  }

  /** Get gateway's geographic location. */
  async gpuMyLocation(): Promise<Record<string, unknown>> {
    const res = await this.fetch('/v1/gpu/my-location', { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/gpu/my-location') as Record<string, unknown>;
  }

  /** Get GPU host reputation scores. */
  async gpuReputation(): Promise<Record<string, unknown>[]> {
    const res = await this.fetch('/v1/gpu/reputation', { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/gpu/reputation');
    return (data.reputations ?? data) as Record<string, unknown>[];
  }

  // ── Vast.ai Templates ──────────────────────────────────────────────────

  /** List all Vast.ai templates on the account. */
  async vastListTemplates(): Promise<Array<{ hashId: string; id: number; name: string; image: string; tag?: string }>> {
    const res = await this.fetch('/v1/gpu/vast/templates', { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/gpu/vast/templates');
    return (data.templates ?? []) as Array<{ hashId: string; id: number; name: string; image: string; tag?: string }>;
  }

  /** Create a Vast.ai template. Returns the template's hash_id for use in deployments. */
  async vastCreateTemplate(spec: {
    name: string;
    image: string;
    tag?: string;
    envVars?: Record<string, string>;
    exposePorts?: number[];
    onstartCmd?: string;
    diskSpaceGb?: number;
  }): Promise<{ hashId: string; id: number }> {
    const res = await this.fetch('/v1/gpu/vast/templates', {
      method: 'POST', timeout: this.timeouts.deploy,
      body: JSON.stringify(spec),
    });
    return await this.parseJson(res, '/v1/gpu/vast/templates') as { hashId: string; id: number };
  }

  /** Update an existing Vast.ai template. */
  async vastUpdateTemplate(hashId: string, updates: { name?: string; image?: string; tag?: string; diskSpaceGb?: number; desc?: string }): Promise<{ hashId: string; id: number }> {
    const res = await this.fetch('/v1/gpu/vast/templates', {
      method: 'PUT', timeout: this.timeouts.deploy,
      body: JSON.stringify({ hashId, ...updates }),
    });
    return await this.parseJson(res, '/v1/gpu/vast/templates') as { hashId: string; id: number };
  }

  /** Delete a Vast.ai template by numeric ID. */
  async vastDeleteTemplate(templateId: number): Promise<void> {
    await this.fetch(`/v1/gpu/vast/templates?id=${templateId}`, { method: 'DELETE', timeout: this.timeouts.deploy });
  }

  /** Idempotent: find existing template by name+image or create one. */
  async vastFindOrCreateTemplate(spec: {
    name: string;
    image: string;
    tag?: string;
    envVars?: Record<string, string>;
    exposePorts?: number[];
    onstartCmd?: string;
    diskSpaceGb?: number;
  }): Promise<{ hashId: string; id: number; created: boolean }> {
    const res = await this.fetch('/v1/gpu/vast/templates/find-or-create', {
      method: 'POST', timeout: this.timeouts.deploy,
      body: JSON.stringify(spec),
    });
    return await this.parseJson(res, '/v1/gpu/vast/templates/find-or-create') as { hashId: string; id: number; created: boolean };
  }

  // ── Vast.ai Serverless Endpoints ────────────────────────────────────────

  /** List all serverless endpoints on the Vast.ai account. */
  async vastListEndpoints(): Promise<Array<{ id: number; name: string; apiKey: string; state: string; minLoad: number; targetUtil: number; coldWorkers: number; maxWorkers: number; createdAt: string }>> {
    const res = await this.fetch('/v1/gpu/vast/endpoints', { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/gpu/vast/endpoints');
    return (data.endpoints ?? []) as Array<{ id: number; name: string; apiKey: string; state: string; minLoad: number; targetUtil: number; coldWorkers: number; maxWorkers: number; createdAt: string }>;
  }

  /** Create a Vast.ai serverless endpoint. Add worker groups via vastCreateWorkerGroup(). */
  async vastCreateEndpoint(spec: { name: string; minLoad?: number; targetUtil?: number; coldMult?: number; coldWorkers?: number; maxWorkers?: number }): Promise<{ id: number; name: string }> {
    const res = await this.fetch('/v1/gpu/vast/endpoints', {
      method: 'POST', timeout: this.timeouts.deploy,
      body: JSON.stringify(spec),
    });
    return await this.parseJson(res, '/v1/gpu/vast/endpoints') as { id: number; name: string };
  }

  /** Delete a Vast.ai serverless endpoint and all its workers. */
  async vastDeleteEndpoint(endpointId: number): Promise<{ deletedWorkers: number[]; failedWorkers: number[] }> {
    const res = await this.fetch(`/v1/gpu/vast/endpoints?id=${endpointId}`, { method: 'DELETE', timeout: this.timeouts.deploy });
    return await this.parseJson(res, '/v1/gpu/vast/endpoints') as { deletedWorkers: number[]; failedWorkers: number[] };
  }

  /** Get logs from a Vast.ai serverless endpoint. Requires endpoint's own API key. */
  async vastGetEndpointLogs(endpointName: string, endpointApiKey: string, lines = 100): Promise<string> {
    const res = await this.fetch('/v1/gpu/vast/endpoints/logs', {
      method: 'POST', timeout: this.timeouts.health,
      body: JSON.stringify({ endpointName, endpointApiKey, lines }),
    });
    const data = await this.parseJson(res, '/v1/gpu/vast/endpoints/logs');
    return (data.logs as string) ?? '';
  }

  /**
   * Route an inference request to the least-loaded worker in a Vast.ai serverless endpoint.
   * Returns the worker URL, or null if no worker is available (cold start in progress).
   * Requires endpoint's own API key (from vastListEndpoints()).
   */
  async vastRouteRequest(endpointName: string, endpointApiKey: string, cost = 100): Promise<{ url: string; reqnum: number; signature: string; requestId: string } | null> {
    const validatedCost = validatePositiveInt(cost, 'cost', 100, 100000);
    const res = await this.fetch('/v1/gpu/vast/endpoints/route', {
      method: 'POST', timeout: 10_000,
      body: JSON.stringify({ endpointName, endpointApiKey, cost: validatedCost }),
    });
    const data = await this.parseJson(res, '/v1/gpu/vast/endpoints/route') as { available: boolean; url?: string; reqnum?: number; signature?: string; requestId?: string };
    if (!data.available || !data.url) return null;
    return { url: data.url, reqnum: data.reqnum ?? 0, signature: data.signature ?? '', requestId: data.requestId ?? '' };
  }

  // ── Vast.ai Worker Groups ───────────────────────────────────────────────

  /** List all worker groups on the Vast.ai account. */
  async vastListWorkerGroups(): Promise<Array<{ id: number; endpointId: number; endpointName: string; templateHash: string; gpuRamGb: number; maxWorkers: number; createdAt: string }>> {
    const res = await this.fetch('/v1/gpu/vast/workergroups', { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/gpu/vast/workergroups');
    return (data.workerGroups ?? []) as Array<{ id: number; endpointId: number; endpointName: string; templateHash: string; gpuRamGb: number; maxWorkers: number; createdAt: string }>;
  }

  /** Create a worker group for a serverless endpoint. */
  async vastCreateWorkerGroup(spec: { endpointId?: number; endpointName?: string; templateHash?: string; searchParams?: string; gpuRamGb?: number; maxWorkers?: number; coldWorkers?: number }): Promise<{ id: number }> {
    const res = await this.fetch('/v1/gpu/vast/workergroups', {
      method: 'POST', timeout: this.timeouts.deploy,
      body: JSON.stringify(spec),
    });
    return await this.parseJson(res, '/v1/gpu/vast/workergroups') as { id: number };
  }

  /** Update a worker group's scaling params or GPU filter. */
  async vastUpdateWorkerGroup(id: number, updates: { minLoad?: number; targetUtil?: number; templateHash?: string; searchParams?: string; gpuRamGb?: number; maxWorkers?: number }): Promise<void> {
    await this.fetch('/v1/gpu/vast/workergroups', {
      method: 'PUT', timeout: this.timeouts.deploy,
      body: JSON.stringify({ id, ...updates }),
    });
  }

  /** Delete a worker group and stop its workers. */
  async vastDeleteWorkerGroup(id: number): Promise<{ deletedWorkers: number[]; failedWorkers: number[] }> {
    const res = await this.fetch(`/v1/gpu/vast/workergroups?id=${id}`, { method: 'DELETE', timeout: this.timeouts.deploy });
    return await this.parseJson(res, '/v1/gpu/vast/workergroups') as { deletedWorkers: number[]; failedWorkers: number[] };
  }

  // ── Config ─────────────────────────────────────────────────────────────

  /** Get provider configuration (STT/LLM/TTS chains). */
  async getProviderConfig(): Promise<ProviderConfig> {
    const res = await this.fetch('/v1/config/providers', { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/config/providers') as ProviderConfig;
  }

  /** Update provider configuration. */
  async setProviderConfig(config: Partial<ProviderConfig>): Promise<void> {
    await this.fetch('/v1/config/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
      timeout: this.timeouts.health,
    });
  }

  /** Get configured API keys (masked). */
  async getApiKeys(): Promise<ApiKeyInfo[]> {
    const res = await this.fetch('/v1/config/api-keys', { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/config/api-keys');
    return (data.keys ?? data) as ApiKeyInfo[];
  }

  /** Update API keys. */
  async setApiKeys(keys: Record<string, string>): Promise<void> {
    await this.fetch('/v1/config/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(keys),
      timeout: this.timeouts.health,
    });
  }

  /** Get labs feature flags. */
  async getLabsFlags(): Promise<Record<string, unknown>> {
    const res = await this.fetch('/v1/config/labs', { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/config/labs') as Record<string, unknown>;
  }

  /** Update labs feature flags. */
  async setLabsFlags(flags: Record<string, unknown>): Promise<void> {
    await this.fetch('/v1/config/labs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(flags),
      timeout: this.timeouts.health,
    });
  }

  // ── Profiles ───────────────────────────────────────────────────────────

  /** Create or update a provider profile. */
  async createProfile(profile: CreateProfileOptions): Promise<ProviderConfig> {
    const res = await this.fetch('/v1/config/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
      timeout: this.timeouts.health,
    });
    return await this.parseJson(res, '/v1/config/profiles') as ProviderConfig;
  }

  /** Delete a provider profile. */
  async deleteProfile(id: string): Promise<ProviderConfig> {
    const res = await this.fetch('/v1/config/profiles', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
      timeout: this.timeouts.health,
    });
    return await this.parseJson(res, '/v1/config/profiles') as ProviderConfig;
  }

  /** Activate a profile (copy its chains to top-level config). Pass null to deactivate. */
  async activateProfile(id: string | null): Promise<ProviderConfig> {
    const res = await this.fetch('/v1/config/profiles/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
      timeout: this.timeouts.health,
    });
    return await this.parseJson(res, '/v1/config/profiles/activate') as ProviderConfig;
  }

  // ── GPU Readiness ──────────────────────────────────────────────────────

  /** Get GPU readiness status (benchmark state, P95 latencies, production flag). */
  async gpuReadinessStatus(): Promise<GpuReadinessStatus> {
    const res = await this.fetch('/v1/gpu/readiness/status', { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/gpu/readiness/status') as GpuReadinessStatus;
  }

  /** Get GPU readiness history (state transitions over time). */
  async gpuReadinessHistory(): Promise<GpuReadinessHistory> {
    const res = await this.fetch('/v1/gpu/readiness/history', { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/gpu/readiness/history') as unknown as GpuReadinessHistory;
  }

  /** Reset GPU readiness tracking (clears benchmarks, restarts readiness check). */
  async resetGpuReadiness(): Promise<{ ok: boolean; message: string }> {
    const res = await this.fetch('/v1/gpu/readiness/reset', { method: 'POST', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/gpu/readiness/reset') as { ok: boolean; message: string };
  }

  // ── Inference extended ─────────────────────────────────────────────────

  /** Preview TTS with specific voice and speed. Returns WAV audio. */
  async ttsPreview(text: string, options: GenerateAudioOptions = {}): Promise<GenerateAudioResponse> {
    const body: Record<string, unknown> = { text, ...options };
    const res = await this.fetch('/v1/tts/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: this.timeouts.tts,
    });
    let audio: Uint8Array;
    try {
      const buf = await res.arrayBuffer();
      audio = new Uint8Array(buf);
    } catch (err) {
      throw new GatewayError(
        `Failed to read audio response: ${err instanceof Error ? err.message : String(err)}`,
        res.status,
        '/v1/tts/preview',
      );
    }
    return { audio, contentType: 'audio/wav', usedGpu: true };
  }

  /** Auto-detect input language. */
  async detectLanguage(text: string): Promise<{ language: string; confidence: number }> {
    const res = await this.fetch('/v1/detect-language', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      timeout: this.timeouts.health,
    });
    return await this.parseJson(res, '/v1/detect-language') as { language: string; confidence: number };
  }

  // ── Bot ────────────────────────────────────────────────────────────────

  /** Deploy a meeting bot instance. */
  async deployBot(options: BotDeployOptions): Promise<BotStatus> {
    const res = await this.fetch('/v1/bot/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
      timeout: this.timeouts.deploy,
    });
    return await this.parseJson(res, '/v1/bot/deploy') as BotStatus;
  }

  /** Get bot deployment status. */
  async botStatus(): Promise<BotStatus> {
    const res = await this.fetch('/v1/bot/status', { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/bot/status') as BotStatus;
  }

  /** Bot joins meeting. */
  async botJoin(meetingUrl: string): Promise<void> {
    await this.fetch('/v1/bot/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingUrl }),
      timeout: this.timeouts.deploy,
    });
  }

  /** Bot leaves meeting. */
  async botLeave(): Promise<void> {
    await this.fetch('/v1/bot/leave', { method: 'POST', timeout: this.timeouts.health });
  }

  /** Terminate bot pod. */
  async botTerminate(): Promise<void> {
    await this.fetch('/v1/bot/terminate', { method: 'POST', timeout: this.timeouts.deploy });
  }

  // ── Workloads ──────────────────────────────────────────────────────────

  /** List all workloads, optionally filtered by type and paginated. */
  async listWorkloads(options?: { type?: WorkloadInfo['type']; limit?: number; offset?: number }): Promise<{ workloads: WorkloadInfo[]; total: number; limit: number; offset: number }> {
    const params = new URLSearchParams();
    if (options?.type) params.set('type', options.type);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const qs = params.toString();
    const res = await this.fetch(`/v1/workloads${qs ? `?${qs}` : ''}`, { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/workloads');
    return {
      workloads: (data.workloads ?? []) as WorkloadInfo[],
      total: (data.total as number) ?? 0,
      limit: (data.limit as number) ?? 100,
      offset: (data.offset as number) ?? 0,
    };
  }

  /** Deploy a new workload (GPU, bot, or database). */
  async deployWorkload(options: WorkloadDeployOptions): Promise<WorkloadInfo> {
    const res = await this.fetch('/v1/workloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
      timeout: this.timeouts.deploy,
      allowedStatuses: [201],
    });
    return await this.parseJson(res, '/v1/workloads') as unknown as WorkloadInfo;
  }

  /** Get status of a specific workload. */
  async workloadStatus(id: string): Promise<WorkloadInfo> {
    const res = await this.fetch(`/v1/workloads/${id}`, { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, `/v1/workloads/${id}`) as unknown as WorkloadInfo;
  }

  /** Stop (pause) a workload. */
  async stopWorkload(id: string): Promise<WorkloadInfo> {
    const res = await this.fetch(`/v1/workloads/${id}/stop`, { method: 'POST', timeout: this.timeouts.deploy });
    return await this.parseJson(res, `/v1/workloads/${id}/stop`) as unknown as WorkloadInfo;
  }

  /** Start / resume a stopped workload. */
  async startWorkload(id: string): Promise<WorkloadInfo> {
    const res = await this.fetch(`/v1/workloads/${id}/start`, { method: 'POST', timeout: this.timeouts.deploy });
    return await this.parseJson(res, `/v1/workloads/${id}/start`) as unknown as WorkloadInfo;
  }

  /** Terminate (destroy) a workload permanently. */
  async terminateWorkload(id: string): Promise<void> {
    await this.fetch(`/v1/workloads/${id}`, { method: 'DELETE', timeout: this.timeouts.deploy });
  }

  // ── Diagnostics ────────────────────────────────────────────────────────

  /** Get request history/log. */
  async requestLog(limit = 50): Promise<Record<string, unknown>[]> {
    const res = await this.fetch(`/v1/requests/log?limit=${limit}`, { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/requests/log');
    return (data.requests ?? data) as Record<string, unknown>[];
  }

  /** Get Prometheus-style metrics. Default max 1MB response. */
  async metrics(maxBytes = 1024 * 1024): Promise<string> {
    const res = await this.fetch('/metrics', { method: 'GET', timeout: this.timeouts.health });
    const text = await res.text();
    return text.slice(0, maxBytes);
  }

  /** Get service statistics. */
  async serviceStats(): Promise<Record<string, unknown>> {
    const res = await this.fetch('/v1/service-stats', { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/service-stats') as Record<string, unknown>;
  }

  /** Inspect Docker image metadata from Docker Hub. */
  async dockerInspect(imageName: string): Promise<Record<string, unknown>> {
    const res = await this.fetch('/v1/docker/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageName }),
      timeout: this.timeouts.health,
    });
    return await this.parseJson(res, '/v1/docker/inspect') as Record<string, unknown>;
  }

  // ── Health ──────────────────────────────────────────────────────────────

  /** Check if the gateway is reachable. */
  async health(): Promise<boolean> {
    try {
      const res = await this.fetch('/health', { method: 'GET', timeout: this.timeouts.health });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /** Get detailed health info (providers, GPU state, uptime). */
  async healthDetail(): Promise<Record<string, unknown>> {
    const res = await this.fetch('/health', { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/health') as Record<string, unknown>;
  }

  // ── Groq direct fallback (gateway offline) ────────────────────────────

  /** Call Groq Whisper directly — used when the gateway is unreachable. */
  private async groqTranscribeFallback(audio: Uint8Array, language: string, prompt: string): Promise<TranscribeResponse> {
    const form = new FormData();
    // Cast to BlobPart[] — audio is always ArrayBuffer-backed (never
    // SharedArrayBuffer) but TS 5.7+ defaults Uint8Array to generic
    // ArrayBufferLike, which Blob rejects.
    form.append('file', new Blob([audio as BlobPart], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', GROQ_FALLBACK_STT_MODEL);
    form.append('language', language);
    form.append('response_format', 'json');
    if (prompt) form.append('prompt', prompt);

    const res = await fetch(`${GROQ_API_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.groqApiKey}` },
      body: form,
      signal: AbortSignal.timeout(this.timeouts.stt),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GatewayError(`Groq STT fallback failed (${res.status}): ${text.slice(0, 200)}`, res.status, '/groq/audio/transcriptions');
    }
    const data = await res.json() as { text?: string };
    return { text: data.text ?? '', usedGpu: false };
  }

  /** Call Groq chat completions directly — used when the gateway is unreachable. */
  private async groqChatFallback(messages: ChatMessage[], options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
    const body: Record<string, unknown> = {
      model: options.model ?? GROQ_FALLBACK_LLM_MODEL,
      messages,
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;

    const res = await fetch(`${GROQ_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeouts.translate),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GatewayError(`Groq LLM fallback failed (${res.status}): ${text.slice(0, 200)}`, res.status, '/groq/chat/completions');
    }
    const data = await res.json() as {
      model?: string;
      choices?: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    return {
      content,
      model: data.model ?? (options.model ?? GROQ_FALLBACK_LLM_MODEL),
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /** Clean up resources. No-op for now (fetch has no persistent connections). */
  close(): void {
    // Reserved for future connection pooling
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /**
   * Internal fetch with retry on connection-level errors.
   * Retries ECONNREFUSED, network failures with exponential backoff
   * so that gateway restarts don't cause permanent failures.
   * HTTP 4xx/5xx errors are NOT retried.
   */
  private async fetch(
    path: string,
    options: {
      method: string;
      headers?: Record<string, string>;
      body?: BodyInit | Uint8Array;
      timeout: number;
      allowedStatuses?: number[];
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    let lastError: unknown;
    const maxRetries = this.maxRetries;
    const backoff = this.retryBackoffMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = backoff[Math.min(attempt - 1, backoff.length - 1)];
        await new Promise(r => setTimeout(r, delay));
      }

      const controller = new AbortController();
      const timeoutSignal = AbortSignal.timeout(options.timeout);

      const combinedSignal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;

      try {
        const res = await fetch(url, {
          method: options.method,
          headers: { ...this.headers, ...options.headers },
          body: options.body as BodyInit,
          signal: combinedSignal,
        });

        controller.abort();

        const allowed = options.allowedStatuses ?? [];
        if (!res.ok && !allowed.includes(res.status)) {
          const text = await res.text().catch(() => '');
          throw new GatewayError(
            `${options.method} ${path} failed (${res.status}): ${text.slice(0, 200)}`,
            res.status,
            path,
          );
        }
        return res;
      } catch (err: unknown) {
        controller.abort();
        // HTTP errors (GatewayError with status code) are NOT retried
        if (err instanceof GatewayError && err.statusCode > 0) throw err;

        // Timeout errors are NOT retried
        if (err instanceof Error && err.name === 'AbortError') {
          const reason = (err as Error & { cause?: unknown }).cause;
          if (reason instanceof Error && reason.name === 'AbortError') {
            throw err;
          }
          throw new GatewayError(
            `${options.method} ${path} timed out (${options.timeout}ms)`,
            0,
            path,
          );
        }

        lastError = err;

        // Only retry connection-level errors
        if (!isRetryableError(err) || attempt >= maxRetries) {
          if (err instanceof TypeError) {
            throw new GatewayError(
              `${options.method} ${path} network error: ${err.message}`,
              0,
              path,
              true, // isNetworkError — triggers Groq fallback
            );
          }
          throw err;
        }
        // Connection error — retry
      }
    }

    // Unreachable, but satisfies TS
    if (lastError instanceof TypeError) {
      throw new GatewayError(
        `${options.method} ${path} network error after ${maxRetries + 1} attempts: ${(lastError as Error).message}`,
        0,
        path,
        true, // isNetworkError
      );
    }
    throw lastError;
  }

  /** Parse JSON from response, throwing GatewayError on invalid JSON. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async parseJson(res: Response, path: string): Promise<Record<string, unknown>> {
    try {
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new GatewayError(
          `${path}: invalid JSON: "${text.slice(0, 100)}"`,
          res.status,
          path,
        );
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new GatewayError(
          `${path}: invalid JSON response: expected object, got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}`,
          res.status,
          path,
        );
      }
      return parsed as Record<string, unknown>;
    } catch (err: unknown) {
      if (err instanceof GatewayError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new GatewayError(
        `${path}: invalid JSON response: ${msg}`,
        res.status,
        path,
      );
    }
  }
}
