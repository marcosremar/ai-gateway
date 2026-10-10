// ── AI Gateway — Live subtitle rooms: viewer WebSocket ───────────────────────
// `GET /v1/rooms/:code/ws`, public. Reuses the realtime relay's RFC 6455 codec (src/realtime/ws-frames.ts), which
// works on the node:http upgrade socket under Bun ≥ 1.4.2 and Node alike.
//
// Server → client: {"type":"snapshot","room"} on connect, then "line" / "audio" / "ended" (and "pong").
// Client → server: {"type":"ping"}; optional {"type":"listen","lang":"en"|null} — once sent, audio clips are
// delivered only for that language (null = none), so viewers who are not listening do not download the dubbing.

import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import {
  OP, WsFrameParser, WsProtocolError, closePayload, encodeFrame, handshakeResponse, httpRefusal,
} from '../realtime/ws-frames';
import type { RoomService, RoomViewer } from './service';
import { normalizeCode } from './validate';

export const ROOM_WS_PATH = /^\/v1\/rooms\/([A-Za-z0-9]{1,16})\/ws\/?$/;
const MAX_CLIENT_MESSAGE = 4 * 1024;
/** A viewer that stops reading (its socket buffer over this) is dropped: live subtitles that late are useless. */
const MAX_BACKLOG = 16 * 1024 * 1024;
/** Under Railway's / Cloudflare's idle cuts. */
const KEEPALIVE_MS = 25_000;

export function createRoomWs(service: RoomService, log: (msg: string, data?: Record<string, unknown>) => void = () => {}) {
  /** Handles the upgrade when the path is a room WS; false otherwise (the next listener gets it). */
  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const path = (req.url ?? '/').split('?')[0]!;
    const match = ROOM_WS_PATH.exec(path);
    if (!match) return false;
    socket.on('error', () => socket.destroy());
    void accept(req, socket, head, match[1]!).catch((err: unknown) => {
      log('rooms: ws upgrade failed', { error: err instanceof Error ? err.message : String(err) });
      if (socket.writable) socket.end(httpRefusal(503, 'room unavailable'));
    });
    return true;
  }

  async function accept(req: IncomingMessage, socket: Duplex, head: Buffer, rawCode: string): Promise<void> {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') { socket.end(httpRefusal(400, 'not a WebSocket 13 upgrade')); return; }
    const code = normalizeCode(rawCode);
    const room = code ? await service.get(code) : null;
    if (!room) { socket.end(httpRefusal(404, 'room not found or expired')); return; }
    if (socket.destroyed) return;

    let closed = false;
    let listen: string | null | undefined;
    const parser = new WsFrameParser(MAX_CLIENT_MESSAGE);
    const write = (opcode: number, payload: Uint8Array) => {
      if (closed || !socket.writable) return;
      if (((socket as { writableLength?: number }).writableLength ?? 0) > MAX_BACKLOG) { shutdown(1013, 'viewer not reading'); return; }
      socket.write(encodeFrame(opcode, payload));
    };
    const viewer: RoomViewer = {
      send: (text) => write(OP.text, Buffer.from(text, 'utf8')),
      close: (c, reason) => shutdown(c, reason),
      wantsAudio: (lang) => listen === undefined || listen === lang,
    };
    if (!service.addViewer(room, viewer)) { socket.end(httpRefusal(503, 'room is at its viewer limit', { 'Retry-After': 30 })); return; }

    const keepalive = setInterval(() => write(OP.ping, new Uint8Array(0)), KEEPALIVE_MS);
    keepalive.unref?.();
    function shutdown(c: number, reason: string): void {
      if (closed) return;
      const wire = c >= 1000 && c < 5000 && c !== 1005 && c !== 1006 && c !== 1015 ? c : 1000;
      if (socket.writable) socket.write(encodeFrame(OP.close, closePayload(wire, reason)));
      closed = true;
      clearInterval(keepalive);
      service.removeViewer(room!, viewer);
      socket.end();
      setTimeout(() => socket.destroy(), 1_000).unref?.();
    }

    const onMessage = (data: Buffer) => {
      let msg: { type?: unknown; lang?: unknown };
      try { msg = JSON.parse(data.toString('utf8')) as typeof msg; } catch { return; }
      if (msg?.type === 'ping') viewer.send('{"type":"pong"}');
      else if (msg?.type === 'listen') listen = typeof msg.lang === 'string' ? msg.lang : null;
    };
    const onData = (chunk: Buffer) => {
      let messages;
      try { messages = parser.push(chunk); } catch (err) {
        shutdown(err instanceof WsProtocolError ? err.code : 1002, (err as Error).message);
        return;
      }
      for (const m of messages) {
        if (closed) return;
        if (m.kind === 'text') onMessage(m.data);
        else if (m.kind === 'ping') write(OP.pong, m.data);
        else if (m.kind === 'close') { shutdown(m.code, ''); return; }
      }
    };

    (socket as { setTimeout?: (ms: number) => void }).setTimeout?.(0);
    (socket as { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true);
    socket.write(handshakeResponse(key));
    socket.on('data', onData);
    socket.on('close', () => shutdown(1001, 'viewer went away'));
    viewer.send(JSON.stringify({ type: 'snapshot', room: service.publicView(room) }));
    if (room.meta.ended) viewer.send('{"type":"ended"}');
    if (head.length) onData(head);
  }

  return { handleUpgrade };
}
