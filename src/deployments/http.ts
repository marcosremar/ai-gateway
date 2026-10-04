/**
 * HTTP surface of deployments, mounted as a prefix route on the proxy (`serve.ts`):
 *
 *   GET    /v1/deployments                     list
 *   PUT    /v1/deployments/:name               create or update (merge) — body: spec fields and/or { profile }
 *   PATCH  /v1/deployments/:name               update an existing one (e.g. { minReplicas, maxReplicas })
 *   GET    /v1/deployments/:name               status + replicas
 *   DELETE /v1/deployments/:name               release every replica and forget the spec
 *   POST   /v1/deployments/:name/wake          start replicas now (pre-warm before traffic)
 *   *      /v1/deployments/:name/invoke/<path> forwarded to a ready replica as /<path> (waits through cold start)
 *   GET    /v1/profiles                        list profiles (built-in + stored)
 *   PUT    /v1/profiles/:name                  create or replace a profile
 *   DELETE /v1/profiles/:name                  delete a stored profile
 *
 * Auth already happened in the proxy (Bearer from GATEWAY_API_KEYS). Mutations additionally need `isAdmin(req)`.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { Readable } from 'stream';
import { DeploymentController, DeploymentError } from './controller';
import { SpecError } from './spec';
import type { DeploymentSpec, ReplicaMachine, ReplicaProbe } from './types';

const MAX_INVOKE_BODY = 100 * 1024 * 1024;
/** Specs may carry a boot script and its files (up to 8 MB of base64). */
const MAX_ADMIN_BODY = 16 * 1024 * 1024;
const INVOKE_TIMEOUT_MS = 15 * 60_000;
const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'authorization', 'content-length', 'x-aigw-token', 'x-aigw-wait', 'x-forwarded-for', 'x-forwarded-host',
  'x-forwarded-proto', 'x-real-ip', 'cookie',
]);

/** Probe over the replica's nginx front: boot finished (`/__aigw/ready`) AND the app still answers its health path. */
export class HttpReplicaProbe implements ReplicaProbe {
  constructor(private readonly timeoutMs = 4_000, private readonly fetchImpl: typeof fetch = fetch) {}

  async ready(machine: ReplicaMachine, spec: DeploymentSpec, token: string): Promise<boolean> {
    if (!machine.ip) return false;
    const headers = { 'X-Aigw-Token': token };
    const get = (path: string) => this.fetchImpl(`${replicaBase(machine)}${path}`, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    const marker = await get('/__aigw/ready');
    if (!marker.ok) return false;
    const health = await get(spec.healthPath);
    return health.ok;
  }
}

/** `ip` may carry a port (local tests); real replicas listen on :80. */
export function replicaBase(machine: ReplicaMachine): string {
  return `http://${machine.ip}`;
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
  /** Mutations (PUT/PATCH/DELETE/wake, profiles) require this. Default: every authenticated caller. */
  isAdmin?: (req: IncomingMessage) => boolean;
  fetchImpl?: typeof fetch;
}

export function createDeploymentRoutes(opts: DeploymentRoutesOptions) {
  const { controller } = opts;
  const isAdmin = opts.isAdmin ?? (() => true);
  const fetchImpl = opts.fetchImpl ?? fetch;

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
    const exclude = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt++) {
      const lease = await controller.acquire(name, { waitMs, exclude, signal: abort.signal });
      let upstream: Response;
      try {
        upstream = await fetchImpl(`${replicaBase(lease.machine)}/${rest}${query}`, {
          method,
          headers: { ...headers, 'X-Aigw-Token': lease.token },
          body: body && body.length ? new Uint8Array(body) : undefined,
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(INVOKE_TIMEOUT_MS)]),
        });
      } catch (err) {
        lease.done(true);
        if (abort.signal.aborted) return;
        exclude.add(lease.machine.id);
        if (attempt === 1) throw new DeploymentError(502, `replica unreachable: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      try {
        const out: Record<string, string> = { 'X-Aigw-Replica': lease.machine.id };
        upstream.headers.forEach((v, k) => {
          // fetch already decoded the body, so its encoding/length headers no longer apply.
          if (!HOP_BY_HOP.has(k) && k !== 'content-encoding') out[k] = v;
        });
        res.writeHead(upstream.status, out);
        if (upstream.body && method !== 'HEAD') {
          await new Promise<void>((resolve, reject) => {
            const stream = Readable.fromWeb(upstream.body as unknown as import('stream/web').ReadableStream);
            stream.on('error', reject);
            res.on('close', resolve);
            stream.pipe(res);
          });
        } else {
          res.end();
        }
      } finally {
        lease.done(false);
      }
      return;
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<void> {
    const query = (req.url ?? '').includes('?') ? (req.url ?? '').slice((req.url ?? '').indexOf('?')) : '';
    const parts = path.split('/').filter(Boolean); // ['v1', 'deployments' | 'profiles', name?, action?, ...]
    const [, kind, name, action] = parts;
    const admin = () => {
      if (!isAdmin(req)) throw new DeploymentError(403, 'this API key cannot manage deployments');
    };

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
      if (method === 'GET') return send(res, 200, { namespace: controller.namespace, health: controller.health(), deployments: controller.list() });
      return send(res, 405, { error: 'method not allowed' });
    }
    if (action === 'invoke') {
      // The proxy kills sockets idle for PROXY_TOTAL_TIMEOUT_MS (60 s). A request waiting through a cold start sends
      // and receives nothing for minutes by design; its own bounds are coldStartWaitSeconds and INVOKE_TIMEOUT_MS.
      req.socket?.setTimeout(0);
      const rest = parts.slice(4).join('/') + (path.endsWith('/') && parts.length > 4 ? '/' : '');
      return invoke(req, res, name, rest, query, method);
    }
    if (action === 'wake' && method === 'POST') { admin(); return send(res, 202, controller.wake(name)); }
    if (action) return send(res, 404, { error: `unknown action '${action}'` });

    if (method === 'GET') {
      const view = controller.get(name);
      return view ? send(res, 200, view) : send(res, 404, { error: `deployment '${name}' not found` });
    }
    if (method === 'PUT' || method === 'PATCH') {
      admin();
      if (method === 'PATCH' && !controller.get(name)) return send(res, 404, { error: `deployment '${name}' not found` });
      const { view, created } = await controller.put(name, await readJson(req));
      return send(res, created ? 201 : 200, view);
    }
    if (method === 'DELETE') {
      admin();
      return (await controller.remove(name)) ? send(res, 200, { deleted: name }) : send(res, 404, { error: `deployment '${name}' not found` });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  /** `PrefixRoute` handler: owns every path under /v1/deployments and /v1/profiles. */
  return function handle(req: IncomingMessage, res: ServerResponse, path: string, method: string): boolean {
    if (!(path === '/v1/deployments' || path.startsWith('/v1/deployments/') || path === '/v1/profiles' || path.startsWith('/v1/profiles/'))) {
      return false;
    }
    route(req, res, path, method).catch((err) => {
      if (err instanceof SpecError) return send(res, 400, { error: err.message });
      if (err instanceof DeploymentError) {
        return send(res, err.status, { error: err.message, ...(err.status === 503 ? { status: 'warming' } : {}) },
          err.retryAfterSeconds ? { 'Retry-After': err.retryAfterSeconds } : {});
      }
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
    return true;
  };
}
