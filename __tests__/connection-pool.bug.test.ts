import { describe, it, expect, vi } from 'vitest';
import { createConnectionPool } from '../src/connection-pool/index.js';

describe('Connection Pool', () => {
  it('enforces timeout', async () => {
    const pool = createConnectionPool({ timeoutMs: 500 });

    // Start a timer
    const start = Date.now();

    // Try to fetch from a slow endpoint or use a mock that delays
    // This should timeout after 500ms but currently doesn't
    await expect(pool.fetch('https://httpbin.org/delay/10')).rejects.toThrow(/timeout/i);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000); // Should timeout quickly
  });

  it('respects max connections', async () => {
    const pool = createConnectionPool({ maxConnections: 2 });

    // Try to make 3 concurrent requests
    // With maxConnections=2, one should be queued
    const promises = [
      pool.fetch('https://httpbin.org/delay/1'),
      pool.fetch('https://httpbin.org/delay/1'),
      pool.fetch('https://httpbin.org/delay/1'),
    ];

    // All should eventually resolve
    const results = await Promise.all(promises);
    expect(results.every(r => r.ok!)).toBe(true);
  });
});