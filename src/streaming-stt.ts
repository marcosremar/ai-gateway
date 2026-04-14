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

const FIREWORKS_STREAMING_URL =
  'wss://audio-streaming.api.fireworks.ai/v1/audio/transcriptions/streaming';

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_TEXT_LENGTH = 10_000;
const DEFAULT_MAX_AUDIO_BUFFER_BYTES = 10 * 1024 * 1024;

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
  logger?.error?.(msg, ...args) ?? console.error(msg, ...args);
}

function logDebug(logger: Console | undefined, msg: string, ...args: unknown[]): void {
  logger?.debug?.(msg, ...args) ?? console.debug(msg, ...args);
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

export type StreamingSTTProvider = 'gpu' | 'qwen3-asr' | 'fireworks';

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

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    public readonly provider: StreamingSTTProvider,
    options?: {
      logger?: Console;
      connectTimeoutMs?: number;
      maxTextLength?: number;
      maxBufferBytes?: number;
    },
  ) {
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
    const ws = new WebSocket(this.url, { headers: this.headers } as any);
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
        if (evt.data instanceof ArrayBuffer) {
          if (evt.data.byteLength > this._maxTextLength) {
            logError(this._logger, '[StreamingSTT] Oversized message: %s bytes', evt.data.byteLength);
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
          logError(this._logger, '[StreamingSTT] Oversized text: %s chars', raw.length);
          return;
        }

        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) {
          logDebug(this._logger, '[StreamingSTT] Non-object JSON skipped');
          return;
        }
        const text = (parsed.text ?? '').trim();
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
        this.onDisconnected?.(`${evt.code}: ${evt.reason || 'closed'}`);
      }
    };

    ws.onerror = () => {
      this._clearConnectTimer();
      logError(this._logger, '[StreamingSTT] WebSocket error');
      this.onDisconnected?.('WebSocket error');
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
    this.onDisconnected?.('Closed by client');
    this._cleanupCallbacks();
  }

  abort(): void {
    this._aborted = true;
    this._closedIntentionally = false;
    this._closeWs('abort');
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

  /** Returns a connected backend for the given language, or null if unavailable. */
  createBackend(language?: string, excludeProviders?: Set<string>, params?: StreamingSTTParams): StreamingSTTBackend | null {
    const backendOptions = {
      logger: this.config.logger,
      connectTimeoutMs: this.config.connectTimeoutMs,
      maxTextLength: this.config.maxTextLength,
      maxBufferBytes: this.config.maxBufferBytes,
    };

    for (const id of this.order) {
      if (excludeProviders?.has(id)) continue;
      if (id === 'gpu') {
        const gpuUrl = this.config.getGpuUrl();
        if (gpuUrl) {
          const qs = this._buildParams(language, params);
          const wsUrl = gpuUrl.replace(/^http/, 'ws').replace(/\/$/, '')
            + `/ws/audio-stream?${qs}`;
          return new StreamingSTTBackend(wsUrl, {}, 'gpu', backendOptions);
        }
      }
      if (id === 'qwen3-asr') {
        const url = this.config.getQwen3AsrUrl?.();
        if (url) {
          const qs = this._buildParams(language, params);
          const wsUrl = url.replace(/^http/, 'ws').replace(/\/$/, '')
            + `/ws/audio-stream?${qs}`;
          return new StreamingSTTBackend(wsUrl, {}, 'qwen3-asr', backendOptions);
        }
      }
      if (id === 'fireworks') {
        const key = this.config.fireworksApiKey;
        if (key) {
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
      }
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
    };
  }
}
