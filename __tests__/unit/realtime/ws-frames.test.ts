/** RFC 6455 codec of the relay (src/realtime/ws-frames.ts). */
import { describe, expect, it } from 'vitest';
import { OP, WsFrameParser, WsProtocolError, acceptKey, closePayload, encodeFrame } from '../../../src/realtime/ws-frames';

const MASK = new Uint8Array([1, 2, 3, 4]);

describe('ws-frames', () => {
  it('computes the RFC 6455 accept key (spec example)', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('parses masked frames of every length class, split across chunks', () => {
    const p = new WsFrameParser(1 << 20);
    const sizes = [0, 125, 126, 65_535, 65_536, 200_000];
    const wire = Buffer.concat(sizes.map(n => encodeFrame(OP.binary, Buffer.alloc(n, n % 251), MASK)));
    const out = [];
    for (let i = 0; i < wire.length; i += 777) out.push(...p.push(wire.subarray(i, i + 777)));
    expect(out.map(m => (m.kind === 'binary' ? m.data.length : -1))).toEqual(sizes);
    expect(out.every(m => m.kind === 'binary' && m.data.every(b => b === m.data.length % 251))).toBe(true);
  });

  it('reassembles fragments, passes control frames between them, decodes close', () => {
    const p = new WsFrameParser();
    const first = encodeFrame(OP.text, Buffer.from('hel'), MASK);
    first[0] = first[0]! & 0x7f; // FIN off
    const ping = encodeFrame(OP.ping, Buffer.from('p'), MASK);
    const last = encodeFrame(OP.continuation, Buffer.from('lo'), MASK);
    const close = encodeFrame(OP.close, closePayload(4001, 'bye'), MASK);
    const out = p.push(Buffer.concat([first, ping, last, close]));
    expect(out).toEqual([
      { kind: 'ping', data: Buffer.from('p') },
      { kind: 'text', data: Buffer.from('hello') },
      { kind: 'close', code: 4001, reason: 'bye' },
    ]);
  });

  it('rejects unmasked client frames, oversize messages and stray continuations', () => {
    expect(() => new WsFrameParser().push(encodeFrame(OP.text, Buffer.from('x')))).toThrow(WsProtocolError);
    try { new WsFrameParser(10).push(encodeFrame(OP.binary, Buffer.alloc(11), MASK)); } catch (err) { expect((err as WsProtocolError).code).toBe(1009); }
    expect(() => new WsFrameParser().push(encodeFrame(OP.continuation, Buffer.from('x'), MASK))).toThrow(/continuation/);
  });
});
