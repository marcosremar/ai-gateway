/**
 * Unified, correlated telemetry (docs/api/telemetry.md): one sink on the gateway for the browser SDK, the gateway
 * itself and the edge agent of each GPU replica, correlated by W3C trace id + session/turn/replica ids.
 */
export * from './contract';
export { TelemetryEventSchema, TelemetryAttrValueSchema } from './schema';
export { scrubAttrs, hashIp, SENSITIVE_KEY } from './scrub';
export { newTraceId, newSpanId, parseTraceparent, formatTraceparent, traceOfRequest, currentTraceId, outgoingTraceHeaders } from './trace-context';
export { emitGatewayEvent, setGatewayTelemetrySink, gatewayTelemetryEnabled, type TelemetrySink, type GatewayEventFields } from './emit';
export { deploymentLogToTelemetry } from './gateway-events';
export { TelemetryStore, type TelemetryStoreOptions } from './store';
export { TelemetryIngest, traceSampled, type IngestOptions, type IngestCounters } from './ingest';
export { authenticateTelemetry, edgeTelemetrySignature, verifySessionPrincipal, type TelemetryPrincipal, type TelemetryAuthDeps } from './auth';
export { queryEvents, timeline, summarize, percentile, SUMMARY_GROUPS, type EventFilter, type SummaryGroup } from './query';
export { createTelemetryRoutes, telemetryFromEnv, type TelemetryService } from './http';
export { realtimeSinkToTelemetry, sessionResolverFrom, toContractTs, type RealtimeGatewayEvent } from './adapters';
