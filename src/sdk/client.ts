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
  GpuStatus,
  DeployOptions,
  DeployResponse,
} from './types';
import { GatewayError } from './types';

const DEFAULT_TIMEOUTS = {
  stt: 15_000,
  translate: 15_000,
  pipeline: 30_000,
  health: 8_000,
  deploy: 30_000,
};

export class GatewaySDK {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeouts: Required<NonNullable<GatewayConfig['timeouts']>>;

  constructor(config: GatewayConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.headers = config.apiKey
      ? { Authorization: `Bearer ${config.apiKey}` }
      : {};
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
  }

  // ── Inference ───────────────────────────────────────────────────────────

  /** Transcribe audio to text (GPU-aware: gateway routes to GPU or cloud). */
  async transcribe(audio: Uint8Array, language = 'fr'): Promise<TranscribeResponse> {
    const res = await this.fetch(`/v1/transcribe?language=${encodeURIComponent(language)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: audio,
      timeout: this.timeouts.stt,
    });
    const data = await this.parseJson(res, '/v1/transcribe');
    return { text: data.text ?? '', usedGpu: data.used_gpu ?? false };
  }

  /** Translate text (GPU-aware: gateway routes to GPU or cloud LLM). */
  async translate(text: string, sourceLang: string, targetLang: string): Promise<TranslateResponse> {
    if (!text.trim()) return { translatedText: '', usedGpu: false };
    const res = await this.fetch('/v1/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, source_lang: sourceLang, target_lang: targetLang }),
      timeout: this.timeouts.translate,
    });
    const data = await this.parseJson(res, '/v1/translate');
    return { translatedText: data.translated_text ?? '', usedGpu: data.used_gpu ?? false };
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
    return {
      transcription: data.transcription ?? '',
      response: data.response ?? '',
      audioBase64: data.audio_base64 ?? '',
      contentType: data.content_type ?? '',
      timing: {
        totalMs: data.timing?.total_ms ?? 0,
        usedGpu: data.timing?.used_gpu ?? false,
      },
    };
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
    return { status: data.status ?? '', message: data.message ?? '' };
  }

  /** Get current GPU deployment status, health, and active tier. */
  async gpuStatus(): Promise<GpuStatus> {
    const res = await this.fetch('/v1/gpu/status', {
      method: 'GET',
      timeout: this.timeouts.health,
    });
    const d = await this.parseJson(res, '/v1/gpu/status');
    return {
      status: d.status ?? 'idle',
      podId: d.podId ?? '',
      endpoint: d.endpoint ?? '',
      gpuType: d.gpuType ?? '',
      message: d.message ?? '',
      step: d.step ?? '',
      stepDetail: d.stepDetail ?? '',
      gpuHealthy: d.gpuHealthy ?? false,
      activeTier: d.activeTier ?? 'cloud',
      idleSec: d.idleSec ?? 0,
      idleTimeoutSec: d.idleTimeoutSec ?? 0,
      elapsedSec: d.elapsedSec ?? 0,
      startedAt: d.startedAt ?? 0,
      retryCount: d.retryCount ?? 0,
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

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /** Clean up resources. No-op for now (fetch has no persistent connections). */
  close(): void {
    // Reserved for future connection pooling
  }

  // ── Internal ──────────────────────────────────────────────────────────

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
    let res: Response;
    try {
      res = await fetch(url, {
        method: options.method,
        headers: { ...this.headers, ...options.headers },
        body: options.body as BodyInit,
        signal: AbortSignal.timeout(options.timeout),
      });
    } catch (err: unknown) {
      // Network errors (ECONNREFUSED, DNS failure) and timeouts
      if (err instanceof Error && err.name === 'AbortError') {
        throw new GatewayError(
          `${options.method} ${path} timed out (${options.timeout}ms)`,
          0,
          path,
        );
      }
      if (err instanceof TypeError) {
        throw new GatewayError(
          `${options.method} ${path} network error: ${err.message}`,
          0,
          path,
        );
      }
      throw err;
    }

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
  }

  /** Parse JSON from response, throwing GatewayError on invalid JSON. */
  private async parseJson(res: Response, path: string): Promise<Record<string, unknown>> {
    try {
      return await res.json() as Record<string, unknown>;
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
