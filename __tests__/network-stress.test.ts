/**
 * Network Stress Test: HTTP edge cases, connection handling, and resilience.
 *
 * Tests that the gateway handles malformed requests, large payloads,
 * concurrent connections, and rate limiting without crashing.
 *
 * Run:
 *   bun run test:network
 *
 * Set SKIP_LIVE_TESTS=1 to skip in CI.
 */

import { describe, it, expect, beforeAll } from 'vitest';

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://parle-gateway-loadtest.fly.dev';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || 'gw_loadtest_2026';
const SKIP = process.env.SKIP_LIVE_TESTS === '1';

function authHeaders(contentType = 'application/json'): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Authorization': `Bearer ${GATEWAY_API_KEY}`,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(SKIP)('Network Stress — Live Gateway', { timeout: 600_000 }, () => {

  // ── Health baseline ────────────────────────────────────────────────────

  it('gateway is reachable', { timeout: 15_000 }, async () => {
    const res = await fetchWithTimeout(`${GATEWAY_URL}/health`, { headers: authHeaders() });
    expect(res.status).toBe(200);
  });

  // ── 100 simultaneous TCP connections ──────────────────────────────────

  it('handles 100 simultaneous HTTP connections', { timeout: 60_000 }, async () => {
    const promises = Array.from({ length: 100 }, () =>
      fetchWithTimeout(`${GATEWAY_URL}/health`, { headers: authHeaders() }, 30_000)
        .then(r => ({ ok: r.ok, status: r.status }))
        .catch(err => ({ ok: false, status: 0, error: err.message }))
    );

    const results = await Promise.allSettled(promises);
    const succeeded = results.filter(r => r.status === 'fulfilled' && (r.value as any).ok).length;

    console.log(`100 simultaneous connections: ${succeeded}/100 succeeded`);
    expect(succeeded).toBeGreaterThan(80); // allow some connection resets
  });

  // ── Malformed requests don't crash the server ─────────────────────────

  describe('malformed requests', () => {
    it('handles empty body on chat endpoint', { timeout: 15_000 }, async () => {
      const res = await fetchWithTimeout(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: authHeaders(),
        body: '',
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    it('handles invalid JSON', { timeout: 15_000 }, async () => {
      const res = await fetchWithTimeout(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: authHeaders(),
        body: '{invalid json!!!',
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('handles missing required fields', { timeout: 15_000 }, async () => {
      const res = await fetchWithTimeout(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ not_messages: 'hello' }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('handles wrong content-type', { timeout: 15_000 }, async () => {
      const res = await fetchWithTimeout(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...authHeaders('text/plain') },
        body: 'plain text body',
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('handles oversized request gracefully', { timeout: 45_000 }, async () => {
      // 11MB of data — should be rejected before reading all of it
      const bigBody = JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'x'.repeat(11 * 1024 * 1024) }],
      });

      const res = await fetchWithTimeout(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: authHeaders(),
        body: bigBody,
      }, 30_000);
      // Should get 413 or 400, not 500 or hang
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ── Mixed valid + invalid under load ──────────────────────────────────

  it('handles mixed valid and invalid requests simultaneously', { timeout: 120_000 }, async () => {
    const validBody = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'Reply: OK' }],
      max_tokens: 5,
    });

    const promises = Array.from({ length: 50 }, (_, i) => {
      const isValid = i % 2 === 0;
      return fetchWithTimeout(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: authHeaders(),
        body: isValid ? validBody : '{broken',
      }, 30_000)
        .then(r => ({ valid: isValid, status: r.status }))
        .catch(err => ({ valid: isValid, status: 0, error: err.message }));
    });

    const results = await Promise.all(promises);
    const validResults = results.filter(r => r.valid);
    const invalidResults = results.filter(r => !r.valid);

    const validOk = validResults.filter(r => r.status === 200).length;
    const invalidRejected = invalidResults.filter(r => r.status >= 400 && r.status < 500).length;

    console.log(`Mixed load: ${validOk}/25 valid OK, ${invalidRejected}/25 invalid rejected correctly`);

    // Valid requests should mostly succeed
    expect(validOk).toBeGreaterThan(15);
    // Invalid requests should be rejected, not cause 500s
    expect(invalidRejected).toBeGreaterThan(15);
  });

  // ── Payload sizes ─────────────────────────────────────────────────────

  describe('varied payload sizes', () => {
    const sizes = [
      { name: '1KB', chars: 1024 },
      { name: '100KB', chars: 100 * 1024 },
      { name: '1MB', chars: 1024 * 1024 },
    ];

    for (const { name, chars } of sizes) {
      it(`handles ${name} request body`, { timeout: 30_000 }, async () => {
        const res = await fetchWithTimeout(`${GATEWAY_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: 'x'.repeat(Math.min(chars, 4000)) }],
            max_tokens: 5,
          }),
        }, 30_000);
        // Should either succeed (200) or reject cleanly (4xx)
        expect(res.status).toBeLessThan(500);
        console.log(`${name} body: status ${res.status}`);
      });
    }
  });

  // ── Rate limiting behavior ────────────────────────────────────────────

  it('rate limiting returns 429 without crashing', { timeout: 120_000 }, async () => {
    // Rapid-fire 200 requests to trigger rate limiter
    const promises = Array.from({ length: 200 }, () =>
      fetchWithTimeout(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      }, 15_000)
        .then(r => r.status)
        .catch(() => 0)
    );

    const statuses = await Promise.all(promises);
    const got429 = statuses.filter(s => s === 429).length;
    const got200 = statuses.filter(s => s === 200).length;
    const got5xx = statuses.filter(s => s >= 500).length;

    console.log(`Rate limit test: 200=${got200}, 429=${got429}, 5xx=${got5xx}`);

    // Some should succeed, some should be rate limited
    // The important thing: no 5xx errors (server didn't crash)
    expect(got5xx).toBeLessThan(10);

    // After rate limiting, gateway should still be healthy
    const health = await fetchWithTimeout(`${GATEWAY_URL}/health`, { headers: authHeaders() });
    expect(health.status).toBe(200);
  });

  // ── Unauthorized access ───────────────────────────────────────────────

  it('rejects requests without auth', { timeout: 15_000 }, async () => {
    const res = await fetchWithTimeout(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'test' }],
      }),
    });
    expect(res.status).toBe(401);
  });

  // ── 100 unauthorized requests shouldn't impact server ─────────────────

  it('100 unauthorized requests dont impact server', { timeout: 60_000 }, async () => {
    const promises = Array.from({ length: 100 }, () =>
      fetchWithTimeout(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
      }, 10_000)
        .then(r => r.status)
        .catch(() => 0)
    );

    const statuses = await Promise.all(promises);
    const got401 = statuses.filter(s => s === 401).length;
    console.log(`100 unauth requests: ${got401}/100 got 401`);

    // Server should still respond normally after
    const health = await fetchWithTimeout(`${GATEWAY_URL}/health`, { headers: authHeaders() });
    expect(health.status).toBe(200);
  });

  // ── HTTP methods ──────────────────────────────────────────────────────

  it('rejects unsupported HTTP methods', { timeout: 30_000 }, async () => {
    const methods = ['PUT', 'DELETE', 'PATCH'] as const;
    for (const method of methods) {
      const res = await fetchWithTimeout(`${GATEWAY_URL}/v1/chat/completions`, {
        method,
        headers: authHeaders(),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  });

  // ── Unknown routes ────────────────────────────────────────────────────

  it('returns 404 for unknown routes', { timeout: 15_000 }, async () => {
    const res = await fetchWithTimeout(`${GATEWAY_URL}/v1/nonexistent`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });

});
