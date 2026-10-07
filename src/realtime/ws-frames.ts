/**
 * Minimal RFC 6455 server side for the realtime WebSocket relay: the handshake answer and the frame codec, over the raw
 * socket the node:http `upgrade` event hands over. Written here instead of a library because the gateway runs on Bun,
 * whose `ws` is a shim of its own: this code behaves the same under Node (tests) and Bun ≥ 1.4.2 (production; Bun
 * 1.3.x never delivered bytes written to an upgraded node:http socket — checked 2026-10-07).
 *
 * Scope: text, binary, continuation, close, ping, pong; client frames must be masked; no extensions (no
 * permessage-deflate — PCM does not compress and the handshake does not offer it).
 */
import { createHash } from 'crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

export function handshakeResponse(key: string, headers: Record<string, string> = {}): string {
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  return 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n${extra}\r\n`;
}

/** A plain HTTP refusal on the upgrade socket (before the handshake). */
export function httpRefusal(status: number, message: string, headers: Record<string, string | number> = {}): string {
  const body = JSON.stringify({ error: { message, type: 'realtime_ws' } });
  const reason = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 410: 'Gone', 502: 'Bad Gateway', 503: 'Service Unavailable' }[status] ?? 'Error';
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  return `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`
    + `Access-Control-Allow-Origin: *\r\n${extra}Connection: close\r\n\r\n${body}`;
}

/** One frame. Server frames are unmasked; `mask` (4 bytes) is for tests playing the client. */
export function encodeFrame(opcode: number, payload: Uint8Array = new Uint8Array(0), mask?: Uint8Array): Buffer {
  const len = payload.length;
  const ext = len < 126 ? 0 : len < 65_536 ? 2 : 8;
  const head = Buffer.alloc(2 + ext + (mask ? 4 : 0));
  head[0] = 0x80 | (opcode & 0x0f);
  const maskBit = mask ? 0x80 : 0;
  if (ext === 0) head[1] = maskBit | len;
  else if (ext === 2) { head[1] = maskBit | 126; head.writeUInt16BE(len, 2); }
  else { head[1] = maskBit | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  if (!mask) return Buffer.concat([head, payload]);
  mask.forEach((b, i) => { head[2 + ext + i] = b; });
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i]! ^= mask[i & 3]!;
  return Buffer.concat([head, body]);
}

export function closePayload(code: number, reason = ''): Buffer {
  const text = Buffer.from(reason.slice(0, 120), 'utf8');
  const out = Buffer.alloc(2 + text.length);
  out.writeUInt16BE(code, 0);
  text.copy(out, 2);
  return out;
}

export type WsMessage =
  | { kind: 'text'; data: Buffer }
  | { kind: 'binary'; data: Buffer }
  | { kind: 'ping'; data: Buffer }
  | { kind: 'pong'; data: Buffer }
  | { kind: 'close'; code: number; reason: string };

export class WsProtocolError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

/**
 * Incremental parser of client frames: feed socket chunks, get whole messages (fragments reassembled). Throws
 * `WsProtocolError` (with the close code to send) on a protocol violation or a message over `maxMessageBytes`.
 */
export class WsFrameParser {
  private buf = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentKind: 'text' | 'binary' | null = null;
  private fragmentBytes = 0;

  constructor(private readonly maxMessageBytes = 1024 * 1024, private readonly requireMask = true) {}

  push(chunk: Uint8Array): WsMessage[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out: WsMessage[] = [];
    for (;;) {
      const frame = this.nextFrame();
      if (!frame) break;
      const msg = this.assemble(frame.fin, frame.opcode, frame.payload);
      if (msg) out.push(msg);
    }
    return out;
  }

  private nextFrame(): { fin: boolean; opcode: number; payload: Buffer } | null {
    if (this.buf.length < 2) return null;
    const b0 = this.buf[0]!, b1 = this.buf[1]!;
    if (b0 & 0x70) throw new WsProtocolError(1002, 'reserved bits set (no extension negotiated)');
    const masked = (b1 & 0x80) !== 0;
    if (this.requireMask && !masked) throw new WsProtocolError(1002, 'client frames must be masked');
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (this.buf.length < 4) return null;
      len = this.buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (this.buf.length < 10) return null;
      const big = this.buf.readBigUInt64BE(2);
      if (big > BigInt(this.maxMessageBytes)) throw new WsProtocolError(1009, 'frame too large');
      len = Number(big);
      offset = 10;
    }
    if (len > this.maxMessageBytes) throw new WsProtocolError(1009, 'frame too large');
    const maskAt = offset;
    if (masked) offset += 4;
    if (this.buf.length < offset + len) return null;
    const payload = Buffer.from(this.buf.subarray(offset, offset + len));
    if (masked) for (let i = 0; i < payload.length; i++) payload[i]! ^= this.buf[maskAt + (i & 3)]!;
    this.buf = this.buf.subarray(offset + len);
    return { fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload };
  }

  private assemble(fin: boolean, opcode: number, payload: Buffer): WsMessage | null {
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) throw new WsProtocolError(1002, 'bad control frame');
      if (opcode === OP.close) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        return { kind: 'close', code, reason: payload.subarray(2).toString('utf8') };
      }
      if (opcode === OP.ping) return { kind: 'ping', data: payload };
      if (opcode === OP.pong) return { kind: 'pong', data: payload };
      throw new WsProtocolError(1002, `unknown control opcode ${opcode}`);
    }
    if (opcode === OP.continuation) {
      if (!this.fragmentKind) throw new WsProtocolError(1002, 'continuation without a first fragment');
    } else if (opcode === OP.text || opcode === OP.binary) {
      if (this.fragmentKind) throw new WsProtocolError(1002, 'new message inside a fragmented one');
      this.fragmentKind = opcode === OP.text ? 'text' : 'binary';
    } else {
      throw new WsProtocolError(1002, `unknown opcode ${opcode}`);
    }
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.maxMessageBytes) throw new WsProtocolError(1009, 'message too large');
    this.fragments.push(payload);
    if (!fin) return null;
    const kind = this.fragmentKind!;
    const data = this.fragments.length === 1 ? this.fragments[0]! : Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentKind = null;
    this.fragmentBytes = 0;
    return { kind, data };
  }
}
