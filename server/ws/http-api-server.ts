// ── HTTP REST API server (port PORT) ─────────────────────────────────────────
// Bun.serve()-based adapter that translates Bun Request → Node-style (req, res)
// so the handlers registered in server/routes/* continue to work.

import { createLogger } from '../../src/logger';
import { PORT } from '../config';

const log = createLogger('http-api-server');

/**
 * Wraps a Node-style handler(req, res) so it resolves to a Bun Response.
 * Used for both the flat handler map and dynamic Docker/workload handlers.
 */
function invokeNodeStyleHandler(
  req: Request,
  bodyBuf: Buffer | null,
  invoke: (fakeReq: any, fakeRes: any) => void,
): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;
  const listeners: Record<string, Function[]> = {};
  const fakeReq: any = {
    method, url: url.pathname + url.search,
    headers: (() => { const h: Record<string, string> = {}; req.headers.forEach((v, k) => { h[k] = v; }); return h; })(),
    on: (ev: string, cb: Function) => { (listeners[ev] = listeners[ev] || []).push(cb); return fakeReq; },
  };
  queueMicrotask(() => {
    if (bodyBuf && bodyBuf.length) (listeners['data'] || []).forEach(cb => cb(bodyBuf));
    (listeners['end'] || []).forEach(cb => cb());
  });

  return new Promise<Response>((resolve) => {
    let statusCode = 200;
    const resHeaders: Record<string, string> = {};
    const chunks: (string | Buffer | Uint8Array)[] = [];
    const fakeRes: any = {
      writeHead: (code: number, hdrs?: Record<string, string>) => { statusCode = code; fakeRes.statusCode = code; if (hdrs) Object.assign(resHeaders, hdrs); },
      setHeader: (k: string, v: string) => { resHeaders[k] = v; },
      end: (data?: string | Buffer | Uint8Array) => {
        if (data) chunks.push(data);
        const body = Buffer.concat(chunks.map(c => Buffer.isBuffer(c) ? c : c instanceof Uint8Array ? Buffer.from(c) : Buffer.from(c as string)));
        resolve(new Response(body, {
          status: statusCode,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': req.headers.get('origin') || '*', ...resHeaders },
        }));
      },
      write: (data: string | Buffer | Uint8Array) => { chunks.push(data); },
      getHeader: (k: string) => resHeaders[k],
      statusCode: 200,
    };
    invoke(fakeReq, fakeRes);
  });
}

/** Boot the REST API server on `PORT`. Returns without throwing on failure. */
export function startHttpApiServer(): void {
  try {
    const { registerAllRoutes, getDockerDynamicMatcher } = require('../routes');
    const handlers: Record<string, Function> = {};
    registerAllRoutes(handlers);

    // ── Initialize workload registry ────────────────────────────────────
    try {
      const { workloadRegistry } = require('../../src/workloads/registry');
      const { GpuWorkloadDriver } = require('../../src/workloads/gpu-driver');
      const { BotWorkloadDriver } = require('../../src/workloads/bot-driver');
      const { DbWorkloadDriver } = require('../../src/workloads/db-driver');
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

    Bun.serve({
      port: PORT,
      // GPU offers/catalog queries fan out to multiple cloud providers and can
      // exceed the default 10s. Bump to 120s so long-running admin endpoints
      // finish without empty-reply hangups.
      idleTimeout: 120,
      fetch: async (req) => {
        const url = new URL(req.url);
        const method = req.method;

        // CORS preflight
        if (method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: {
            'Access-Control-Allow-Origin': req.headers.get('origin') || '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          }});
        }

        // Workload routes (dynamic :id segments — checked before flat handlers)
        if (routeWorkloadRequest && url.pathname.startsWith('/v1/workloads')) {
          const bodyBuf = method !== 'GET' && method !== 'HEAD' && method !== 'DELETE' ? Buffer.from(await req.arrayBuffer()) : null;
          return invokeNodeStyleHandler(req, bodyBuf, (fakeReq, fakeRes) => {
            if (!routeWorkloadRequest!(fakeReq, fakeRes, url.pathname, method)) {
              // Not matched — write 404 via fakeRes
              fakeRes.writeHead(404, { 'Content-Type': 'application/json' });
              fakeRes.end(JSON.stringify({ error: 'Not found' }));
            }
          });
        }

        // Docker dynamic routes (e.g. /v1/docker/builds/:id)
        if (matchDockerDynamic && url.pathname.startsWith('/v1/docker/')) {
          const match = matchDockerDynamic(method, url.pathname);
          if (match) {
            const [dynHandler, params] = match;
            const bodyBuf2 = method !== 'GET' && method !== 'HEAD' ? Buffer.from(await req.arrayBuffer()) : null;
            return invokeNodeStyleHandler(req, bodyBuf2, (fakeReq, fakeRes) => {
              dynHandler(fakeReq, fakeRes, ...params);
            });
          }
        }

        const key = `${method} ${url.pathname}`;
        const handler = handlers[key];
        if (!handler) {
          return new Response(JSON.stringify({ error: 'Not found', endpoints: Object.keys(handlers) }), {
            status: 404, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          });
        }

        // Node→Bun adapter (use arrayBuffer for binary-safe body transfer)
        const bodyBuf = method !== 'GET' && method !== 'HEAD' ? Buffer.from(await req.arrayBuffer()) : null;
        return invokeNodeStyleHandler(req, bodyBuf, (fakeReq, fakeRes) => handler(fakeReq, fakeRes));
      },
    });
    log.log(`[ws-server] HTTP API on port ${PORT}`);
  } catch (e: any) {
    log.warn(`[ws-server] HTTP API not started: ${e.message?.slice(0, 80)}`);
  }
}
