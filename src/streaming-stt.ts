/**
 * StreamingSTTRouter — routes binary PCM WebSocket to the best available STT backend.
 *
 * Default provider: Qwen3-ASR 1.7B (6.6% avg WER, 1.7x better than Fireworks Whisper).
 *
 * Priority order (configurable):
 *   1. GPU streaming endpoint (self-hosted Qwen3-ASR or Whisper, lowest latency)
 *   2. Qwen3-ASR via Modal (serverless, default STT — best accuracy)
 *   3. Fireworks AI streaming (cloud Whisper, fastest TTFR but lower accuracy)
 *
 * Per-session params (query string): chunk_size, beam_size, temperature,
 *   unfixed_chunk_num, unfixed_token_num — see StreamingSTTParams.
 *
 * Protocol:
 *   Client → gateway: binary Int16 PCM frames (16kHz, mono, 16-bit LE)
 *   Gateway → client: JSON newline-delimited { text: string, provider: string }
 *
 * Benchmark (2026-03-21, 6 corpora, chunk=1.0s):
 *   Qwen3-ASR: 6.6% WER, 1541ms TTFR (A10G) / ~700ms est. (RTX 4090)
 *   Fireworks:  11.5% WER, 1113ms TTFR
 */

import type { DeploymentController, Lease } from './deployments/controller';
import { noWakeActive, recordNoWakeSkip } from './gateway/proxy/no-wake';
import { replicaBase } from './deployments/http';
import { replicaTls } from './deployments/replica-tls';
import { outgoingTraceHeaders } from './telemetry/trace-context';

const FIREWORKS_STREAMING_URL =
  'wss://audio-streaming.api.fireworks.ai/v1/audio/transcriptions/streaming';

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_TEXT_LENGTH = 10_000;
const DEFAULT_MAX_AUDIO_BUFFER_BYTES = 10 * 1024 * 1024;
/** How long a streaming STT session waits for a warm deployment replica before hedging to a cloud provider. */
const DEFAULT_DEPLOYMENT_ACQUIRE_MS = 20_000;

function sanitizeQueryParam(value: unknown): string {
  if (typeof value === 'string') {
    return value.replace(/[\r\n\t]/g, '').slice(0, 256);
  }
  return '';
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
  } catch {
    return false;
  }
}

function logError(logger: Console | undefined, msg: string, ...args: unknown[]): void {
  if (logger?.error) logger.error(msg, ...args);
  else console.error(msg, ...args);
}

function logDebug(logger: Console | undefined, msg: string, ...args: unknown[]): void {
  if (logger?.debug) logger.debug(msg, ...args);
  else console.debug(msg, ...args);
}

/** Per-session streaming STT parameters (passed as query params to backend). */
export interface StreamingSTTParams {
  chunkSize?: number;        // seconds (0.5-10, default 1.0)
  beamSize?: number;         // 1=greedy, 3=default, 5=accurate
  temperature?: number;      // 0.0=deterministic
  unfixedChunkNum?: number;  // chunks kept revisable (default 2)
  unfixedTokenNum?: number;  // rollback tokens (default 5)
}

export interface StreamingSTTConfig {
  /** Returns the GPU base URL (e.g. "http://host:8000") or null if not ready. */
  getGpuUrl: () => string | null;
  /** Fireworks API key — used as fallback when GPU is not ready. */
  fireworksApiKey?: string;
  /** Returns the Qwen3-ASR endpoint URL (e.g. Modal) or null if not available. */
  getQwen3AsrUrl?: () => string | null;
  /**
   * Speech-stack deployment on the gateway's own autoscaler (Scaleway). When set, provider id `deployment` may
   * appear in `providerOrder`: its backend is the replica's `/ws/audio-stream` behind the token-gated front.
   */
  deployment?: {
    controller: Pick<DeploymentController, 'acquire' | 'get' | 'wake'>;
    /** Deployment name, or a resolver (the deployment can be created after the gateway boots). */
    name: string | (() => string | null);
    /** Wait for a warm replica before hedging to the next provider (default 20 s — a cold boot is minutes). */
    acquireWaitMs?: number;
  };
  /** Ordered list of provider IDs to try. Default: ["gpu", "qwen3-asr", "fireworks"] */
  providerOrder?: string[];
  /** Optional logger for debugging. */
  logger?: Console;
  /** Connection timeout in ms (default 10000). */
  connectTimeoutMs?: number;
  /** Max text length allowed in transcription response (default 10000). */
  maxTextLength?: number;
  /** Max audio buffer size in bytes (default 10MB). */
  maxBufferBytes?: number;
}

export type StreamingSTTProvider = 'gpu' | 'qwen3-asr' | 'fireworks' | 'deployment';

export interface StreamingSTTStatus {
  provider: StreamingSTTProvider | null;
  available: boolean;
  reason?: string;
}

/** Partial transcription event sent to the client. */
export interface StreamingSTTEvent {
  text: string;
  provider: StreamingSTTProvider;
  isFinal?: boolean;
}

// ---------------------------------------------------------------------------
// StreamingSTTBackend — wraps one upstream WebSocket connection
// ---------------------------------------------------------------------------

export class StreamingSTTBackend {
  private ws: WebSocket | null = null;
  private _open = false;
  private _aborted = false;
  private _connecting = false;
  private _logger: Console | undefined;
  private _connectTimeoutMs: number;
  private _maxTextLength: number;
  private _maxBufferBytes: number;
  private _connectTimer: ReturnType<typeof setTimeout> | undefined;
  private _closedIntentionally = false;
  private _textDecoder: TextDecoder | null = null;

  onResult?: (event: StreamingSTTEvent) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
  /**
   * Terminal hook, fires once on every end path: `failed` marks connection-level failure (timeouts, socket errors,
   * abnormal close — the upstream may be suspect), `false` for deliberate close/abort. A provider holding a resource
   * (a deployment lease) releases it here; callers keep using onDisconnected for control flow.
   */
  onFinalize?: (failed: boolean) => void;
  private _finalized = false;
  private readonly _tls?: { ca: string };
  private _finalize(failed: boolean): void {
    if (this._finalized) return;
    this._finalized = true;
    this.onFinalize?.(failed);
  }

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    public readonly provider: StreamingSTTProvider,
    options?: {
      logger?: Console;
      connectTimeoutMs?: number;
      maxTextLength?: number;
      maxBufferBytes?: number;
      tls?: { ca: string };
    },
  ) {
    this._tls = options?.tls;
    this._logger = options?.logger;
    this._connectTimeoutMs = options?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this._maxTextLength = options?.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
    this._maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_AUDIO_BUFFER_BYTES;
    this._textDecoder = new TextDecoder();
  }

  private _clearConnectTimer(): void {
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = undefined;
    }
  }

  private _scheduleConnectTimeout(): void {
    this._clearConnectTimer();
    this._connectTimer = setTimeout(() => {
      if (this._connecting && !this._open) {
        logError(this._logger, '[StreamingSTT] Connection timeout');
        this._aborted = true;
        this._closeWs('timeout');
        this._finalize(true);
        this.onDisconnected?.('Connection timeout');
      }
    }, this._connectTimeoutMs);
  }

  private _closeWs(reason?: string): void {
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      this._open = false;
      this._connecting = false;
      this._clearConnectTimer();

      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close(1000, reason ?? 'normal');
      } catch {
        // ignore close errors
      }
    }
  }

  connect(): void {
    if (this._connecting || this._open || this._aborted) {
      logDebug(this._logger, '[StreamingSTT] Connect skipped: state=%s/%s/%s',
        this._connecting, this._open, this._aborted);
      return;
    }

    if (!isValidUrl(this.url)) {
      logError(this._logger, '[StreamingSTT] Invalid WebSocket URL');
      this.onDisconnected?.('Invalid URL');
      return;
    }

    this._connecting = true;
    this._closedIntentionally = false;
    logDebug(this._logger, '[StreamingSTT] Connecting to %s', this.url);

    // Bun exposes WebSocket globally (same API as browser but runs server-side)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = new WebSocket(this.url, { headers: this.headers, ...(this._tls ? { tls: this._tls } : {}) } as any);
    this.ws = ws;
    this._aborted = false;

    this._scheduleConnectTimeout();

    ws.onopen = () => {
      this._clearConnectTimer();
      this._connecting = false;
      if (this._aborted) {
        this._closeWs('aborted during open');
        return;
      }
      this._open = true;
      logDebug(this._logger, '[StreamingSTT] Connected');
      this.onConnected?.();
    };

    ws.onmessage = (evt) => {
      if (this._aborted) return;
      try {
        let raw: string;
        // Treat byte cap as 4× char cap (worst case UTF-8 expansion: 4 bytes
        // per character). Previously compared bytes against a char limit —
        // a small UTF-16 message could fail the gate while a large UTF-8
        // could pass and only be caught by the second char gate after decode.
        const maxBytes = this._maxTextLength * 4;
        if (evt.data instanceof ArrayBuffer) {
          if (evt.data.byteLength > maxBytes) {
            logError(this._logger, '[StreamingSTT] Oversized message: %s bytes (max %s)', evt.data.byteLength, maxBytes);
            return;
          }
          raw = this._textDecoder!.decode(evt.data);
        } else if (typeof evt.data === 'string') {
          raw = evt.data;
        } else {
          logError(this._logger, '[StreamingSTT] Unsupported message type');
          return;
        }

        if (raw.length > this._maxTextLength) {
          logError(this._logger, '[StreamingSTT] Oversized text: %s chars (max %s)', raw.length, this._maxTextLength);
          return;
        }

        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) {
          logDebug(this._logger, '[StreamingSTT] Non-object JSON skipped');
          return;
        }
        // A misbehaving provider could send a non-string `text` field
        // (number, boolean, null) — calling .trim() on it would throw and
        // crash the whole onmessage handler. Coerce defensively.
        const rawText = parsed.text;
        const text = typeof rawText === 'string' ? rawText.trim() : '';
        if (text.length > this._maxTextLength) {
          logError(this._logger, '[StreamingSTT] Oversize text after trim: %s', text.length);
          return;
        }
        if (text) {
          this.onResult?.({ text, provider: this.provider });
        }
      } catch (e) {
        logError(this._logger, '[StreamingSTT] Parse error: %s', e);
      }
    };

    ws.onclose = (evt) => {
      const wasClosedIntentionally = this._closedIntentionally;
      this._open = false;
      this._connecting = false;
      this._clearConnectTimer();

      if (!wasClosedIntentionally) {
        logDebug(this._logger, '[StreamingSTT] Disconnected: %s', evt.code);
        this._finalize(true);
        this.onDisconnected?.(`${evt.code}: ${evt.reason || 'closed'}`);
      }
    };

    ws.onerror = () => {
      this._clearConnectTimer();
      logError(this._logger, '[StreamingSTT] WebSocket error');
      this._finalize(true);
      this.onDisconnected?.('WebSocket error');
      // Close socket to release FD; otherwise repeated upstream failures grow
      // open-FD count without bound (onerror fires but socket sticks until GC).
      this._closeWs('error');
    };
  }

  sendAudio(pcm: ArrayBuffer | Buffer): void {
    if (!this._open || this._aborted) return;

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    let buffer: ArrayBuffer;
    if (pcm instanceof ArrayBuffer) {
      buffer = pcm;
    } else if (pcm instanceof Buffer) {
      const buf = pcm.buffer;
      if (!(buf instanceof ArrayBuffer)) {
        logError(this._logger, '[StreamingSTT] Unsupported buffer type');
        return;
      }
      buffer = buf;
    } else {
      logError(this._logger, '[StreamingSTT] Invalid audio type');
      return;
    }

    if (buffer.byteLength > this._maxBufferBytes) {
      logError(this._logger, '[StreamingSTT] Audio buffer too large: %s bytes', buffer.byteLength);
      return;
    }

    try {
      ws.send(buffer);
    } catch (e) {
      logError(this._logger, '[StreamingSTT] Send error: %s', e);
    }
  }

  close(): void {
    if (this._closedIntentionally) return;
    this._closedIntentionally = true;
    this._aborted = true;
    this._closeWs('close called');
    this._finalize(false);
    this.onDisconnected?.('Closed by client');
    this._cleanupCallbacks();
  }

  abort(): void {
    this._aborted = true;
    this._closedIntentionally = false;
    this._closeWs('abort');
    this._finalize(false);
    this.onDisconnected?.('Aborted');
    this._cleanupCallbacks();
  }

  private _cleanupCallbacks(): void {
    this.onResult = undefined;
    this.onConnected = undefined;
    this.onDisconnected = undefined;
  }

  get isOpen(): boolean {
    return this._open;
  }

  get isConnecting(): boolean {
    return this._connecting;
  }
}

// ---------------------------------------------------------------------------
// StreamingSTTRouter — provider selection + session factory
// ---------------------------------------------------------------------------

export class StreamingSTTRouter {
  private readonly order: string[];

  constructor(private readonly config: StreamingSTTConfig) {
    this.order = config.providerOrder ?? ['gpu', 'qwen3-asr', 'fireworks'];
  }

  /** Returns which provider would be used right now (for status display). */
  getActiveProvider(): StreamingSTTProvider | null {
    for (const id of this.order) {
      if (id === 'gpu' && this.config.getGpuUrl()) return 'gpu';
      if (id === 'qwen3-asr' && this.config.getQwen3AsrUrl?.()) return 'qwen3-asr';
      if (id === 'fireworks' && this.config.fireworksApiKey) return 'fireworks';
      if (id === 'deployment' && this._deploymentName()) return 'deployment';
    }
    return null;
  }

  /** Build query string from streaming params (with sanitization). */
  private _buildParams(language?: string, params?: StreamingSTTParams): string {
    const p = new URLSearchParams();
    if (language) p.set('language', sanitizeQueryParam(language));
    if (params?.chunkSize != null) p.set('chunk_size', String(params.chunkSize));
    if (params?.beamSize != null) p.set('beam_size', String(params.beamSize));
    if (params?.temperature != null) p.set('temperature', String(params.temperature));
    if (params?.unfixedChunkNum != null) p.set('unfixed_chunk_num', String(params.unfixedChunkNum));
    if (params?.unfixedTokenNum != null) p.set('unfixed_token_num', String(params.unfixedTokenNum));
    return p.toString();
  }

  private _deploymentName(): string | null {
    const dep = this.config.deployment;
    if (!dep) return null;
    const name = typeof dep.name === 'function' ? dep.name() : dep.name;
    return name || null;
  }

  /** A backend for a synchronous provider id, or null when that provider cannot serve right now. */
  private _backendFor(id: string, language?: string, params?: StreamingSTTParams): StreamingSTTBackend | null {
    const backendOptions = {
      logger: this.config.logger,
      connectTimeoutMs: this.config.connectTimeoutMs,
      maxTextLength: this.config.maxTextLength,
      maxBufferBytes: this.config.maxBufferBytes,
    };
    if (id === 'gpu') {
      const gpuUrl = this.config.getGpuUrl();
      if (!gpuUrl) return null;
      const qs = this._buildParams(language, params);
      const wsUrl = gpuUrl.replace(/^http/, 'ws').replace(/\/$/, '')
        + `/ws/audio-stream?${qs}`;
      return new StreamingSTTBackend(wsUrl, {}, 'gpu', backendOptions);
    }
    if (id === 'qwen3-asr') {
      const url = this.config.getQwen3AsrUrl?.();
      if (!url) return null;
      const qs = this._buildParams(language, params);
      const wsUrl = url.replace(/^http/, 'ws').replace(/\/$/, '')
        + `/ws/audio-stream?${qs}`;
      return new StreamingSTTBackend(wsUrl, {}, 'qwen3-asr', backendOptions);
    }
    if (id === 'fireworks') {
      const key = this.config.fireworksApiKey;
      if (!key) return null;
      const lang = sanitizeQueryParam(language);
      const wsUrl = `${FIREWORKS_STREAMING_URL}`
        + `?language=${lang}&response_format=verbose_json`;
      return new StreamingSTTBackend(
        wsUrl,
        { Authorization: `Bearer ${key}` },
        'fireworks',
        backendOptions,
      );
    }
    return null;
  }

  /**
   * Acquire a ready replica of the speech-stack deployment and return a backend connected (on connect()) to its
   * `/ws/audio-stream` through the token-gated front. `null` when no replica became ready within `acquireWaitMs` —
   * the deployment is woken so the next attempt is warm, and the caller hedges to the next provider.
   */
  private async _deploymentBackend(language?: string, params?: StreamingSTTParams): Promise<StreamingSTTBackend | null> {
    const dep = this.config.deployment;
    const name = this._deploymentName();
    if (!dep || !name) return null;
    let lease: Lease;
    const noWake = noWakeActive(); // gateway/proxy/no-wake.ts: use a ready replica, never wake a cold one
    try {
      lease = await dep.controller.acquire(name, noWake ? { waitMs: 0, noWake: true } : { waitMs: dep.acquireWaitMs ?? DEFAULT_DEPLOYMENT_ACQUIRE_MS });
    } catch (err) {
      // Cold or saturated: start replicas so the next session lands warm, then let the caller fall through.
      if (noWake) recordNoWakeSkip();
      else try { dep.controller.wake(name); } catch { /* deployment gone */ }
      logDebug(this.config.logger, '[StreamingSTT] Deployment acquire failed (hedging): %s',
        err instanceof Error ? err.message : err);
      return null;
    }
    const backendOptions = {
      logger: this.config.logger,
      connectTimeoutMs: this.config.connectTimeoutMs,
      maxTextLength: this.config.maxTextLength,
      maxBufferBytes: this.config.maxBufferBytes,
    };
    const qs = this._buildParams(language, params);
    const wsUrl = replicaBase(lease.machine, lease.exposed).replace(/^http/, 'ws')
      + `/ws/audio-stream?${qs}`;
    const backend = new StreamingSTTBackend(wsUrl, { ...outgoingTraceHeaders(), 'X-Aigw-Token': lease.token }, 'deployment',
      { ...backendOptions, ...(replicaTls(wsUrl, lease.token)) });
    // The lease spans the whole stream: released on close, failed on a connection-level drop.
    backend.onFinalize = (failed) => lease.done(failed);
    return backend;
  }

  /** Returns a backend for the given language from a synchronous provider, or null if unavailable. */
  createBackend(language?: string, excludeProviders?: Set<string>, params?: StreamingSTTParams): StreamingSTTBackend | null {
    for (const id of this.order) {
      if (excludeProviders?.has(id) || id === 'deployment') continue;
      const backend = this._backendFor(id, language, params);
      if (backend) return backend;
    }
    return null;
  }

  /**
   * `createBackend` plus the `deployment` provider, whose replica acquire is async. A deployment that cannot serve
   * in time is treated like a failed provider (skipped, woken for next time) and the order continues — so a cold
   * speech-stack hedges to the cloud instead of failing the session.
   */
  async createBackendAsync(language?: string, excludeProviders?: Set<string>, params?: StreamingSTTParams): Promise<StreamingSTTBackend | null> {
    const excluded = new Set(excludeProviders ?? []);
    for (const id of this.order) {
      if (excluded.has(id)) continue;
      if (id === 'deployment') {
        const backend = await this._deploymentBackend(language, params);
        if (backend) return backend;
        excluded.add(id);
        continue;
      }
      const backend = this._backendFor(id, language, params);
      if (backend) return backend;
    }
    return null;
  }

  /** Status for each provider — used by the settings panel. */
  getStatus(): Record<string, StreamingSTTStatus> {
    const gpuUrl = this.config.getGpuUrl();
    const qwen3Url = this.config.getQwen3AsrUrl?.();
    return {
      gpu: {
        provider: 'gpu',
        available: Boolean(gpuUrl),
        reason: gpuUrl ? `endpoint: ${gpuUrl}` : 'GPU not ready',
      },
      'qwen3-asr': {
        provider: 'qwen3-asr',
        available: Boolean(qwen3Url),
        reason: qwen3Url ? `endpoint: ${qwen3Url}` : 'No endpoint configured',
      },
      fireworks: {
        provider: 'fireworks',
        available: Boolean(this.config.fireworksApiKey),
        reason: this.config.fireworksApiKey ? 'API key configured' : 'No API key',
      },
      // Only listed when a deployment is configured — an absent provider should not appear in the status panel.
      ...(this.config.deployment ? {
        deployment: (() => {
          const name = this._deploymentName();
          if (!name) return { provider: 'deployment' as const, available: false, reason: 'No deployment name' };
          const view = this.config.deployment!.controller.get(name);
          const ready = view?.replicas.filter(r => r.phase === 'ready').length ?? 0;
          return {
            provider: 'deployment' as const,
            available: Boolean(view && !view.spec.paused),
            reason: !view ? `deployment '${name}' not found`
              : view.spec.paused ? 'paused'
                : ready ? `${ready} replica(s) ready` : `status: ${view.status} (wakes on demand)`,
          };
        })(),
      } : {}),
    };
  }
}
