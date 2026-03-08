/**
 * GatewayHttpClient — TypeScript HTTP client for the BabelCast AI Gateway.
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
  TranslateResult,
  PipelineResult,
  PipelineOptions,
  DeployOptions,
  GpuStatus,
  HealthStatus,
  ComponentHealth,
  GatewayMetrics,
} from './types';
import { DEFAULT_TIMEOUTS, DEFAULT_RETRY, DEFAULT_CIRCUIT_BREAKER } from './types';

export { CircuitBreaker, CircuitOpenError } from './circuit-breaker';
export type { CircuitState } from './circuit-breaker';
export * from './types';

/** Thrown when the gateway returns an HTTP error. */
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
  if (err instanceof TypeError) return true; // fetch throws TypeError for network failures
  if (err instanceof DOMException && err.name === 'AbortError') return false; // timeout, don't retry
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|network/i.test(msg);
}

function generateRequestId(): string {
  return crypto.randomUUID();
}

export class GatewayHttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeouts: TimeoutConfig;
  private readonly retryConfig: RetryConfig;
  private readonly circuitBreaker: CircuitBreaker;
  private closed = false;

  constructor(config: GatewayHttpClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey ?? '';
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
    this.retryConfig = { ...DEFAULT_RETRY, ...config.retry };
    this.circuitBreaker = new CircuitBreaker({
      ...DEFAULT_CIRCUIT_BREAKER,
      ...config.circuitBreaker,
    });
  }

  /**
   * Internal request method with circuit breaker, retry, and request ID.
   */
  private async _request<T>(
    method: string,
    path: string,
    options: {
      body?: BodyInit | null;
      headers?: Record<string, string>;
      params?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ): Promise<{ data: T; requestId: string; response: Response }> {
    if (this.closed) throw new Error('Client is closed');

    this.circuitBreaker.allowRequest(); // throws CircuitOpenError if open

    const url = new URL(path, this.baseUrl);
    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        url.searchParams.set(k, v);
      }
    }

    const requestId = generateRequestId();
    const headers: Record<string, string> = {
      'X-Request-ID': requestId,
      ...options.headers,
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const timeoutMs = options.timeoutMs ?? this.timeouts.pipelineMs;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.retryConfig.backoffMs[attempt - 1] ?? this.retryConfig.backoffMs.at(-1) ?? 1000;
        await new Promise(r => setTimeout(r, delay));
      }

      try {
        const response = await fetch(url.toString(), {
          method,
          headers,
          body: options.body,
          signal: AbortSignal.timeout(timeoutMs),
        });

        // HTTP errors are NOT retried — the gateway has its own fallback chain
        if (response.status >= 400) {
          const text = await response.text().catch(() => '');
          this.circuitBreaker.recordFailure();
          throw new GatewayHttpError(
            `${method} ${path}: ${response.status} ${text.slice(0, 200)}`,
            response.status,
            path,
          );
        }

        this.circuitBreaker.recordSuccess();
        const data = await response.json() as T;
        return { data, requestId, response };
      } catch (err) {
        if (err instanceof GatewayHttpError) throw err; // don't retry HTTP errors
        if (err instanceof CircuitOpenError) throw err;

        lastError = err;
        if (!isConnectionError(err) || attempt >= this.retryConfig.maxRetries) {
          this.circuitBreaker.recordFailure();
          throw err;
        }
        // Connection error — retry
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
      return {
        status: 'error',
        uptimeSec: 0,
        components: {},
        isHealthy: false,
      };
    }
  }

  // ── Metrics ─────────────────────────────────────────────────────────────

  async metrics(): Promise<GatewayMetrics> {
    const { data } = await this._request<GatewayMetrics>('GET', '/metrics', {
      timeoutMs: this.timeouts.healthMs,
    });
    return data;
  }

  // ── STT ─────────────────────────────────────────────────────────────────

  async transcribe(audio: Uint8Array | Buffer, language = 'fr'): Promise<TranscribeResult> {
    const { data } = await this._request<{ text: string; used_gpu: boolean }>(
      'POST', '/v1/transcribe',
      {
        body: audio,
        headers: { 'Content-Type': 'audio/wav' },
        params: { language },
        timeoutMs: this.timeouts.sttMs,
      },
    );
    return { text: data.text || '', usedGpu: data.used_gpu ?? false };
  }

  // ── Translation ─────────────────────────────────────────────────────────

  async translate(text: string, sourceLang = 'fr', targetLang = 'en'): Promise<TranslateResult> {
    const { data } = await this._request<{ translated_text: string; used_gpu: boolean }>(
      'POST', '/v1/translate',
      {
        body: JSON.stringify({ text, source_lang: sourceLang, target_lang: targetLang }),
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: this.timeouts.translateMs,
      },
    );
    return { translatedText: data.translated_text || '', usedGpu: data.used_gpu ?? false };
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
        body: audio,
        headers: { 'Content-Type': 'audio/wav' },
        params,
        timeoutMs: this.timeouts.pipelineMs,
      },
    );

    const timing = data.timing || {};
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

    const { data } = await this._request<Record<string, unknown>>(
      'POST', '/v1/gpu/deploy',
      {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: this.timeouts.deployMs,
      },
    );
    return data;
  }

  async gpuStatus(): Promise<GpuStatus> {
    const { data } = await this._request<Record<string, unknown>>(
      'GET', '/v1/gpu/status',
      { timeoutMs: this.timeouts.healthMs },
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

  async terminateGpu(apiKey: string): Promise<Record<string, unknown>> {
    const { data } = await this._request<Record<string, unknown>>(
      'POST', '/v1/gpu/terminate',
      {
        body: JSON.stringify({ apiKey }),
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: this.timeouts.deployMs,
      },
    );
    return data;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Get the underlying circuit breaker (for inspection/testing). */
  getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }
}
