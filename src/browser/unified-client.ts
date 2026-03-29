/**
 * UnifiedSpeechClient — Single entry point for voice interactions.
 *
 * Tries OpenAI Realtime WebRTC first (lowest latency, native STT+LLM+TTS),
 * falls back to SpeechClient pipeline (SSE/WS with Groq/OpenAI providers).
 *
 * The app calls ONE thing and gets the best transport automatically:
 *
 *   const client = new UnifiedSpeechClient({
 *     realtime: { model: 'gpt-4o-mini-realtime-preview', voice: 'ash' },
 *     pipeline: { discoveryEndpoint: '/api/speech/health' },
 *   });
 *   client.on('response', (r) => showSubtitle(r.text));
 *   await client.connect();
 */

import { TypedEmitter } from './emitter';
import type { SpeechResponse, SpeechClientConfig, ProcessingStage } from './types';
import type {
  OpenAIRealtimeOptions,
  OpenAIRealtimeResponse,
  NetworkQuality,
  ConnectionPhase,
} from './openai-realtime';

// ── Types ─────────────────────────────────────────────────────────────────

export type ActiveTransport = 'realtime' | 'pipeline' | 'none';

export interface UnifiedResponse {
  /** Bot's text response. */
  text: string;
  /** User's transcript (what they said). */
  userText: string;
  /** Audio as base64 (pipeline) or empty string (realtime — audio plays via WebRTC track). */
  audio: string;
  /** Viseme data for lip-sync (pipeline only). */
  visemes: Array<{ start: number; end: number; value: string }>;
  /** Audio duration in seconds (0 for realtime). */
  duration: number;
  /** Which transport delivered this response. */
  transport: ActiveTransport;
  /** Timing info (pipeline only). */
  timing?: { stt_ms?: number; llm_ms?: number; tts_ms?: number; total_ms?: number };
  /** Providers used (pipeline only). */
  providers?: Record<string, string>;
}

export interface UnifiedSpeechClientEventMap {
  /** A complete response from the model. */
  response: UnifiedResponse;
  /** Streaming transcript (live subtitles). */
  transcript: { delta: string; full: string };
  /** Processing stage changed. */
  'stage-change': { stage: ProcessingStage | ConnectionPhase };
  /** Model started speaking. */
  'speaking-start': void;
  /** Model stopped speaking. */
  'speaking-end': void;
  /** Connected to a transport. */
  connected: { transport: ActiveTransport };
  /** Disconnected from all transports. */
  disconnected: { reason: string };
  /** Error (may be recoverable via fallback). */
  error: { message: string; transport: ActiveTransport; fatal: boolean };
  /** Fallback occurred. */
  fallback: { from: ActiveTransport; to: ActiveTransport; reason: string };
  /** Remote audio stream (realtime WebRTC only). */
  'audio-stream': MediaStream | null;
  /** Audio chunk (pipeline only). */
  'audio-chunk': { chunk: Uint8Array };
  /** Network quality (realtime only). */
  'network-quality': NetworkQuality;
}

export interface UnifiedSpeechClientConfig {
  /** OpenAI Realtime config (tried first). Omit to skip realtime. */
  realtime?: OpenAIRealtimeOptions;
  /** SpeechClient pipeline config (fallback). Omit to skip pipeline. */
  pipeline?: SpeechClientConfig;
  /** Strategy: 'realtime-first' (default) or 'pipeline-only'. */
  strategy?: 'realtime-first' | 'pipeline-only';
  /** Timeout for realtime connect before falling back (ms). Default: 15000. */
  realtimeTimeoutMs?: number;
}

// ── Implementation ────────────────────────────────────────────────────────

export class UnifiedSpeechClient extends TypedEmitter<UnifiedSpeechClientEventMap> {
  private realtimeClient: InstanceType<typeof import('./openai-realtime').OpenAIRealtimeClient> | null = null;
  private speechClient: InstanceType<typeof import('./speech-client').SpeechClient> | null = null;
  private config: UnifiedSpeechClientConfig;
  private _activeTransport: ActiveTransport = 'none';
  private _destroyed = false;

  constructor(config: UnifiedSpeechClientConfig) {
    super();
    this.config = config;
  }

  get activeTransport(): ActiveTransport { return this._activeTransport; }
  get isConnected(): boolean { return this._activeTransport !== 'none'; }

  /**
   * Connect — tries Realtime first, falls back to Pipeline.
   */
  async connect(): Promise<void> {
    if (this._destroyed) return;

    const strategy = this.config.strategy ?? 'realtime-first';

    if (strategy === 'realtime-first' && this.config.realtime) {
      try {
        await this.connectRealtime();
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit('error', { message: msg, transport: 'realtime', fatal: false });
        this.emit('fallback', { from: 'realtime', to: 'pipeline', reason: msg });
        // Fall through to pipeline
      }
    }

    if (this.config.pipeline) {
      await this.connectPipeline();
      return;
    }

    this.emit('error', { message: 'No transport configured', transport: 'none', fatal: true });
  }

  /**
   * Disconnect all transports.
   */
  disconnect(): void {
    if (this.realtimeClient) {
      this.realtimeClient.disconnect();
      this.realtimeClient = null;
    }
    if (this.speechClient) {
      this.speechClient.disconnect();
      this.speechClient = null;
    }
    const prev = this._activeTransport;
    this._activeTransport = 'none';
    if (prev !== 'none') {
      this.emit('disconnected', { reason: 'user' });
    }
  }

  /**
   * Send audio data (Float32Array PCM).
   * Only works with pipeline transport — Realtime handles mic via WebRTC track.
   */
  async sendAudio(data: Float32Array): Promise<void> {
    if (this._activeTransport === 'pipeline' && this.speechClient) {
      await this.speechClient.sendAudio(data);
    }
    // Realtime: no-op — mic audio flows via WebRTC track automatically
  }

  /**
   * Send text message.
   */
  sendText(text: string): void {
    if (this._activeTransport === 'realtime' && this.realtimeClient) {
      this.realtimeClient.sendText(text);
    } else if (this._activeTransport === 'pipeline' && this.speechClient) {
      this.speechClient.sendText(text);
    }
  }

  /**
   * Destroy — clean up all resources.
   */
  destroy(): void {
    this._destroyed = true;
    this.disconnect();
    this.removeAllListeners();
  }

  // ── Private: Realtime ─────────────────────────────────────────────────

  private async connectRealtime(): Promise<void> {
    const { OpenAIRealtimeClient } = await import('./openai-realtime');
    const client = new OpenAIRealtimeClient(this.config.realtime!);
    this.realtimeClient = client;

    // Wire events
    client.on('connected', () => {
      if (this._destroyed) return;
      this._activeTransport = 'realtime';
      this.emit('connected', { transport: 'realtime' });
    });

    client.on('disconnected', () => {
      if (this._destroyed) return;
      if (this._activeTransport === 'realtime') {
        this._activeTransport = 'none';
        this.emit('disconnected', { reason: 'realtime-disconnected' });
      }
    });

    client.on('error', ({ message }) => {
      if (this._destroyed) return;
      this.emit('error', { message, transport: 'realtime', fatal: false });
    });

    client.on('response', (r: OpenAIRealtimeResponse) => {
      if (this._destroyed) return;
      this.emit('response', {
        text: r.text,
        userText: r.userText,
        audio: '',  // Audio plays via WebRTC track
        visemes: r.visemes,
        duration: r.duration,
        transport: 'realtime',
      });
    });

    client.on('transcript', (t) => {
      if (this._destroyed) return;
      this.emit('transcript', t);
    });

    client.on('speaking-start', () => {
      if (this._destroyed) return;
      this.emit('speaking-start', undefined as any);
    });

    client.on('speaking-end', () => {
      if (this._destroyed) return;
      this.emit('speaking-end', undefined as any);
    });

    client.on('audio-stream', (stream) => {
      if (this._destroyed) return;
      this.emit('audio-stream', stream);
    });

    client.on('network-quality', (q) => {
      if (this._destroyed) return;
      this.emit('network-quality', q);
    });

    client.on('status-change', ({ phase }) => {
      if (this._destroyed) return;
      this.emit('stage-change', { stage: phase });
    });

    // Connect with timeout
    const timeoutMs = this.config.realtimeTimeoutMs ?? 15_000;
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Realtime connect timeout (${timeoutMs}ms)`)), timeoutMs),
      ),
    ]);
  }

  // ── Private: Pipeline ─────────────────────────────────────────────────

  private async connectPipeline(): Promise<void> {
    const { SpeechClient } = await import('./speech-client');
    const client = new SpeechClient(this.config.pipeline!);
    this.speechClient = client;

    // Wire events
    client.on('connected', () => {
      if (this._destroyed) return;
      this._activeTransport = 'pipeline';
      this.emit('connected', { transport: 'pipeline' });
    });

    client.on('disconnected', () => {
      if (this._destroyed) return;
      if (this._activeTransport === 'pipeline') {
        this._activeTransport = 'none';
        this.emit('disconnected', { reason: 'pipeline-disconnected' });
      }
    });

    client.on('error', ({ message }) => {
      if (this._destroyed) return;
      this.emit('error', { message, transport: 'pipeline', fatal: false });
    });

    client.on('response', (r: SpeechResponse) => {
      if (this._destroyed) return;
      this.emit('response', {
        text: r.text,
        userText: r.userText ?? '',
        audio: r.audio,
        visemes: r.visemes,
        duration: r.duration,
        transport: 'pipeline',
        timing: r.timing,
        providers: r.providers,
      });
    });

    client.on('stage-change', ({ stage }) => {
      if (this._destroyed) return;
      this.emit('stage-change', { stage });
    });

    client.on('audio-chunk', ({ chunk }) => {
      if (this._destroyed) return;
      this.emit('audio-chunk', { chunk });
    });

    await client.connect();
  }
}
