/**
 * @parle/ai-gateway/realtime — realtime voice in the browser over a transport ladder (docs/realtime.md):
 * WebRTC direct to the GPU replica (TURN over TCP/443 when UDP is blocked) → WebSocket relayed by the gateway →
 * s2s-stream (one streamed HTTP request per turn) → plain POST. One call, `createRealtimeSession`, does it all; the
 * rest is exported for consumers that wire their own pieces (and for tests).
 */
export { createRealtimeSession } from './session';
export type { RealtimeSession, RealtimeSessionOptions, RealtimeVoiceOptions, SpeakText } from './session';
export {
  DEFAULT_TIMEOUTS, TRANSPORT_LADDER,
} from './types';
export type {
  AttemptRecord, ChatMessage, ClientMessage, IceServerInit, LinkStats, RealtimeEvent, RealtimeLocalEvent, RealtimeMetrics,
  RealtimeServerEvent, RealtimeTimeouts, RealtimeTransport, SessionDescriptor, SessionRefusal, SessionRequest,
  StorageLike, TransportContext, TransportFactory, TransportOffer, TransportType,
} from './types';
export {
  LadderExhausted, WINNER_TTL_MS, attemptTimeoutMs, climbLadder, createWinnerMemory, defaultNetworkKey, orderWithWinner,
} from './ladder';
export { configFromToken, requestSession, telemetryUrlOf } from './descriptor';
export type { SessionSource } from './descriptor';
export {
  DOWNSTREAM_RATE, FRAME_MS, FrameChunker, LinearResampler, UPSTREAM_RATE, WS_AUDIO_HEADER,
  decodeAudioFrame, encodeAudioFrame, floatToInt16, int16ToFloat, samplesPerFrame, trimLeadingSilence,
} from './pcm';
export { CAPTURE_WORKLET, PLAYER_WORKLET, createPcmCapture, createPcmPlayer, decodeClip } from './audio-io';
export type { DecodedClip, PcmCapture, PcmPlayer } from './audio-io';
export { createWebRtcTransport, preferRedundantAudio, setPlayoutDelay } from './transports/webrtc';
export { createWsTransport } from './transports/ws';
export { createPostTransport, createS2SStreamTransport, mapS2SEvent } from './transports/clip';
export type { PostTurn, PostTurnResult, S2SEndpoint } from './transports/clip';
export { DEFAULT_POLICY, decideTransport, initialPolicy } from './transport-policy';
export type { NetworkSample, PolicyContext, PolicyEffect, PolicyState, TransportPolicyThresholds } from './transport-policy';
export { createVoiceBridge } from './voice-bridge';
export type { VoiceBridge, VoiceBridgeOptions } from './voice-bridge';
export { TELEMETRY_MAX_BATCH, createLocalTelemetry, newTraceparent, newTurnId, safeAttrs } from './telemetry';
export type { LocalTelemetryOptions, RealtimeTelemetry, TelemetryEvent, TelemetryFields, TelemetryLevel } from './telemetry';
