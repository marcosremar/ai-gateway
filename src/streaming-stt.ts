/**
 * StreamingSTTRouter — routes binary PCM WebSocket to the best available STT backend.
 *
 * Priority order (configurable):
 *   1. GPU streaming endpoint (self-hosted Whisper, lowest latency)
 *   2. Fireworks AI streaming (cloud, no GPU required)
 *
 * Protocol:
 *   Client → gateway: binary Int16 PCM frames (16kHz, mono, 16-bit LE)
 *   Gateway → client: JSON newline-delimited { text: string, provider: string }
 */

const FIREWORKS_STREAMING_URL =
  'wss://audio-streaming.api.fireworks.ai/v1/audio/transcriptions/streaming';

export interface StreamingSTTConfig {
  /** Returns the GPU base URL (e.g. "http://host:8000") or null if not ready. */
  getGpuUrl: () => string | null;
  /** Fireworks API key — used as fallback when GPU is not ready. */
  fireworksApiKey?: string;
  /** Ordered list of provider IDs to try. Default: ["gpu", "fireworks"] */
  providerOrder?: string[];
}

export type StreamingSTTProvider = 'gpu' | 'fireworks';

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
    const ws = new WebSocket(this.url, { headers: this.headers } as RequestInit);
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
    this.order = config.providerOrder ?? ['gpu', 'fireworks'];
  }

  /** Returns which provider would be used right now (for status display). */
  getActiveProvider(): StreamingSTTProvider | null {
    for (const id of this.order) {
      if (id === 'gpu' && this.config.getGpuUrl()) return 'gpu';
      if (id === 'fireworks' && this.config.fireworksApiKey) return 'fireworks';
    }
    return null;
  }

  /** Returns a connected backend for the given language, or null if unavailable. */
  createBackend(language?: string, excludeProviders?: Set<string>): StreamingSTTBackend | null {
    for (const id of this.order) {
      if (excludeProviders?.has(id)) continue;
      if (id === 'gpu') {
        const gpuUrl = this.config.getGpuUrl();
        if (gpuUrl) {
          const wsUrl = gpuUrl.replace(/^http/, 'ws').replace(/\/$/, '')
            + `/ws/audio-stream?language=${language}`;
          return new StreamingSTTBackend(wsUrl, {}, 'gpu');
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
    return {
      gpu: {
        provider: 'gpu',
        available: Boolean(gpuUrl),
        reason: gpuUrl ? `endpoint: ${gpuUrl}` : 'GPU not ready',
      },
      fireworks: {
        provider: 'fireworks',
        available: Boolean(this.config.fireworksApiKey),
        reason: this.config.fireworksApiKey ? 'API key configured' : 'No API key',
      },
    };
  }
}
