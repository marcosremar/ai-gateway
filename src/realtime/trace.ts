/**
 * Correlated telemetry on the gateway side of a realtime session (docs/realtime.md § Telemetry).
 *
 * The browser SDK opens one W3C trace per session and sends `traceparent` on every gateway call (as a query parameter on
 * the WebSocket, which cannot carry headers). The gateway keeps it, forwards it to the edge (`traceparent` header on
 * every replica call, the WS upgrade included), echoes `X-Aigw-Trace-Id`, and emits its own events with the same
 * `traceId`: `{ts, source:"gateway", level, event, traceId, sessionId?, durMs?, attrs?}`. Never audio, text, SDP or
 * tokens in them — codes, counts and durations.
 *
 * The sink is pluggable (`RealtimeTelemetrySink`): the shared telemetry store lands separately; until then events go to
 * the gateway log.
 */
import { randomBytes } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';

export const TRACE_ID_HEADER = 'X-Aigw-Trace-Id';
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export interface Trace { traceId: string; traceparent: string }

export function parseTraceparent(value: string | null | undefined): Trace | null {
  const m = TRACEPARENT.exec((value ?? '').trim().toLowerCase());
  if (!m || m[1] === 'ff' || /^0+$/.test(m[2]!) || /^0+$/.test(m[3]!)) return null;
  return { traceId: m[2]!, traceparent: m[0] };
}

export function newTrace(): Trace {
  const traceId = randomBytes(16).toString('hex');
  return { traceId, traceparent: `00-${traceId}-${randomBytes(8).toString('hex')}-01` };
}

/** The request's trace: `traceparent` header, else `?traceparent=` (WebSocket), else a new one. */
export function traceOf(req: IncomingMessage): Trace {
  const header = req.headers.traceparent;
  const fromHeader = parseTraceparent(Array.isArray(header) ? header[0] : header);
  if (fromHeader) return fromHeader;
  try {
    const q = new URL(req.url ?? '/', 'http://gateway').searchParams.get('traceparent');
    return parseTraceparent(q) ?? newTrace();
  } catch { return newTrace(); }
}

/** A child span for a call to the edge: same trace, new parent id. */
export function childTraceparent(trace: Trace): string {
  return `00-${trace.traceId}-${randomBytes(8).toString('hex')}-01`;
}

export function echoTrace(res: ServerResponse, trace: Trace): void {
  if (!res.headersSent) res.setHeader(TRACE_ID_HEADER, trace.traceId);
}

export interface GatewayTelemetryEvent {
  /** Milliseconds since the epoch (`Date.now()`), as the ingest requires. */
  ts: number;
  source: 'gateway';
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  traceId: string;
  sessionId?: string;
  durMs?: number;
  attrs?: Record<string, string | number | boolean | null>;
}

/** Where gateway realtime events go; serve.ts passes `realtimeSinkToTelemetry(...)`, the default is the log. */
export type RealtimeTelemetrySink = (event: GatewayTelemetryEvent) => void;

export function makeEmitter(sink: RealtimeTelemetrySink | undefined, log: (msg: string, data?: Record<string, unknown>) => void) {
  const out: RealtimeTelemetrySink = sink ?? ((e) => log(`telemetry ${e.event}`, e as unknown as Record<string, unknown>));
  return (trace: Trace, event: string, fields: { level?: GatewayTelemetryEvent['level']; sessionId?: string; durMs?: number; attrs?: GatewayTelemetryEvent['attrs'] } = {}) => {
    try {
      out({
        ts: Date.now(), source: 'gateway', level: fields.level ?? 'info', event, traceId: trace.traceId,
        ...(fields.sessionId ? { sessionId: fields.sessionId } : {}),
        ...(typeof fields.durMs === 'number' ? { durMs: Math.round(fields.durMs) } : {}),
        ...(fields.attrs ? { attrs: fields.attrs } : {}),
      });
    } catch { /* telemetry never breaks a session */ }
  };
}

export type GatewayEmit = ReturnType<typeof makeEmitter>;
