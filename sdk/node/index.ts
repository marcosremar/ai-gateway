/**
 * Node SDK entry (`@parle/ai-gateway/client`). The live client is `GatewayClient` (exported at the bottom).
 *
 * LEGACY below: GatewayHttpClient — TypeScript HTTP client for the BabelCast AI Gateway (deprecated).
 *
 * Mirrors the Python gateway_sdk.GatewaySDK with circuit breaker + retry.
 *
 * Usage:
 *   const gw = new GatewayHttpClient({ baseUrl: 'http://localhost:4000' });
 *   const result = await gw.pipeline(audioBuffer, { source: 'fr', target: 'en' });
 *   const health = await gw.health();
 *   await gw.close();
 */

import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';
import type {
  GatewayHttpClientConfig,
  TimeoutConfig,
  RetryConfig,
  TranscribeResult,
  EnsembleTranscribeResult,
  TranslateResult,
  ChatCompletionResult,
  PipelineResult,
  PipelineOptions,
  TtsOptions,
  TtsResult,
  ImageOptions,
  ImageResult,
  ModelInfo,
  ModelsResult,
  DeployOptions,
  GpuStatus,
  GpuInstance,
  GpuOffer,
  GpuPreflightResult,
  GpuSnapshotResult,
  GpuReadinessResult,
  GpuLatencyHost,
  CanaryStatus,
  DockerBuildOptions,
  DockerBuild,
  DockerImage,
  BotDeployOptions,
  BotJoinOptions,
  BotStatus,
  WorkloadOptions,
  Workload,
  RequestLog,
  RequestLogsResult,
  HealthStatus,
  ComponentHealth,
  GatewayMetrics,
  ToolDescriptor,
  ToolsResult,
  LightningStudioStatus,
} from './types';
import { DEFAULT_TIMEOUTS, DEFAULT_RETRY, DEFAULT_CIRCUIT_BREAKER } from './types';

const GROQ_API_BASE = 'https://api.groq.com/openai/v1';

export { CircuitBreaker, CircuitOpenError } from './circuit-breaker';
export type { CircuitState } from './circuit-breaker';
export * from './types';
export { AudioSegmenter, VAD_WINDOW_SAMPLES } from './audio';
export type { AudioSegmenterConfig, AudioSegment } from './audio';

/** Thrown when the gateway returns an HTTP error. */
/** @deprecated Error type of the legacy `GatewayHttpClient`; `GatewayClient` throws `GatewayError`. */
export class GatewayHttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 0,
    public readonly endpoint: string = '',
  ) {
    super(message);
    this.name = 'GatewayHttpError';
  }
}

/** Check if an error is a connection-level error (retryable). */
function isConnectionError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|network/i.test(msg);
}

function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * @deprecated Legacy client: about 45 of its routes (/v1/pipeline, /v1/speech, /v1/invoke, ...) are not mounted by
 * serve.ts. Use `GatewayClient` from `@parle/ai-gateway/client` (sdk/node/gateway-client.ts) for HTTP, and `@parle/ai-gateway/voice` (sdk/browser/voice) in the browser.
 * Kept until the next major.
 */
export class GatewayHttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly groqApiKey: string;
  private readonly timeouts: TimeoutConfig;
  private readonly retryConfig: RetryConfig;
  private readonly circuitBreaker: CircuitBreaker;
  private closed = false;

  constructor(config: GatewayHttpClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey ?? '';
    this.groqApiKey = config.groqApiKey ?? (typeof process !== 'undefined' ? process.env.GROQ_API_KEY ?? '' : '');
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
    this.retryConfig = { ...DEFAULT_RETRY, ...config.retry };
    this.circuitBreaker = new CircuitBreaker({
      ...DEFAULT_CIRCUIT_BREAKER,
      ...config.circuitBreaker,
    });
  }

  private async _request<T>(
    method: string,
    path: string,
    options: {
      body?: BodyInit | Uint8Array | null;
      headers?: Record<string, string>;
      params?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ): Promise<{ data: T; requestId: string; response: Response }> {
    if (this.closed) throw new Error('Client is closed');
    // Short-circuit when the breaker is open so callers fail fast with
    // CircuitOpenError instead of paying for one more request that will
    // either time out or pile another failure onto the count.
    this.circuitBreaker.allowRequest();

    const requestId = generateRequestId();
    const timeoutMs = options.timeoutMs ?? this.timeouts.defaultMs;

    let url = `${this.baseUrl}${path}`;
    if (options.params) {
      const qs = new URLSearchParams(options.params).toString();
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = {
      'X-Request-ID': requestId,
      ...options.headers,
    };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.retryConfig.backoffMs[Math.min(attempt - 1, this.retryConfig.backoffMs.length - 1)];
        await new Promise(r => setTimeout(r, delay));
      }

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: options.body as BodyInit | null | undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          this.circuitBreaker.recordFailure();
          throw new GatewayHttpError(
            `Gateway ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`,
            response.status,
            path,
          );
        }

        this.circuitBreaker.recordSuccess();
        const contentType = response.headers.get('content-type') ?? '';
        let data: T;
        if (contentType.includes('application/json')) {
          data = await response.json() as T;
        } else {
          data = await response.arrayBuffer() as unknown as T;
        }
        return { data, requestId, response };
      } catch (err) {
        if (err instanceof GatewayHttpError) throw err;
        if (err instanceof CircuitOpenError) throw err;

        lastError = err;
        if (!isConnectionError(err) || attempt >= this.retryConfig.maxRetries) {
          this.circuitBreaker.recordFailure();
          throw err;
        }
      }
    }

    this.circuitBreaker.recordFailure();
    throw lastError;
  }

  // ── Health ──────────────────────────────────────────────────────────────

  async health(): Promise<HealthStatus> {
    try {
      const { data } = await this._request<Record<string, unknown>>('GET', '/health', {
        timeoutMs: this.timeouts.healthMs,
      });
      const status = (data.status as string) || 'ok';
      const rawComponents = (data.components || {}) as Record<string, Record<string, unknown>>;
      const components: Record<string, ComponentHealth> = {};
      for (const [k, v] of Object.entries(rawComponents)) {
        components[k] = {
          status: (v.status as ComponentHealth['status']) || 'ok',
          provider: v.provider as string | undefined,
          reason: v.reason as string | undefined,
          endpoint: v.endpoint as string | undefined,
          healthy: v.healthy as boolean | undefined,
          idleSec: (v.idle_sec ?? v.idleSec) as number | undefined,
        };
      }
      return {
        status: status as HealthStatus['status'],
        uptimeSec: ((data.uptime_sec ?? data.uptimeSec) as number) || 0,
        components,
        isHealthy: status === 'ok' || status === 'degraded',
      };
    } catch {
      return { status: 'error', uptimeSec: 0, components: {}, isHealthy: false };
    }
  }

  // ── Tools discovery ─────────────────────────────────────────────────────

  async getTools(): Promise<ToolsResult> {
    try {
      const { data } = await this._request<{ tools?: ToolDescriptor[] }>('GET', '/api/tools', {
        timeoutMs: this.timeouts.healthMs,
      });
      return { tools: data.tools ?? [] };
    } catch {
      return { tools: [] };
    }
  }

  // ── Metrics ─────────────────────────────────────────────────────────────

  async metrics(): Promise<GatewayMetrics> {
    const { data } = await this._request<GatewayMetrics>('GET', '/metrics', {
      timeoutMs: this.timeouts.healthMs,
    });
    return data;
  }

  async requestLogs(options?: { limit?: number; stage?: string }): Promise<RequestLogsResult> {
    const params: Record<string, string> = {};
    if (options?.limit) params.limit = String(options.limit);
    if (options?.stage) params.stage = options.stage;
    const { data } = await this._request<{ logs?: RequestLog[]; total?: number }>(
      'GET', '/v1/requests/log', { params, timeoutMs: this.timeouts.healthMs }
    );
    return { logs: data.logs ?? [], total: data.total ?? 0 };
  }

  async systemAnalytics(): Promise<Record<string, unknown>> {
    const { data } = await this._request<Record<string, unknown>>('GET', '/v1/analytics/system', {
      timeoutMs: this.timeouts.healthMs,
    });
    return data;
  }

  async performanceStats(): Promise<Record<string, unknown>> {
    const { data } = await this._request<Record<string, unknown>>('GET', '/v1/performance', {
      timeoutMs: this.timeouts.healthMs,
    });
    return data;
  }

  // ── Models ───────────────────────────────────────────────────────────────

  async listModels(): Promise<ModelsResult> {
    const { data } = await this._request<{ data?: unknown[] }>('GET', '/v1/models', {
      timeoutMs: this.timeouts.healthMs,
    });
    const models: ModelInfo[] = (data.data ?? []).map((m: unknown) => {
      const model = m as Record<string, unknown>;
      return {
        id: (model.id as string) ?? '',
        provider: (model.owned_by as string) ?? '',
        type: (model.object as string) ?? 'model',
        contextLength: model.context_length as number | undefined,
      };
    });
    return { models };
  }

  // ── STT ─────────────────────────────────────────────────────────────────

  async transcribe(audio: Uint8Array | Buffer, language = 'fr'): Promise<TranscribeResult> {
    try {
      const { data } = await this._request<{ text: string; used_gpu: boolean }>(
        'POST', '/v1/transcribe',
        {
          body: audio as unknown as BodyInit,
          headers: { 'Content-Type': 'audio/wav' },
          params: { language },
          timeoutMs: this.timeouts.sttMs,
        },
      );
      return { text: data.text || '', usedGpu: data.used_gpu ?? false };
    } catch (err) {
      if (!isConnectionError(err) || !this.groqApiKey) throw err;
      return this._groqTranscribe(audio, language);
    }
  }

  async ensembleTranscribe(
    audio: Uint8Array | Buffer,
    options?: { language?: string; providers?: string[] },
  ): Promise<EnsembleTranscribeResult> {
    const params: Record<string, string> = {};
    if (options?.language) params.language = options.language;
    if (options?.providers) params.providers = options.providers.join(',');
    const { data } = await this._request<{
      text: string;
      provider: string;
      all_results?: Array<{ provider: string; text: string; latency_ms: number }>;
    }>(
      'POST', '/v1/ensemble-transcribe',
      {
        body: audio as unknown as BodyInit,
        headers: { 'Content-Type': 'audio/wav' },
        params,
        timeoutMs: this.timeouts.sttMs * 2,
      },
    );
    return {
      text: data.text ?? '',
      provider: data.provider ?? '',
      allResults: (data.all_results ?? []).map(r => ({
        provider: r.provider,
        text: r.text,
        latencyMs: r.latency_ms,
      })),
    };
  }

  // ── Chat (LLM) ────────────────────────────────────────────────────────────

  async chat(
    messages: Array<{ role: string; content: string }>,
    model = 'llama-3.3-70b-versatile',
    options?: {
      temperature?: number;
      maxTokens?: number;
      responseFormat?: { type: 'json_object' | 'text' };
      timeoutMs?: number;
    },
  ): Promise<ChatCompletionResult> {
    try {
      const body: Record<string, unknown> = { model, messages };
      if (options?.temperature !== undefined) body.temperature = options.temperature;
      if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;
      if (options?.responseFormat !== undefined) body.response_format = options.responseFormat;
      const { data } = await this._request<{
        model: string;
        choices: Array<{ message: { content?: string; reasoning?: string; reasoning_content?: string } }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      }>(
        'POST', '/v1/chat/completions',
        {
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
          timeoutMs: options?.timeoutMs ?? this.timeouts.translateMs,
        },
      );
      const msg = data.choices?.[0]?.message;
      const content = (msg?.content && msg.content.trim())
        || msg?.reasoning
        || msg?.reasoning_content
        || '';
      return { content, model: data.model || model, usage: data.usage };
    } catch (err) {
      if (!isConnectionError(err) || !this.groqApiKey) throw err;
      return this._groqChat(messages, model, options);
    }
  }

  // ── Translation ─────────────────────────────────────────────────────────

  async translate(text: string, sourceLang = 'fr', targetLang = 'en'): Promise<TranslateResult> {
    try {
      const { data } = await this._request<{ translated_text: string; used_gpu: boolean }>(
        'POST', '/v1/translate',
        {
          body: JSON.stringify({ text, source_lang: sourceLang, target_lang: targetLang }),
          headers: { 'Content-Type': 'application/json' },
          timeoutMs: this.timeouts.translateMs,
        },
      );
      return { translatedText: data.translated_text || '', usedGpu: data.used_gpu ?? false };
    } catch (err) {
      if (!isConnectionError(err) || !this.groqApiKey) throw err;
      const result = await this._groqChat(
        [{ role: 'user', content: `Translate from ${sourceLang} to ${targetLang}. Return ONLY the translation.\n\n${text}` }],
        'llama-3.3-70b-versatile',
      );
      return { translatedText: result.content, usedGpu: false };
    }
  }

  // ── TTS ─────────────────────────────────────────────────────────────────

  async tts(text: string, options?: TtsOptions): Promise<TtsResult> {
    const body: Record<string, unknown> = {
      input: text,
      model: options?.model ?? 'tts-1',
      voice: options?.voice ?? 'alloy',
    };
    if (options?.speed !== undefined) body.speed = options.speed;
    const { response } = await this._request<ArrayBuffer>(
      'POST', '/v1/audio/speech',
      {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: this.timeouts.defaultMs,
      },
    );
    const audioBuffer = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? 'audio/wav';
    return { audioBuffer, contentType };
  }

  async ttsPreview(text: string, options?: TtsOptions): Promise<TtsResult> {
    const body: Record<string, unknown> = { text };
    if (options?.voice) body.voice = options.voice;
    if (options?.model) body.model = options.model;
    const { response } = await this._request<ArrayBuffer>(
      'POST', '/v1/tts-preview',
      {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: this.timeouts.defaultMs,
      },
    );
    const audioBuffer = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? 'audio/wav';
    return { audioBuffer, contentType };
  }

  // ── Image generation ─────────────────────────────────────────────────────

  async generateImage(prompt: string, options?: ImageOptions): Promise<ImageResult> {
    const body: Record<string, unknown> = { prompt };
    if (options?.model) body.model = options.model;
    if (options?.size) body.size = options.size;
    if (options?.quality) body.quality = options.quality;
    if (options?.n) body.n = options.n;
    const { data } = await this._request<{ data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }> }>(
      'POST', '/v1/images/generate',
      {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: 60_000,
      },
    );
    const first = data.data?.[0] ?? {};
    return {
      url: first.url,
      base64: first.b64_json,
      revisedPrompt: first.revised_prompt,
    };
  }

  // ── Pipeline ────────────────────────────────────────────────────────────

  async pipeline(audio: Uint8Array | Buffer, options?: PipelineOptions): Promise<PipelineResult> {
    const source = options?.source ?? 'fr';
    const target = options?.target ?? 'en';
    const params: Record<string, string> = { source, target };
    if (options?.speaker) params.speaker = options.speaker;

    const { data } = await this._request<{
      transcription: string;
      response: string;
      audio_base64: string;
      content_type: string;
      timing: { total_ms: number; stt_ms: number; llm_ms: number; tts_ms: number; used_gpu: boolean };
    }>(
      'POST', '/v1/speech',
      {
        body: audio as unknown as BodyInit,
        headers: { 'Content-Type': 'audio/wav' },
        params,
        timeoutMs: this.timeouts.pipelineMs,
      },
    );

    const timing = data.timing || { total_ms: 0, stt_ms: 0, llm_ms: 0, tts_ms: 0, used_gpu: false };
    return {
      transcription: data.transcription || '',
      response: data.response || '',
      audioBase64: data.audio_base64 || '',
      contentType: data.content_type || '',
      timing: {
        totalMs: timing.total_ms || 0,
        sttMs: timing.stt_ms || 0,
        llmMs: timing.llm_ms || 0,
        ttsMs: timing.tts_ms || 0,
        usedGpu: timing.used_gpu ?? false,
      },
    };
  }

  // ── GPU Management ──────────────────────────────────────────────────────

  async deployGpu(options: DeployOptions): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { apiKey: options.apiKey };
    if (options.dockerImage) body.dockerImage = options.dockerImage;
    if (options.gpuTypes) body.gpuTypes = options.gpuTypes;
    if (options.maxCostUsd !== undefined) body.maxCostUsd = options.maxCostUsd;
    if (options.containerDiskInGb !== undefined) body.containerDiskInGb = options.containerDiskInGb;
    if (options.interruptible !== undefined) body.interruptible = options.interruptible;
    const { data } = await this._request<Record<string, unknown>>(
      'POST', '/v1/gpu/deploy',
      { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, timeoutMs: this.timeouts.deployMs },
    );
    return data;
  }

  async gpuStatus(): Promise<GpuStatus> {
    const { data } = await this._request<Record<string, unknown>>(
      'GET', '/v1/gpu/status', { timeoutMs: this.timeouts.healthMs }
    );
    return {
      status: (data.status as string) || 'idle',
      podId: (data.podId as string) || '',
      endpoint: (data.endpoint as string) || '',
      gpuType: (data.gpuType as string) || '',
      message: (data.message as string) || '',
      step: (data.step as string) || '',
      stepDetail: (data.stepDetail as string) || '',
      elapsedSec: (data.elapsedSec as number) || 0,
      gpuHealthy: (data.gpuHealthy as boolean) || false,
      activeTier: (data.activeTier as string) || 'cloud',
      idleSec: (data.idleSec as number) || 0,
      idleTimeoutSec: (data.idleTimeoutSec as number) || 900,
      startedAt: (data.startedAt as number) || 0,
      retryCount: (data.retryCount as number) || 0,
    };
  }

  async stopGpu(): Promise<Record<string, unknown>> {
    const { data } = await this._request<Record<string, unknown>>(
      'POST', '/v1/gpu/stop',
      { body: '{}', headers: { 'Content-Type': 'application/json' }, timeoutMs: this.timeouts.deployMs }
    );
    return data;
  }

  async resumeGpu(): Promise<Record<string, unknown>> {
    const { data } = await this._request<Record<string, unknown>>(
      'POST', '/v1/gpu/resume',
      { body: '{}', headers: { 'Content-Type': 'application/json' }, timeoutMs: this.timeouts.deployMs }
    );
    return data;
  }

  async terminateGpu(): Promise<Record<string, unknown>> {
    const { data } = await this._request<Record<string, unknown>>(
      'POST', '/v1/gpu/terminate',
      { body: '{}', headers: { 'Content-Type': 'application/json' }, timeoutMs: this.timeouts.deployMs }
    );
    return data;
  }

  async gpuLogs(options?: { tail?: number }): Promise<string> {
    const params: Record<string, string> = {};
    if (options?.tail) params.tail = String(options.tail);
    const { data } = await this._request<{ logs?: string } | string>(
      'GET', '/v1/gpu/logs', { params, timeoutMs: this.timeouts.defaultMs }
    );
    return typeof data === 'string' ? data : (data as { logs?: string }).logs ?? '';
  }

  async gpuInspect(): Promise<Record<string, unknown>> {
    const { data } = await this._request<Record<string, unknown>>(
      'GET', '/v1/gpu/inspect', { timeoutMs: this.timeouts.defaultMs }
    );
    return data;
  }

  async gpuList(options?: { probe?: boolean; mine?: boolean; label?: string }): Promise<GpuInstance[]> {
    const params: Record<string, string> = {};
    if (options?.probe === false) params.probe = 'false';
    if (options?.mine) params.mine = 'true';
    if (options?.label) params.label = options.label;
    const { data } = await this._request<{ instances?: unknown[] }>(
      'GET', '/v1/gpu/list', { params, timeoutMs: this.timeouts.defaultMs }
    );
    return (data.instances ?? []).map((i: unknown) => {
      const inst = i as Record<string, unknown>;
      return {
        podId: (inst.podId ?? inst.pod_id ?? inst.id) as string ?? '',
        provider: inst.provider as string ?? '',
        status: inst.status as string ?? '',
        gpuType: (inst.gpuType ?? inst.gpu_type) as string ?? '',
        endpoint: inst.endpoint as string | undefined,
        costPerHr: inst.costPerHr as number | undefined,
        label: inst.label as string | undefined,
        createdAt: inst.createdAt as string | undefined,
      };
    });
  }

  async gpuOffers(options?: { gpuType?: string; minVram?: number; maxPrice?: number }): Promise<GpuOffer[]> {
    const params: Record<string, string> = {};
    if (options?.gpuType) params.gpuType = options.gpuType;
    if (options?.minVram) params.minVram = String(options.minVram);
    if (options?.maxPrice) params.maxPrice = String(options.maxPrice);
    const { data } = await this._request<{ offers?: unknown[] }>(
      'GET', '/v1/gpu/offers', { params, timeoutMs: this.timeouts.defaultMs }
    );
    return (data.offers ?? []).map((o: unknown) => {
      const offer = o as Record<string, unknown>;
      return {
        id: offer.id as string ?? '',
        provider: offer.provider as string ?? '',
        gpuType: (offer.gpuType ?? offer.gpu_type) as string ?? '',
        gpuCount: (offer.gpuCount ?? offer.gpu_count ?? 1) as number,
        vramGb: (offer.vramGb ?? offer.vram_gb ?? 0) as number,
        pricePerHr: (offer.pricePerHr ?? offer.price_per_hr ?? 0) as number,
        region: offer.region as string | undefined,
        score: offer.score as number | undefined,
      };
    });
  }

  async gpuPreflight(options?: { dockerImage?: string; gpuTypes?: string[] }): Promise<GpuPreflightResult> {
    const body: Record<string, unknown> = {};
    if (options?.dockerImage) body.dockerImage = options.dockerImage;
    if (options?.gpuTypes) body.gpuTypes = options.gpuTypes;
    const { data } = await this._request<Record<string, unknown>>(
      'POST', '/v1/gpu/preflight',
      { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, timeoutMs: this.timeouts.defaultMs }
    );
    return {
      canAfford: (data.canAfford ?? data.can_afford ?? false) as boolean,
      estimatedHourlyCost: (data.estimatedHourlyCost ?? data.estimated_hourly_cost ?? 0) as number,
      balanceUsd: (data.balanceUsd ?? data.balance_usd ?? 0) as number,
      warnings: (data.warnings ?? []) as string[],
      errors: (data.errors ?? []) as string[],
    };
  }

  async gpuSnapshot(): Promise<GpuSnapshotResult> {
    const { data } = await this._request<Record<string, unknown>>(
      'GET', '/v1/gpu/snapshot', { timeoutMs: this.timeouts.defaultMs }
    );
    return {
      snapshotId: data.snapshotId as string | undefined,
      status: (data.status ?? 'unknown') as string,
      createdAt: data.createdAt as string | undefined,
    };
  }

  async createGpuSnapshot(): Promise<GpuSnapshotResult> {
    const { data } = await this._request<Record<string, unknown>>(
      'POST', '/v1/gpu/snapshot',
      { body: '{}', headers: { 'Content-Type': 'application/json' }, timeoutMs: this.timeouts.deployMs }
    );
    return {
      snapshotId: data.snapshotId as string | undefined,
      status: (data.status ?? 'creating') as string,
      createdAt: data.createdAt as string | undefined,
    };
  }

  async deleteGpuSnapshot(): Promise<void> {
    await this._request('DELETE', '/v1/gpu/snapshot', { timeoutMs: this.timeouts.defaultMs });
  }

  async gpuReadinessStatus(): Promise<GpuReadinessResult> {
    const { data } = await this._request<Record<string, unknown>>(
      'GET', '/v1/gpu/readiness/status', { timeoutMs: this.timeouts.healthMs }
    );
    return {
      ready: (data.ready ?? false) as boolean,
      phase: (data.phase ?? 'unknown') as string,
      benchmarkScore: data.benchmarkScore as number | undefined,
      lastCheckedAt: data.lastCheckedAt as string | undefined,
      detail: data.detail as string | undefined,
    };
  }

  async resetGpuReadiness(): Promise<void> {
    await this._request('POST', '/v1/gpu/readiness/reset', {
      body: '{}', headers: { 'Content-Type': 'application/json' }, timeoutMs: this.timeouts.defaultMs
    });
  }

  async gpuLatencyHosts(options?: { gpu?: string; limit?: number; sort?: string }): Promise<GpuLatencyHost[]> {
    const params: Record<string, string> = {};
    if (options?.gpu) params.gpu = options.gpu;
    if (options?.limit) params.limit = String(options.limit);
    if (options?.sort) params.sort = options.sort;
    const { data } = await this._request<{ hosts?: unknown[] }>(
      'GET', '/v1/gpu/latency/hosts', { params, timeoutMs: this.timeouts.defaultMs }
    );
    return (data.hosts ?? []).map((h: unknown) => {
      const host = h as Record<string, unknown>;
      return {
        host: host.host as string ?? '',
        rttMs: (host.rttMs ?? host.rtt_ms ?? 0) as number,
        gpuType: (host.gpuType ?? host.gpu_type) as string | undefined,
        provider: host.provider as string | undefined,
        reputation: host.reputation as number | undefined,
        lastProbed: host.lastProbed as string | undefined,
      };
    });
  }

  async triggerLatencyProbe(): Promise<void> {
    await this._request('POST', '/v1/gpu/latency/probe', {
      body: '{}', headers: { 'Content-Type': 'application/json' }, timeoutMs: this.timeouts.defaultMs
    });
  }

  async gpuSweep(): Promise<Record<string, unknown>> {
    const { data } = await this._request<Record<string, unknown>>(
      'GET', '/v1/gpu/sweep', { timeoutMs: this.timeouts.defaultMs }
    );
    return data;
  }

  async canaryStatus(): Promise<CanaryStatus> {
    const { data } = await this._request<Record<string, unknown>>(
      'GET', '/v1/canary/status', { timeoutMs: this.timeouts.healthMs }
    );
    return {
      active: (data.active ?? false) as boolean,
      deployId: data.deployId as string | undefined,
      trafficPct: (data.trafficPct ?? data.traffic_pct ?? 0) as number,
      errorRate: data.errorRate as number | undefined,
      rolledBack: data.rolledBack as boolean | undefined,
    };
  }

  // ── Docker Image Builder ─────────────────────────────────────────────────

  async dockerBuild(dir: string, options: DockerBuildOptions): Promise<DockerBuild> {
    const body: Record<string, unknown> = { dir, ...options };
    const { data } = await this._request<Record<string, unknown>>(
      'POST', '/v1/docker/build',
      {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: options.wait ? 30 * 60_000 : this.timeouts.deployMs,
      },
    );
    return {
      buildId: (data.buildId ?? data.build_id ?? '') as string,
      name: (data.name ?? '') as string,
      status: (data.status ?? 'pending') as string,
      imageUrl: data.imageUrl as string | undefined,
      startedAt: (data.startedAt ?? new Date().toISOString()) as string,
      finishedAt: data.finishedAt as string | undefined,
      error: data.error as string | undefined,
    };
  }

  async dockerBuilds(): Promise<DockerBuild[]> {
    const { data } = await this._request<{ builds?: unknown[] }>(
      'GET', '/v1/docker/builds', { timeoutMs: this.timeouts.defaultMs }
    );
    return (data.builds ?? []).map((b: unknown) => {
      const build = b as Record<string, unknown>;
      return {
        buildId: (build.buildId ?? build.build_id ?? '') as string,
        name: (build.name ?? '') as string,
        status: (build.status ?? '') as string,
        imageUrl: build.imageUrl as string | undefined,
        startedAt: (build.startedAt ?? '') as string,
        finishedAt: build.finishedAt as string | undefined,
        error: build.error as string | undefined,
      };
    });
  }

  async dockerImages(): Promise<DockerImage[]> {
    const { data } = await this._request<{ images?: unknown[] }>(
      'GET', '/v1/docker/images', { timeoutMs: this.timeouts.defaultMs }
    );
    return (data.images ?? []).map((i: unknown) => {
      const img = i as Record<string, unknown>;
      return {
        name: (img.name ?? '') as string,
        imageUrl: (img.imageUrl ?? img.image_url ?? '') as string,
        builtAt: (img.builtAt ?? img.built_at ?? '') as string,
        platform: img.platform as string | undefined,
      };
    });
  }

  // ── Bot Management ───────────────────────────────────────────────────────

  async deployBot(options?: BotDeployOptions): Promise<Record<string, unknown>> {
    const { data } = await this._request<Record<string, unknown>>(
      'POST', '/v1/bot/deploy',
      {
        body: JSON.stringify(options ?? {}),
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: this.timeouts.deployMs,
      },
    );
    return data;
  }

  async botJoin(options: BotJoinOptions): Promise<Record<string, unknown>> {
    const { data } = await this._request<Record<string, unknown>>(
      'POST', '/v1/bot/join',
      {
        body: JSON.stringify(options),
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: this.timeouts.deployMs,
      },
    );
    return data;
  }

  async botLeave(options?: { botId?: string }): Promise<void> {
    await this._request('POST', '/v1/bot/leave', {
      body: JSON.stringify(options ?? {}),
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: this.timeouts.defaultMs,
    });
  }

  async botStatus(): Promise<BotStatus> {
    const { data } = await this._request<Record<string, unknown>>(
      'GET', '/v1/bot/status', { timeoutMs: this.timeouts.healthMs }
    );
    return {
      status: (data.status ?? 'idle') as string,
      botId: data.botId as string | undefined,
      meetingUrl: data.meetingUrl as string | undefined,
      platform: data.platform as string | undefined,
      joinedAt: data.joinedAt as string | undefined,
    };
  }

  // ── Workloads ────────────────────────────────────────────────────────────

  async launchWorkload(options: WorkloadOptions): Promise<Workload> {
    const { data } = await this._request<Record<string, unknown>>(
      'POST', '/v1/workloads',
      {
        body: JSON.stringify(options),
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: this.timeouts.deployMs,
      },
    );
    return {
      workloadId: (data.workloadId ?? data.workload_id ?? '') as string,
      type: (data.type ?? options.type) as string,
      name: data.name as string | undefined,
      status: (data.status ?? 'pending') as string,
      createdAt: (data.createdAt ?? new Date().toISOString()) as string,
    };
  }

  async listWorkloads(): Promise<Workload[]> {
    const { data } = await this._request<{ workloads?: unknown[] }>(
      'GET', '/v1/workloads', { timeoutMs: this.timeouts.defaultMs }
    );
    return (data.workloads ?? []).map((w: unknown) => {
      const wl = w as Record<string, unknown>;
      return {
        workloadId: (wl.workloadId ?? wl.workload_id ?? '') as string,
        type: (wl.type ?? '') as string,
        name: wl.name as string | undefined,
        status: (wl.status ?? '') as string,
        createdAt: (wl.createdAt ?? '') as string,
      };
    });
  }

  // ── Lightning AI Studio ──────────────────────────────────────────────────

  async lightningStatus(): Promise<LightningStudioStatus> {
    const { data } = await this._request<Record<string, unknown>>(
      'GET', '/v1/lightning/status', { timeoutMs: this.timeouts.healthMs }
    );
    const phase = (data.phase ?? 'STOPPED') as string;
    return {
      phase: phase as LightningStudioStatus['phase'],
      running: phase === 'CLOUD_SPACE_INSTANCE_STATE_RUNNING',
      sshUser: data.sshUser as string | undefined,
      sshHost: data.sshHost as string | undefined,
      instanceId: data.instanceId as string | undefined,
      startedAt: data.startedAt as string | undefined,
      activeSessions: data.activeSessions as number | undefined,
    };
  }

  async lightningStart(): Promise<LightningStudioStatus> {
    const { data } = await this._request<Record<string, unknown>>(
      'POST', '/v1/lightning/start',
      { body: '{}', headers: { 'Content-Type': 'application/json' }, timeoutMs: 5 * 60_000 }
    );
    const phase = (data.phase ?? 'STOPPED') as string;
    return {
      phase: phase as LightningStudioStatus['phase'],
      running: phase === 'CLOUD_SPACE_INSTANCE_STATE_RUNNING',
      sshUser: data.sshUser as string | undefined,
      sshHost: data.sshHost as string | undefined,
      instanceId: data.instanceId as string | undefined,
      startedAt: data.startedAt as string | undefined,
    };
  }

  async lightningStop(): Promise<void> {
    await this._request('POST', '/v1/lightning/stop', {
      body: '{}', headers: { 'Content-Type': 'application/json' }, timeoutMs: this.timeouts.defaultMs
    });
  }

  async lightningSessionStart(): Promise<void> {
    await this._request('POST', '/v1/lightning/session/start', {
      body: '{}', headers: { 'Content-Type': 'application/json' }, timeoutMs: this.timeouts.defaultMs
    });
  }

  async lightningSessionEnd(): Promise<void> {
    await this._request('POST', '/v1/lightning/session/end', {
      body: '{}', headers: { 'Content-Type': 'application/json' }, timeoutMs: this.timeouts.defaultMs
    });
  }

  // ── Groq direct fallback ────────────────────────────────────────────────

  private async _groqTranscribe(audio: Uint8Array | Buffer, language: string): Promise<TranscribeResult> {
    const form = new FormData();
    form.append('file', new Blob([audio as unknown as BlobPart], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', language);

    const res = await fetch(`${GROQ_API_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.groqApiKey}` },
      body: form,
      signal: AbortSignal.timeout(this.timeouts.sttMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GatewayHttpError(
        `Groq STT fallback failed (${res.status}): ${text.slice(0, 200)}`,
        res.status,
        'groq:/audio/transcriptions',
      );
    }
    const data = await res.json() as { text?: string };
    return { text: data.text || '', usedGpu: false };
  }

  private async _groqChat(
    messages: Array<{ role: string; content: string }>,
    model: string,
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<ChatCompletionResult> {
    const body: Record<string, unknown> = { model, messages };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;

    const res = await fetch(`${GROQ_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeouts.translateMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GatewayHttpError(
        `Groq LLM fallback failed (${res.status}): ${text.slice(0, 200)}`,
        res.status,
        'groq:/chat/completions',
      );
    }
    const data = await res.json() as {
      model: string;
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    return { content, model: data.model || model, usage: data.usage };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async close(): Promise<void> {
    this.closed = true;
  }

  getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }
}

// ── GatewayClient: the client of the current API (docs/client.md). GatewayHttpClient above is the legacy client. ──
export { GatewayClient } from './gateway-client';
export { GatewayError, servedFrom } from './gateway-http';
export { S2SFrameDecoder } from './s2s-frames';
export { GATEWAY_CLIENT_TIMEOUTS } from './gateway-types';
export type {
  AppImage, AppView, CallOptions, ChatCompletion, ChatMessage, ChatRequest, ChatStream, ChatUsage, DeploymentList,
  DeploymentPutBody, DeploymentSpec, DeploymentView, DirectFallbackOptions, FallbackCredential, FallbackEntry,
  FallbackPlan, FetchLike, GatewayClientOptions, GatewayRoute, GatewayState, HealthReport, InstabilityEvent,
  InstabilityOptions, ModelRoutesSpec, Profile, ReplicaView,
  RouteChange, RouteEntrySpec, S2SConfig, S2SEvent, S2SFrame, S2SRequest, S2SStream, Served, SpeechRequest,
  SpeechResult, TimeoutGroup, Transcription, TranscribeRequest,
} from './gateway-types';

// ── Telemetry (docs/api/telemetry.md): server-side batching emitter, authenticated with the app key. ──
export { createServerTelemetry, TelemetryEmitter, newTraceId, traceparentOf } from './telemetry';
export type { ServerTelemetryOptions, EmitFields, TelemetryContext, TelemetryStats } from './telemetry';
