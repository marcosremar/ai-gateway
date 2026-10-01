// ── HTTP REST API server (port PORT) ─────────────────────────────────────────
// Bun.serve()-based adapter that translates Bun Request → Node-style (req, res)
// so the handlers registered in server/routes/* continue to work.

import { timingSafeEqual } from 'crypto';
import { PassThrough } from 'stream';
import { createLogger } from '../../src/logger';
import { PORT } from '../config';
import { getRouteBodyLimit } from '../http-utils';
import { resolveBearer, X_AIGW_USER_ID } from './api-key-resolver';

const log = createLogger('http-api-server');

type AuthzResult =
  | { ok: true; userId: string | null }
  | { ok: false; status: number; message: string };

const PUBLIC_HTTP_ROUTES = new Set([
  'GET /health',
  'HEAD /health',
  'GET /api/tools',
]);

function safeCompare(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function isLoopbackAddress(address: string): boolean {
  // Accept the full 127.0.0.0/8 range per RFC 1122, plus IPv6 loopback and
  // IPv4-mapped IPv6 loopback addresses (e.g. ::ffff:127.0.0.x).
  if (address === '::1') return true;
  if (address === '0:0:0:0:0:0:0:1') return true;
  const v4Mapped = address.match(/^::ffff:(.+)$/i);
  if (v4Mapped) return isLoopbackAddress(v4Mapped[1]);
  return address.startsWith('127.');
}

export function isPublicHttpRoute(method: string, pathname: string): boolean {
  return PUBLIC_HTTP_ROUTES.has(`${method.toUpperCase()} ${pathname}`);
}

export interface CorsResolution {
  origin: string | null;
  allowCredentials: boolean;
}

export function resolveHttpCorsOrigin(origin: string | null): CorsResolution {
  if (!origin) return { origin: null, allowCredentials: false };

  const corsOriginsEnv = process.env.CORS_ORIGINS
    || `http://localhost:${PORT},http://127.0.0.1:${PORT},http://localhost:3000,http://127.0.0.1:3000`;

  // Wildcard: echo origin but DROP credentials. Browsers forbid `*` + credentials,
  // and echoing the origin while keeping `Access-Control-Allow-Credentials: true`
  // is a CSRF vector — any malicious site can read authenticated responses.
  if (corsOriginsEnv === '*') return { origin, allowCredentials: false };

  const allowedOrigins = corsOriginsEnv
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  if (isLocal || allowedOrigins.includes(origin)) {
    return { origin, allowCredentials: true };
  }
  return { origin: null, allowCredentials: false };
}

function buildCorsHeaders(corsResolved: CorsResolution | string | null): Record<string, string> {
  // Back-compat: accept legacy string form (always treat as credentialed).
  const resolved: CorsResolution = typeof corsResolved === 'string' || corsResolved === null
    ? { origin: corsResolved, allowCredentials: corsResolved !== null }
    : corsResolved;
  if (!resolved.origin) return {};
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': resolved.origin,
    'Vary': 'Origin',
  };
  if (resolved.allowCredentials) {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

export function authorizeHttpRequest(
  method: string,
  pathname: string,
  authHeader: string | null,
  remoteAddr: string,
): AuthzResult {
  if (isPublicHttpRoute(method, pathname)) {
    return { ok: true, userId: null };
  }

  const token = (authHeader || '').replace(/^Bearer\s+/i, '');

  // Multi-key registry path — when GATEWAY_API_KEYS is set, every request
  // must present a Bearer that resolves to a known userId. The userId is
  // forwarded to handlers via the x-aigw-user-id synthetic header so they
  // can scope GPU list/terminate to only this caller's instances.
  const multiKeysRaw = process.env.GATEWAY_API_KEYS;
  if (multiKeysRaw) {
    const resolution = resolveBearer(token);
    if (!resolution.ok) {
      return { ok: false, status: 401, message: 'Invalid or missing API key' };
    }
    return { ok: true, userId: resolution.userId };
  }

  // Legacy single-key path — a single shared GATEWAY_API_KEY for back-compat.
  // Callers all resolve to userId 'default' (no per-app isolation).
  const expectedToken = process.env.GATEWAY_API_KEY;
  if (expectedToken) {
    if (!token || !safeCompare(token, expectedToken)) {
      return { ok: false, status: 401, message: 'Invalid or missing API key' };
    }
    return { ok: true, userId: 'default' };
  }

  if (!isLoopbackAddress(remoteAddr)) {
    return {
      ok: false,
      status: 401,
      message: 'No GATEWAY_API_KEY configured — remote access denied. Set GATEWAY_API_KEY or connect from localhost.',
    };
  }
  // Localhost with no auth configured = admin (sees all instances). This
  // matches today's behavior for local dev where the operator is trusted.
  return { ok: true, userId: null };
}

async function pumpRequestBody(
  req: Request,
  fakeReq: PassThrough,
  routeLimit: number,
): Promise<void> {
  const contentLength = req.headers.get('content-length');
  if (contentLength) {
    const length = parseInt(contentLength, 10);
    if (!Number.isNaN(length) && length > routeLimit) {
      const err = new Error('Payload Too Large');
      (err as Error & { statusCode?: number }).statusCode = 413;
      throw err;
    }
  }

  if (!req.body) {
    fakeReq.end();
    return;
  }

  const reader = req.body.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > routeLimit) {
      const err = new Error('Payload Too Large');
      (err as Error & { statusCode?: number }).statusCode = 413;
      throw err;
    }
    fakeReq.write(chunk);
  }
  fakeReq.end();
}

/**
 * Wraps a Node-style handler(req, res) so it resolves to a Bun Response.
 * Used for both the flat handler map and dynamic Docker/workload handlers.
 */
/** Exported for tests. */
export function invokeNodeStyleHandler(
  req: Request,
  invoke: (fakeReq: any, fakeRes: any) => void,
  corsOrigin: CorsResolution | string | null,
  routeLimit: number,
  /** Resolved app/user identity from the auth wrapper. Forwarded to handlers
   *  via the synthetic x-aigw-user-id header so they can scope GPU isolation. */
  userId: string | null = null,
): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;
  const fakeReq = new PassThrough() as PassThrough & {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
  };
  // Body pump failures (client disconnect, 413) destroy fakeReq with the error.
  // Handlers that answer without reading the body attach no 'error' listener,
  // and an unhandled 'error' event kills the whole gateway process.
  fakeReq.on('error', (err: Error) => {
    log.debug(`[http-api-server] request body error (${method} ${url.pathname}): ${err.message}`);
  });
  fakeReq.method = method;
  fakeReq.url = url.pathname + url.search;
  fakeReq.headers = (() => {
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });
    // Inject resolved identity (or strip the inbound copy so callers can't
    // spoof it). Trusted handlers downstream read X_AIGW_USER_ID for app
    // isolation in GPU list/terminate/deploy.
    if (userId) {
      headers[X_AIGW_USER_ID] = userId;
    } else {
      delete headers[X_AIGW_USER_ID];
    }
    return headers;
  })();

  return new Promise<Response>((resolve) => {
    let statusCode = 200;
    const resHeaders: Record<string, string> = {};
    const chunks: (string | Buffer | Uint8Array)[] = [];
    let settled = false;
    const finish = (response: Response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    const fakeRes: any = {
      headersSent: false,
      writeHead: (code: number, hdrs?: Record<string, string>) => {
        statusCode = code;
        fakeRes.statusCode = code;
        fakeRes.headersSent = true;
        if (hdrs) Object.assign(resHeaders, hdrs);
      },
      setHeader: (k: string, v: string) => { resHeaders[k] = v; },
      end: (data?: string | Buffer | Uint8Array) => {
        if (settled) return;
        if (data) chunks.push(data);
        const body = Buffer.concat(chunks.map(c => Buffer.isBuffer(c) ? c : c instanceof Uint8Array ? Buffer.from(c) : Buffer.from(c as string)));
        finish(new Response(body, {
          status: statusCode,
          headers: { 'Content-Type': 'application/json', ...buildCorsHeaders(corsOrigin), ...resHeaders },
        }));
      },
      write: (data: string | Buffer | Uint8Array) => { chunks.push(data); },
      getHeader: (k: string) => resHeaders[k],
      hasHeader: (k: string) => Object.prototype.hasOwnProperty.call(resHeaders, k),
      statusCode: 200,
    };

    Promise.resolve(invoke(fakeReq, fakeRes)).catch((err: unknown) => {
      log.error(`[http-api-server] Handler error: ${err instanceof Error ? err.message : String(err)}`);
      if (!settled) {
        finish(new Response(JSON.stringify({ error: 'Internal Server Error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...buildCorsHeaders(corsOrigin) },
        }));
      }
      try { fakeReq.destroy(err as Error); } catch { /* no-op */ }
    });

    void pumpRequestBody(req, fakeReq, routeLimit).catch((err: unknown) => {
      try { fakeReq.destroy(err as Error); } catch { /* no-op */ }
      if (settled) return;
      const status = err instanceof Error && (err as Error & { statusCode?: number }).statusCode === 413 ? 413 : 400;
      const message = status === 413 ? 'Payload Too Large' : 'Failed to read request body';
      finish(new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json', ...buildCorsHeaders(corsOrigin) },
      }));
    });
  });
}

/** Boot the REST API server on `PORT`. Returns without throwing on failure. */
export function startHttpApiServer(): void {
  try {
    const {
      registerAllRoutes,
      getDockerDynamicMatcher,
      getGpuDynamicMatcher,
      getAppDynamicMatcher,
    } = require('../routes');
    const handlers: Record<string, Function> = {};
    registerAllRoutes(handlers);

    // ── Initialize workload registry ────────────────────────────────────
    try {
      const { workloadRegistry } = require('../../src/workloads/registry');
      const { registerWorkloadServerRuntime } = require('../../src/workloads');
      const { GpuWorkloadDriver } = require('../../src/workloads/gpu-driver');
      const { BotWorkloadDriver } = require('../../src/workloads/bot-driver');
      const { DbWorkloadDriver } = require('../../src/workloads/db-driver');
      registerWorkloadServerRuntime({
        state: () => import('../state'),
        providers: () => import('../providers'),
        gpuDeploy: () => import('../gpu-deploy'),
      });
      workloadRegistry.registerDriver(new GpuWorkloadDriver());
      workloadRegistry.registerDriver(new BotWorkloadDriver());
      workloadRegistry.registerDriver(new DbWorkloadDriver());
      log.log('[ws-server] Workload registry initialized (gpu, bot, db drivers)');
    } catch (e: any) {
      log.warn(`[ws-server] Workload registry not available: ${e.message?.slice(0, 80)}`);
    }

    let routeWorkloadRequest: ((req: any, res: any, pathname: string, method: string) => boolean) | null = null;
    try {
      const wh = require('../workload-handlers');
      routeWorkloadRequest = wh.routeWorkloadRequest;
    } catch { /* workload-handlers optional — routing falls through to 404 if absent */ }

    // Docker dynamic routes (e.g. /v1/docker/builds/:id)
    const matchDockerDynamic = getDockerDynamicMatcher();
    const matchGpuDynamic = getGpuDynamicMatcher();
    const matchAppDynamic = getAppDynamicMatcher();

    Bun.serve({
      port: PORT,
      reusePort: true,
      // GPU offers/catalog queries fan out to multiple cloud providers and can
      // exceed the default 10s. Bump to 120s so long-running admin endpoints
      // finish without empty-reply hangups.
      idleTimeout: 120,
      fetch: async (req, server) => {
        const url = new URL(req.url);
        const method = req.method;
        const corsOrigin = resolveHttpCorsOrigin(req.headers.get('origin'));
        const routeLimit = getRouteBodyLimit(url.pathname);

        // CORS preflight
        if (method === 'OPTIONS') {
          if (!corsOrigin.origin) {
            return new Response(JSON.stringify({ error: 'CORS origin not allowed' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(null, {
            status: 204,
            headers: {
              ...buildCorsHeaders(corsOrigin),
              'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            },
          });
        }

        const remoteAddr = server.requestIP(req)?.address || '';
        const authz = authorizeHttpRequest(
          method,
          url.pathname,
          req.headers.get('authorization'),
          remoteAddr,
        );
        if (!authz.ok) {
          return new Response(JSON.stringify({ error: authz.message }), {
            status: authz.status,
            headers: { 'Content-Type': 'application/json', ...buildCorsHeaders(corsOrigin) },
          });
        }

        const callerUserId = authz.ok ? authz.userId : null;
        // Workload routes (dynamic :id segments — checked before flat handlers)
        if (routeWorkloadRequest && url.pathname.startsWith('/v1/workloads')) {
          return invokeNodeStyleHandler(req, (fakeReq, fakeRes) => {
            if (!routeWorkloadRequest!(fakeReq, fakeRes, url.pathname, method)) {
              // Not matched — write 404 via fakeRes
              fakeRes.writeHead(404, { 'Content-Type': 'application/json' });
              fakeRes.end(JSON.stringify({ error: 'Not found' }));
            }
          }, corsOrigin, routeLimit, callerUserId);
        }

        // Docker dynamic routes (e.g. /v1/docker/builds/:id)
        if (matchDockerDynamic && url.pathname.startsWith('/v1/docker/')) {
          const match = matchDockerDynamic(method, url.pathname);
          if (match) {
            const [dynHandler, params] = match;
            return invokeNodeStyleHandler(req, (fakeReq, fakeRes) => {
              dynHandler(fakeReq, fakeRes, ...params);
            }, corsOrigin, routeLimit, callerUserId);
          }
        }

        // GPU dynamic routes (e.g. /v1/gpu/snapshot/:id/restore)
        if (matchGpuDynamic && url.pathname.startsWith('/v1/gpu/')) {
          const match = matchGpuDynamic(method, url.pathname);
          if (match) {
            const [dynHandler, params] = match;
            return invokeNodeStyleHandler(req, (fakeReq, fakeRes) => {
              dynHandler(fakeReq, fakeRes, ...params);
            }, corsOrigin, routeLimit, callerUserId);
          }
        }

        // App registry dynamic routes (e.g. /v1/apps/:name)
        if (matchAppDynamic && url.pathname.startsWith('/v1/apps/')) {
          const match = matchAppDynamic(method, url.pathname);
          if (match) {
            const [dynHandler, params] = match;
            return invokeNodeStyleHandler(req, (fakeReq, fakeRes) => {
              dynHandler(fakeReq, fakeRes, ...params);
            }, corsOrigin, routeLimit, callerUserId);
          }
        }

        const key = `${method} ${url.pathname}`;
        const handler = handlers[key];
        if (!handler) {
          return new Response(JSON.stringify({ error: 'Not found', endpoints: Object.keys(handlers) }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...buildCorsHeaders(corsOrigin) },
          });
        }

        // Node→Bun adapter (stream request body to preserve downstream size limits)
        return invokeNodeStyleHandler(req, (fakeReq, fakeRes) => handler(fakeReq, fakeRes), corsOrigin, routeLimit, callerUserId);
      },
    });
    log.log(`[ws-server] HTTP API on port ${PORT}`);
  } catch (e: any) {
    log.warn(`[ws-server] HTTP API not started: ${e.message?.slice(0, 80)}`);
  }
}
