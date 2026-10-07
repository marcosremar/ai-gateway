/**
 * Telemetry contract (docs/api/telemetry.md) — the one event shape every source writes: the browser SDK, the gateway
 * itself, the edge agent inside each GPU replica (and the model it relays for). Plain constants and types, no runtime
 * dependency: the browser and Node emitters import this file; the server validates with the Zod schema in schema.ts,
 * which is built from these same constants.
 *
 * Correlation: W3C `traceparent` (`traceId` = 32 lowercase hex, created by the browser SDK per realtime/voice session,
 * or by the gateway when absent), plus `sessionId` (realtime session), `turnId` (one student turn), `replicaId`,
 * `deployment` and `app`. `app`, and for session/edge callers also `sessionId` / `deployment` / `replicaId`, are
 * stamped by the gateway from the credential — never trusted from the body.
 *
 * Privacy (research instrument with student data): no audio, no transcript or LLM text, no keys/tokens, no raw IP.
 * Lengths, counts, durations, codes only. The server scrubber (scrub.ts) enforces it on every attribute.
 */

export const TELEMETRY_SOURCES = ['browser', 'gateway', 'edge', 'model'] as const;
export type TelemetrySource = typeof TELEMETRY_SOURCES[number];

export const TELEMETRY_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type TelemetryLevel = typeof TELEMETRY_LEVELS[number];

/** Attribute values: scalars only (no nested objects — they would be a side door for free text). */
export type TelemetryAttrValue = string | number | boolean | null;
export type TelemetryAttrs = Record<string, TelemetryAttrValue>;

/** One event as a source writes it. */
export interface TelemetryEvent {
  /** When it happened, ms since the epoch, by the SOURCE's clock (the server keeps its own receive time as `rxTs`). */
  ts: number;
  source: TelemetrySource;
  level: TelemetryLevel;
  /** Dotted lowercase name, e.g. `rt.ladder.fallback`, `rt.ice.failed`, `vad.segment`, `stt.filtered`, `turn.done`. */
  event: string;
  /** W3C trace id: 32 lowercase hex, not all zeros. */
  traceId: string;
  sessionId?: string;
  turnId?: string;
  replicaId?: string;
  deployment?: string;
  durMs?: number;
  attrs?: TelemetryAttrs;
}

/** What the gateway stores: the event plus what only the server knows. */
export interface StoredTelemetryEvent extends TelemetryEvent {
  /** Monotonic row id (cursor for paging). */
  seq: number;
  /** Server receive time (ms). `rxTs - ts` per source is the clock skew + transit shown by the timeline. */
  rxTs: number;
  /** App account, from the credential (app key user, session token `app`, or the replica's deployment owner). */
  app?: string;
}

/** Ingest batch: `POST /v1/telemetry/events` with `{ events: [...] }` (beacons may add `token`, see the doc). */
export interface TelemetryBatch {
  events: TelemetryEvent[];
  /** Realtime session token, only for `navigator.sendBeacon` (which cannot set headers). */
  token?: string;
}

export const TELEMETRY_LIMITS = {
  /** Events per batch. */
  maxBatchEvents: 100,
  /** Bytes per batch body. */
  maxBatchBytes: 64 * 1024,
  /** Attributes per event (extra keys are dropped). */
  maxAttrs: 32,
  /** Longest attribute key. */
  maxAttrKey: 64,
  /** Longest string attribute value: longer ones are dropped (free text has no business here). */
  maxAttrString: 200,
  /** Longest event name. */
  maxEventName: 64,
  /** Longest id (sessionId, turnId, replicaId, deployment). */
  maxId: 128,
  /** Longest plausible duration (1 day). */
  maxDurMs: 86_400_000,
} as const;

/** Attribute keys that name content: a STRING value under such a key is dropped (scrub.ts, and the emitters). */
export const TELEMETRY_SENSITIVE_KEY = /text|transcript|prompt|content|audio|token|key|secret|authorization/i;

export const TELEMETRY_EVENT_NAME = /^[a-z0-9_]+(\.[a-z0-9_-]+)+$/;
export const TELEMETRY_TRACE_ID = /^(?!0{32})[0-9a-f]{32}$/;
export const TELEMETRY_ID = /^[A-Za-z0-9._:@-]{1,128}$/;

/** HMAC message for the edge's telemetry credential: hex(HMAC-SHA256(key = replicaToken, msg = this)). */
export const TELEMETRY_EDGE_HMAC_INFO = 'aigw-telemetry-v1';
/** Header naming the replica an edge request comes from. */
export const TELEMETRY_REPLICA_HEADER = 'x-aigw-replica';
/** Response header carrying the trace id the gateway used for the request. */
export const TRACE_ID_RESPONSE_HEADER = 'X-Aigw-Trace-Id';
export const TELEMETRY_INGEST_PATH = '/v1/telemetry/events';
