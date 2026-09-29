/**
 * Unit tests for src/middleware/compression.ts
 *
 * Covers:
 *  - negotiateCompression() — content negotiation from Accept-Encoding
 *  - decompressRequest() — gzip/brotli decompression + size-limit guard
 *  - compressResponse() — threshold skip, gzip/brotli output, Vary header
 *  - createDecompressStream() — returns correct transform per encoding
 */

import { describe, it, expect, vi } from 'vitest';
import { gzip as gzipCb, brotliCompress as brotliCb } from 'zlib';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import {
  negotiateCompression,
  decompressRequest,
  compressResponse,
  createDecompressStream,
} from '../../src/middleware/compression';

const gzipAsync = promisify(gzipCb);
const brotliAsync = promisify(brotliCb);

// ──────────────────────────────────────────────────────────────────────────
// negotiateCompression
// ──────────────────────────────────────────────────────────────────────────

describe('negotiateCompression', () => {
  it('returns identity for empty string', () => {
    expect(negotiateCompression('')).toBe('identity');
  });

  it('returns identity for undefined-like falsy values', () => {
    expect(negotiateCompression(undefined as unknown as string)).toBe('identity');
  });

  it('prefers brotli over gzip when both present', () => {
    expect(negotiateCompression('gzip, br, deflate')).toBe('br');
  });

  it('returns br for br-only header', () => {
    expect(negotiateCompression('br')).toBe('br');
  });

  it('returns gzip for gzip-only header', () => {
    expect(negotiateCompression('gzip')).toBe('gzip');
  });

  it('returns identity for unsupported encoding', () => {
    expect(negotiateCompression('deflate, identity')).toBe('identity');
  });

  it('handles case where br appears as a substring of another word', () => {
    // 'brotli' contains 'br' — should still match as br
    expect(negotiateCompression('brotli')).toBe('br');
  });

  it('returns identity for *', () => {
    // * does not match 'br' or 'gzip' literally
    expect(negotiateCompression('*')).toBe('identity');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// decompressRequest
// ──────────────────────────────────────────────────────────────────────────

function makeFakeReq(contentEncoding: string): any {
  const em = new EventEmitter() as any;
  em.headers = { 'content-encoding': contentEncoding };
  return em;
}

describe('decompressRequest', () => {
  it('returns body unchanged for identity encoding', async () => {
    const req = makeFakeReq('identity');
    const body = Buffer.from('hello world');
    const result = await decompressRequest(req, body);
    expect(result).toEqual(body);
  });

  it('returns body unchanged when content-encoding is absent', async () => {
    const req = makeFakeReq('');
    const body = Buffer.from('raw');
    const result = await decompressRequest(req, body);
    expect(result).toEqual(body);
  });

  it('decompresses gzip-encoded body', async () => {
    const original = Buffer.from('gzip compressed payload');
    const compressed = await gzipAsync(original);
    const req = makeFakeReq('gzip');
    const result = await decompressRequest(req, compressed);
    expect(result.toString()).toBe('gzip compressed payload');
  });

  it('decompresses brotli-encoded body', async () => {
    const original = Buffer.from('brotli compressed payload');
    const compressed = await brotliAsync(original);
    const req = makeFakeReq('br');
    const result = await decompressRequest(req, compressed);
    expect(result.toString()).toBe('brotli compressed payload');
  });

  it('rejects a gzip body that expands beyond the size limit', async () => {
    // Build a payload that compresses well but expands over 100 bytes
    const bigPlaintext = Buffer.alloc(200, 0x41); // 200 × 'A'
    const compressed = await gzipAsync(bigPlaintext);
    const req = makeFakeReq('gzip');
    await expect(
      decompressRequest(req, compressed, { maxDecompressedBytes: 100 }),
    ).rejects.toThrow(/exceeds limit/i);
  });

  it('rejects a brotli body that expands beyond the size limit', async () => {
    const bigPlaintext = Buffer.alloc(200, 0x42); // 200 × 'B'
    const compressed = await brotliAsync(bigPlaintext);
    const req = makeFakeReq('br');
    await expect(
      decompressRequest(req, compressed, { maxDecompressedBytes: 100 }),
    ).rejects.toThrow(/exceeds limit/i);
  });

  it('accepts a body exactly at the size limit', async () => {
    const payload = Buffer.alloc(50, 0x43);
    const compressed = await gzipAsync(payload);
    const req = makeFakeReq('gzip');
    const result = await decompressRequest(req, compressed, { maxDecompressedBytes: 50 });
    expect(result.length).toBe(50);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// compressResponse
// ──────────────────────────────────────────────────────────────────────────

function makeFakeRes(): { headers: Record<string, string>; body: Buffer | null; ended: boolean; setHeader(n: string, v: string): void; end(b?: Buffer | string): void } {
  const r = {
    headers: {} as Record<string, string>,
    body: null as Buffer | null,
    ended: false,
    setHeader(name: string, value: string) { r.headers[name.toLowerCase()] = value; },
    end(b?: Buffer | string) { r.body = typeof b === 'string' ? Buffer.from(b) : (b ?? Buffer.alloc(0)); r.ended = true; },
  };
  return r;
}

describe('compressResponse', () => {
  it('skips compression for bodies below the threshold', async () => {
    const res = makeFakeRes() as any;
    const small = Buffer.from('tiny');
    await compressResponse(res, small, { threshold: 100, acceptEncoding: 'gzip' });
    expect(res.headers['content-encoding']).toBe('identity');
    expect(res.body).toEqual(small);
  });

  it('gzip-compresses a large body when client accepts gzip', async () => {
    const res = makeFakeRes() as any;
    const large = Buffer.alloc(2048, 0x41);
    await compressResponse(res, large, { acceptEncoding: 'gzip' });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['vary']).toBe('Accept-Encoding');
    // Compressed body should be smaller than raw for highly-repetitive data
    expect(res.body!.length).toBeLessThan(large.length);
  });

  it('brotli-compresses a large body when client accepts br', async () => {
    const res = makeFakeRes() as any;
    const large = Buffer.alloc(2048, 0x42);
    await compressResponse(res, large, { acceptEncoding: 'br' });
    expect(res.headers['content-encoding']).toBe('br');
    expect(res.headers['vary']).toBe('Accept-Encoding');
    expect(res.body!.length).toBeLessThan(large.length);
  });

  it('falls back to identity when brotli is disabled', async () => {
    const res = makeFakeRes() as any;
    const large = Buffer.alloc(2048, 0x43);
    await compressResponse(res, large, { acceptEncoding: 'br', brotli: false, gzip: false });
    expect(res.headers['content-encoding']).toBe('identity');
  });

  it('accepts string data and compresses it', async () => {
    const res = makeFakeRes() as any;
    const text = 'x'.repeat(2048);
    await compressResponse(res, text, { acceptEncoding: 'gzip' });
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('prefers brotli over gzip when both are accepted', async () => {
    const res = makeFakeRes() as any;
    const large = Buffer.alloc(2048, 0x44);
    await compressResponse(res, large, { acceptEncoding: 'gzip, br' });
    expect(res.headers['content-encoding']).toBe('br');
  });

  it('sends identity when no encoding is accepted', async () => {
    const res = makeFakeRes() as any;
    const large = Buffer.alloc(2048, 0x45);
    await compressResponse(res, large, { acceptEncoding: '' });
    expect(res.headers['content-encoding']).toBe('identity');
    expect(res.body).toEqual(large);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// createDecompressStream
// ──────────────────────────────────────────────────────────────────────────

describe('createDecompressStream', () => {
  it('returns a Transform for gzip encoding', () => {
    const s = createDecompressStream('gzip');
    expect(typeof s.pipe).toBe('function');
    s.destroy();
  });

  it('returns a Transform for br encoding', () => {
    const s = createDecompressStream('br');
    expect(typeof s.pipe).toBe('function');
    s.destroy();
  });

  it('returns a pass-through Transform for identity encoding', () => {
    const s = createDecompressStream('identity');
    expect(typeof s.pipe).toBe('function');
    // Pass-through: data written in should come out unchanged
    const chunks: Buffer[] = [];
    s.on('data', (c: Buffer) => chunks.push(c));
    s.write(Buffer.from('passthrough'));
    s.end();
    return new Promise<void>((resolve) => {
      s.on('end', () => {
        expect(Buffer.concat(chunks).toString()).toBe('passthrough');
        resolve();
      });
    });
  });

  it('returns a pass-through for an unknown encoding', () => {
    const s = createDecompressStream('deflate');
    expect(typeof s.pipe).toBe('function');
    s.destroy();
  });
});
