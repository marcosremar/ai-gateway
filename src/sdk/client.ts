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
  TranslateResponse,
  PipelineResponse,
  PipelineOptions,
  GenerateAudioOptions,
  GenerateAudioResponse,
  ListVoicesResponse,
  GpuStatus,
  DeployOptions,
  DeployResponse,
  ChatMessage,
  ChatCompletionOptions,
  ChatCompletionResponse,
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

/** Retry config for connection-level errors (gateway restart tolerance). */
const MAX_RETRIES = 4;
const RETRY_BACKOFF_MS = [500, 1000, 2000, 4000];

/** Check if an error is a connection-level failure (retryable). */
function isRetryableError(err: unknown): boolean {
  // Timeouts (AbortError) are NOT retried — they indicate the server was reached but slow
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  // TypeError = network failure (ECONNREFUSED, DNS, etc.)
  if (err instanceof TypeError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|network/i.test(msg);
}

export class GatewaySDK {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeouts: Required<NonNullable<GatewayConfig['timeouts']>>;
  private readonly groqApiKey: string;

  constructor(config: GatewayConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.headers = config.apiKey
      ? { Authorization: `Bearer ${config.apiKey}` }
      : {};
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
    this.groqApiKey = config.groqApiKey ?? (typeof process !== 'undefined' ? (process.env.GROQ_API_KEY ?? '') : '');
  }

  // ── Inference ───────────────────────────────────────────────────────────

  /** Transcribe audio to text (GPU-aware: gateway routes to GPU or cloud).
   *  Falls back to Groq Whisper directly when the gateway is unreachable. */
  async transcribe(audio: Uint8Array, language = 'fr', prompt = ''): Promise<TranscribeResponse> {
    const params = new URLSearchParams({ language });
    if (prompt) params.set('prompt', prompt);
    try {
      const res = await this.fetch(`/v1/transcribe?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: audio,
        timeout: this.timeouts.stt,
      });
      const data = await this.parseJson(res, '/v1/transcribe');
      return { text: (data.text as string) ?? '', usedGpu: (data.used_gpu as boolean) ?? false };
    } catch (err) {
      if (err instanceof GatewayError && err.isNetworkError && this.groqApiKey) {
        return this.groqTranscribeFallback(audio, language, prompt);
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
    const res = await this.fetch('/v1/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: this.timeouts.tts,
    });
    const audio = new Uint8Array(await res.arrayBuffer());
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

  /** Deploy a GPU pod (non-blocking — returns immediately, poll gpuStatus()). */
  async deployGpu(options: DeployOptions): Promise<DeployResponse> {
    const res = await this.fetch('/v1/gpu/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: options.apiKey,
        dockerImage: options.dockerImage,
        gpuTypes: options.gpuTypes,
      }),
      timeout: this.timeouts.deploy,
      allowedStatuses: [202, 409], // 409 = deploy already in progress
    });
    const data = await this.parseJson(res, '/v1/gpu/deploy');
    return { status: (data.status as string) ?? '', message: (data.message as string) ?? '' };
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

  // ── Groq direct fallback (gateway offline) ────────────────────────────

  /** Call Groq Whisper directly — used when the gateway is unreachable. */
  private async groqTranscribeFallback(audio: Uint8Array, language: string, prompt: string): Promise<TranscribeResponse> {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/wav' }), 'audio.wav');
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
    },
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
        await new Promise(r => setTimeout(r, delay));
      }

      try {
        const res = await fetch(url, {
          method: options.method,
          headers: { ...this.headers, ...options.headers },
          body: options.body as BodyInit,
          signal: AbortSignal.timeout(options.timeout),
        });

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
        // HTTP errors (GatewayError with status code) are NOT retried
        if (err instanceof GatewayError && err.statusCode > 0) throw err;

        // Timeout errors are NOT retried
        if (err instanceof Error && err.name === 'AbortError') {
          throw new GatewayError(
            `${options.method} ${path} timed out (${options.timeout}ms)`,
            0,
            path,
          );
        }

        lastError = err;

        // Only retry connection-level errors
        if (!isRetryableError(err) || attempt >= MAX_RETRIES) {
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
        `${options.method} ${path} network error after ${MAX_RETRIES + 1} attempts: ${(lastError as Error).message}`,
        0,
        path,
        true, // isNetworkError
      );
    }
    throw lastError;
  }

  /** Parse JSON from response, throwing GatewayError on invalid JSON. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async parseJson(res: Response, path: string): Promise<any> {
    try {
      return await res.json();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new GatewayError(
        `${path}: invalid JSON response: ${msg}`,
        res.status,
        path,
      );
    }
  }
}
