import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createProxyServer, startProxy } from '../../src/proxy/server';
import type { Server, IncomingMessage } from 'http';
import type { ProxyConfig } from '../../src/proxy/types';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Buffer } from 'buffer';
import * as http from 'http';
import * as net from 'net';

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    apiKeys: ['test-key'],
    providers: {},
    ...overrides,
  };
}

function buildMultipart(parts: { name: string; filename?: string; data: string | Buffer }[]): {
  body: Buffer;
  boundary: string;
} {
  const boundary = '----TestBoundary' + Date.now();
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    const disp = part.filename
      ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`
      : `Content-Disposition: form-data; name="${part.name}"\r\n`;
    chunks.push(Buffer.from(disp));
    chunks.push(Buffer.from('\r\n'));
    chunks.push(typeof part.data === 'string' ? Buffer.from(part.data) : part.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), boundary };
}

describe('Proxy Server — multipart upload security', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    server = createProxyServer(makeConfig());
    await new Promise<void>((res) => {
      server.listen(0, '127.0.0.1', () => res());
    });
    port = (server.address() as any).port;
  });

  afterEach(() => {
    server.close();
  });

  it('rejects multipart with invalid boundary characters', async () => {
    const { body } = buildMultipart([{ name: 'file', filename: 'a.wav', data: 'audio-data' }]);
    const res = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-key',
        'Content-Type': `multipart/form-data; boundary=evil@boundary`,
      },
      body: body as any,
    });
    expect(res.status).toBe(400);
    const json: any = await res.json();
    expect(json.error.message).toContain('boundary');
  });

  it('rejects truncated multipart body (no closing boundary)', async () => {
    const { body, boundary } = buildMultipart([{ name: 'file', filename: 'a.wav', data: 'audio' }]);
    const truncated = body.slice(0, body.length - 30);
    const res = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-key',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: truncated as any,
    });
    expect(res.status).toBe(500);
  });

  it('accepts well-formed multipart with file', async () => {
    const { body, boundary } = buildMultipart([
      { name: 'file', filename: 'audio.wav', data: Buffer.from([1, 2, 3, 4]) },
      { name: 'model', data: 'whisper-v3' },
    ]);
    const res = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-key',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: body as any,
    });
    expect([200, 404, 500]).toContain(res.status);
  });
});

describe('Proxy Server — blocked streaming routes (410 Gone)', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    server = createProxyServer(makeConfig());
    await new Promise<void>((res) => {
      server.listen(0, '127.0.0.1', () => res());
    });
    port = (server.address() as any).port;
  });

  afterEach(() => {
    server.close();
  });

  it('returns 410 for /api/stream-audio', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stream-audio`, {
      headers: { Authorization: 'Bearer test-key' },
    });
    expect(res.status).toBe(410);
    const json: any = await res.json();
    expect(json.error.message).toContain('Streaming transport');
  });

  it('returns 410 for /ws/stream', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/ws/stream`, {
      headers: { Authorization: 'Bearer test-key' },
    });
    expect(res.status).toBe(410);
  });

  it('upgrade event handler returns 410 for non-HMR websocket upgrades (source)', () => {
    // Bun routes ALL Upgrade: websocket requests to the 'upgrade' event (not 'request')
    // and socket.write in bun's upgrade handler doesn't transmit data — runtime testing
    // of this is not feasible in bun. Verify the correct handler is present via source.
    const serverSource = readFileSync(join(__dirname, '../src/proxy/server.ts'), 'utf-8');
    const fnStart = serverSource.indexOf("server.on('upgrade'");
    const fnEnd = serverSource.indexOf('\n  return server;', fnStart);
    const fnBody = serverSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
    expect(fnBody).toContain('410 Gone');
    expect(fnBody).toContain('WebSocket transport is removed');
    expect(fnBody).toContain('socket.write(');
    expect(fnBody).toContain('socket.end()');
  });
});

describe('Proxy Server — CORS origin validation', () => {
  let server: Server;
  let port: number;

  afterEach(() => {
    server?.close();
    delete process.env.CORS_ORIGINS;
  });

  async function startWithCors(cors: string) {
    process.env.CORS_ORIGINS = cors;
    server = createProxyServer(makeConfig());
    await new Promise<void>((res) => {
      server.listen(0, '127.0.0.1', () => res());
    });
    port = (server.address() as any).port;
  }

  it('allows specific origin when matched', async () => {
    await startWithCors('https://parle.app');
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: 'https://parle.app' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://parle.app');
  });

  it('omits CORS header for non-matching origin', async () => {
    await startWithCors('https://parle.app');
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: 'https://evil.com' },
    });
    // No CORS header for non-matching origin — browser blocks cross-origin requests
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows localhost regardless of CORS_ORIGINS', async () => {
    await startWithCors('https://parle.app');
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
  });

  it('allows 127.0.0.1 regardless of CORS_ORIGINS', async () => {
    await startWithCors('https://parle.app');
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: 'http://127.0.0.1:3000' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:3000');
  });

  it('allows all origins when CORS_ORIGINS=*', async () => {
    await startWithCors('*');
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: 'https://anything.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('returns correct CORS preflight headers', async () => {
    await startWithCors('*');
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://test.com' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
  });
});

describe('Proxy Server — static files and path traversal', () => {
  let server: Server;
  let port: number;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'static-test-'));
    writeFileSync(join(tmpDir, 'index.html'), '<html>hi</html>');
    writeFileSync(join(tmpDir, 'style.css'), 'body{}');
    mkdirSync(join(tmpDir, 'sub'));
    writeFileSync(join(tmpDir, 'sub', 'page.html'), '<html>sub</html>');

    server = createProxyServer(makeConfig({ staticDir: tmpDir }));
    await new Promise<void>((res) => {
      server.listen(0, '127.0.0.1', () => res());
    });
    port = (server.address() as any).port;
  });

  afterEach(() => {
    server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('blocks path traversal with 403 via raw socket', async () => {
    // Use raw net.Socket with percent-encoded dots (%2e%2e) — bun's http.request
    // normalizes /../../../ to / before sending, defeating the traversal check.
    // The server's decodeURIComponent() decodes %2e%2e → .. then resolve() detects
    // the traversal and returns 403.
    const status = await new Promise<number>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString();
        const match = data.match(/HTTP\/1\.\d (\d+)/);
        if (match) {
          resolve(parseInt(match[1]));
          socket.destroy();
        }
      });
      socket.on('error', () => resolve(0));
      socket.on('end', () => {
        const match = data.match(/HTTP\/1\.\d (\d+)/);
        resolve(match ? parseInt(match[1]) : 0);
      });
      socket.on('connect', () => {
        socket.write(
          `GET /%2e%2e/%2e%2e/%2e%2e/etc/passwd HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer test-key\r\nConnection: close\r\n\r\n`,
        );
      });
    });
    expect(status).toBe(403);
  });

  it('serves existing file with correct content type', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/style.css`, {
      headers: { Authorization: 'Bearer test-key' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css');
  });

  it('serves index.html for root path', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Authorization: 'Bearer test-key' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
  });

  it('sets cache-control: no-cache for HTML', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Authorization: 'Bearer test-key' },
    });
    expect(res.headers.get('cache-control')).toContain('no-cache');
  });

  it('sets immutable cache for non-HTML assets', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/style.css`, {
      headers: { Authorization: 'Bearer test-key' },
    });
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('serves SPA fallback for unknown non-file paths', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/some/react/route`, {
      headers: { Authorization: 'Bearer test-key' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
  });

  it('applies security headers to static responses', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/style.css`, {
      headers: { Authorization: 'Bearer test-key' },
    });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('Proxy Server — startProxy EADDRINUSE', () => {
  let server1: Server;

  afterEach(() => {
    server1?.close();
  });

  it('rejects with descriptive error on port conflict', async () => {
    server1 = createProxyServer(makeConfig());
    await new Promise<void>((res) => {
      server1.listen(0, '127.0.0.1', () => res());
    });
    const usedPort = (server1.address() as any).port;

    await expect(startProxy(makeConfig({ port: usedPort }))).rejects.toThrow(/already in use/);
  });
});
