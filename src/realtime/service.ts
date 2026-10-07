/**
 * Realtime control plane: admission (`POST /v1/realtime/sessions`), the session token, and what the signaling and WS
 * relays need to find a session's replica again. docs/realtime.md has the whole picture.
 *
 * State here is only an optimisation (pending admissions, the edge's session id for ICE/DELETE): a token is
 * self-contained, so a gateway restart does not break a session — the relays re-derive the replica from its claims.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import type { DeploymentController } from '../deployments/controller';
import { replicaBase } from '../deployments/http';
import { noWakeActive, recordNoWakeSkip } from '../gateway/proxy/no-wake';
import type { AppLimitDenial } from '../gateway/proxy/app-limits';
import { EdgeStatusCache, type EdgeStatusResult } from './edge-status';
import {
  isEdgeTransport, orderTransports, pickReplica, sessionCharge, REALTIME_REQUESTS_PER_MINUTE,
  type RealtimeTransportType, type ReplicaCandidate,
} from './admission';
import { iceServersFor, type IceConfig, DEFAULT_STUN_URLS } from './ice';
import { reportExternalLoad } from './external-load';
import { echoTrace, makeEmitter, traceOf, type GatewayEmit, type RealtimeTelemetrySink } from './trace';
import {
  deriveRealtimeKey, encodeSessionConfig, peekClaims, signSessionToken, verifySessionToken,
  RT_MAX_CFG_CHARS, RT_MAX_TTL_SECONDS, type RealtimeClaims,
} from './token';

export type RealtimeController = Pick<DeploymentController, 'get' | 'tokenOf' | 'specOf' | 'wake'>;

export interface RealtimeServiceOptions {
  controller: RealtimeController | null;
  /** Deployment used when the config names none (`S2S_DEPLOYMENT`). */
  defaultDeployment?: string;
  /** The calling key's user (= app id), or null. */
  userOf: (req: IncomingMessage) => string | null;
  isAdmin: (userId: string) => boolean;
  /** Daily budget (AppLimits.chargeRequests); absent = no budget. */
  charge?: (userId: string, requests: number) => AppLimitDenial | null;
  ice?: IceConfig;
  /** Public base of this gateway (`REALTIME_PUBLIC_URL`, e.g. https://gw.example.com); else from the request. */
  publicUrl?: string;
  ttlSeconds?: number;
  requestsPerMinute?: number;
  /** How long an admitted, not yet connected session holds its slot. */
  reservationMs?: number;
  statusTtlMs?: number;
  statusTimeoutMs?: number;
  pollMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  /** Gateway telemetry events (trace.ts); default: the log. */
  telemetry?: RealtimeTelemetrySink;
}

export const REALTIME_DEFAULT_TTL_SECONDS = 600;
const MAX_SESSION_BODY = 256 * 1024;
const FALLBACK = { transport: 's2s-stream', url: '/v1/s2s' } as const;

export interface ResolvedSession {
  claims: RealtimeClaims;
  replicaToken: string;
  replicaId: string;
  base: string;
  /** The edge's own id for the session, learnt from the offer answer (defaults to `sid`). */
  edgeSessionId: string;
}

interface SessionRecord { dep: string; rep: string; app: string; exp: number; edgeSessionId?: string; pendingUntil?: number }

export function readJsonBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error(`body larger than ${limit} bytes`), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed = text ? JSON.parse(text) as unknown : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object');
        resolve(parsed as Record<string, unknown>);
      } catch (err) { reject(Object.assign(err as Error, { status: 400 })); }
    });
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | number> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

const errorBody = (message: string, code: string, extra: Record<string, unknown> = {}) => ({ error: { message, type: 'realtime_error', code }, ...extra });

export class RealtimeService {
  readonly status: EdgeStatusCache;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly now: () => number;
  private readonly log: (msg: string, data?: Record<string, unknown>) => void;
  private poller: ReturnType<typeof setInterval> | null = null;
  readonly emit: GatewayEmit;

  constructor(private readonly opts: RealtimeServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.emit = makeEmitter(opts.telemetry, this.log);
    this.status = new EdgeStatusCache({
      fetchImpl: opts.fetchImpl, now: this.now, ttlMs: opts.statusTtlMs, timeoutMs: opts.statusTimeoutMs,
    });
  }

  get ttlSeconds(): number {
    const t = this.opts.ttlSeconds ?? REALTIME_DEFAULT_TTL_SECONDS;
    return Math.max(60, Math.min(RT_MAX_TTL_SECONDS, Math.floor(t)));
  }

  private get reservationMs(): number { return this.opts.reservationMs ?? 20_000; }

  /** Admitted sessions not yet seen by the replica (pending) on one replica. */
  private pendingOn(replicaId: string): number {
    const now = this.now();
    let n = 0;
    for (const s of this.sessions.values()) if (s.rep === replicaId && s.pendingUntil && s.pendingUntil > now) n++;
    return n;
  }

  /** The replica now counts the session itself (it connected), or the session ended: stop reserving its slot. */
  settle(sid: string, edgeSessionId?: string): void {
    const s = this.sessions.get(sid);
    if (!s) return;
    s.pendingUntil = undefined;
    if (edgeSessionId) s.edgeSessionId = edgeSessionId;
    this.status.invalidate(s.rep);
  }

  forget(sid: string): void {
    const s = this.sessions.get(sid);
    if (s) this.status.invalidate(s.rep);
    this.sessions.delete(sid);
  }

  private publicBase(req: IncomingMessage): string {
    if (this.opts.publicUrl) return this.opts.publicUrl.replace(/\/+$/, '');
    const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();
    const proto = first(req.headers['x-forwarded-proto']) || ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
    const host = first(req.headers['x-forwarded-host']) || req.headers.host || 'localhost';
    return `${proto === 'https' ? 'https' : 'http'}://${host}`;
  }

  /** Ready replicas of a deployment with their base URL (secrets stay here). */
  private readyReplicas(dep: string): Array<{ id: string; base: string }> {
    const view = this.opts.controller?.get(dep);
    if (!view) return [];
    const exposed = !!this.opts.controller?.specOf(dep)?.exposure;
    return view.replicas
      .filter(r => r.phase === 'ready' && !r.draining && r.ip)
      .map(r => ({ id: r.id, base: replicaBase({ ip: r.ip } as never, exposed) }));
  }

  /** `POST /v1/realtime/sessions` (behind the proxy's API-key auth). */
  createSession = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const trace = traceOf(req);
    echoTrace(res, trace);
    const started = this.now();
    const userId = this.opts.userOf(req);
    if (!userId) return sendJson(res, 401, errorBody('a realtime session needs an app API key', 'unauthorized'));
    let body: Record<string, unknown>;
    try { body = await readJsonBody(req, MAX_SESSION_BODY); } catch (err) {
      return sendJson(res, (err as { status?: number }).status ?? 400, errorBody(`bad request: ${(err as Error).message}`, 'invalid_request'));
    }
    const config = body.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return sendJson(res, 400, errorBody('"config" (the /v1/s2s session config) must be an object', 'invalid_request'));
    }
    const ordered = orderTransports(body.transports, body.prefer);
    if ('error' in ordered) return sendJson(res, 400, errorBody(ordered.error, 'invalid_request'));

    const cfgIn = config as Record<string, unknown>;
    const dep = (typeof cfgIn.deployment === 'string' && cfgIn.deployment.trim()) || this.opts.defaultDeployment || '';
    const controller = this.opts.controller;
    const admin = this.opts.isAdmin(userId);
    const view = dep && controller ? controller.get(dep) : null;
    // Same rule as invoke: an app key only reaches its own app's deployments (and does not learn whether others exist).
    if (!admin && (!view || view.app !== userId)) {
      return sendJson(res, 403, errorBody(`this API key cannot open realtime sessions on deployment '${dep || '(none)'}'`, 'forbidden'));
    }
    if (!controller || !view) {
      return sendJson(res, 404, errorBody(`deployment '${dep || '(none)'}' not found`, 'not_found', { fallback: FALLBACK }));
    }
    const app = view.app ?? userId;
    const sessionConfig = { ...cfgIn, deployment: dep };
    const cfg = encodeSessionConfig(sessionConfig);
    if (cfg.length > RT_MAX_CFG_CHARS) {
      return sendJson(res, 413, errorBody(
        `session config is ${cfg.length} base64url characters, over ${RT_MAX_CFG_CHARS}: send the long history with config_update once connected`,
        'config_too_large'));
    }

    const placed = await this.place(dep, ordered.order);
    if ('refusal' in placed) {
      const { status, code, message, retryAfter } = placed.refusal;
      this.emit(trace, 'rt.session.rejected', { level: 'warn', durMs: this.now() - started, attrs: { reason: code, status, deployment: dep } });
      return sendJson(res, status, errorBody(message, code, { fallback: FALLBACK }), { 'Retry-After': retryAfter });
    }
    const replicaToken = controller.tokenOf(dep);
    if (!replicaToken) return sendJson(res, 503, errorBody('deployment has no replica token', 'cold', { fallback: FALLBACK }), { 'Retry-After': 5 });

    const ttl = this.ttlSeconds;
    const charge = sessionCharge(ttl, this.opts.requestsPerMinute ?? REALTIME_REQUESTS_PER_MINUTE);
    const denial = admin ? null : this.opts.charge?.(userId, charge) ?? null;
    if (denial) {
      this.emit(trace, 'rt.session.rejected', { level: 'warn', durMs: this.now() - started, attrs: { reason: denial.type, status: denial.status, deployment: dep } });
      return sendJson(res, denial.status, errorBody(denial.message, denial.type), denial.retryAfterSeconds ? { 'Retry-After': denial.retryAfterSeconds } : {});
    }

    const sid = `rt_${randomUUID().replace(/-/g, '')}`;
    const iat = Math.floor(this.now() / 1000);
    const exp = iat + ttl;
    const token = signSessionToken({ sid, app, dep, rep: placed.replica.id, cfg, iat, exp }, deriveRealtimeKey(replicaToken));
    this.sessions.set(sid, { dep, rep: placed.replica.id, app, exp: exp * 1000, pendingUntil: this.now() + this.reservationMs });
    this.ensurePolling();

    const base = this.publicBase(req);
    const wsBase = base.replace(/^http/, 'ws');
    const ice = this.opts.ice ?? { stun: [...DEFAULT_STUN_URLS], turn: [], turnSecret: null };
    const iceServers = iceServersFor(ice, sid, exp);
    const transports = ordered.order
      .filter(t => !isEdgeTransport(t) || placed.replica.status.transports.includes(t))
      .map((t: RealtimeTransportType) => {
        if (t === 'webrtc') return { type: t, offerUrl: `${base}/v1/realtime/sessions/${sid}/offer`, iceUrl: `${base}/v1/realtime/sessions/${sid}/ice`, iceServers };
        if (t === 'ws') return { type: t, url: `${wsBase}/v1/realtime/ws?token=${token}` };
        if (t === 's2s-stream') return { type: t, url: '/v1/s2s' };
        return { type: t };
      });
    this.log('realtime: session admitted', { sid, app, deployment: dep, replica: placed.replica.id, charge, transports: transports.map(t => t.type), traceId: trace.traceId });
    this.emit(trace, 'rt.session.admitted', {
      sessionId: sid, durMs: this.now() - started,
      attrs: { deployment: dep, replica: placed.replica.id, active: placed.replica.status.active, max: placed.replica.status.max, pending: placed.replica.pending + 1, turn: iceServers.length > 1 },
    });
    sendJson(res, 200, {
      sessionId: sid, token, expiresAt: new Date(exp * 1000).toISOString(), deployment: dep, traceId: trace.traceId,
      telemetryUrl: `${base}/v1/telemetry/events`,
      transports, iceServers,
      limits: {
        maxSessionSeconds: ttl, maxConfigChars: RT_MAX_CFG_CHARS, requestsCharged: admin ? 0 : charge,
        replica: { active: placed.replica.status.active, max: placed.replica.status.max, pending: placed.replica.pending + 1 },
      },
    });
  };

  /** A ready replica with a free slot, or why none (and the deployment woken when it was cold). */
  private async place(dep: string, order: RealtimeTransportType[]): Promise<{ replica: ReplicaCandidate }
    | { refusal: { status: number; code: string; message: string; retryAfter: number } }> {
    const controller = this.opts.controller!;
    if (controller.get(dep)?.spec.paused) return { refusal: { status: 503, code: 'paused', message: `deployment '${dep}' is paused`, retryAfter: 60 } };
    const ready = this.readyReplicas(dep);
    if (!ready.length) {
      if (noWakeActive()) recordNoWakeSkip();
      else { try { controller.wake(dep); } catch { /* vanished */ } }
      return { refusal: { status: 503, code: 'cold', message: `deployment '${dep}': no ready replica${noWakeActive() ? ' (no-wake: not woken)' : ' (waking)'}`, retryAfter: 30 } };
    }
    const token = controller.tokenOf(dep) ?? '';
    const results: Array<{ r: { id: string; base: string }; s: EdgeStatusResult }> = await Promise.all(
      ready.map(async r => ({ r, s: await this.status.get(r.id, r.base, token) })));
    const candidates: ReplicaCandidate[] = [];
    for (const { r, s } of results) {
      if (!s.ok) continue;
      reportExternalLoad(dep, r.id, s.status.active, s.status.max, this.now());
      candidates.push({ id: r.id, base: r.base, status: s.status, pending: this.pendingOn(r.id) });
    }
    const replica = pickReplica(candidates, order);
    if (replica) return { replica };
    if (!candidates.length) {
      const unsupported = results.every(x => !x.s.ok && x.s.reason === 'unsupported');
      return { refusal: unsupported
        ? { status: 503, code: 'unsupported', message: `deployment '${dep}': its replicas run no realtime edge`, retryAfter: 60 }
        : { status: 503, code: 'unreachable', message: `deployment '${dep}': realtime status unreachable`, retryAfter: 5 } };
    }
    // Ready but full: tell the autoscaler (wake keeps the idle clock fresh; the pressure comes from the load report).
    if (!noWakeActive()) { try { controller.wake(dep); } catch { /* vanished */ } }
    return { refusal: { status: 503, code: 'saturated', message: `deployment '${dep}': every replica's realtime slots are taken`, retryAfter: 2 } };
  }

  /** Verifies a session token against its deployment's key and finds its replica. */
  resolveToken(token: string): ResolvedSession | { status: number; code: string; message: string } {
    const peek = peekClaims(token);
    if (!peek) return { status: 401, code: 'invalid_token', message: 'malformed realtime session token' };
    const replicaToken = this.opts.controller?.tokenOf(peek.dep) ?? null;
    if (!replicaToken) return { status: 401, code: 'invalid_token', message: 'unknown deployment in session token' };
    const verdict = verifySessionToken(token, deriveRealtimeKey(replicaToken), Math.floor(this.now() / 1000));
    if ('error' in verdict) return { status: 401, code: verdict.error === 'expired' ? 'token_expired' : 'invalid_token', message: `session token refused: ${verdict.error}` };
    const { claims } = verdict;
    const exposed = !!this.opts.controller?.specOf(claims.dep)?.exposure;
    const replica = this.opts.controller?.get(claims.dep)?.replicas.find(r => r.id === claims.rep && r.ip);
    if (!replica) return { status: 410, code: 'replica_gone', message: 'the replica of this session is gone: open a new session' };
    return {
      claims, replicaToken, replicaId: replica.id, base: replicaBase({ ip: replica.ip } as never, exposed),
      edgeSessionId: this.sessions.get(claims.sid)?.edgeSessionId ?? claims.sid,
    };
  }

  private ensurePolling(): void {
    if (this.poller || !(this.opts.pollMs ?? 5_000)) return;
    this.poller = setInterval(() => { void this.pollOnce().catch(() => {}); }, this.opts.pollMs ?? 5_000);
    this.poller.unref?.();
  }

  /**
   * Refreshes the status of every replica that may hold sessions, reports their load (external-load.ts) and keeps a
   * deployment with active sessions awake (WebRTC audio bypasses the gateway, so its idle clock would not move).
   */
  async pollOnce(): Promise<void> {
    const now = this.now();
    const deps = new Set<string>();
    for (const [sid, s] of this.sessions) {
      if (s.exp <= now) { this.sessions.delete(sid); continue; }
      deps.add(s.dep);
    }
    if (!deps.size && this.poller) { clearInterval(this.poller); this.poller = null; return; }
    for (const dep of deps) {
      const token = this.opts.controller?.tokenOf(dep);
      if (!token) continue;
      let active = 0;
      for (const r of this.readyReplicas(dep)) {
        const s = await this.status.get(r.id, r.base, token, { fresh: true });
        if (!s.ok) continue;
        reportExternalLoad(dep, r.id, s.status.active, s.status.max, this.now());
        active += s.status.active;
      }
      if (active > 0) { try { this.opts.controller?.wake(dep); } catch { /* vanished */ } }
    }
  }

  stop(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }
}
