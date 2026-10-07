import type { RealtimeTelemetry } from './telemetry';

/**
 * Types of the realtime browser SDK (`@parle/ai-gateway/realtime`). The wire contract is docs/realtime.md.
 */

export type TransportType = 'webrtc' | 'ws' | 's2s-stream' | 'post';

/** The full ladder, best first. */
export const TRANSPORT_LADDER: readonly TransportType[] = ['webrtc', 'ws', 's2s-stream', 'post'];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Events from the edge (data channel / WS text frames), the s2s vocabulary. */
export type RealtimeServerEvent =
  | { type: 'ready' }
  | { type: 'vad'; state: 'start' | 'end' }
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'filtered'; reasons: string[] }
  | { type: 'reply_delta'; text: string }
  | { type: 'reply'; text: string }
  | { type: 'audio_start' }
  | { type: 'audio_end' }
  | { type: 'interrupted' }
  | { type: 'done'; empty?: boolean; filtered?: boolean }
  | { type: 'error'; code: string; message: string }
  | { type: 'metrics'; ttfa_ms?: number | null; stt_ms?: number | null; llm_ttft_ms?: number | null; tts_ttfb_ms?: number | null };

/** Events the SDK adds: which transport carries the session, and its end. */
export type RealtimeLocalEvent =
  | { type: 'transport'; transport: TransportType; reason: 'connected' | 'failover'; from?: TransportType; error?: string }
  | { type: 'closed'; reason: string };

export type RealtimeEvent = RealtimeServerEvent | RealtimeLocalEvent;

/** Client → edge control messages. */
export type ClientMessage =
  | { type: 'interrupt' }
  | { type: 'end_turn' }
  | { type: 'config_update'; messages?: ChatMessage[] }
  | { type: 'ping' };

export interface IceServerInit {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type TransportOffer =
  | { type: 'webrtc'; offerUrl: string; iceUrl?: string; iceServers?: IceServerInit[]; iceTransportPolicy?: 'all' | 'relay' }
  | { type: 'ws'; url: string }
  | { type: 's2s-stream'; url?: string }
  | { type: 'post' };

/** What `POST /v1/realtime/sessions` answers (relayed by the app's backend). */
export interface SessionDescriptor {
  sessionId: string;
  token: string;
  expiresAt: string;
  transports: TransportOffer[];
  iceServers?: IceServerInit[];
  limits?: Record<string, unknown>;
  /** Telemetry ingest of the gateway (`POST`, session token as Bearer). */
  telemetryUrl?: string;
  traceId?: string;
}

/** A refused admission (cold / saturated / …): the client goes down the ladder at once. */
export interface SessionRefusal {
  refused: true;
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

export interface SessionRequest {
  transports: TransportType[];
  prefer?: TransportType;
}

export interface RealtimeTimeouts {
  /** Session request to the app's backend. */
  sessionMs: number;
  /** Ceiling of ICE gathering: the offer goes at the first srflx/relay candidate, or here with what was gathered (non-trickle). */
  iceGatherMs: number;
  /** From the answer to a connected peer connection with an open data channel. */
  webrtcConnectMs: number;
  /** Offer POST round trip. */
  signalingMs: number;
  wsOpenMs: number;
  /** From the WS open to the edge's `ready`. */
  wsReadyMs: number;
  /** One s2s-stream / post turn, end to end. */
  turnMs: number;
  /** A WebRTC connection `disconnected` this long is a failure. */
  disconnectGraceMs: number;
}

export const DEFAULT_TIMEOUTS: RealtimeTimeouts = {
  sessionMs: 5_000,
  iceGatherMs: 2_000,
  webrtcConnectMs: 3_000,
  signalingMs: 3_000,
  wsOpenMs: 3_000,
  wsReadyMs: 3_000,
  turnMs: 45_000,
  disconnectGraceMs: 3_000,
};

export interface AttemptRecord {
  type: TransportType;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface RealtimeMetrics {
  transport: TransportType | null;
  connectMs: number | null;
  attempts: AttemptRecord[];
  failovers: number;
  /** Audio frames dropped because the uplink could not keep up (WS). */
  droppedFrames: number;
  /** Last `metrics` event of the edge. */
  lastTurn: { ttfa_ms?: number | null; stt_ms?: number | null; llm_ttft_ms?: number | null; tts_ttfb_ms?: number | null } | null;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** One rung of the ladder, as the session drives it. */
export interface RealtimeTransport {
  readonly type: TransportType;
  /** Turns arrive as recorded clips (s2s-stream, post) rather than as a live audio stream. */
  readonly clipBased: boolean;
  /** Resolves once the transport carries the session; rejects (or the signal aborts) otherwise. */
  connect(signal: AbortSignal): Promise<void>;
  send(message: ClientMessage): void;
  /** Clip-based rungs: one learner turn (16 kHz WAV). */
  sendTurn?(wav: Blob): Promise<void>;
  close(): void;
}

/** What a transport gets from the session. */
export interface TransportContext {
  descriptor: SessionDescriptor | null;
  timeouts: RealtimeTimeouts;
  fetchImpl: typeof fetch;
  mic(): Promise<MediaStream>;
  emit(event: RealtimeEvent): void;
  /** A connected transport broke: the session fails over. */
  fail(error: Error): void;
  remoteAudio(stream: MediaStream | null): void;
  playoutDelayMs?: number;
  /** Session config (decoded from the token, or the caller's) with the conversation so far. */
  config(): Record<string, unknown>;
  dropped(n: number): void;
  /** W3C trace context of the session, sent on every gateway call. */
  traceparent: string;
  telemetry: RealtimeTelemetry;
}

export type TransportFactory = (ctx: TransportContext) => RealtimeTransport | null;
