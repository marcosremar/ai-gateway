// ── AI Gateway — Live subtitle rooms: HTTP routes ────────────────────────────
//   POST /v1/rooms                 gateway key (mounted as a proxy customRoute: the proxy's auth runs first)
//   GET  /v1/rooms/:code           public transcript, CORS open
//   PATCH /v1/rooms/:code          publish token: change room fields after creation ({"youtubeUrl"}, {"serverDub"}, {"steadyDub"})
//   POST /v1/rooms/:code/lines     publish token (or the creating / an admin gateway key)
//   POST /v1/rooms/:code/audio     publish token; broadcast only
//   PUT  /v1/rooms/:code/voice     publish token: the speaker's voice reference (memory only, never served)
//   POST /v1/rooms/:code/end       publish token
//   POST /v1/rooms/:code/events    public: the viewer page's analytics batches (events.ts), rate-limited
//   GET  /v1/rooms/:code/events    admin gateway key: raw events of a room (also after the room expired)
//   GET  /v1/rooms-analytics       admin gateway key: aggregates (?days=30, ?code=)
//   GET  /live[/:code], and `/` + `/:code` on ROOMS_PUBLIC_HOST → viewer pages (page.ts)
// Everything but POST /v1/rooms is served in front of the proxy (index.ts `mount`), since a viewer or a publisher
// holding only a room token never has the gateway key.

import type { IncomingMessage, ServerResponse } from 'http';
import { bearerToken } from '../gateway/proxy/middleware/api-keys';
import { errorTypeForStatus } from '../gateway/proxy/http-conventions';
import { readFileSync } from 'fs';
import { FONT_PATHS } from './font-files';
import { entryPage, notFoundPage, pageCsp, roomPage, type RenderedPage } from './page';
import { EVENTS_MAX_BYTES, parseEventBatch, type RoomEvents } from './events';
import { appIdOf, type LiveRoom, type RoomService } from './service';
import { RoomError, VOICE_MAX_BYTES, normalizeCode, parseAudio, parseCreate, parseLine, parseUpdate, parseVoice } from './validate';

export type KeyUser = (token: string) => { userId: string; admin: boolean } | null;

export interface RoomsHttpOptions {
  service: RoomService;
  events: RoomEvents;
  /** Resolves a bearer as a gateway key (null when it is not one). */
  keyUser: KeyUser;
  /** User of a request that passed the proxy's key auth (POST /v1/rooms). */
  userOf: (req: IncomingMessage) => string;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

const API_PATH = /^\/v1\/rooms\/([^/]{1,32})(?:\/(lines|audio|voice|end|ws|events))?\/?$/;
const ANALYTICS_PATH = /^\/v1\/rooms-analytics\/?$/;
const LIVE_PATH = /^\/live\/([^/]{1,32})\/?$/;
const HOST_CODE_PATH = /^\/([A-Za-z0-9]{6})\/?$/;
const FONT_PATH = /^\/live\/fonts\/([a-z0-9.-]+\.woff2)$/;
const readFont = ([name, path]: [string, string]): Array<[string, Buffer]> => {
  try { return [[name, readFileSync(path)]]; } catch { return []; }
};
const FONTS = new Map(Object.entries(FONT_PATHS).flatMap(readFont));
const CREATE_MAX_BYTES = 16 * 1024;
const LINE_MAX_BYTES = 256 * 1024;
const UPDATE_MAX_BYTES = 4 * 1024;
const VOICE_BODY_MAX_BYTES = Math.ceil(VOICE_MAX_BYTES * 4 / 3) + 16 * 1024;
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

/** Client address for the events rate limit only (hashed in memory, never stored): first X-Forwarded-For hop. */
export function clientIp(req: IncomingMessage): string {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

function queryOf(req: IncomingMessage): URLSearchParams {
  const q = (req.url ?? '').indexOf('?');
  return new URLSearchParams(q >= 0 ? (req.url ?? '').slice(q + 1) : '');
}

function intParam(v: string | null, min: number, max: number, fallback: number): number {
  const n = Number(v);
  return v !== null && v.trim() !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
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
      // A conta do ucast.me (o gate do accounts injeta o id depois de
      // autenticar a chave de ativação; qualquer valor vindo de fora é
      // sobrescrito por ele). Sem conta (outras apps do gateway) = sem a regra.
      const header = req.headers['x-ucast-account'];
      const accountId = typeof header === 'string' && header ? header : undefined;
      sendJson(res, 201, await service.create(input, opts.userOf(req), accountId));
    } catch (err) { fail(res, err, 'create'); }
  }

  async function page(req: IncomingMessage, res: ServerResponse, rawCode: string, basePath: string): Promise<void> {
    const code = normalizeCode(rawCode);
    const room = await service.lookup(code, clientIp(req));
    const pageOpts = { basePath, retentionDays };
    if (!room || !code) { sendPage(res, 404, notFoundPage(pageOpts, code)); return; }
    sendPage(res, 200, roomPage(code, pageOpts, appIdOf(room.meta.ownerId)));
  }

  async function api(req: IncomingMessage, res: ServerResponse, method: string, rawCode: string, action: string | undefined): Promise<void> {
    if (method === 'OPTIONS') {
      sendEmpty(res, 204, { 'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': 86_400 });
      return;
    }
    const allowed = action === undefined ? ['GET', 'HEAD', 'PATCH'] : action === 'ws' ? ['GET'] : action === 'events' ? ['GET', 'POST'] : action === 'voice' ? ['PUT'] : ['POST'];
    if (!allowed.includes(method)) { req.resume(); sendError(res, 405, `use ${allowed.join(' or ')}`, { Allow: allowed.join(', ') }); return; }
    if (action === 'ws') { sendError(res, 426, 'this path is a WebSocket', { Upgrade: 'websocket' }); return; }
    if (action === 'events' && method === 'GET') { await listEvents(req, res, rawCode); return; }
    const code = normalizeCode(rawCode);
    const bearer = bearerToken(req.headers.authorization);
    const publishes = (r: LiveRoom) => { try { service.authorizePublish(r, bearer, opts.keyUser); return true; } catch { return false; } };
    const room = await service.lookup(code, clientIp(req), bearer ? publishes : undefined);
    if (!room) { req.resume(); sendError(res, 404, 'room not found or expired'); return; }
    if (action === undefined && method !== 'PATCH') { sendJson(res, 200, service.publicView(room)); return; }
    if (action === 'events') {
      const batch = parseEventBatch(await readJson(req, EVENTS_MAX_BYTES));
      sendJson(res, 202, await opts.events.record(room.meta.code, batch, clientIp(req)));
      return;
    }

    service.authorizePublish(room, bearerToken(req.headers.authorization), opts.keyUser);
    if (action === undefined) {
      const input = parseUpdate(await readJson(req, UPDATE_MAX_BYTES));
      await service.update(room, input);
      sendJson(res, 200, {
        code: room.meta.code, youtubeUrl: room.meta.youtubeUrl ?? null, serverDub: room.meta.serverDub !== false, ...(room.meta.steadyDub ? { steadyDub: true } : {}),
      });
      return;
    }
    if (action === 'lines') {
      const line = parseLine(await readJson(req, LINE_MAX_BYTES), cfg, Date.now());
      await service.publishLine(room, line);
    } else if (action === 'voice') {
      service.setVoice(room, parseVoice(await readJson(req, VOICE_BODY_MAX_BYTES), cfg));
    } else if (action === 'audio') {
      service.publishAudio(room, parseAudio(await readJson(req, audioMaxBytes), cfg));
    } else {
      req.resume();
      await service.end(room);
    }
    sendEmpty(res, 204);
  }

  /** Admin gateway key or a RoomError (401 no/invalid key, 403 not an admin). */
  function requireAdmin(req: IncomingMessage): void {
    const bearer = bearerToken(req.headers.authorization);
    if (!bearer) throw new RoomError(401, 'missing Authorization: Bearer <admin gateway key>');
    const user = opts.keyUser(bearer);
    if (!user) throw new RoomError(401, 'invalid gateway key');
    if (!user.admin) throw new RoomError(403, 'admin key required');
  }

  /** GET /v1/rooms/:code/events?since=<ms>&limit=<n> (admin). Works after the room content expired. */
  async function listEvents(req: IncomingMessage, res: ServerResponse, rawCode: string): Promise<void> {
    requireAdmin(req);
    const code = normalizeCode(rawCode);
    if (!code) throw new RoomError(400, 'invalid room code');
    const q = queryOf(req);
    const since = q.get('since') === null ? null : intParam(q.get('since'), 0, Number.MAX_SAFE_INTEGER, 0);
    const events = await opts.events.list(code, since, intParam(q.get('limit'), 1, 50_000, 10_000));
    sendJson(res, 200, { code, count: events.length, events });
  }

  /** GET /v1/rooms-analytics?days=30&code=XXXXXX (admin). */
  async function analytics(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
    if (method !== 'GET') { req.resume(); sendError(res, 405, 'use GET', { Allow: 'GET' }); return; }
    requireAdmin(req);
    const q = queryOf(req);
    const rawCode = q.get('code');
    const code = rawCode ? normalizeCode(rawCode) : null;
    if (rawCode && !code) throw new RoomError(400, 'invalid room code');
    const maxDays = Math.max(1, Math.round(opts.events.retentionMs / 86_400_000));
    sendJson(res, 200, await opts.events.analytics(intParam(q.get('days'), 1, maxDays, Math.min(30, maxDays)), code));
  }

  /** Serves the request when it is a rooms path (true); false = not ours, the proxy gets it. */
  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = (req.url ?? '/').split('?')[0]!;
    const isGet = method === 'GET' || method === 'HEAD';
    const run = (p: Promise<void>, where: string) => { p.catch((err: unknown) => fail(res, err, where)); return true; };

    const apiMatch = API_PATH.exec(path);
    if (apiMatch) return run(api(req, res, method, apiMatch[1]!, apiMatch[2]), 'api');
    if (ANALYTICS_PATH.test(path)) return run(analytics(req, res, method), 'analytics');
    if (!isGet) return false;
    const font = FONTS.get(FONT_PATH.exec(path)?.[1] ?? '');
    if (font) {
      res.writeHead(200, { 'Content-Type': 'font/woff2', 'Content-Length': font.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      res.end(method === 'HEAD' ? undefined : font);
      return true;
    }
    if (cfg.publicHost && hostOf(req) === cfg.publicHost) {
      if (path === '/') { sendPage(res, 200, entryPage({ basePath: '/', retentionDays })); return true; }
      const hostCode = HOST_CODE_PATH.exec(path)?.[1];
      // Only the room-code alphabet: "/health" and other 6-letter paths keep reaching the proxy.
      if (hostCode && normalizeCode(hostCode)) return run(page(req, res, hostCode, '/'), 'page');
    }
    if (path === '/live' || path === '/live/') { sendPage(res, 200, entryPage({ basePath: '/live/', retentionDays })); return true; }
    const liveCode = LIVE_PATH.exec(path)?.[1];
    if (liveCode) return run(page(req, res, liveCode, '/live/'), 'page');
    return false;
  }

  return { create, handle };
}
