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

  onResult?: (event: StreamingSTTEvent) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    public readonly provider: StreamingSTTProvider,
  ) {}

  connect(): void {
    // Bun exposes WebSocket globally (same API as browser but runs server-side)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = new WebSocket(this.url, { headers: this.headers } as any);
    this.ws = ws;

    ws.onopen = () => {
      this._open = true;
      this.onConnected?.();
    };

    ws.onmessage = (evt) => {
      try {
        const raw = typeof evt.data === 'string'
          ? evt.data
          : new TextDecoder().decode(evt.data as ArrayBuffer);
        const msg = JSON.parse(raw) as { text?: string };
        const text = (msg.text ?? '').trim();
        if (text) {
          this.onResult?.({ text, provider: this.provider });
        }
      } catch {
        // ignore malformed frames
      }
    };

    ws.onclose = (evt) => {
      this._open = false;
      this.onDisconnected?.(`${evt.code}: ${evt.reason || 'closed'}`);
    };

    ws.onerror = () => {
      this._open = false;
      this.onDisconnected?.('WebSocket error');
    };
  }

  sendAudio(pcm: ArrayBuffer | Buffer): void {
    if (this._open && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm);
    }
  }

  close(): void {
    this.ws?.close();
    this._open = false;
  }

  get isOpen(): boolean {
    return this._open;
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

  /** Build query string from streaming params. */
  private _buildParams(language?: string, params?: StreamingSTTParams): string {
    const p = new URLSearchParams();
    if (language) p.set('language', language);
    if (params?.chunkSize != null) p.set('chunk_size', String(params.chunkSize));
    if (params?.beamSize != null) p.set('beam_size', String(params.beamSize));
    if (params?.temperature != null) p.set('temperature', String(params.temperature));
    if (params?.unfixedChunkNum != null) p.set('unfixed_chunk_num', String(params.unfixedChunkNum));
    if (params?.unfixedTokenNum != null) p.set('unfixed_token_num', String(params.unfixedTokenNum));
    return p.toString();
  }

  /** Returns a connected backend for the given language, or null if unavailable. */
  createBackend(language?: string, excludeProviders?: Set<string>, params?: StreamingSTTParams): StreamingSTTBackend | null {
    for (const id of this.order) {
      if (excludeProviders?.has(id)) continue;
      if (id === 'gpu') {
        const gpuUrl = this.config.getGpuUrl();
        if (gpuUrl) {
          const qs = this._buildParams(language, params);
          const wsUrl = gpuUrl.replace(/^http/, 'ws').replace(/\/$/, '')
            + `/ws/audio-stream?${qs}`;
          return new StreamingSTTBackend(wsUrl, {}, 'gpu');
        }
      }
      if (id === 'qwen3-asr') {
        const url = this.config.getQwen3AsrUrl?.();
        if (url) {
          const qs = this._buildParams(language, params);
          const wsUrl = url.replace(/^http/, 'ws').replace(/\/$/, '')
            + `/ws/audio-stream?${qs}`;
          return new StreamingSTTBackend(wsUrl, {}, 'qwen3-asr');
        }
      }
      if (id === 'fireworks') {
        const key = this.config.fireworksApiKey;
        if (key) {
          const wsUrl = `${FIREWORKS_STREAMING_URL}`
            + `?language=${language}&response_format=verbose_json`;
          return new StreamingSTTBackend(
            wsUrl,
            { Authorization: `Bearer ${key}` },
            'fireworks',
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
