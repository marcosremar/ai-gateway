/**
 * Browser SDK types — framework-agnostic interfaces for the SpeechClient.
 *
 * Derived from `cabecao-chat/types.ts` without React dependencies.
 */

import type { SpeechErrorCode } from './errors';

// ── Processing & Status ────────────────────────────────────────────────────

/** Current stage of the speech processing pipeline. */
export type ProcessingStage = 'idle' | 'connecting' | 'stt' | 'llm' | 'tts' | 'complete';

/** High-level service availability status. */
export type ServiceStatus = 'unknown' | 'sleeping' | 'waking' | 'ready' | 'error';

/** Transport protocol identifier. */
export type ProtocolId = 'webrtc' | 'websocket' | 'sse';

/** Per-model load status (maps to backend health endpoint). */
export interface ModelLoadStatus {
  whisper: boolean;
  llm: boolean;
  tts: boolean;
}

// ── Response ───────────────────────────────────────────────────────────────

/** Server-reported timing for each pipeline stage. */
export interface TimingInfo {
  stt_ms?: number;
  llm_ms?: number;
  tts_ms?: number;
  total_ms?: number;
}

/** Speech metrics (word count, speed, etc.) returned by backend. */
export interface SpeechMetrics {
  audio_duration_sec: number;
  word_count: number;
  wpm: number;
}

/** Adaptive speed suggestions from backend. */
export interface AdaptiveSpeed {
  suggested_speed: number;
  student_wpm: number;
  speed_mode: 'auto' | 'manual';
}

/** Complete response from the speech pipeline. */
export interface SpeechResponse {
  /** Bot's text response. */
  text: string;
  /** Base64-encoded WAV audio. Empty string for WebRTC (audio plays via track). */
  audio: string;
  /** Viseme data for lip-sync animation. */
  visemes: Array<{ start: number; end: number; value: string }>;
  /** Audio duration in seconds. */
  duration: number;
  /** User's original text (transcript from STT). */
  userText?: string;
  speechMetrics?: SpeechMetrics;
  adaptiveSpeed?: AdaptiveSpeed;
  timing?: TimingInfo;
}

// ── Transport interface ────────────────────────────────────────────────────

/** Interface every transport must implement. */
export interface Transport {
  readonly protocol: ProtocolId;

  /** Attempt to establish connection. Returns true on success. */
  connect(): Promise<boolean>;
  /** Gracefully close the connection. */
  disconnect(): void;
  /** Send PCM audio data through the pipeline. */
  sendAudio(data: Float32Array): Promise<void>;
  /** Send text for TTS synthesis. */
  sendText(text: string): Promise<void>;
  /** Whether the transport is currently connected. */
  isConnected(): boolean;

  // Callbacks set by the orchestrator
  onResponse: ((r: SpeechResponse) => void) | null;
  onStageChange: ((stage: ProcessingStage) => void) | null;
  onError: ((error: string, httpStatus?: number) => void) | null;
  onDisconnect: (() => void) | null;
  /** Emitted as each audio chunk arrives (before 'complete'). */
  onAudioChunk: ((chunk: Uint8Array) => void) | null;

  /** Remote audio stream (WebRTC only). */
  getRemoteStream?(): MediaStream | null;

  /** Update auth token on an active transport (WS/SSE). */
  updateToken?(token: string): void;
}

// ── Transport configs ──────────────────────────────────────────────────────

/** WebSocket transport configuration. */
export interface WebSocketConfig {
  /** WebSocket URL (e.g., `wss://gpu:8000/ws/stream`). */
  url: string;
  /** Bearer token appended as `?token=` query parameter. */
  token?: string;
  /** Keepalive ping interval. Default: 25000ms. */
  pingIntervalMs?: number;
  /** Max time to wait for WS handshake. Default: 10000ms. */
  connectionTimeoutMs?: number;
  /** System prompt for the LLM (sent as config message on connect). */
  systemPrompt?: string;
}

/** SSE (Server-Sent Events) transport configuration. */
export interface SSEConfig {
  /** Base URL for the SSE endpoint (e.g., `https://modal.run` or `/api/speech`). */
  endpoint: string;
  /** Bearer token for Authorization header. */
  token?: string;
  /** Max time to wait for health check response. Default: 10000ms. */
  healthCheckTimeoutMs?: number;
  /**
   * Audio endpoint path. Default: `/api/stream-audio`.
   * Override to `/` when pointing at /api/speech (the path IS the endpoint).
   */
  audioPath?: string;
  /** Health check path. Default: `/health`. */
  healthPath?: string;
  /** System prompt sent as FormData field (for server-side pipeline). */
  systemPrompt?: string;
  /** Conversation history sent as FormData field (for server-side pipeline). */
  history?: Array<{ role: string; content: string }>;
  /** ISO language code for STT (e.g. 'pt', 'en'). Improves Whisper accuracy. */
  language?: string;
}

/** WebRTC transport configuration (Pipecat-based). */
export interface WebRTCConfig {
  /** Pipecat signaling server URL. */
  signalingUrl: string;
  /** Cluster name for the backend. */
  clusterName: string;
  /** Direct IP of the head node. */
  headIp?: string;
  /** Access mode for the cluster. */
  accessMode?: 'direct' | 'ssh';
  /** Backend endpoint for ICE server discovery. */
  backendEndpoint?: string;
}

// ── Circuit Breaker config ────────────────────────────────────────────────

/** Circuit breaker configuration to prevent hammering a failing server. */
export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit. Default: 5. */
  failureThreshold?: number;
  /** Cooldown period in ms before attempting again. Default: 30000ms. */
  cooldownMs?: number;
}

// ── SpeechClient config ────────────────────────────────────────────────────

/** Response from the discovery endpoint (GET /api/speech/health). */
export interface DiscoveryResponse {
  gpu?: {
    status: string;
    models?: Record<string, boolean>;
    estimatedReadySecs?: number;
  };
  transports?: {
    webrtc?: { signalingUrl: string; clusterName?: string };
    websocket?: { url: string; token?: string };
    sse?: { endpoint: string; token?: string; audioPath?: string; healthPath?: string };
  };
  token?: string;
}

/** Main configuration for the SpeechClient. */
export interface SpeechClientConfig {
  /**
   * Discovery endpoint URL. When set, connect() will first fetch this endpoint
   * to auto-configure transport URLs. The backend returns available transports
   * and their URLs dynamically (based on GPU state, autoscaler, etc.).
   *
   * This is the recommended way to configure SpeechClient — just point it at
   * the discovery endpoint and let it figure out the rest.
   *
   * @example '/api/speech/health'
   */
  discoveryEndpoint?: string;
  /** Order in which transports are tried. Default: ['webrtc', 'websocket', 'sse']. */
  fallbackOrder?: ProtocolId[];
  /** WebSocket transport configuration. */
  websocket?: WebSocketConfig;
  /** SSE transport configuration. */
  sse?: SSEConfig;
  /** WebRTC transport configuration. */
  webrtc?: WebRTCConfig;
  /** System prompt for the LLM (passed to SSE transport for server-side pipeline). */
  systemPrompt?: string;
  /** ISO language code for STT (e.g. 'pt', 'en'). Passed to Whisper for accuracy. */
  language?: string;
  /** Max time per transport before trying the next. Default: 10000ms. */
  fallbackTimeoutMs?: number;
  /** Automatically reconnect on unexpected disconnect. Default: false. */
  autoReconnect?: boolean;
  /** Max reconnect attempts before giving up. Default: 3. */
  maxReconnectAttempts?: number;
  /** Response timeout — max time to wait for 'complete' event. Default: 30000ms. */
  responseTimeoutMs?: number;
  /** Circuit breaker configuration. */
  circuitBreaker?: CircuitBreakerConfig;
  /**
   * Callback invoked when a 401 is detected. Return a fresh token string
   * to retry, or null/undefined to fail. The returned token will be used
   * to update the active transport's auth.
   */
  onTokenRefresh?: () => Promise<string | null | undefined>;
  /** Enable debug-level logging. Default: false. */
  debug?: boolean;
}

// ── Metrics ────────────────────────────────────────────────────────────────

/** Snapshot of connection and usage metrics. */
export interface SDKMetrics {
  /** Total number of successful connections since creation. */
  totalConnections: number;
  /** Total number of fallback hops. */
  totalFallbacks: number;
  /** Total number of errors. */
  totalErrors: number;
  /** Per-transport connection latency (last measured, in ms). */
  transportLatency: Partial<Record<ProtocolId, number>>;
  /** Number of consecutive failures on the current transport. */
  consecutiveFailures: number;
  /** Timestamp (ms) of the last successful response. */
  lastResponseAt: number | null;
  /** Whether the circuit breaker is currently open. */
  circuitOpen: boolean;
}

// ── Event map ──────────────────────────────────────────────────────────────

/** All events emitted by the SpeechClient. */
export interface SpeechClientEventMap {
  /** Complete response from the pipeline. */
  response: SpeechResponse;
  /** Pipeline stage changed. */
  'stage-change': { stage: ProcessingStage };
  /** An error occurred. */
  error: { message: string; recoverable: boolean; code?: SpeechErrorCode };
  /** Transport fallback happened. */
  fallback: { from: ProtocolId; to: ProtocolId };
  /** Successfully connected. */
  connected: { protocol: ProtocolId };
  /** Disconnected (user-initiated or unexpected). */
  disconnected: { protocol: ProtocolId | null; reason?: string };
  /** Service status changed (sleeping → waking → ready). */
  'status-change': { status: ServiceStatus; models?: ModelLoadStatus };
  /** Auth token expired — 401 detected. */
  'auth-error': { protocol: ProtocolId; httpStatus: number };
  /** Audio chunk arrived (streaming — before 'complete'). */
  'audio-chunk': { chunk: Uint8Array; protocol: ProtocolId };
  /** Circuit breaker state changed. */
  'circuit-change': { open: boolean; failures: number };
}
