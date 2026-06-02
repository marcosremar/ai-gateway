import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createConnectionPool } from '../src/connection-pool/index.js';

async function withServer(handler: Parameters<typeof createServer>[0]): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('Connection Pool', () => {
  it('enforces timeout', async () => {
    const server = await withServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end('ok');
      }, 1_000);
    });
    const pool = createConnectionPool({ timeoutMs: 100 });

    try {
      const start = Date.now();

      await expect(pool.fetch(`${server.url}/slow`)).rejects.toThrow(/timeout/i);

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500);
    } finally {
      await server.close();
    }
  });

  it('respects max connections', async () => {
    const server = await withServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end('ok');
      }, 25);
    });
    const pool = createConnectionPool({ maxConnections: 2 });

    try {
      const promises = [
        pool.fetch(`${server.url}/one`),
        pool.fetch(`${server.url}/two`),
        pool.fetch(`${server.url}/three`),
      ];

      const results = await Promise.all(promises);
      expect(results.every(r => r.ok)).toBe(true);
    } finally {
      await server.close();
    }
  });
});
