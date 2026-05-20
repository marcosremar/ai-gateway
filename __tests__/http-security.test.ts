/**
 * HTTP Security & Limits — Integration Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PassThrough } from 'stream';
import { getRouteBodyLimit, readRawBody } from '../server/http-utils';
import type { IncomingMessage, ServerResponse } from 'http';

const readSource = (file: string) => readFileSync(join(__dirname, '..', file), 'utf-8');

describe('HTTP Body Size Limits', () => {
  it('should define per-route limits for text endpoints', () => {
    const source = readSource('server/http-utils.ts');
    expect(source).toContain('ROUTE_MAX_BYTES');
    expect(source).toContain('/v1/translate');
    expect(source).toContain('/v1/chat/completions');
    expect(source).toContain('/v1/config/providers');
    expect(source).toContain('/v1/config/api-keys');
  });

  it('should use route-specific limit in readRawBody', () => {
    const source = readSource('server/http-utils.ts');
    expect(source).toContain('routeLimit');
    expect(source).toContain("req.url?.split('?')[0]");
  });

  it('should have RAW_BODY_TIMEOUT >= 60 seconds', () => {
    const source = readSource('server/http-utils.ts');
    // Match RAW_BODY_TIMEOUT_MS = 120_000 (supports underscore separator)
    const match = source.match(/RAW_BODY_TIMEOUT_MS\s*=\s*([\d_]+)/);
    expect(match).not.toBeNull();
    const timeout = parseInt(match![1].replace(/_/g, ''), 10);
    expect(timeout).toBeGreaterThanOrEqual(60_000);
  });

  it('uses the strict route limit even when the URL has a query string', () => {
    expect(getRouteBodyLimit('/v1/chat/completions')).toBe(1024 * 1024);

    const req = new PassThrough() as IncomingMessage;
    req.url = '/v1/chat/completions?debug=true';
    req.headers = { 'content-length': String(1024 * 1024 + 1) };

    const res = {
      headersSent: false,
      writeHead: vi.fn(function (this: { headersSent: boolean }) {
        this.headersSent = true;
      }),
      end: vi.fn(),
    } as unknown as ServerResponse;

    expect(readRawBody(req, res)).toBeNull();
    expect(res.writeHead).toHaveBeenCalledWith(413, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(expect.stringContaining('PAYLOAD_TOO_LARGE'));
  });

  it('rejects streamed bodies that exceed the route limit without content-length', async () => {
    const req = new PassThrough() as IncomingMessage;
    req.url = '/v1/config/api-keys';
    req.headers = {};

    const body = readRawBody(req);
    expect(body).not.toBeNull();

    req.write(Buffer.alloc(64 * 1024));
    req.write(Buffer.alloc(1));

    await expect(body).rejects.toThrow('Request body too large (>64KB)');
  });
});
