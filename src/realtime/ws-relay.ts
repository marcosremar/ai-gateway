/**
 * `GET /v1/realtime/ws?token=…` — the WebSocket rung of the ladder, relayed by the gateway to the session's replica
 * (`/__aigw/rt/ws?token=…`, ws:// or wss:// following `replicaBase`), frames passed through untouched both ways:
 * text = JSON events / control messages, binary = audio (1-byte header 0x01 + PCM16 LE mono; 16 kHz up, 24 kHz down).
 *
 * The upstream connection opens first: a replica that refuses or is gone answers the browser with a plain HTTP error
 * before any handshake, so the SDK falls to the next rung at once.
 *
 * Backpressure: browser → replica, the browser socket is paused while the upstream buffer is over `HIGH_WATER` and
 * resumed under `LOW_WATER`; replica → browser, a browser that does not read (its socket buffer over `MAX_BACKLOG`, ~20 s
 * of 24 kHz audio) is closed with 1013, since audio that late is useless. Close codes and reasons cross both ways.
 */
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import NodeWebSocket from 'ws';
import type { RealtimeService } from './service';
import { TRACE_ID_HEADER, childTraceparent, traceOf } from './trace';
import {
  OP, WsFrameParser, WsProtocolError, closePayload, encodeFrame, handshakeResponse, httpRefusal,
} from './ws-frames';

export const WS_PATH = '/v1/realtime/ws';
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const MAX_BACKLOG = 1024 * 1024;
const MAX_MESSAGE = 1024 * 1024;
const UPSTREAM_CONNECT_MS = 5_000;
const KEEPALIVE_MS = 20_000;

/** The subset of the WHATWG WebSocket the relay uses (Bun's global, or the `ws` package under Node). */
interface Upstream {
  binaryType: string;
  readonly bufferedAmount: number;
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type UpstreamFactory = (url: string, headers: Record<string, string>) => Upstream;

/** Bun's global WebSocket takes `{ headers }`; under Node the `ws` package does. */
export const defaultUpstream: UpstreamFactory = (url, headers) => {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
    return new (WebSocket as unknown as new (u: string, o: { headers: Record<string, string> }) => Upstream)(url, { headers });
  }
  return new NodeWebSocket(url, { headers, maxPayload: MAX_MESSAGE }) as unknown as Upstream;
};

export interface WsRelayOptions {
  upstream?: UpstreamFactory;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

/** Closes codes a peer may send on the wire (1005/1006/1015 are local-only). */
const wireCode = (code: number) => (code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 && code !== 1015 ? code : 1000);

function refuse(socket: Duplex, status: number, message: string, headers: Record<string, string | number> = {}): void {
  socket.end(httpRefusal(status, message, headers));
}

export function createWsRelay(service: RealtimeService, opts: WsRelayOptions = {}) {
  const open = opts.upstream ?? defaultUpstream;
  const log = opts.log ?? (() => {});
  let active = 0;

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? '/', 'http://gateway');
    if (url.pathname !== WS_PATH) return false;
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') { refuse(socket, 400, 'not a WebSocket 13 upgrade'); return true; }
    const token = url.searchParams.get('token') ?? '';
    const trace = traceOf(req);
    const traceHeader = { [TRACE_ID_HEADER]: trace.traceId };
    const session = service.resolveToken(token);
    if ('status' in session) {
      service.emit(trace, 'ws.refused', { level: 'warn', attrs: { status: session.status, code: session.code } });
      refuse(socket, session.status, session.message, traceHeader);
      return true;
    }
    const startedAt = Date.now();

    const target = `${session.base.replace(/^http/, 'ws')}/__aigw/rt/ws?token=${encodeURIComponent(token)}`;
    let upstream: Upstream;
    try { upstream = open(target, { 'X-Aigw-Token': session.replicaToken, traceparent: childTraceparent(trace) }); } catch (err) {
      refuse(socket, 502, `replica unreachable: ${(err as Error).message}`, traceHeader);
      return true;
    }
    upstream.binaryType = 'arraybuffer';
    (socket as { setTimeout?: (ms: number) => void }).setTimeout?.(0);
    (socket as { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true);
    const sid = session.claims.sid;
    let opened = false;
    let closed = false;
    const early: Buffer[] = head.length ? [Buffer.from(head)] : [];
    const collectEarly = (c: Buffer) => { early.push(c); };
    socket.on('data', collectEarly);
    const connectTimer = setTimeout(() => {
      if (opened) return;
      closed = true;
      try { upstream.close(); } catch { /* not open */ }
      refuse(socket, 504, 'replica did not accept the WebSocket in time', traceHeader);
    }, UPSTREAM_CONNECT_MS);

    const parser = new WsFrameParser(MAX_MESSAGE);
    let paused = false;
    let drainTimer: ReturnType<typeof setInterval> | null = null;
    let keepalive: ReturnType<typeof setInterval> | null = null;

    const shutdown = (code: number, reason: string, from: 'client' | 'upstream' | 'relay') => {
      if (closed) return;
      closed = true;
      active--;
      if (drainTimer) clearInterval(drainTimer);
      if (keepalive) clearInterval(keepalive);
      if (from !== 'upstream') { try { upstream.close(wireCode(code), reason.slice(0, 120)); } catch { /* gone */ } }
      // To the client: our close, or the echo of its own (RFC 6455 §5.5.1).
      if (socket.writable) socket.write(encodeFrame(OP.close, closePayload(wireCode(code), reason)));
      socket.end();
      setTimeout(() => socket.destroy(), 1_000).unref?.();
      log('realtime: ws relay closed', { sid, code, reason: reason.slice(0, 80), from });
      service.emit(trace, 'ws.close', { level: code === 1000 ? 'info' : 'warn', sessionId: sid, durMs: Date.now() - startedAt, attrs: { code, from } });
    };

    const toClient = (opcode: number, payload: Uint8Array) => {
      if (closed || !socket.writable) return;
      if ((socket as { writableLength?: number }).writableLength! > MAX_BACKLOG) { shutdown(1013, 'client not reading (relay backlog)', 'relay'); return; }
      socket.write(encodeFrame(opcode, payload));
    };

    const onClientData = (chunk: Buffer) => {
      let messages;
      try { messages = parser.push(chunk); } catch (err) {
        const code = err instanceof WsProtocolError ? err.code : 1002;
        shutdown(code, (err as Error).message, 'relay');
        return;
      }
      for (const m of messages) {
        if (closed) return;
        if (m.kind === 'text') upstream.send(m.data.toString('utf8'));
        else if (m.kind === 'binary') upstream.send(new Uint8Array(m.data));
        else if (m.kind === 'ping') toClient(OP.pong, m.data);
        else if (m.kind === 'close') { shutdown(m.code, m.reason, 'client'); return; }
      }
      if (!paused && upstream.bufferedAmount > HIGH_WATER) {
        paused = true;
        socket.pause();
        drainTimer = setInterval(() => {
          if (upstream.bufferedAmount > LOW_WATER) return;
          paused = false;
          if (drainTimer) clearInterval(drainTimer);
          drainTimer = null;
          socket.resume();
        }, 20);
      }
    };

    upstream.onopen = () => {
      if (closed) return;
      opened = true;
      active++;
      clearTimeout(connectTimer);
      socket.write(handshakeResponse(key, traceHeader));
      socket.off('data', collectEarly);
      socket.on('data', onClientData);
      service.settle(sid);
      keepalive = setInterval(() => toClient(OP.ping, new Uint8Array(0)), KEEPALIVE_MS);
      keepalive.unref?.();
      log('realtime: ws relay open', { sid, replica: session.replicaId });
      service.emit(trace, 'ws.open', { sessionId: sid, durMs: Date.now() - startedAt, attrs: { replica: session.replicaId } });
      for (const c of early.splice(0)) onClientData(c);
    };
    upstream.onmessage = (ev) => {
      const d = ev.data;
      if (typeof d === 'string') toClient(OP.text, Buffer.from(d, 'utf8'));
      else if (d instanceof ArrayBuffer) toClient(OP.binary, new Uint8Array(d));
      else if (ArrayBuffer.isView(d)) toClient(OP.binary, new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
    };
    upstream.onclose = (ev) => {
      if (!opened) {
        clearTimeout(connectTimer);
        if (!closed) {
          closed = true;
          service.emit(trace, 'ws.refused', { level: 'warn', sessionId: sid, attrs: { status: 502, code: ev.code } });
          refuse(socket, 502, `replica refused the WebSocket (${ev.code})`, traceHeader);
        }
        return;
      }
      shutdown(ev.code, ev.reason || 'replica closed', 'upstream');
    };
    upstream.onerror = () => {
      if (!opened) {
        clearTimeout(connectTimer);
        if (!closed) {
          closed = true;
          service.emit(trace, 'ws.refused', { level: 'warn', sessionId: sid, attrs: { status: 502, code: 'unreachable' } });
          refuse(socket, 502, 'replica unreachable', traceHeader);
        }
        try { upstream.close(); } catch { /* never opened */ }
        return;
      }
      shutdown(1011, 'replica connection error', 'upstream');
    };
    socket.on('error', () => { if (opened) shutdown(1006, 'client socket error', 'client'); else { closed = true; try { upstream.close(); } catch { /* */ } } });
    socket.on('close', () => { if (opened) shutdown(1001, 'client went away', 'client'); else if (!closed) { closed = true; clearTimeout(connectTimer); try { upstream.close(); } catch { /* */ } } });
    return true;
  }

  return { handleUpgrade, get active() { return active; } };
}
