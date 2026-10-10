// ── AI Gateway — Live subtitle rooms: HTTP routes ────────────────────────────
//   POST /v1/rooms                 gateway key (mounted as a proxy customRoute: the proxy's auth runs first)
//   GET  /v1/rooms/:code           public transcript, CORS open
//   POST /v1/rooms/:code/lines     publish token (or the creating / an admin gateway key)
//   POST /v1/rooms/:code/audio     publish token; broadcast only
//   POST /v1/rooms/:code/end       publish token
//   GET  /live[/:code], and `/` + `/:code` on ROOMS_PUBLIC_HOST → viewer pages (page.ts)
// Everything but POST /v1/rooms is served in front of the proxy (index.ts `mount`), since a viewer or a publisher
// holding only a room token never has the gateway key.

import type { IncomingMessage, ServerResponse } from 'http';
import { bearerToken } from '../gateway/proxy/middleware/api-keys';
import { errorTypeForStatus } from '../gateway/proxy/http-conventions';
import { entryPage, notFoundPage, pageCsp, roomPage, type RenderedPage } from './page';
import type { RoomService } from './service';
import { RoomError, normalizeCode, parseAudio, parseCreate, parseLine } from './validate';

export type KeyUser = (token: string) => { userId: string; admin: boolean } | null;

export interface RoomsHttpOptions {
  service: RoomService;
  /** Resolves a bearer as a gateway key (null when it is not one). */
  keyUser: KeyUser;
  /** User of a request that passed the proxy's key auth (POST /v1/rooms). */
  userOf: (req: IncomingMessage) => string;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

const API_PATH = /^\/v1\/rooms\/([^/]{1,32})(?:\/(lines|audio|end|ws))?\/?$/;
const LIVE_PATH = /^\/live\/([^/]{1,32})\/?$/;
const HOST_CODE_PATH = /^\/([A-Za-z0-9]{6})\/?$/;
const CREATE_MAX_BYTES = 16 * 1024;
const LINE_MAX_BYTES = 256 * 1024;
const BODY_TIMEOUT_MS = 30_000;

const API_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | number> = {}): void {
  if (res.headersSent) { res.end(); return; }
  const text = JSON.stringify(body);
  res.writeHead(status, { ...API_HEADERS, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string | number> = {}): void {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { ...API_HEADERS, ...headers });
  res.end();
}

function sendError(res: ServerResponse, status: number, message: string, headers: Record<string, string | number> = {}): void {
  sendJson(res, status, { error: { message, type: errorTypeForStatus(status) } }, headers);
}

function sendPage(res: ServerResponse, status: number, page: RenderedPage): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(page.html),
    'Content-Security-Policy': pageCsp(page.nonce),
    'Cache-Control': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(page.html);
}

/** JSON body with a size cap (413) and a read timeout; not-JSON → 400. */
export function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > maxBytes) {
    req.resume();
    return Promise.reject(new RoomError(413, `body larger than ${maxBytes} bytes`));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (err: Error | null, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => finish(new RoomError(408, 'body read timed out')), BODY_TIMEOUT_MS);
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) { finish(new RoomError(413, `body larger than ${maxBytes} bytes`)); req.resume(); return; }
      if (!done) chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      const text = Buffer.concat(chunks).toString('utf8');
      try { finish(null, text ? JSON.parse(text) : {}); } catch { finish(new RoomError(400, 'body is not valid JSON')); }
    });
    req.on('error', (err) => finish(err));
  });
}

function hostOf(req: IncomingMessage): string {
  return String(req.headers.host ?? '').trim().toLowerCase().replace(/:\d+$/, '');
}

export function createRoomsHttp(opts: RoomsHttpOptions) {
  const { service } = opts;
  const cfg = service.config;
  const log = opts.log ?? (() => {});
  const retentionDays = Math.round(cfg.retentionMs / 86_400_000);
  const audioMaxBytes = Math.ceil(cfg.maxAudioBytes * 4 / 3) + 64 * 1024;

  const fail = (res: ServerResponse, err: unknown, where: string) => {
    if (err instanceof RoomError) { sendError(res, err.status, err.message, err.status === 429 ? { 'Retry-After': 60 } : {}); return; }
    log('rooms: request failed', { where, error: err instanceof Error ? err.message : String(err) });
    sendError(res, 500, 'internal error');
  };

  /** POST /v1/rooms (customRoute: the proxy authenticated the key). */
  async function create(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const input = parseCreate(await readJson(req, CREATE_MAX_BYTES), cfg);
      sendJson(res, 201, await service.create(input, opts.userOf(req)));
    } catch (err) { fail(res, err, 'create'); }
  }

  async function page(res: ServerResponse, rawCode: string, basePath: string): Promise<void> {
    const code = normalizeCode(rawCode);
    const room = code ? await service.get(code) : null;
    const pageOpts = { basePath, retentionDays };
    if (!room || !code) { sendPage(res, 404, notFoundPage(pageOpts, code)); return; }
    sendPage(res, 200, roomPage(code, pageOpts));
  }

  async function api(req: IncomingMessage, res: ServerResponse, method: string, rawCode: string, action: string | undefined): Promise<void> {
    if (method === 'OPTIONS') {
      sendEmpty(res, 204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': 86_400 });
      return;
    }
    const allowed = action === undefined ? ['GET', 'HEAD'] : action === 'ws' ? ['GET'] : ['POST'];
    if (!allowed.includes(method)) { req.resume(); sendError(res, 405, `use ${allowed.join(' or ')}`, { Allow: allowed.join(', ') }); return; }
    if (action === 'ws') { sendError(res, 426, 'this path is a WebSocket', { Upgrade: 'websocket' }); return; }
    const code = normalizeCode(rawCode);
    const room = code ? await service.get(code) : null;
    if (!room) { req.resume(); sendError(res, 404, 'room not found or expired'); return; }
    if (action === undefined) { sendJson(res, 200, service.publicView(room)); return; }

    service.authorizePublish(room, bearerToken(req.headers.authorization), opts.keyUser);
    if (action === 'lines') {
      const line = parseLine(await readJson(req, LINE_MAX_BYTES), cfg, Date.now());
      await service.publishLine(room, line);
    } else if (action === 'audio') {
      service.publishAudio(room, parseAudio(await readJson(req, audioMaxBytes), cfg));
    } else {
      req.resume();
      await service.end(room);
    }
    sendEmpty(res, 204);
  }

  /** Serves the request when it is a rooms path (true); false = not ours, the proxy gets it. */
  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = (req.url ?? '/').split('?')[0]!;
    const isGet = method === 'GET' || method === 'HEAD';
    const run = (p: Promise<void>, where: string) => { p.catch((err: unknown) => fail(res, err, where)); return true; };

    const apiMatch = API_PATH.exec(path);
    if (apiMatch) return run(api(req, res, method, apiMatch[1]!, apiMatch[2]), 'api');
    if (!isGet) return false;
    if (cfg.publicHost && hostOf(req) === cfg.publicHost) {
      if (path === '/') { sendPage(res, 200, entryPage({ basePath: '/', retentionDays })); return true; }
      const hostCode = HOST_CODE_PATH.exec(path)?.[1];
      // Only the room-code alphabet: "/health" and other 6-letter paths keep reaching the proxy.
      if (hostCode && normalizeCode(hostCode)) return run(page(res, hostCode, '/'), 'page');
    }
    if (path === '/live' || path === '/live/') { sendPage(res, 200, entryPage({ basePath: '/live/', retentionDays })); return true; }
    const liveCode = LIVE_PATH.exec(path)?.[1];
    if (liveCode) return run(page(res, liveCode, '/live/'), 'page');
    return false;
  }

  return { create, handle };
}
