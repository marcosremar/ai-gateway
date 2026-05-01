/**
 * @parle/ai-gateway Browser SDK
 *
 * Framework-agnostic SpeechClient with automatic transport fallback
 * (WebRTC -> WebSocket -> SSE) and auto-discovery from backend.
 */

// ── SpeechClient ───────────────────────────────────────────────────────────
export { SpeechClient } from './speech-client';

// ── Transports ─────────────────────────────────────────────────────────────
export { WebSocketTransport } from './transport-ws';
export { SSETransport } from './transport-sse';
export { WebRTCTransport } from './transport-webrtc';

// ── Emitter ────────────────────────────────────────────────────────────────
export { TypedEmitter } from './emitter';

// ── OpenAI Realtime WebRTC ─────────────────────────────────────────────────
export { OpenAIRealtimeClient } from './openai-realtime';
export type {
  NetworkQuality,
  ConnectionPhase,
  OpenAIRealtimeOptions,
  OpenAIRealtimeResponse,
} from './openai-realtime';

// ── Unified Client (Realtime + Pipeline) ──────────────────────────────
export { UnifiedSpeechClient } from './unified-client';
export type {
  UnifiedSpeechClientConfig,
  UnifiedSpeechClientEventMap,
  UnifiedResponse,
  ActiveTransport,
} from './unified-client';

// ── Realtime Lipsync (WebRTC audio → viseme estimation) ──────────────────
export { RealtimeLipsyncAnalyser } from './realtime-lipsync';

// ── Errors ─────────────────────────────────────────────────────────────────
export { SpeechSDKError } from './errors';
export type { SpeechErrorCode } from './errors';

// ── Logger ─────────────────────────────────────────────────────────────────
export { createLogger, setLogLevel, setLogHandler } from './logger';
export type { Logger, LogLevel, LoggerOptions } from './logger';

// ── Audio Utils ────────────────────────────────────────────────────────────
export {
  uint8ToBase64,
  float32ToWavBuffer,
  combineWavChunksToBase64,
  buildSilentWav,
} from './audio';

// ── SSE Frame Parser
export { SSEFrameParser } from './sse-frame-parser';
export type { SSEFrame } from './sse-frame-parser';

// ── Streaming Audio ───────────────────────────────────────────────────────
export { StreamingAudioPlayer } from './streaming-audio';

// ── Types ──────────────────────────────────────────────────────────────────
export type {
  ProcessingStage,
  ServiceStatus,
  ProtocolId,
  ModelLoadStatus,
  TimingInfo,
  SpeechMetrics,
  AdaptiveSpeed,
  SpeechResponse,
  Transport,
  WebSocketConfig,
  SSEConfig,
  WebRTCConfig,
  CircuitBreakerConfig,
  SpeechClientConfig,
  SDKMetrics,
  SpeechClientEventMap,
  DiscoveryResponse,
} from './types';
