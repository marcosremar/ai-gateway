/**
 * Realtime capacity of each replica, read from the edge's `GET /__aigw/rt/status` (behind the replica's token gate):
 *
 *     { active, max, available, transports: ["webrtc", "ws"], udpPorts: [lo, hi], firstAudioMaxMs }
 *
 * `available` is 0 while the replica sheds load (its recent first-audio maximum is over the deadline).
 *
 * Cached per replica for `ttlMs` (admission of a class of 30 students at once polls each replica once, not 30 times).
 * A 404 means the replica runs an image without the edge (`unsupported`, cached the same): sessions go elsewhere or
 * down the ladder.
 */

export type EdgeTransport = 'webrtc' | 'ws';

/** The edge's media path (netcheck.py): `unknown` until this gateway probed it. */
export interface EdgeNet {
  path: 'unknown' | 'direct' | 'relay' | 'ws';
  udpInbound: 'unknown' | 'ok' | 'blocked';
  publicIp: string | null;
  /** Unix seconds of the last decision, null before the first probe. */
  checkedAt: number | null;
}

export interface EdgeStatus {
  active: number;
  max: number;
  available: number;
  transports: EdgeTransport[];
  udpPorts: [number, number] | null;
  /** UDP port answering the reachability probe; null on an edge from before netcheck. */
  probePort: number | null;
  net: EdgeNet | null;
  firstAudioMaxMs: number | null;
}

export type EdgeStatusResult = { ok: true; status: EdgeStatus } | { ok: false; reason: 'unsupported' | 'unreachable' };

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

export function parseEdgeStatus(body: unknown): EdgeStatus | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const active = count(b.active), max = count(b.max);
  if (active === null || max === null) return null;
  const available = count(b.available) ?? Math.max(0, max - active);
  const transports = Array.isArray(b.transports)
    ? b.transports.filter((t): t is EdgeTransport => t === 'webrtc' || t === 'ws') : [];
  const ports = Array.isArray(b.udpPorts) && b.udpPorts.length === 2 && b.udpPorts.every(p => Number.isInteger(p))
    ? [b.udpPorts[0], b.udpPorts[1]] as [number, number] : null;
  const probePort = Number.isInteger(b.probePort) ? b.probePort as number : null;
  const n = b.net && typeof b.net === 'object' ? b.net as Record<string, unknown> : null;
  const net: EdgeNet | null = n ? {
    path: (['direct', 'relay', 'ws'] as const).find(p => p === n.path) ?? 'unknown',
    udpInbound: n.udpInbound === 'ok' || n.udpInbound === 'blocked' ? n.udpInbound : 'unknown',
    publicIp: typeof n.publicIp === 'string' && n.publicIp ? n.publicIp : null,
    checkedAt: typeof n.checkedAt === 'number' ? n.checkedAt : null,
  } : null;
  return { active, max, available: Math.min(available, max), transports, udpPorts: ports, probePort, net, firstAudioMaxMs: count(b.firstAudioMaxMs) };
}

export interface EdgeStatusCacheOptions {
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export class EdgeStatusCache {
  private readonly cache = new Map<string, { at: number; result: EdgeStatusResult }>();
  private readonly inflight = new Map<string, Promise<EdgeStatusResult>>();
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: EdgeStatusCacheOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.ttlMs = opts.ttlMs ?? 2_000;
    this.timeoutMs = opts.timeoutMs ?? 1_500;
    this.now = opts.now ?? Date.now;
  }

  /** The replica's status, from cache when fresh. `base` = replicaBase(...), `token` = the deployment's replica token. */
  async get(replicaId: string, base: string, token: string, opts: { fresh?: boolean } = {}): Promise<EdgeStatusResult> {
    const hit = this.cache.get(replicaId);
    if (!opts.fresh && hit && this.now() - hit.at < this.ttlMs) return hit.result;
    const running = this.inflight.get(replicaId);
    if (running) return running;
    const p = this.fetchStatus(base, token).then((result) => {
      this.cache.set(replicaId, { at: this.now(), result });
      return result;
    }).finally(() => this.inflight.delete(replicaId));
    this.inflight.set(replicaId, p);
    return p;
  }

  /** Forget a replica's status (a session was just placed on it, or it vanished). */
  invalidate(replicaId: string): void {
    this.cache.delete(replicaId);
  }

  private async fetchStatus(base: string, token: string): Promise<EdgeStatusResult> {
    try {
      const res = await this.fetchImpl(`${base}/__aigw/rt/status`, {
        headers: { 'X-Aigw-Token': token }, signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 404) return { ok: false, reason: 'unsupported' };
      if (!res.ok) return { ok: false, reason: 'unreachable' };
      const status = parseEdgeStatus(await res.json().catch(() => null));
      return status ? { ok: true, status } : { ok: false, reason: 'unsupported' };
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
  }
}
