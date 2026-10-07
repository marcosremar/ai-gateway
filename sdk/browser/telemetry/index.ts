/**
 * Browser telemetry for the gateway (docs/api/telemetry.md). The realtime SDK creates one emitter per session:
 *
 *   import { createTelemetry } from '@parle/ai-gateway/telemetry';
 *   const telemetry = createTelemetry({ endpoint: gatewayUrl, token: () => session.token, sessionId: session.id });
 *   telemetry.emit('rt.ladder.fallback', { level: 'warn', attrs: { from: 'webrtc', to: 'ws', reason: 'ice_failed' } });
 */
export { TelemetryEmitter, createTelemetry, newTraceId, traceparentOf } from './emitter';
export type {
  TelemetryEmitterOptions, TelemetryContext, EmitFields, TelemetryStats,
  TelemetryEvent, TelemetryLevel, TelemetrySource, TelemetryAttrs,
} from './emitter';
