/**
 * Admission of a realtime session, the pure part: which transports the client gets, in which order, and which replica
 * takes the session (docs/realtime.md § Admission).
 */
import type { EdgeStatus, EdgeTransport } from './edge-status';

export type RealtimeTransportType = 'webrtc' | 'ws' | 's2s-stream' | 'post';

export const TRANSPORT_LADDER: readonly RealtimeTransportType[] = ['webrtc', 'ws', 's2s-stream', 'post'];

const isTransport = (v: unknown): v is RealtimeTransportType => typeof v === 'string' && (TRANSPORT_LADDER as readonly string[]).includes(v);
export const isEdgeTransport = (t: RealtimeTransportType): t is EdgeTransport => t === 'webrtc' || t === 'ws';

/**
 * The client's ordered preference (`transports`), with `prefer` moved first. Absent = the full ladder. Unknown names
 * are an error (a typo must not silently drop WebRTC).
 */
export function orderTransports(requested: unknown, prefer: unknown): { order: RealtimeTransportType[] } | { error: string } {
  let order: RealtimeTransportType[];
  if (requested === undefined || requested === null) order = [...TRANSPORT_LADDER];
  else if (!Array.isArray(requested) || !requested.length) return { error: '"transports" must be a non-empty array' };
  else {
    const bad = requested.filter(t => !isTransport(t));
    if (bad.length) return { error: `unknown transport(s): ${bad.map(String).join(', ')} (known: ${TRANSPORT_LADDER.join(', ')})` };
    order = [...new Set(requested as RealtimeTransportType[])];
  }
  if (prefer !== undefined && prefer !== null) {
    if (!isTransport(prefer)) return { error: `unknown "prefer" transport: ${String(prefer)}` };
    order = [prefer, ...order.filter(t => t !== prefer)];
  }
  if (!order.some(isEdgeTransport)) return { error: 'a realtime session needs "webrtc" or "ws" among its transports (s2s-stream and post need no session)' };
  return { order };
}

export interface ReplicaCandidate {
  id: string;
  base: string;
  status: EdgeStatus;
  /** Sessions admitted here that the replica's status does not count yet (not connected). */
  pending: number;
}

export const freeSlots = (c: ReplicaCandidate) => Math.max(0, c.status.available - c.pending);

const PATH_RANK = { direct: 0, unknown: 1, relay: 2, ws: 3 } as const;
const pathRank = (c: ReplicaCandidate) => PATH_RANK[c.status.net?.path ?? 'unknown'];

/**
 * The replica that takes a session: it speaks one of the wanted edge transports and has a free slot after the pending
 * admissions; the best media path wins (direct, then not probed yet, then relay, then ws), then the most free slots,
 * then the least loaded (active / max), then the id (stable).
 */
export function pickReplica(candidates: ReplicaCandidate[], wanted: RealtimeTransportType[]): ReplicaCandidate | null {
  const edge = wanted.filter(isEdgeTransport);
  const usable = candidates.filter(c => freeSlots(c) > 0 && c.status.transports.some(t => edge.includes(t)));
  if (!usable.length) return null;
  const ratio = (c: ReplicaCandidate) => (c.status.max ? (c.status.active + c.pending) / c.status.max : 1);
  return usable.reduce((best, c) => {
    const dp = pathRank(c) - pathRank(best);
    if (dp !== 0) return dp < 0 ? c : best;
    const df = freeSlots(c) - freeSlots(best);
    if (df !== 0) return df > 0 ? c : best;
    const dr = ratio(c) - ratio(best);
    if (dr !== 0) return dr < 0 ? c : best;
    return c.id < best.id ? c : best;
  });
}

/**
 * Requests charged to the app's daily budget (AppLimits) for one session: `perMinute × ⌈ttl / 60⌉`, at admission.
 * The gateway does not see WebRTC audio (it flows browser ↔ replica), so the budget charges the time the token covers,
 * the most audio the session can carry. Default 4 per minute: about one turn every 15 s, each worth one `/v1/s2s`.
 */
export const REALTIME_REQUESTS_PER_MINUTE = 4;

export function sessionCharge(ttlSeconds: number, perMinute = REALTIME_REQUESTS_PER_MINUTE): number {
  return Math.max(1, Math.ceil(ttlSeconds / 60) * perMinute);
}
