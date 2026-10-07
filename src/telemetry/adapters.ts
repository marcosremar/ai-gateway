/**
 * Adapters between the realtime control plane (src/realtime, merged separately) and telemetry, typed structurally so
 * neither side imports the other.
 *
 *   realtime gateway sink:  createRealtime({ telemetrySink: realtimeSinkToTelemetry(telemetry.ingest) })
 *   session tokens:         telemetryFromEnv(env, { auth: { …, resolveSessionToken: sessionResolverFrom(realtime) } })
 */

import type { TelemetryAttrs, TelemetryEvent, TelemetryLevel } from './contract';
import type { TelemetryIngest } from './ingest';

/** Shape of src/realtime/trace.ts `GatewayTelemetryEvent` (its `ts` is an ISO string; the contract wants ms). */
export interface RealtimeGatewayEvent {
  ts: string | number;
  source: 'gateway';
  level: TelemetryLevel;
  event: string;
  traceId: string;
  sessionId?: string;
  durMs?: number;
  attrs?: TelemetryAttrs;
}

export function toContractTs(ts: string | number): number {
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : Date.now();
}

/** A `RealtimeTelemetrySink` that stores into the telemetry store (same validation + scrubber as everything else). */
export function realtimeSinkToTelemetry(ingest: Pick<TelemetryIngest, 'ingestOwn'>): (event: RealtimeGatewayEvent) => void {
  return (e) => {
    const out: TelemetryEvent = { ...e, ts: toContractTs(e.ts), source: 'gateway' };
    ingest.ingestOwn(out);
  };
}

/**
 * `resolveSessionToken` for telemetry auth from anything with realtime's `resolveToken(token)` (claims on success,
 * `{status, code}` on failure). A refusal returns null so the built-in verifier still gets a chance (a session whose
 * replica is gone answers 410 there, but its last telemetry batch must still land).
 */
export function sessionResolverFrom(realtime: {
  resolveToken(token: string): { claims: { sid: string; app: string; dep: string; rep: string } } | { status: number };
}): (token: string) => { sid: string; app: string; dep: string; rep: string } | null {
  return (token) => {
    const r = realtime.resolveToken(token);
    if (!('claims' in r)) return null;
    const { sid, app, dep, rep } = r.claims;
    return { sid, app, dep, rep };
  };
}
