/**
 * Request/response compression middleware.
 *
 * Supports gzip and brotli for response compression.
 * Decompresses gzip/brotli request bodies.
 *
 * @example
 * ```ts
 * import { compressResponse, decompressRequest } from './compression';
 *
 * // In request handler:
 * const body = await decompressRequest(req);
 * // ... process ...
 * await compressResponse(res, data);
 * ```
 */

import { createGunzip, createGzip, gzip, gunzip, createBrotliDecompress, brotliCompress } from 'zlib';
import type { IncomingMessage, ServerResponse } from 'http';
import { Transform } from 'stream';

export type CompressionAlgorithm = 'gzip' | 'br' | 'identity';

export interface CompressionOptions {
  /** Minimum response size to compress (default: 1024 bytes) */
  threshold?: number;
  /** Enable brotli (default: true) */
  brotli?: boolean;
  /** Enable gzip (default: true) */
  gzip?: boolean;
  /** Gzip compression level 1-9 (default: 6) */
  gzipLevel?: number;
}

const DEFAULT_OPTIONS: Required<CompressionOptions> = {
  threshold: 1024,
  brotli: true,
  gzip: true,
  gzipLevel: 6,
};

/**
 * Determine the best compression algorithm from Accept-Encoding header.
 */
export function negotiateCompression(acceptEncoding: string): CompressionAlgorithm {
  if (!acceptEncoding) return 'identity';

  // Prefer brotli over gzip
  if (acceptEncoding.includes('br')) return 'br';
  if (acceptEncoding.includes('gzip')) return 'gzip';

  return 'identity';
}

/**
 * Compress response body and set appropriate headers.
 */
export async function compressResponse(
  res: ServerResponse,
  data: Buffer | string,
  options: CompressionOptions & { acceptEncoding?: string } = {},
): Promise<void> {
  const opts: Required<CompressionOptions> = { ...DEFAULT_OPTIONS, ...options };
  const buf = typeof data === 'string' ? Buffer.from(data) : data;

  // Skip compression for small responses
  if (buf.length < opts.threshold) {
    res.setHeader('Content-Encoding', 'identity');
    res.end(buf);
    return;
  }

  // Accept-Encoding comes from REQUEST, not response. Previously read from
  // res.getHeader() which always returned undefined → middleware silently
  // emitted identity for every response. Caller must pass the request's
  // Accept-Encoding via options.acceptEncoding (or attach it to res via a
  // synthetic header before calling — kept for backward compat).
  const acceptEncoding = options.acceptEncoding
    ?? (res.getHeader('Accept-Encoding') as string | undefined)
    ?? '';
  const algorithm = negotiateCompression(acceptEncoding);

  if (algorithm === 'br' && opts.brotli) {
    try {
      const compressed = await new Promise<Buffer>((resolve, reject) => {
        brotliCompress(buf, {}, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
      res.setHeader('Content-Encoding', 'br');
      res.setHeader('Vary', 'Accept-Encoding');
      res.end(compressed);
      return;
    } catch {
      // Fallback to gzip if brotli fails
    }
  }

  if (algorithm === 'gzip' && opts.gzip) {
    try {
      const compressed = await new Promise<Buffer>((resolve, reject) => {
        gzip(buf, { level: opts.gzipLevel }, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.end(compressed);
      return;
    } catch {
      // Fallback to uncompressed
    }
  }

  // No compression
  res.setHeader('Content-Encoding', 'identity');
  res.end(buf);
}

/**
 * Decompress request body based on Content-Encoding header.
 */
export async function decompressRequest(req: IncomingMessage, body: Buffer, opts?: { maxDecompressedBytes?: number }): Promise<Buffer> {
  const encoding = (req.headers['content-encoding'] ?? '').toLowerCase();
  // Decompression bomb guard — a 1KB gzip body can expand to gigabytes.
  // Default cap 50MB matches MAX_BODY_BYTES; callers can override.
  const maxBytes = opts?.maxDecompressedBytes ?? 50 * 1024 * 1024;

  if (encoding.includes('br')) {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const decompressor = createBrotliDecompress();

      decompressor.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          decompressor.destroy(new Error(`Decompressed body exceeds limit (${maxBytes} bytes)`));
          return;
        }
        chunks.push(chunk);
      });
      decompressor.on('end', () => resolve(Buffer.concat(chunks)));
      decompressor.on('error', reject);

      decompressor.end(body);
    });
  }

  if (encoding.includes('gzip')) {
    return new Promise<Buffer>((resolve, reject) => {
      const decompressor = createGunzip();
      const chunks: Buffer[] = [];
      let total = 0;
      decompressor.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          decompressor.destroy(new Error(`Decompressed body exceeds limit (${maxBytes} bytes)`));
          return;
        }
        chunks.push(chunk);
      });
      decompressor.on('end', () => resolve(Buffer.concat(chunks)));
      decompressor.on('error', reject);
      decompressor.end(body);
    });
  }

  return body;
}

/**
 * Stream-based decompression for large request bodies.
 */
export function createDecompressStream(encoding: string): import('stream').Transform {
  if (encoding.includes('br')) {
    return createBrotliDecompress() as unknown as import('stream').Transform;
  }

  if (encoding.includes('gzip')) {
    return createGunzip() as unknown as import('stream').Transform;
  }

  // Pass-through stream for identity
  return new Transform({
    transform(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null, data?: unknown) => void,
    ) {
      this.push(chunk);
      callback();
    },
  });
}
