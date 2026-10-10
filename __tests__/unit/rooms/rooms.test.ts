/**
 * Live subtitle rooms (src/rooms, docs/rooms.md) behind a stand-in for serve.ts: a node:http server whose own listener
 * plays the proxy (API-key auth → 401, the `POST /v1/rooms` custom route, `/health`), with `createRooms(...).mount`
 * placed in front, as in production.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';
import { CODE_RE, FileRoomStore, MemoryRoomStore, createRooms, linesFromJsonl, type RoomStore, type RoomsConfig } from '../../../src/rooms';

const KEYS: Record<string, string> = { 'key-ucast': 'ucast', 'key-other': 'other', 'key-admin': 'admin' };
const DAY = 86_400_000;

interface Gw {
  url: string;
  server: Server;
  rooms: ReturnType<typeof createRooms>;
  clock: { now: number };
  close(): Promise<void>;
}

async function startGateway(config: Partial<RoomsConfig> = {}, store: RoomStore = new MemoryRoomStore()): Promise<Gw> {
  const clock = { now: Date.UTC(2026, 9, 10, 12) };
  const userOfToken = (t: string) => KEYS[t] ?? null;
  const rooms = createRooms({
    env: {},
    config: { dir: null, publicHost: 'live.ucast.me', publicBaseUrl: 'https://live.ucast.me', ...config },
    store,
    keyUser: (t) => { const u = userOfToken(t); return u ? { userId: u, admin: u === 'admin' } : null; },
    userOf: (req) => userOfToken(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')) ?? 'anonymous',
    now: () => clock.now,
    sweepIntervalMs: 0,
  });
  const server = createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); return; }
    const user = userOfToken(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    if (!user) { res.writeHead(401); res.end('{"error":"proxy auth"}'); return; }
    if (req.method === 'POST' && req.url === '/v1/rooms') { void rooms.route.handler(req, res); return; }
    res.writeHead(404); res.end('{"error":"proxy 404"}');
  });
  server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n'); });
  rooms.mount(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, server, rooms, clock,
    close: async () => {
      rooms.stop();
      server.closeAllConnections?.();
      await new Promise<void>(r => server.close(() => r()));
    },
  };
}

const json = { 'Content-Type': 'application/json' };

async function createRoom(gw: Gw, body: unknown = { title: 'Aula', originalLang: 'pt', languages: ['en', 'es'] }, key = 'key-ucast') {
  return fetch(`${gw.url}/v1/rooms`, { method: 'POST', headers: { ...json, Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
}

async function newRoom(gw: Gw): Promise<{ code: string; publishToken: string; url: string; expiresAt: string }> {
  const res = await createRoom(gw);
  expect(res.status).toBe(201);
  return res.json() as never;
}

function post(gw: Gw, code: string, action: string, body: unknown, token?: string) {
  return fetch(`${gw.url}/v1/rooms/${code}/${action}`, {
    method: 'POST', headers: { ...json, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
}

const line = (id: number, en = `hello ${id}`) => ({ id, original: `olá ${id}`, originalLang: 'pt', translations: { en, es: `hola ${id}` }, ts: 1_000 + id });

/** GET with an explicit Host header (fetch may not let a caller set it). */
function rawGet(gw: Gw, path: string, host: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  const { port } = new URL(gw.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A viewer socket collecting every JSON message. */
async function viewer(gw: Gw, code: string): Promise<{ ws: WebSocket; messages: Array<Record<string, unknown>>; next(type: string): Promise<Record<string, unknown>> }> {
  const ws = new WebSocket(`${gw.url.replace('http', 'ws')}/v1/rooms/${code}/ws`);
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (d) => { messages.push(JSON.parse(String(d)) as Record<string, unknown>); waiters.splice(0).forEach(w => w()); });
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const next = async (type: string) => {
    for (let i = 0; i < 100; i++) {
      const found = messages.find(m => m.type === type);
      if (found) { messages.splice(messages.indexOf(found), 1); return found; }
      await new Promise<void>(r => { waiters.push(r); setTimeout(r, 50); });
    }
    throw new Error(`no ${type} message`);
  };
  return { ws, messages, next };
}

function refusedStatus(gw: Gw, code: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${gw.url.replace('http', 'ws')}/v1/rooms/${code}/ws`);
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
    ws.on('open', () => { resolve(101); ws.close(); });
    ws.on('error', () => { /* reported by unexpected-response */ });
  });
}

describe('rooms API', () => {
  let gw: Gw;
  beforeEach(async () => { gw = await startGateway(); });
  afterEach(async () => { await gw.close(); });

  it('creates a room with a gateway key: 6-char code without ambiguous characters, token, public url, expiry', async () => {
    expect((await createRoom(gw, { languages: ['en'] }, 'nope')).status).toBe(401);
    const room = await newRoom(gw);
    expect(room.code).toMatch(CODE_RE);
    expect(room.code).not.toMatch(/[0O1IL]/);
    expect(room.publishToken.length).toBeGreaterThanOrEqual(24);
    expect(room.url).toBe(`https://live.ucast.me/${room.code}`);
    expect(Date.parse(room.expiresAt) - gw.clock.now).toBe(30 * DAY);
  });

  it('rejects a bad create body', async () => {
    expect((await createRoom(gw, { languages: 'en' })).status).toBe(400);
    expect((await createRoom(gw, { languages: ['not a lang'] })).status).toBe(400);
    expect((await createRoom(gw, { languages: ['en'], title: 'x'.repeat(500) })).status).toBe(400);
    const bad = await fetch(`${gw.url}/v1/rooms`, { method: 'POST', headers: { ...json, Authorization: 'Bearer key-ucast' }, body: '{nope' });
    expect(bad.status).toBe(400);
  });

  it('publishes lines with the publish token only (or the creating / an admin key); the transcript is public', async () => {
    const room = await newRoom(gw);
    expect((await post(gw, room.code, 'lines', line(1))).status).toBe(401);
    expect((await post(gw, room.code, 'lines', line(1), 'wrong-token')).status).toBe(401);
    expect((await post(gw, room.code, 'lines', line(1), 'key-other')).status).toBe(403);
    expect((await post(gw, room.code, 'lines', line(1), room.publishToken)).status).toBe(204);
    expect((await post(gw, room.code, 'lines', line(2), 'key-ucast')).status).toBe(204);
    expect((await post(gw, room.code, 'lines', line(3), 'key-admin')).status).toBe(204);

    const res = await fetch(`${gw.url}/v1/rooms/${room.code.toLowerCase()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ code: room.code, title: 'Aula', originalLang: 'pt', languages: ['en', 'es'], ended: false });
    expect(typeof body.createdAt).toBe('string');
    expect(body.lines).toEqual([line(1), line(2), line(3)]);
    expect(body).not.toHaveProperty('tokenHash');
    expect(body).not.toHaveProperty('ownerId');
  });

  it('is idempotent on the line id: a re-sent id replaces, out-of-order ids are kept in id order', async () => {
    const room = await newRoom(gw);
    for (const l of [line(1), line(3), line(1, 'hello again'), line(2)]) expect((await post(gw, room.code, 'lines', l, room.publishToken)).status).toBe(204);
    const body = await (await fetch(`${gw.url}/v1/rooms/${room.code}`)).json() as { lines: Array<{ id: number; translations: Record<string, string> }> };
    expect(body.lines.map(l => l.id)).toEqual([1, 2, 3]);
    expect(body.lines[0]!.translations.en).toBe('hello again');
  });

  it('validates lines and enforces the limits', async () => {
    await gw.close();
    gw = await startGateway({ maxLines: 2, maxFieldChars: 50, maxAudioBytes: 1024 });
    const room = await newRoom(gw);
    const t = room.publishToken;
    expect((await post(gw, room.code, 'lines', { id: 'x', original: 'a' }, t)).status).toBe(400);
    expect((await post(gw, room.code, 'lines', { id: 1, original: 'a', translations: { 'bad key': 'x' } }, t)).status).toBe(400);
    expect((await post(gw, room.code, 'lines', { id: 1, original: 'a'.repeat(51) }, t)).status).toBe(413);
    expect((await post(gw, room.code, 'lines', line(1), t)).status).toBe(204);
    expect((await post(gw, room.code, 'lines', line(2), t)).status).toBe(204);
    expect((await post(gw, room.code, 'lines', line(3), t)).status).toBe(409);
    expect((await post(gw, room.code, 'lines', line(2, 'replaced'), t)).status).toBe(204);
    expect((await post(gw, room.code, 'audio', { lineId: 1, lang: 'en', wav: Buffer.alloc(2048).toString('base64') }, t)).status).toBe(413);
    expect((await post(gw, room.code, 'audio', { lineId: 1, lang: 'en', wav: 'not base64!' }, t)).status).toBe(400);
    const big = await fetch(`${gw.url}/v1/rooms/${room.code}/lines`, {
      method: 'POST', headers: { ...json, Authorization: `Bearer ${t}` }, body: JSON.stringify({ id: 9, original: 'x'.repeat(300_000) }),
    });
    expect(big.status).toBe(413);
  });

  it('answers 404 for unknown codes, 405 for wrong methods, and ends a room (no publishing after)', async () => {
    expect((await fetch(`${gw.url}/v1/rooms/ZZZZZZ`)).status).toBe(404);
    expect((await fetch(`${gw.url}/v1/rooms/not-a-code`)).status).toBe(404);
    const room = await newRoom(gw);
    expect((await fetch(`${gw.url}/v1/rooms/${room.code}/lines`)).status).toBe(405);
    expect((await post(gw, room.code, 'end', {}, 'wrong')).status).toBe(401);
    expect((await post(gw, room.code, 'end', {}, room.publishToken)).status).toBe(204);
    expect((await post(gw, room.code, 'lines', line(1), room.publishToken)).status).toBe(409);
    const body = await (await fetch(`${gw.url}/v1/rooms/${room.code}`)).json() as { ended: boolean };
    expect(body.ended).toBe(true);
  });

  it('rate-limits room creation per key per hour', async () => {
    await gw.close();
    gw = await startGateway({ maxRoomsPerHour: 2 });
    expect((await createRoom(gw)).status).toBe(201);
    expect((await createRoom(gw)).status).toBe(201);
    const third = await createRoom(gw);
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBe('60');
    expect((await createRoom(gw, undefined, 'key-other')).status).toBe(201);
    gw.clock.now += 3_600_001;
    expect((await createRoom(gw)).status).toBe(201);
  });

  it('expires a room after the retention since its last activity', async () => {
    const room = await newRoom(gw);
    gw.clock.now += 29 * DAY;
    expect((await post(gw, room.code, 'lines', line(1), room.publishToken)).status).toBe(204);
    gw.clock.now += 29 * DAY;
    expect((await fetch(`${gw.url}/v1/rooms/${room.code}`)).status).toBe(200);
    gw.clock.now += 2 * DAY;
    expect((await fetch(`${gw.url}/v1/rooms/${room.code}`)).status).toBe(404);
    expect((await rawGet(gw, `/live/${room.code}`, 'example.com')).status).toBe(404);
  });

  it('sweeps expired rooms and evicts idle ones from memory', async () => {
    const a = await newRoom(gw);
    gw.clock.now += 20 * 60_000;
    const evicted = await gw.rooms.service.sweep();
    expect(evicted.evicted).toContain(a.code);
    expect((await fetch(`${gw.url}/v1/rooms/${a.code}`)).status).toBe(200);
    gw.clock.now += 31 * DAY;
    const swept = await gw.rooms.service.sweep();
    expect(swept.removed).toContain(a.code);
    expect((await fetch(`${gw.url}/v1/rooms/${a.code}`)).status).toBe(404);
  });
});

describe('rooms viewer WebSocket', () => {
  let gw: Gw;
  beforeEach(async () => { gw = await startGateway(); });
  afterEach(async () => { await gw.close(); });

  it('sends the snapshot, then live lines, audio clips and the end', async () => {
    const room = await newRoom(gw);
    await post(gw, room.code, 'lines', line(1), room.publishToken);
    const v = await viewer(gw, room.code);
    const snap = await v.next('snapshot');
    expect((snap.room as { lines: unknown[]; code: string }).lines).toEqual([line(1)]);
    expect((snap.room as { code: string }).code).toBe(room.code);

    expect((await post(gw, room.code, 'lines', line(2), room.publishToken)).status).toBe(204);
    expect((await v.next('line')).line).toEqual(line(2));

    const wav = Buffer.from('RIFF....WAVEfmt ').toString('base64');
    expect((await post(gw, room.code, 'audio', { lineId: 2, lang: 'en', wav }, room.publishToken)).status).toBe(204);
    expect(await v.next('audio')).toEqual({ type: 'audio', lineId: 2, lang: 'en', wav });

    v.ws.send(JSON.stringify({ type: 'ping' }));
    expect(await v.next('pong')).toEqual({ type: 'pong' });

    expect((await post(gw, room.code, 'end', {}, room.publishToken)).status).toBe(204);
    expect(await v.next('ended')).toEqual({ type: 'ended' });
    v.ws.close();
  });

  it('delivers audio only for the language a viewer listens to, once it says', async () => {
    const room = await newRoom(gw);
    const v = await viewer(gw, room.code);
    await v.next('snapshot');
    v.ws.send(JSON.stringify({ type: 'listen', lang: 'es' }));
    await new Promise(r => setTimeout(r, 50));
    const wav = Buffer.from('clip').toString('base64');
    await post(gw, room.code, 'audio', { lineId: 1, lang: 'en', wav }, room.publishToken);
    await post(gw, room.code, 'audio', { lineId: 1, lang: 'es', wav }, room.publishToken);
    expect(await v.next('audio')).toMatchObject({ lang: 'es' });
    expect(v.messages.filter(m => m.type === 'audio')).toHaveLength(0);
    v.ws.close();
  });

  it('refuses unknown rooms (404) and viewers over the limit (503)', async () => {
    expect(await refusedStatus(gw, 'ZZZZZZ')).toBe(404);
    await gw.close();
    gw = await startGateway({ maxViewers: 1 });
    const room = await newRoom(gw);
    const v = await viewer(gw, room.code);
    expect(await refusedStatus(gw, room.code)).toBe(503);
    v.ws.close();
  });

  it('leaves other WebSocket upgrades to the proxy', async () => {
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${gw.url.replace('http', 'ws')}/v1/other/ws`);
      ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
      ws.on('error', () => {});
    });
    expect(status).toBe(410);
  });
});

describe('rooms viewer pages', () => {
  let gw: Gw;
  beforeEach(async () => { gw = await startGateway(); });
  afterEach(async () => { await gw.close(); });

  it('serves the room page on the public host by code, and on /live/:code on any host', async () => {
    const room = await newRoom(gw);
    for (const [path, host] of [[`/${room.code}`, 'live.ucast.me'], [`/${room.code.toLowerCase()}`, 'LIVE.UCAST.ME:443'], [`/live/${room.code}`, 'parle-ai-gateway.up.railway.app']] as const) {
      const res = await rawGet(gw, path, host);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.headers['content-security-policy']).toMatch(/script-src 'nonce-/);
      expect(res.body).toContain('lang="pt-BR"');
      expect(res.body).toContain(`"${room.code}"`);
      expect(res.body).toContain('Ouvir dublagem');
      expect(res.body).not.toMatch(/<script[^>]+src=/);
    }
  });

  it('serves the code entry page and a Portuguese 404; leaves other paths to the proxy', async () => {
    const root = await rawGet(gw, '/', 'live.ucast.me');
    expect(root.status).toBe(200);
    expect(root.body).toContain('Digite o código da sessão');
    expect((await rawGet(gw, '/live', 'example.com')).body).toContain('Digite o código da sessão');
    const missing = await rawGet(gw, '/ZZZZZZ', 'live.ucast.me');
    expect(missing.status).toBe(404);
    expect(missing.body).toContain('Sessão não encontrada');
    expect((await rawGet(gw, '/live/nope', 'example.com')).status).toBe(404);
    // Not ours: the proxy answers.
    expect((await rawGet(gw, '/health', 'live.ucast.me')).body).toBe('{"status":"ok"}');
    expect((await rawGet(gw, '/', 'parle-ai-gateway.up.railway.app')).status).toBe(401);
    expect((await rawGet(gw, '/ABCDEF', 'parle-ai-gateway.up.railway.app')).status).toBe(401);
  });
});

describe('rooms file store', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rooms-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('persists rooms and lines across a restart (last record of an id wins) and deletes expired files', async () => {
    let gw = await startGateway({}, new FileRoomStore(dir));
    const room = await newRoom(gw);
    for (const l of [line(1), line(2), line(1, 'fixed')]) await post(gw, room.code, 'lines', l, room.publishToken);
    await post(gw, room.code, 'end', {}, room.publishToken);
    const now = gw.clock.now;
    await gw.close();

    gw = await startGateway({}, new FileRoomStore(dir));
    gw.clock.now = now;
    const body = await (await fetch(`${gw.url}/v1/rooms/${room.code}`)).json() as { ended: boolean; lines: Array<{ id: number; translations: Record<string, string> }> };
    expect(body.ended).toBe(true);
    expect(body.lines.map(l => l.id)).toEqual([1, 2]);
    expect(body.lines[0]!.translations.en).toBe('fixed');
    expect((await post(gw, room.code, 'end', {}, room.publishToken)).status).toBe(204);
    await gw.close();

    gw = await startGateway({}, new FileRoomStore(dir));
    gw.clock.now = Date.now() + 31 * DAY;
    const swept = await gw.rooms.service.sweep();
    expect(swept.removed).toEqual([room.code]);
    expect(readdirSync(dir).filter(n => n.startsWith(room.code))).toEqual([]);
    await gw.close();
  });

  it('reads back a lines file, skipping broken records', () => {
    const text = [JSON.stringify(line(2)), '{broken', JSON.stringify(line(1)), JSON.stringify(line(2, 'again')), ''].join('\n');
    expect(linesFromJsonl(text).map(l => [l.id, l.translations.en])).toEqual([[1, 'hello 1'], [2, 'again']]);
  });
});

describe('rooms line delayMs', () => {
  it('accepts an optional non-negative integer ≤ 120000, serves it in GET and WS lines, keeps it across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rooms-delay-'));
    try {
      let gw = await startGateway({}, new FileRoomStore(dir));
      const room = await newRoom(gw);
      const v = await viewer(gw, room.code);
      await v.next('snapshot');
      expect((await post(gw, room.code, 'lines', { ...line(1), delayMs: 1800 }, room.publishToken)).status).toBe(204);
      expect(((await v.next('line')).line as Record<string, unknown>).delayMs).toBe(1800);
      expect((await post(gw, room.code, 'lines', line(2), room.publishToken)).status).toBe(204); // still optional
      expect((await post(gw, room.code, 'lines', { ...line(3), delayMs: null }, room.publishToken)).status).toBe(204);
      for (const bad of [-1, 1.5, 120_001, '1800', true]) {
        const res = await post(gw, room.code, 'lines', { ...line(4), delayMs: bad }, room.publishToken);
        expect(res.status).toBe(400);
        expect(JSON.stringify(await res.json())).toMatch(/delayMs/);
      }
      expect((await post(gw, room.code, 'lines', { ...line(4), delayMs: 120_000 }, room.publishToken)).status).toBe(204);
      v.ws.close();
      const get = async () => (await (await fetch(`${gw.url}/v1/rooms/${room.code}`)).json()) as { lines: Array<Record<string, unknown>> };
      const check = (body: { lines: Array<Record<string, unknown>> }) => {
        expect(body.lines.map(l => l.delayMs)).toEqual([1800, undefined, undefined, 120_000]);
        expect('delayMs' in body.lines[1]!).toBe(false);
      };
      check(await get());
      await gw.close();
      gw = await startGateway({}, new FileRoomStore(dir));
      check(await get());
      await gw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});