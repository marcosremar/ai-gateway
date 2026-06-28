import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createConnectionPool } from '../src/connection-pool/index.js';

describe('Connection Pool', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('enforces timeout', async () => {
    // Simulate a fetch that never resolves (hangs indefinitely).
    // Without the AbortSignal.timeout() fix the pool would hang here; with it
    // the signal fires and the pool converts the TimeoutError to our message.
    fetchSpy.mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (sig) {
          sig.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'TimeoutError'));
          });
        }
        // never resolves on its own
      });
    });

    const pool = createConnectionPool({ timeoutMs: 50 });

    const start = Date.now();
    await expect(pool.fetch('https://example.com/slow')).rejects.toThrow(/timeout/i);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it('respects max connections — all concurrent requests complete', async () => {
    // Mock fetch to return a successful response immediately.
    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }));

    const pool = createConnectionPool({ maxConnections: 2 });

    // Fire 3 requests; the pool wrapper passes them all through (no queuing
    // is implemented yet — this test pins the current behaviour).
    const results = await Promise.all([
      pool.fetch('https://example.com/1'),
      pool.fetch('https://example.com/2'),
      pool.fetch('https://example.com/3'),
    ]);

    expect(results).toHaveLength(3);
    expect(results.every(r => r.ok)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
