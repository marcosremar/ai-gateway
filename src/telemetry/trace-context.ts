/**
 * W3C trace context (https://www.w3.org/TR/trace-context/) for the gateway: read the caller's `traceparent`, keep its
 * trace id for the whole request in the logger's AsyncLocalStorage frame (`traceId` / `spanId` next to `requestId`),
 * echo it as `X-Aigw-Trace-Id`, and propagate it to upstreams (replica HTTP, edge) as a child `traceparent`.
 *
 * Dependency-light on purpose: the proxy bundle imports it.
 */

import { randomBytes } from 'crypto';
import { getLogContext } from '../logger';
import { TELEMETRY_TRACE_ID } from './contract';

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export interface TraceParent {
  traceId: string;
  parentSpanId: string;
  sampled: boolean;
}

export function newTraceId(): string {
  let id = randomBytes(16).toString('hex');
  while (!TELEMETRY_TRACE_ID.test(id)) id = randomBytes(16).toString('hex');
  return id;
}

export function newSpanId(): string {
  let id = randomBytes(8).toString('hex');
  while (id === '0000000000000000') id = randomBytes(8).toString('hex');
  return id;
}

/** Parsed `traceparent`, or null when absent/invalid (version ff, all-zero ids → invalid, as the spec says). */
export function parseTraceparent(value: string | string[] | undefined): TraceParent | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const m = raw ? TRACEPARENT.exec(raw.trim().toLowerCase()) : null;
  if (!m) return null;
  const [, version, traceId, parentSpanId, flags] = m as unknown as [string, string, string, string, string];
  if (version === 'ff' || !TELEMETRY_TRACE_ID.test(traceId) || parentSpanId === '0000000000000000') return null;
  return { traceId, parentSpanId, sampled: (parseInt(flags, 16) & 1) === 1 };
}

export function formatTraceparent(traceId: string, spanId: string, sampled = true): string {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}

/**
 * Trace of an incoming request: its `traceparent` header, else `?traceparent=` in the URL (a browser WebSocket cannot
 * set headers — same rule as src/realtime/trace.ts), else an `X-Aigw-Trace-Id` a client sent alone, else a new one.
 * `spanId` is the gateway's own span for this request.
 */
export function traceOfRequest(
  headers: Record<string, string | string[] | undefined>, url?: string,
): { traceId: string; spanId: string; parentSpanId?: string } {
  const query = url && url.includes('traceparent=') ? /[?&]traceparent=([^&]+)/.exec(url)?.[1] : undefined;
  const parent = parseTraceparent(headers.traceparent) ?? (query ? parseTraceparent(query.replace(/%2D/gi, '-')) : null);
  if (parent) return { traceId: parent.traceId, spanId: newSpanId(), parentSpanId: parent.parentSpanId };
  const loose = headers['x-aigw-trace-id'];
  const given = (Array.isArray(loose) ? loose[0] : loose)?.trim().toLowerCase();
  return { traceId: given && TELEMETRY_TRACE_ID.test(given) ? given : newTraceId(), spanId: newSpanId() };
}

/** The trace id of the request being served (AsyncLocalStorage), or null outside one. */
export function currentTraceId(): string | null {
  const id = getLogContext()?.traceId;
  return typeof id === 'string' && TELEMETRY_TRACE_ID.test(id) ? id : null;
}

/** Headers to add to an upstream call: a child `traceparent` of the current request; `{}` outside a request. */
export function outgoingTraceHeaders(): Record<string, string> {
  const traceId = currentTraceId();
  return traceId ? { traceparent: formatTraceparent(traceId, newSpanId()) } : {};
}
