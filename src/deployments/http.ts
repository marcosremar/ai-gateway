/**
 * HTTP surface of deployments, mounted as a prefix route on the proxy (`serve.ts`):
 *
 *   GET    /v1/deployments                     list
 *   PUT    /v1/deployments/:name               create or update (merge) — body: spec fields and/or { profile }
 *   PATCH  /v1/deployments/:name               update an existing one (e.g. { minReplicas, maxReplicas })
 *   GET    /v1/deployments/:name               status + replicas
 *   DELETE /v1/deployments/:name               release every replica and forget the spec
 *   GET    /v1/deployments/:name/capacity      session ceiling and measured boot / resume times per machine type
 *   POST   /v1/deployments/:name/wake          start replicas now (pre-warm before traffic)
 *   POST   /v1/deployments/:name/park          done for now: scale to minReplicas at once (power off under idleAction stop)
 *   *      /v1/deployments/:name/invoke/<path> forwarded to a ready replica as /<path> (waits through cold start)
 *   GET    /v1/profiles                        list profiles (built-in + stored)
 *   PUT    /v1/profiles/:name                  create or replace a profile
 *   DELETE /v1/profiles/:name                  delete a stored profile
 *   GET    /v1/apps/:app/fallback              direct-fallback plan with provider keys (app-fallback.ts); the app's
 *                                              own key, or an admin key with `X-App: <app>`
 *   POST   /v1/apps/:app/stability-report      instability events buffered by the SDK while the gateway was down
 *                                              (stability.ts); same callers as the app's other paths
 *   GET    /v1/apps/:app/stability-report      recent reports (`?limit=`, default 50 batches)
 *
 * Auth already happened in the proxy (Bearer from GATEWAY_API_KEYS). Mutations additionally need `isAdmin(req)`.
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import type { Socket } from 'net';
import { DeploymentController, DeploymentError } from './controller';
import { PROBE_PORT, SpecError } from './spec';
import { AppError, APP_ID_RE, type AppRegistry } from './apps';
import type { AppFallbackService } from './app-fallback';
import type { ClientStabilityLog } from './stability';
import type { DeploymentSpec, ProbeResult, ReplicaMachine, ReplicaProbe } from './types';
import { createLogger } from '../logger';

const log = createLogger('deployments-http');
import { noWakeActive, recordNoWakeSkip } from '../gateway/proxy/no-wake';
import { requestIdOf } from '../gateway/proxy/http-conventions';
import { outgoingTraceHeaders } from '../telemetry/trace-context';
import { noteStreamCut, type StreamCut } from '../telemetry/stream-cuts';

const MAX_INVOKE_BODY = 100 * 1024 * 1024;
/** Specs may carry a boot script and its files (up to 8 MB of base64). */
const MAX_ADMIN_BODY = 16 * 1024 * 1024;
const INVOKE_TIMEOUT_MS = 15 * 60_000;
export const INVOKE_IDLE_MS = 5 * 60_000;
/** CDP bootstrap sessions default/max TTL (the gateway keeps the machine's lease while the session is alive). */
const CDP_DEFAULT_TTL_MS = 5 * 60_000;
const CDP_MAX_TTL_MS = 15 * 60_000;
const HTTP_REASON: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 502: 'Bad Gateway', 503: 'Service Unavailable' };
const statusText = (status: number) => HTTP_REASON[status] ?? 'Error';
const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'authorization', 'content-length', 'x-aigw-token', 'x-aigw-wait', 'x-gateway-no-wake', 'x-forwarded-for', 'x-forwarded-host',
  'x-forwarded-proto', 'x-real-ip', 'cookie',
]);

/**
 * Stage values a health body may report while a model is still coming up. A replica that answers 200 with
 * `{"stt": "downloading"}` is not ready: the first real request would fail instead of waiting.
 */
const NOT_READY_STAGE = /^(down|off|pending|starting|booting|loading|downloading|warming|failed|error|not_ready)$/i;

function stageReady(value: unknown): boolean {
  if (value === undefined || value === null) return true; // the app does not report this stage at all
  if (typeof value === 'string') return !NOT_READY_STAGE.test(value);
  if (value === false) return false;
  if (typeof value === 'object') {
    const stage = value as { ready?: unknown; ok?: unknown; status?: unknown; state?: unknown };
    if (stage.ready === false || stage.ok === false) return false;
    if (typeof stage.status === 'string' && NOT_READY_STAGE.test(stage.status)) return false;
    if (typeof stage.state === 'string' && NOT_READY_STAGE.test(stage.state)) return false;
  }
  return true;
}

/**
 * Interprets a health endpoint's JSON body. `null`/non-JSON keeps the old contract (HTTP 200 = ready). Structured
 * bodies are checked: a top-level `ok`/`ready` false, or a known pipeline stage (`stt`, `llm`, `tts`) reporting a
 * not-ready status, means the replica is warming — even when it answers 200.
 */
export function healthBodyReady(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return true;
  const top = body as { ok?: unknown; ready?: unknown };
  if (top.ok === false || top.ready === false) return false;
  return ['stt', 'llm', 'tts'].every(stage => stageReady((body as Record<string, unknown>)[stage]));
}

/**
 * Probe over the replica's nginx front: boot finished (`/__aigw/ready`, liveness — nginx answers it even while the app
 * is saturated) AND the app still answers its health path (readiness). `timeoutMs` per call: DEPLOYMENTS_PROBE_TIMEOUT_MS.
 */
export class HttpReplicaProbe implements ReplicaProbe {
  constructor(private readonly timeoutMs = 4_000, private readonly fetchImpl: typeof fetch = fetch) {}

  async ready(machine: ReplicaMachine, spec: DeploymentSpec, token: string): Promise<boolean> {
    return (await this.check(machine, spec, token)) === 'ready';
  }

  async check(machine: ReplicaMachine, spec: DeploymentSpec, token: string): Promise<ProbeResult> {
    if (!machine.ip) return 'down';
    const headers = { 'X-Aigw-Token': token };
    const get = (path: string) => this.fetchImpl(`${replicaBase(machine, !!spec.exposure)}${path}`, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    const marker = await get('/__aigw/ready').catch(() => null);
    if (!marker?.ok) return 'down';
    const health = await get(spec.healthPath).catch(() => null);
    if (!health?.ok) return 'busy';
    return healthBodyReady(await health.json().catch(() => null)) ? 'ready' : 'busy';
  }
}

/** `ip` may carry a port (local tests); real replicas listen on :80, exposed ones on `PROBE_PORT`. */
export function replicaBase(machine: ReplicaMachine, exposed = false): string {
  return exposed && machine.ip && !machine.ip.includes(':') ? `http://${machine.ip}:${PROBE_PORT}` : `http://${machine.ip}`;
}

/**
 * The URL an `invoke` forwards to: the replica's own base plus the caller's path. The host comes only from our machine
 * list; the caller's part must stay a plain path on it — no scheme, no `//` authority, no backslash, no `.`/`..`
 * segment (raw or percent-encoded) — and the resolved URL must keep the base's origin (CodeQL js/request-forgery,
 * PR #45). Null = refused (400).
 */
/**
 * The forwarded path/query re-spelled byte by byte from a fixed table (CodeQL js/request-forgery: the string sent is
 * built from our constants, not from the request): URL characters stay as they are, any other byte is percent-encoded.
 */
const URL_SAFE = new Set([...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~!$&\'()*+,;=:@%/?']);
const BYTE_SPELLING: string[] = Array.from({ length: 256 }, (_, b) => {
  const c = String.fromCharCode(b);
  return b < 128 && URL_SAFE.has(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
});

function respell(v: string): string {
  let out = '';
  for (const byte of Buffer.from(v, 'utf8')) out += BYTE_SPELLING[byte];
  return out;
}

export function replicaTarget(base: string, rest: string, query: string): URL | null {
  if (/[\\\s]/.test(rest) || rest.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(rest)) return null;
  for (const segment of rest.split('/')) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { return null; }
    if (decoded === '.' || decoded === '..' || /[\\/]/.test(decoded)) return null;
  }
  if (query && !query.startsWith('?')) return null;
  const path = respell(`/${rest}${query}`);
  let url: URL;
  try { url = new URL(path, base); } catch { return null; }
  const origin = new URL(base).origin;
  return url.origin === origin && url.pathname.startsWith('/') ? url : null;
}

/**
 * Invoke path with an optional seat prefix `/c/<n>/…`: the nginx maps each seat to its own app port on the same
 * host (`nginxConfig`), so the target keeps the prefix and the seat count bounds it. Without the prefix, plain.
 */
export function seatInvokeTarget(base: string, rest: string, query: string, seats: number): URL | null {
  const match = /^c\/([0-9]+)(?:\/(.*))?$/.exec(rest);
  if (!match) return replicaTarget(base, rest, query);
  const index = Number(match[1]);
  if (!Number.isInteger(index) || index < 0 || index >= seats) return null;
  // replicaTarget builds the path with a leading slash (it cannot keep a base path), so validate the seat's own
  // rest first and then place it under the /c/<n>/ prefix.
  const plain = replicaTarget(base, match[2] ?? '', query);
  if (!plain) return null;
  return new URL(`${base}/c/${index}${plain.pathname}${plain.search}`);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | number> = {}): void {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new DeploymentError(413, `body larger than ${Math.round(limit / 1024 / 1024)} MB`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, MAX_ADMIN_BODY);
  if (!raw.length) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new SpecError('body must be JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SpecError('body must be a JSON object');
  return parsed as Record<string, unknown>;
}

export interface DeploymentRoutesOptions {
  controller: DeploymentController;
  /** App accounts (apps.ts). Without it /v1/apps answers 404 and `appImage` is refused. */
  apps?: AppRegistry;
  /** The calling key's user id (the app it belongs to). */
  userOf?: (req: IncomingMessage) => string | null;
  /** Mutations (PUT/PATCH/DELETE/wake, profiles) require this. Default: nobody (fail closed). */
  isAdmin?: (req: IncomingMessage) => boolean;
  fetchImpl?: typeof fetch;
  invokeIdleMs?: number;
  /** Silence on a relayed WebSocket after which the lease is released (`RELAY_IDLE_TIMEOUT_MS`, default 5 min). */
  relayIdleMs?: number;
  /** Status of the declared deployments (`declared.ts`), listed as `declared` by `GET /v1/deployments`. */
  declaredStatus?: () => unknown;
  /** An app replaced its routes (`PUT /v1/apps/:app/routes`): re-mount the providers. */
  onRoutesChange?: () => void;
  /** Direct-fallback plans (`GET /v1/apps/:app/fallback`). Without it that path answers 404. */
  fallback?: AppFallbackService;
  /** SDK instability reports (`/v1/apps/:app/stability-report`). Without it those paths answer 404. */
  stability?: ClientStabilityLog;
}

export function createDeploymentRoutes(opts: DeploymentRoutesOptions) {
  const { controller } = opts;
  const isAdmin = opts.isAdmin ?? (() => false);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const idleMs = opts.invokeIdleMs ?? (Number(process.env.INVOKE_IDLE_TIMEOUT_MS) || INVOKE_IDLE_MS);
  const relayIdleMs = opts.relayIdleMs ?? (Number(process.env.RELAY_IDLE_TIMEOUT_MS) || 5 * 60_000);

  /** CDP bootstrap sessions (`/v1/deployments/:name/cdp`): the client talks to the replica DIRECTLY with the lease
   * token, and the gateway keeps the lease alive only while the session is renewed (`POST …/cdp/keepalive`) or
   * until the TTL. In-memory: a gateway restart leaves the lease to the controller's own recovery. */
  const cdpSessions = new Map<string, { deadline: number; release: () => void }>();
  const cdpTtlMs = (req: IncomingMessage) => Math.min(
    Math.max(parseInt(String(req.headers['x-cdp-ttl'] ?? ''), 10) * 1000 || CDP_DEFAULT_TTL_MS, 60_000),
    CDP_MAX_TTL_MS,
  );
  const cdpSweeper = (() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    return () => {
      if (timer) return;
      timer = setInterval(() => {
        const now = Date.now();
        for (const [id, session] of cdpSessions) {
          if (session.deadline < now) {
            cdpSessions.delete(id);
            try { session.release(); console.log(`[cdp] sessão ${id.slice(0, 8)} expirada, lease liberada`); }
            catch (err) { console.error(`[cdp] release da sessão ${id.slice(0, 8)} FALHOU:`, String(err)); }
          }
        }
      }, 30_000);
      timer.unref?.();
    };
  })();

  /** The client can talk to the replica DIRECTLY (`base` + token, no gateway hop for the frames). */
  async function cdpBootstrap(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const waitHeader = req.headers['x-aigw-wait'];
    const waitMs = typeof waitHeader === 'string' && /^\d+$/.test(waitHeader) ? Math.min(Number(waitHeader), 840) * 1000 : undefined;
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    let lease: Awaited<ReturnType<DeploymentController['acquire']>>;
    try {
      lease = await controller.acquire(name, { waitMs, signal: abort.signal });
    } catch (err) {
      const status = err instanceof DeploymentError ? err.status : 502;
      return send(res, status, { error: err instanceof Error ? err.message : String(err), ...(status === 503 ? { status: 'warming' } : {}) },
        err instanceof DeploymentError && err.retryAfterSeconds ? { 'Retry-After': err.retryAfterSeconds } : {});
    }
    const base = replicaBase(lease.machine, lease.exposed);
    let wsPath: string | null = null;
    try {
      const version = await fetchImpl(`${base}/json/version`, {
        headers: { 'X-Aigw-Token': lease.token }, signal: AbortSignal.timeout(10_000),
      });
      if (version.ok) {
        const body = await version.json().catch(() => null) as { webSocketDebuggerUrl?: string } | null;
        if (body?.webSocketDebuggerUrl) wsPath = new URL(body.webSocketDebuggerUrl).pathname;
      }
    } catch { /* the client discovers /json/version itself on `base` */ }
    const sessionId = randomUUID();
    const ttlMs = cdpTtlMs(req);
    let released = false;
    const release = () => { if (!released) { released = true; lease.done(false); } };
    cdpSessions.set(sessionId, { deadline: Date.now() + ttlMs, release });
    cdpSweeper();
    return send(res, 200, {
      sessionId, base, wsBase: base.replace(/^http/, 'ws'), token: lease.token,
      ...(wsPath ? { wsPath } : {}),
      expiresInSeconds: Math.floor(ttlMs / 1000),
    });
  }

  async function cdpKeepalive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req).catch(() => null) as { sessionId?: string } | null;
    const session = typeof body?.sessionId === 'string' ? cdpSessions.get(body.sessionId) : undefined;
    if (!session) return send(res, 404, { error: 'cdp session not found or expired' });
    const ttlMs = cdpTtlMs(req);
    session.deadline = Date.now() + ttlMs;
    return send(res, 200, { expiresInSeconds: Math.floor(ttlMs / 1000) });
  }

  /**
   * The app this request acts for: `X-App` from an admin key, else the key's own user; null = admin acting globally.
   * A non-admin key may send `X-App` naming its own app (the SDK's `GatewayClient({ app })` always does; it used to be
   * a 403) — never another one. The same rule applies to any other app-scoped route (e.g. a machines API).
   */
  function appOf(req: IncomingMessage): string | null {
    const header = req.headers['x-app'];
    const user = opts.userOf?.(req) ?? null;
    const own = user && APP_ID_RE.test(user) ? user : null;
    if (typeof header === 'string' && header.trim()) {
      if (!isAdmin(req) && header.trim() !== own) throw new DeploymentError(403, 'only an admin key may act for another app (X-App)');
      if (!APP_ID_RE.test(header.trim())) throw new DeploymentError(400, `X-App must match ${APP_ID_RE}`);
      return header.trim();
    }
    if (isAdmin(req)) return null;
    return own;
  }

  /** Admin, or the app named in the path is the caller's own. */
  function mayUseApp(req: IncomingMessage, app: string): boolean {
    return isAdmin(req) || appOf(req) === app;
  }

  async function appRoutes(req: IncomingMessage, res: ServerResponse, parts: string[], method: string): Promise<void> {
    const registry = opts.apps;
    if (!registry) return send(res, 404, { error: 'app accounts are not enabled on this gateway' });
    const [, , app, sub, imageName, extra] = parts; // ['v1', 'apps', app?, 'images'?, name?]
    if (!app) {
      if (method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      const own = appOf(req);
      if (isAdmin(req) && !own) return send(res, 200, { apps: registry.list() });
      return send(res, 200, { apps: registry.list().filter(a => a.id === own) });
    }
    if (!mayUseApp(req, app)) return send(res, 403, { error: `this key cannot use app '${app}'` });
    if (!sub) {
      if (method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      const account = registry.get(app);
      const deployments = controller.list().filter(d => d.app === app).map(d => ({ name: d.name, status: d.status, appImage: d.appImage }));
      return send(res, 200, { id: app, createdAt: account?.createdAt ?? null, images: Object.values(account?.images ?? {}), deployments });
    }
    if (sub === 'routes' && !imageName) {
      if (method === 'GET') return send(res, 200, { app, routes: registry.get(app)?.routes ?? {} });
      if (method !== 'PUT') return send(res, 405, { error: 'method not allowed' });
      // An admin sets any route; the app's own key only reorders/re-aliases what it already has, plus its own deployments.
      const routes = await registry.putRoutes(app, await readJson(req), isAdmin(req) ? {}
        : { restrictedTo: (deployment) => controller.get(deployment)?.app === app });
      opts.onRoutesChange?.();
      return send(res, 200, { app, routes });
    }
    if (sub === 'fallback' && !imageName) {
      if (method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      // Stricter than the other app paths: the plan carries provider keys, so it goes to the app's own key, or to an
      // admin key that names the app (X-App) — never to an admin acting globally.
      if (appOf(req) !== app) return send(res, 403, { error: `the fallback plan of '${app}' needs its app key (or an admin key with X-App: ${app})` });
      if (!opts.fallback) return send(res, 404, { error: 'direct fallback is not enabled on this gateway' });
      const plan = await opts.fallback.plan(app, registry.get(app)?.routes);
      return send(res, 200, plan, { 'Cache-Control': 'no-store' });
    }
    if (sub === 'stability-report' && !imageName) {
      if (!opts.stability) return send(res, 404, { error: 'stability reports are not enabled on this gateway' });
      if (method === 'POST') {
        const accepted = opts.stability.append(app, await readJson(req));
        return send(res, 200, { ok: true, accepted });
      }
      if (method === 'GET') {
        const raw = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('limit');
        const limit = raw && /^\d+$/.test(raw) ? Number(raw) : 50;
        return send(res, 200, { app, reports: opts.stability.recent(app, limit) });
      }
      return send(res, 405, { error: 'method not allowed' });
    }
    if (sub !== 'images' || extra) return send(res, 404, { error: `unknown path '/${parts.join('/')}'` });
    if (!imageName) {
      if (method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      return send(res, 200, { app, images: Object.values(registry.get(app)?.images ?? {}) });
    }
    if (method === 'GET') {
      const image = registry.image(app, imageName);
      return image ? send(res, 200, image) : send(res, 404, { error: `app '${app}' has no image '${imageName}'` });
    }
    if (method === 'PUT') {
      const { image, created } = await registry.putImage(app, imageName, await readJson(req));
      return send(res, created ? 201 : 200, image);
    }
    if (method === 'DELETE') {
      return (await registry.deleteImage(app, imageName)) ? send(res, 200, { deleted: imageName })
        : send(res, 404, { error: `app '${app}' has no image '${imageName}'` });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  async function invoke(req: IncomingMessage, res: ServerResponse, name: string, rest: string, query: string, method: string) {
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req, MAX_INVOKE_BODY);
    const waitHeader = req.headers['x-aigw-wait'];
    const waitMs = typeof waitHeader === 'string' && /^\d+$/.test(waitHeader) ? Math.min(Number(waitHeader), 840) * 1000 : undefined;
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k) && typeof v === 'string') headers[k] = v;
    }
    if (!replicaTarget('http://replica.invalid', rest, query)) return send(res, 400, { error: 'invoke path must be a plain relative path (no scheme, //, backslash or ./.. segments)' });
    const exclude = new Set<string>();
    // No-wake mode (gateway/proxy/no-wake.ts): a ready replica serves; none ready = 503 at once, nothing woken.
    const noWake = noWakeActive();
    for (let attempt = 0; attempt < 2; attempt++) {
      let lease;
      try {
        lease = await controller.acquire(name, noWake ? { waitMs: 0, exclude, signal: abort.signal, noWake: true } : { waitMs, exclude, signal: abort.signal });
      } catch (err) {
        if (!(noWake && err instanceof DeploymentError && err.status === 503)) throw err;
        recordNoWakeSkip();
        return send(res, 503, { error: err.message, status: 'cold', code: 'cold', noWake: true }, { 'Retry-After': err.retryAfterSeconds ?? 30 });
      }
      const target = seatInvokeTarget(replicaBase(lease.machine, lease.exposed), rest, query, controller.get(name)?.spec?.seats ?? 1);
      if (!target) { lease.done('cancelled'); return send(res, 400, { error: 'invoke path does not resolve on the replica' }); }
      let upstream: Response;
      try {
        upstream = await fetchImpl(target.href, {
          method,
          headers: { ...headers, ...outgoingTraceHeaders(), 'X-Aigw-Token': lease.token },
          body: body && body.length ? new Uint8Array(body) : undefined,
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(INVOKE_TIMEOUT_MS)]),
        });
      } catch (err) {
        // The client going away says nothing about the replica, and running out of time means busy: neither is a strike
        // (only a connection failure is; QA 2026-10-07).
        const timedOut = err instanceof Error && err.name === 'TimeoutError';
        lease.done(abort.signal.aborted ? 'cancelled' : timedOut ? 'timeout' : true);
        if (abort.signal.aborted) return;
        if ((controller.get(name)?.replicas.length ?? 0) > 1) exclude.add(lease.machine.id);
        if (attempt === 1) {
          log.warn({ deployment: name, error: err instanceof Error ? err.message : String(err) }, 'invoke: replica unreachable');
          throw new DeploymentError(502, 'replica unreachable');
        }
        continue;
      }
      try {
        const out: Record<string, string> = { 'X-Aigw-Replica': lease.machine.id };
        upstream.headers.forEach((v, k) => {
          // fetch already decoded the body, so its encoding/length headers no longer apply.
          if (!HOP_BY_HOP.has(k) && k !== 'content-encoding') out[k] = v;
        });
        res.writeHead(upstream.status, out);
        const cut = upstream.body && method !== 'HEAD' ? await relay(upstream.body, res) : null;
        if (!cut || abort.signal.aborted) {
          res.end();
        } else {
          res.destroy();
          lease.done(cut === 'stalled' ? 'timeout' : true);
          noteStreamCut({ deployment: name, replica: lease.machine.id, stage: 'invoke' }, cut, rest);
          log.warn({ deployment: name, replica: lease.machine.id, path: rest, cut }, 'invoke: replica stream cut after the response started');
        }
      } finally {
        lease.done(false);
      }
      return;
    }
  }

  /**
   * WebSocket rung of `invoke`: the client's upgrade goes to a ready replica with the lease token, and the raw
   * sockets are piped both ways — frames pass untouched (CDP, SSE-upgraded streams). The replica's nginx does the
   * handshake against the caller's own `Sec-WebSocket-Key`; an upstream refusal answers with a plain HTTP error.
   */
  async function upgradeInvoke(
    req: IncomingMessage, socket: Socket, _head: Buffer, name: string, rest: string, query: string,
  ): Promise<boolean> {
    if (!isAdmin(req)) {
      const own = appOf(req);
      if (!own || controller.get(name)?.app !== own) { socketError(socket, 403, `this API key cannot invoke deployment '${name}'`); return true; }
    }
    if (!replicaTarget('http://replica.invalid', rest, query)) { socketError(socket, 400, 'invoke path must be a plain relative path'); return true; }
    req.socket?.setTimeout(0);
    const waitHeader = req.headers['x-aigw-wait'];
    const waitMs = typeof waitHeader === 'string' && /^\d+$/.test(waitHeader) ? Math.min(Number(waitHeader), 840) * 1000 : undefined;
    const abort = new AbortController();
    let upgraded = false;
    let released = false;
    let lease: Awaited<ReturnType<DeploymentController['acquire']>> | null = null;
    const release = (reason?: Parameters<NonNullable<Awaited<ReturnType<DeploymentController['acquire']>>['done']>>[0]) => {
      if (lease && !released) { released = true; lease.done(reason ?? false); }
    };
    socket.on('close', () => release());
    try {
      lease = await controller.acquire(name, { waitMs, signal: abort.signal });
    } catch (err) {
      const status = err instanceof DeploymentError ? err.status : 502;
      socketError(socket, status, err instanceof Error ? err.message : String(err));
      return true;
    }
    const target = seatInvokeTarget(replicaBase(lease.machine, lease.exposed), rest, query, controller.get(name)?.spec?.seats ?? 1);
    if (!target) { release('cancelled'); socketError(socket, 400, 'invoke path does not resolve on the replica'); return true; }
    const headers: Record<string, string> = { host: target.host, 'x-aigw-token': lease.token };
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string' && k !== 'host' && k !== 'x-aigw-token') headers[k] = v;
    }
    const proxyReq = httpRequest(target, { method: 'GET', headers, signal: abort.signal });
    proxyReq.on('upgrade', (upstreamRes: IncomingMessage, proxySocket: Socket, proxyHead: Buffer) => {
      upgraded = true;
      const out = ['HTTP/1.1 101 Switching Protocols'];
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (typeof v === 'string') out.push(`${k}: ${v}`);
        else if (Array.isArray(v)) for (const item of v) out.push(`${k}: ${item}`);
      }
      socket.write(out.join('\r\n') + '\r\n\r\n');
      if (proxyHead.length) socket.write(proxyHead);
      proxySocket.on('error', () => socket.destroy());
      socket.on('error', () => proxySocket.destroy());
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
      // Backpressure is native to pipe(); the gap this closes is the LEAK: a client that stops talking holds the
      // machine's lease until nginx's 900 s read timeout. Cut at `relayIdleMs` of silence and release.
      let lastActivity = Date.now();
      const touch = () => { lastActivity = Date.now(); };
      socket.on('data', touch);
      proxySocket.on('data', touch);
      const idle = setInterval(() => {
        if (Date.now() - lastActivity > relayIdleMs) {
          clearInterval(idle);
          // Cut the CLIENT abruptly (it stopped talking); end the UPSTREAM gently so the replica's socket closes
          // cleanly instead of hanging on a half-open RST.
          socket.destroy();
          proxySocket.end();
          release();
        }
      }, Math.min(30_000, Math.max(1_000, Math.floor(relayIdleMs / 2))));
      idle.unref?.();
      socket.on('close', () => { clearInterval(idle); proxySocket.destroy(); });
      proxySocket.on('close', () => { clearInterval(idle); socket.destroy(); });
    });
    proxyReq.on('error', () => {
      if (!upgraded) { release(true); socketError(socket, 502, 'replica unreachable'); }
    });
    proxyReq.end();
    return true;
  }

  async function relay(body: ReadableStream<Uint8Array>, res: ServerResponse): Promise<StreamCut | null> {
    const reader = body.getReader();
    try {
      for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<'stalled'>((resolve) => { timer = setTimeout(() => resolve('stalled'), idleMs); });
        const next = await Promise.race([reader.read().catch(() => 'truncated' as const), idle]).finally(() => clearTimeout(timer));
        if (typeof next === 'string') return next;
        if (next.done) return null;
        if (!res.write(next.value)) await new Promise<void>((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
        if (res.destroyed) return null;
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<void> {
    const query = (req.url ?? '').includes('?') ? (req.url ?? '').slice((req.url ?? '').indexOf('?')) : '';
    const parts = path.split('/').filter(Boolean); // ['v1', 'deployments' | 'profiles', name?, action?, ...]
    const [, kind, name, action] = parts;
    const admin = () => {
      if (!isAdmin(req)) throw new DeploymentError(403, 'this API key cannot manage deployments');
    };
    if (kind === 'apps') return appRoutes(req, res, parts, method);

    if (kind === 'profiles') {
      if (!name && method === 'GET') return send(res, 200, { profiles: controller.listProfiles() });
      if (name && !action && method === 'PUT') { admin(); return send(res, 200, await controller.putProfile(name, await readJson(req))); }
      if (name && !action && method === 'DELETE') {
        admin();
        return (await controller.deleteProfile(name)) ? send(res, 200, { deleted: name })
          : send(res, 404, { error: `profile '${name}' not found or built-in` });
      }
      return send(res, 405, { error: 'method not allowed' });
    }

    if (!name) {
      if (method === 'GET') {
        const own = appOf(req);
        const filter = own ?? new URLSearchParams(query.slice(1)).get('app');
        const deployments = controller.list().filter(d => !filter || d.app === filter);
        // Declared deployments are the operator's (gateway-wide): not shown to an app-scoped caller.
        // `scope: "all"` = the full list (admin, no app filter): the external reaper trusts only that (reaper.ts).
        return send(res, 200, {
          // An app key sees its own deployments' counts and bill, never the namespace's (QA 2026-10-07).
          namespace: controller.namespace, scope: filter ? 'app' : 'all', health: controller.health(own ?? undefined), deployments,
          ...(own ? {} : { pendingNetworkReleases: controller.pendingNetworkReleases() }),
          ...(opts.declaredStatus && !own ? { declared: opts.declaredStatus() } : {}),
        });
      }
      return send(res, 405, { error: 'method not allowed' });
    }
    if (action === 'invoke') {
      // A non-admin key invokes only its own app's deployments (a leaked app key must not reach another app's GPU).
      if (!isAdmin(req)) {
        const own = appOf(req);
        if (!own || controller.get(name)?.app !== own) return send(res, 403, { error: `this API key cannot invoke deployment '${name}'` });
      }
      // The proxy kills sockets idle for PROXY_TOTAL_TIMEOUT_MS (60 s). A request waiting through a cold start sends
      // and receives nothing for minutes by design; its own bounds are coldStartWaitSeconds (capped by the gateway's
      // maximum wait, DEPLOYMENTS_MAX_WAIT_SECONDS) and INVOKE_TIMEOUT_MS.
      req.socket?.setTimeout(0);
      const rest = parts.slice(4).join('/') + (path.endsWith('/') && parts.length > 4 ? '/' : '');
      return invoke(req, res, name, rest, query, method);
    }
    if (action === 'cdp') {
      // Same scope as invoke: admin, or the key of the app the deployment belongs to.
      if (!isAdmin(req)) {
        const own = appOf(req);
        if (!own || controller.get(name)?.app !== own) return send(res, 403, { error: `this API key cannot open a CDP session on deployment '${name}'` });
      }
      req.socket?.setTimeout(0);
      if (method === 'POST' && parts.slice(4).join('/') === 'keepalive') return cdpKeepalive(req, res);
      if (method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      return cdpBootstrap(req, res, name);
    }
    if (action === 'wake' && method === 'POST') { admin(); return send(res, 202, controller.wake(name)); }
    if (action === 'park' && method === 'POST') { admin(); return send(res, 202, await controller.park(name)); }
    if (action === 'warm' && method === 'POST') {
      admin();
      const body = await readJson(req);
      return send(res, 202, await controller.warm(name, body.replicas as number, body.untilMinutes as number));
    }
    if (action === 'capacity' && method === 'GET') {
      const own = appOf(req);
      const capacity = own && controller.get(name)?.app !== own ? null : controller.capacity(name);
      return capacity ? send(res, 200, capacity) : send(res, 404, { error: `deployment '${name}' not found` });
    }
    if (action === 'offers' && method === 'GET') {
      admin();
      const preview = await controller.offers(name);
      return preview ? send(res, 200, { deployment: name, ...preview }) : send(res, 404, { error: `deployment '${name}' has no vast placement` });
    }
    if (action) return send(res, 404, { error: `unknown action '${action}'` });

    const existing = controller.get(name);
    const caller = appOf(req);
    if (existing && caller && existing.app && existing.app !== caller) {
      return send(res, 403, { error: `deployment '${name}' belongs to app '${existing.app}'` });
    }
    if (method === 'GET') {
      return existing ? send(res, 200, existing) : send(res, 404, { error: `deployment '${name}' not found` });
    }
    if (method === 'PUT' || method === 'PATCH') {
      admin();
      if (method === 'PATCH' && !existing) return send(res, 404, { error: `deployment '${name}' not found` });
      let body = await readJson(req);
      const app = existing?.app ?? caller;
      const appImage = typeof body.appImage === 'string' ? body.appImage : undefined;
      if (body.appImage !== undefined) {
        if (!opts.apps) throw new DeploymentError(400, 'appImage needs app accounts, not enabled on this gateway');
        if (!app) throw new DeploymentError(400, 'appImage: say which app the deployment belongs to (X-App header)');
        body = opts.apps.resolveDeployBody(app, body);
      }
      const { view, created } = await controller.put(name, body, { ...(app ? { app } : {}), ...(appImage ? { appImage } : {}) });
      return send(res, created ? 201 : 200, view);
    }
    if (method === 'DELETE') {
      admin();
      return (await controller.remove(name)) ? send(res, 200, { deleted: name }) : send(res, 404, { error: `deployment '${name}' not found` });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  /**
   * `UpgradeRoute` handler for the proxy: owns any WebSocket upgrade under `/v1/deployments` whose path is
   * `/:name/invoke/<rest>`; anything else returns `false` so the proxy keeps its generic 410.
   */
  async function upgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<boolean> {
    const url = req.url ?? '/';
    const path = url.split('?')[0];
    const query = url.includes('?') ? url.slice(url.indexOf('?')) : '';
    const parts = path.split('/').filter(Boolean); // ['v1', 'deployments', name?, action?, ...]
    const [, kind, name, action] = parts;
    if (kind !== 'deployments' || !name || action !== 'invoke') return false;
    const rest = parts.slice(4).join('/') + (path.endsWith('/') && parts.length > 4 ? '/' : '');
    try {
      return await upgradeInvoke(req, socket, head, name, rest, query);
    } catch (err) {
      if (err instanceof SpecError) { socketError(socket, 400, err.message); return true; }
      if (err instanceof AppError) { socketError(socket, err.status, err.message); return true; }
      if (err instanceof DeploymentError) {
        socketError(socket, err.status, err.message);
        return true;
      }
      const requestId = requestIdOf(req.headers['x-request-id']);
      log.error({ requestId, path, error: err instanceof Error ? err.stack ?? err.message : String(err) }, 'deployments upgrade failed');
      socketError(socket, 500, 'internal error');
      return true;
    }
  }

  /** `PrefixRoute` handler: owns every path under /v1/deployments and /v1/profiles. Callable with `.upgrade` attached. */
  const handle = function handle(req: IncomingMessage, res: ServerResponse, path: string, method: string): boolean {
    const owns = ['/v1/deployments', '/v1/profiles', '/v1/apps'].some(p => path === p || path.startsWith(`${p}/`));
    if (!owns) return false;
    route(req, res, path, method).catch((err) => {
      if (err instanceof SpecError) return send(res, 400, { error: err.message });
      if (err instanceof AppError) return send(res, err.status, { error: err.message });
      if (err instanceof DeploymentError) {
        return send(res, err.status, { error: err.message, ...(err.status === 503 ? { status: 'warming' } : {}) },
          err.retryAfterSeconds ? { 'Retry-After': err.retryAfterSeconds } : {});
      }
      // Never the raw error (message/stack) to the client: a generic message + an id to find the log line.
      const requestId = requestIdOf(req.headers['x-request-id']);
      log.error({ requestId, path, error: err instanceof Error ? err.stack ?? err.message : String(err) }, 'deployments route failed');
      send(res, 500, { error: 'internal error', requestId });
    });
    return true;
  };
  (handle as unknown as { upgrade: typeof upgrade }).upgrade = upgrade;
  return handle as unknown as typeof handle & { upgrade: typeof upgrade };
}

/** Error reply on a raw (pre-upgrade) socket: the client sees a plain HTTP error, not a dropped connection. */
function socketError(socket: Socket, status: number, error: string): void {
  const body = JSON.stringify({ error: { message: error, type: status === 410 ? 'gone' : 'error' } });
  socket.write(`HTTP/1.1 ${status} ${statusText(status)}\r\nContent-Type: application/json`
    + `\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  socket.end();
}
