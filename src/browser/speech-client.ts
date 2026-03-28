/**
 * SpeechClient — orchestrator with automatic transport fallback.
 *
 * Features:
 * - Automatic fallback chain (WebRTC → WebSocket → SSE)
 * - Exponential backoff reconnection (same transport first, then fallback)
 * - Service status & health polling with wake-up detection
 * - Circuit breaker (stops hammering after N consecutive failures)
 * - Auth error detection with token refresh callback
 * - Response timeout for incomplete pipeline responses
 * - Streaming audio chunks (emitted before 'complete')
 * - Request guards (prevents concurrent send calls)
 * - Input validation (empty audio/text rejection)
 * - Comprehensive metrics
 * - Browser API checks
 * - Configurable logging
 *
 * @example
 * ```ts
 * // Minimal setup — auto-discovers transports from the backend:
 * const client = new SpeechClient({
 *   discoveryEndpoint: '/api/speech/health',
 * });
 *
 * // Or manual config with explicit transports:
 * const client = new SpeechClient({
 *   websocket: { url: 'wss://gpu:8000/ws/stream', token: 'xxx' },
 *   sse: { endpoint: 'https://modal.run', token: 'xxx' },
 *   webrtc: { signalingUrl: 'https://gpu:8000/webrtc', clusterName: 'parle' },
 *   fallbackTimeoutMs: 10_000,
 *   autoReconnect: true,
 *   responseTimeoutMs: 30_000,
 *   circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000 },
 *   onTokenRefresh: async () => { const t = await refreshToken(); return t; },
 *   debug: false,
 * });
 *
 * client.on('response', (r) => playAudio(r.audio));
 * client.on('fallback', ({ from, to }) => console.log(`${from} -> ${to}`));
 * client.on('stage-change', ({ stage }) => updateUI(stage));
 * client.on('status-change', ({ status }) => showServiceStatus(status));
 * client.on('audio-chunk', ({ chunk }) => streamPlayback(chunk));
 * client.on('auth-error', () => redirectToLogin());
 * client.on('error', ({ message, recoverable, code }) => handleError(code));
 *
 * await client.connect();
 * await client.sendAudio(pcmData);
 * client.disconnect();
 * client.destroy();
 * ```
 */

import { TypedEmitter } from './emitter';
import { SpeechSDKError } from './errors';
import { createLogger, setLogLevel } from './logger';
import type {
  SpeechClientConfig,
  SpeechClientEventMap,
  ProtocolId,
  ProcessingStage,
  ServiceStatus,
  ModelLoadStatus,
  Transport,
  SDKMetrics,
  DiscoveryResponse,
} from './types';
import { WebSocketTransport } from './transport-ws';
import { SSETransport } from './transport-sse';
// WebRTC imported lazily to avoid pulling in @pipecat-ai/small-webrtc-transport at build time
type WebRTCTransportType = import('./transport-webrtc').WebRTCTransport;

const DEFAULT_FALLBACK_ORDER: ProtocolId[] = ['webrtc', 'websocket', 'sse'];
const DEFAULT_FALLBACK_TIMEOUT = 10_000;
const DEFAULT_MAX_RECONNECT = 3;
const DEFAULT_RESPONSE_TIMEOUT = 30_000;
const DEFAULT_CB_FAILURE_THRESHOLD = 5;
const DEFAULT_CB_COOLDOWN = 30_000;

// Exponential backoff: 100ms, 200ms, 400ms, 800ms, capped at 5s
const BACKOFF_BASE_MS = 100;
const BACKOFF_MAX_MS = 5_000;

export class SpeechClient extends TypedEmitter<SpeechClientEventMap> {
  private config: SpeechClientConfig;
  private transport: Transport | null = null;
  private reconnectCount = 0;
  private destroyed = false;
  private discoveryDone = false;
  private _stage: ProcessingStage = 'idle';
  private _serviceStatus: ServiceStatus = 'unknown';
  private _modelStatus: ModelLoadStatus | null = null;
  private healthPollTimer: ReturnType<typeof setInterval> | null = null;
  private responseTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private log = createLogger('Client');

  // Circuit breaker state
  private cbFailures = 0;
  private cbOpenUntil = 0; // timestamp

  // Metrics
  private _metrics: SDKMetrics = {
    totalConnections: 0,
    totalFallbacks: 0,
    totalErrors: 0,
    transportLatency: {},
    consecutiveFailures: 0,
    lastResponseAt: null,
    circuitOpen: false,
  };

  constructor(config: SpeechClientConfig) {
    super();
    this.config = config;
    if (config.debug) setLogLevel('debug');
  }

  // ── Public getters ─────────────────────────────────────────────────────

  /** Current pipeline processing stage. */
  get stage(): ProcessingStage {
    return this._stage;
  }

  /** Currently active transport protocol, or null if disconnected. */
  get activeProtocol(): ProtocolId | null {
    return this.transport?.protocol ?? null;
  }

  /** Whether a transport is currently connected. */
  get connected(): boolean {
    return this.transport?.isConnected() ?? false;
  }

  /** Remote audio stream (WebRTC only). */
  get remoteStream(): MediaStream | null {
    return this.transport?.getRemoteStream?.() ?? null;
  }

  /** Current service status. */
  get serviceStatus(): ServiceStatus {
    return this._serviceStatus;
  }

  /** Per-model load status from last health check. */
  get modelStatus(): ModelLoadStatus | null {
    return this._modelStatus;
  }

  /** Snapshot of connection and usage metrics. */
  getMetrics(): Readonly<SDKMetrics> {
    return { ...this._metrics, circuitOpen: this.isCircuitOpen() };
  }

  // ── Browser checks ──────────────────────────────────────────────────────

  /**
   * Check if the current environment supports the required browser APIs.
   * Returns an object with per-feature support flags.
   */
  static checkBrowserSupport(): {
    webSocket: boolean;
    fetch: boolean;
    textDecoder: boolean;
    mediaStream: boolean;
    webRTC: boolean;
  } {
    return {
      webSocket: typeof WebSocket !== 'undefined',
      fetch: typeof fetch !== 'undefined',
      textDecoder: typeof TextDecoder !== 'undefined',
      mediaStream: typeof MediaStream !== 'undefined',
      webRTC: typeof RTCPeerConnection !== 'undefined',
    };
  }

  // ── Connect with fallback ──────────────────────────────────────────────

  /**
   * Connect using the configured fallback chain.
   *
   * If a `discoveryEndpoint` is configured, the first connect() call will
   * fetch it to auto-configure transport URLs. Subsequent calls reuse the
   * cached config (call `discover()` to force a refresh).
   *
   * @returns true if any transport connected successfully, false if destroyed or failed.
   */
  async connect(): Promise<boolean> {
    if (this.destroyed) {
      throw new SpeechSDKError('DESTROYED', 'SpeechClient has been destroyed');
    }

    // Disconnect any existing transport to prevent duplicate connections.
    // Without this, calling connect() twice leaves the old transport active
    // alongside the new one, causing double responses.
    if (this.transport) {
      this.log.debug('disconnecting existing transport before reconnect');
      this.transport.disconnect();
      this.transport = null;
    }

    // Auto-discover transport URLs from the backend
    if (this.config.discoveryEndpoint && !this.discoveryDone) {
      await this.discover();
    }

    // Circuit breaker check
    if (this.isCircuitOpen()) {
      const remaining = this.cbOpenUntil - Date.now();
      this.log.warn('circuit breaker open, cooldown remaining:', remaining, 'ms');
      this.emit('error', {
        message: `Circuit breaker open — retry in ${Math.ceil(remaining / 1000)}s`,
        recoverable: true,
        code: 'CIRCUIT_OPEN',
      });
      return false;
    }

    const order = this.config.fallbackOrder ?? DEFAULT_FALLBACK_ORDER;
    const timeout = this.config.fallbackTimeoutMs ?? DEFAULT_FALLBACK_TIMEOUT;

    let previousProtocol: ProtocolId | null = null;

    for (const protocol of order) {
      const transport = await this.createTransport(protocol);
      if (!transport) continue;

      this.wireTransport(transport);
      this.setStage('connecting');

      const t0 = performance.now();
      const success = await this.connectWithTimeout(transport, timeout);
      const latency = performance.now() - t0;

      if (success) {
        this._metrics.transportLatency[protocol] = Math.round(latency);
        this._metrics.totalConnections++;
        this._metrics.consecutiveFailures = 0;
        this.cbFailures = 0;

        if (previousProtocol) {
          this._metrics.totalFallbacks++;
          this.emit('fallback', { from: previousProtocol, to: protocol });
        }
        this.transport = transport;
        this.reconnectCount = 0;
        this.log.info('connected via', protocol, `(${Math.round(latency)}ms)`);
        this.emit('connected', { protocol });
        return true;
      }

      // Cleanup failed transport — disconnect AND clear callbacks to prevent ghost events
      transport.onResponse = null as any;
      transport.onStageChange = null as any;
      transport.onError = null as any;
      transport.onDisconnect = null as any;
      transport.onAudioChunk = null as any;
      transport.disconnect();
      previousProtocol = protocol;
      this.log.debug(protocol, 'failed, trying next...');
    }

    // All failed
    this.recordFailure();
    this.setStage('idle');
    this.emit('error', {
      message: `All transports failed: ${order.join(', ')}`,
      recoverable: false,
      code: 'TRANSPORT_FAILED',
    });
    return false;
  }

  // ── Discovery ──────────────────────────────────────────────────────────

  /**
   * Fetch transport URLs from the backend discovery endpoint.
   * Called automatically by connect() when `discoveryEndpoint` is set.
   * Can also be called manually to refresh transport config (e.g., after GPU wake-up).
   */
  async discover(): Promise<DiscoveryResponse | null> {
    const endpoint = this.config.discoveryEndpoint;
    if (!endpoint) return null;

    this.log.debug('discovering transports from', endpoint);

    try {
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(3_000), credentials: 'include' });
      if (!res.ok) {
        this.log.warn('discovery failed:', res.status);
        return null;
      }

      const json = await res.json();
      // Support both { data: { ... } } (ApiResponse wrapper) and { transports: { ... } } (raw)
      const data: DiscoveryResponse = json.data ?? json;

      this.applyDiscovery(data);
      this.discoveryDone = true;

      // Update service status from GPU info
      if (data.gpu) {
        const status = data.gpu.status as ServiceStatus;
        if (status) this.setServiceStatus(status);
        if (data.gpu.models) {
          this._modelStatus = {
            whisper: !!data.gpu.models.whisper,
            llm: !!data.gpu.models.llm,
            tts: !!data.gpu.models.tts,
          };
        }
      }

      this.log.info('discovery complete, transports:', Object.keys(data.transports ?? {}));
      return data;
    } catch (err) {
      this.log.warn('discovery error:', err instanceof Error ? err.message : err);
      this.discoveryDone = true; // Don't retry on every connect()
      return null;
    }
  }

  /**
   * Apply discovery response — merges backend-provided transport configs
   * into the existing config without overwriting manually-set values.
   */
  private applyDiscovery(data: DiscoveryResponse): void {
    const t = data.transports;
    if (!t) return;

    const systemPrompt = this.config.systemPrompt;

    if (t.websocket && !this.config.websocket) {
      this.config.websocket = {
        url: t.websocket.url,
        token: t.websocket.token ?? data.token,
        systemPrompt,
      };
    }

    if (t.sse && !this.config.sse) {
      this.config.sse = {
        endpoint: t.sse.endpoint,
        token: t.sse.token ?? data.token,
        audioPath: t.sse.audioPath,
        healthPath: t.sse.healthPath,
        systemPrompt,
        language: this.config.language,
      };
    }

    if (t.webrtc && !this.config.webrtc) {
      this.config.webrtc = {
        signalingUrl: t.webrtc.signalingUrl,
        clusterName: t.webrtc.clusterName ?? '',
      };
    }

  }

  // ── Send ───────────────────────────────────────────────────────────────

  /**
   * Send PCM audio data through the pipeline.
   * @param data Float32Array of PCM samples (-1..1).
   * @throws {SpeechSDKError} if not connected, empty audio, or client destroyed.
   */
  async sendAudio(data: Float32Array): Promise<void> {
    this.validateBeforeSend();
    if (data.length === 0) {
      throw new SpeechSDKError('INVALID_INPUT', 'Audio data is empty');
    }

    this.startResponseTimeout();
    await this.transport!.sendAudio(data);
  }

  /**
   * Send text for TTS synthesis.
   * @param text The text to synthesize.
   * @throws {SpeechSDKError} if not connected, empty text, or client destroyed.
   */
  async sendText(text: string): Promise<void> {
    this.validateBeforeSend();
    if (!text.trim()) {
      throw new SpeechSDKError('INVALID_INPUT', 'Text is empty');
    }

    this.startResponseTimeout();
    await this.transport!.sendText(text);
  }

  // ── Service status & health polling ────────────────────────────────────

  /**
   * Start periodic health polling. Useful for detecting cold-start wake-up.
   * Emits 'status-change' events as the service transitions.
   * @param intervalMs Polling interval. Default: 5000ms.
   */
  startHealthPolling(intervalMs: number = 5_000): void {
    this.stopHealthPolling();
    this.log.debug('starting health polling every', intervalMs, 'ms');
    this.pollHealth(); // immediate first check
    this.healthPollTimer = setInterval(() => this.pollHealth(), intervalMs);
  }

  /** Stop health polling. */
  stopHealthPolling(): void {
    if (this.healthPollTimer) {
      clearInterval(this.healthPollTimer);
      this.healthPollTimer = null;
    }
  }

  // ── Disconnect & destroy ───────────────────────────────────────────────

  /** Gracefully disconnect the active transport and clear its callbacks. */
  disconnect(): void {
    const protocol = this.transport?.protocol ?? null;
    if (this.transport) {
      // Clear callbacks before disconnect to prevent ghost events during teardown
      this.transport.onResponse = null as any;
      this.transport.onStageChange = null as any;
      this.transport.onError = null as any;
      this.transport.onDisconnect = null as any;
      this.transport.onAudioChunk = null as any;
      this.transport.disconnect();
      this.transport = null;
    }
    this.clearResponseTimeout();
    this.setStage('idle');
    this.emit('disconnected', { protocol });
  }

  /** Destroy the client — disconnects, stops polling, removes all listeners. */
  destroy(): void {
    this.destroyed = true;
    this.stopHealthPolling();
    this.clearResponseTimeout();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.disconnect();
    this.removeAllListeners();
  }

  // ── Private ────────────────────────────────────────────────────────────

  private async createTransport(protocol: ProtocolId): Promise<Transport | null> {
    switch (protocol) {
      case 'websocket':
        return this.config.websocket ? new WebSocketTransport(this.config.websocket) : null;
      case 'sse':
        return this.config.sse ? new SSETransport({
          ...this.config.sse,
          language: this.config.sse.language ?? this.config.language,
        }) : null;
      case 'webrtc':
        if (!this.config.webrtc) return null;
        try {
          const { WebRTCTransport } = await import('./transport-webrtc');
          return new WebRTCTransport(this.config.webrtc);
        } catch {
          this.log.warn('WebRTC transport unavailable (missing @pipecat-ai/small-webrtc-transport)');
          return null;
        }
      default:
        return null;
    }
  }

  private wireTransport(transport: Transport): void {
    transport.onResponse = (r) => {
      this.clearResponseTimeout();
      this._metrics.lastResponseAt = Date.now();
      this._metrics.consecutiveFailures = 0;
      this.emit('response', r);
    };
    transport.onStageChange = (s) => this.setStage(s);
    transport.onError = (message, httpStatus) => {
      this._metrics.totalErrors++;
      // Detect auth errors
      if (httpStatus === 401 || httpStatus === 403) {
        this.handleAuthError(transport.protocol, httpStatus);
        return;
      }
      this.emit('error', { message, recoverable: true });
    };
    transport.onDisconnect = () => this.handleUnexpectedDisconnect();
    transport.onAudioChunk = (chunk) => {
      this.emit('audio-chunk', { chunk, protocol: transport.protocol });
    };
  }

  private async connectWithTimeout(transport: Transport, timeoutMs: number): Promise<boolean> {
    return Promise.race([
      transport.connect(),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  // ── Reconnection with exponential backoff ──────────────────────────────

  private handleUnexpectedDisconnect(): void {
    const maxAttempts = this.config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT;

    if (!this.config.autoReconnect || this.destroyed) {
      this.emit('disconnected', {
        protocol: this.transport?.protocol ?? null,
        reason: 'unexpected',
      });
      this.transport = null;
      return;
    }

    if (this.reconnectCount >= maxAttempts) {
      this.log.warn('max reconnect attempts reached:', maxAttempts);
      this.emit('error', {
        message: `Max reconnect attempts (${maxAttempts}) reached`,
        recoverable: false,
        code: 'TRANSPORT_FAILED',
      });
      this.emit('disconnected', {
        protocol: this.transport?.protocol ?? null,
        reason: 'max_reconnect',
      });
      this.transport = null;
      return;
    }

    this.reconnectCount++;
    const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, this.reconnectCount - 1), BACKOFF_MAX_MS);
    this.log.info(`reconnecting in ${delay}ms (attempt ${this.reconnectCount}/${maxAttempts})`);

    // Clear any existing reconnect timer to prevent duplicate reconnect attempts
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(e => console.warn('[speech] reconnect failed:', e instanceof Error ? e.message : e));
    }, delay);
  }

  // ── Auth error handling ────────────────────────────────────────────────

  private async handleAuthError(protocol: ProtocolId, httpStatus: number): Promise<void> {
    this.log.warn('auth error detected, status:', httpStatus);
    this.emit('auth-error', { protocol, httpStatus });

    if (this.config.onTokenRefresh) {
      this.log.info('attempting token refresh...');
      try {
        const newToken = await this.config.onTokenRefresh();
        if (newToken) {
          this.log.info('token refreshed, updating transport');
          // Update the transport's token
          if (this.transport?.updateToken) this.transport.updateToken(newToken);
          // Update config for future transports
          if (this.config.websocket) this.config.websocket.token = newToken;
          if (this.config.sse) this.config.sse.token = newToken;
          return;
        }
      } catch (err) {
        this.log.error('token refresh failed:', err);
      }
    }

    this.emit('error', {
      message: 'Authentication failed',
      recoverable: false,
      code: 'AUTH_ERROR',
    });
  }

  // ── Circuit breaker ────────────────────────────────────────────────────

  private isCircuitOpen(): boolean {
    if (this.cbOpenUntil > Date.now()) return true;
    if (this.cbOpenUntil > 0) {
      // Cooldown expired — reset
      this.cbOpenUntil = 0;
      this.cbFailures = 0;
      this._metrics.circuitOpen = false;
      this.emit('circuit-change', { open: false, failures: 0 });
    }
    return false;
  }

  private recordFailure(): void {
    const threshold = this.config.circuitBreaker?.failureThreshold ?? DEFAULT_CB_FAILURE_THRESHOLD;
    const cooldown = this.config.circuitBreaker?.cooldownMs ?? DEFAULT_CB_COOLDOWN;

    this.cbFailures++;
    this._metrics.consecutiveFailures = this.cbFailures;

    if (this.cbFailures >= threshold) {
      this.cbOpenUntil = Date.now() + cooldown;
      this._metrics.circuitOpen = true;
      this.log.warn(`circuit breaker OPEN after ${this.cbFailures} failures, cooldown ${cooldown}ms`);
      this.emit('circuit-change', { open: true, failures: this.cbFailures });
    }
  }

  // ── Response timeout ───────────────────────────────────────────────────

  private startResponseTimeout(): void {
    this.clearResponseTimeout();
    const timeout = this.config.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT;
    this.responseTimer = setTimeout(() => {
      this.log.warn('response timeout after', timeout, 'ms');
      this._metrics.totalErrors++;
      this.emit('error', {
        message: `Response timeout after ${timeout}ms`,
        recoverable: true,
        code: 'TIMEOUT',
      });
      this.setStage('idle');
    }, timeout);
  }

  private clearResponseTimeout(): void {
    if (this.responseTimer) {
      clearTimeout(this.responseTimer);
      this.responseTimer = null;
    }
  }

  // ── Health polling ─────────────────────────────────────────────────────

  private async pollHealth(): Promise<void> {
    // Determine health endpoint from SSE config or any available endpoint
    const endpoint = this.config.sse?.endpoint
      || this.config.websocket?.url?.replace(/^ws/, 'http').replace(/\/ws\/.*$/, '')
      || null;

    if (!endpoint) return;

    try {
      const res = await fetch(`${endpoint}/health`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        this.setServiceStatus('error');
        return;
      }

      const data = await res.json();
      const models: ModelLoadStatus = {
        whisper: data.models?.whisper ?? false,
        llm: data.models?.llm ?? data.models?.vllm ?? false,
        tts: data.models?.tts ?? data.models?.kokoro ?? false,
      };

      this._modelStatus = models;
      const allReady = models.whisper && models.llm && models.tts;

      const statusOk = data.status === 'ok' || data.status === 'healthy';
      if (statusOk && allReady) {
        this.setServiceStatus('ready');
      } else if (statusOk) {
        this.setServiceStatus('waking');
      } else {
        this.setServiceStatus('sleeping');
      }
    } catch {
      // Network error — service might be sleeping
      if (this._serviceStatus === 'unknown') {
        this.setServiceStatus('sleeping');
      }
    }
  }

  private setServiceStatus(status: ServiceStatus): void {
    if (status === this._serviceStatus) return;
    this._serviceStatus = status;
    this.log.debug('service status:', status);
    this.emit('status-change', { status, models: this._modelStatus ?? undefined });
  }

  // ── Validation ─────────────────────────────────────────────────────────

  private validateBeforeSend(): void {
    if (this.destroyed) {
      throw new SpeechSDKError('DESTROYED', 'SpeechClient has been destroyed');
    }
    if (!this.transport?.isConnected()) {
      throw new SpeechSDKError('NOT_CONNECTED', 'Not connected — call connect() first');
    }
  }

  /**
   * Update the system prompt on the active and configured transports without
   * reconnecting. Call this when user profile data (nativeLanguage, birthDate,
   * studentName) arrives asynchronously after the initial connection.
   */
  updateSystemPrompt(prompt: string): void {
    this.config.systemPrompt = prompt;
    // Propagate to transport-level configs so the new prompt is sent on the next request
    if (this.config.sse) this.config.sse.systemPrompt = prompt;
    if (this.config.websocket) this.config.websocket.systemPrompt = prompt;
  }

  // ── Stage management ───────────────────────────────────────────────────

  private setStage(stage: ProcessingStage): void {
    if (stage === this._stage) return;
    this._stage = stage;
    this.emit('stage-change', { stage });
  }
}
