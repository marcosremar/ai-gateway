/**
 * The gateway's own telemetry events (source `gateway`): routing decision, fallback, hedge, breaker open, autoscale
 * decisions, replica lifecycle, STT filter hits. They go through the same sink as what browsers and edges send
 * (serve.ts installs it with `setGatewayTelemetrySink`, pointing at the TelemetryStore). Without a sink — tests, the
 * library used on its own — `emitGatewayEvent` is a no-op. It never throws into the caller.
 *
 * Inside a request the event carries that request's trace id (trace-context.ts); outside one (background loops) it
 * gets a fresh trace id, so each autoscale decision is its own little trace.
 */

import type { TelemetryAttrs, TelemetryEvent, TelemetryLevel } from './contract';
import { currentTraceId, newTraceId } from './trace-context';

export type TelemetrySink = (event: TelemetryEvent) => void;

let sink: TelemetrySink | null = null;

export function setGatewayTelemetrySink(next: TelemetrySink | null): void {
  sink = next;
}

export function gatewayTelemetryEnabled(): boolean {
  return sink !== null;
}

export interface GatewayEventFields {
  level?: TelemetryLevel;
  durMs?: number;
  sessionId?: string;
  turnId?: string;
  replicaId?: string;
  deployment?: string;
  traceId?: string;
  attrs?: Record<string, TelemetryAttrs[string] | undefined>;
}

export function emitGatewayEvent(event: string, fields: GatewayEventFields = {}): void {
  if (!sink) return;
  try {
    const { attrs, level, traceId, ...rest } = fields;
    const clean: TelemetryAttrs = {};
    for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined) clean[k] = v;
    const out: TelemetryEvent = {
      ts: Date.now(), source: 'gateway', level: level ?? 'info', event,
      traceId: traceId ?? currentTraceId() ?? newTraceId(),
      ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
      ...(Object.keys(clean).length ? { attrs: clean } : {}),
    };
    sink(out);
  } catch {
    // Telemetry must never break the request or loop that reports it.
  }
}
