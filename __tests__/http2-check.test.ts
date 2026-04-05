/**
 * Quick check: what HTTP protocol version does Bun's fetch() negotiate?
 */

import { describe, it } from 'vitest';

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://parle-gateway-loadtest.fly.dev';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || 'gw_loadtest_2026';
const SKIP = process.env.SKIP_LIVE_TESTS === '1';

describe.skipIf(SKIP)('HTTP/2 Check', { timeout: 30_000 }, () => {

  it('check fetch() HTTP version via response headers', { timeout: 15_000 }, async () => {
    const res = await fetch(`${GATEWAY_URL}/health`, {
      headers: { 'Authorization': `Bearer ${GATEWAY_API_KEY}` },
    });

    console.log('\n── HTTP Protocol Check ──');
    console.log(`  Status: ${res.status}`);
    console.log(`  Headers:`);
    res.headers.forEach((value, key) => {
      console.log(`    ${key}: ${value}`);
    });

    // Bun's fetch has httpVersion on the response in some versions
    const anyRes = res as any;
    console.log(`  res.httpVersion: ${anyRes.httpVersion ?? 'not available'}`);
    console.log(`  res.url: ${anyRes.url}`);

    // Check via header — Fly sets 'via: 2 fly.io' for HTTP/2
    const via = res.headers.get('via');
    console.log(`\n  'via' header: ${via}`);
    if (via?.includes('2 fly.io')) {
      console.log('  → Fly proxy used HTTP/2 on its side');
    }
    // Note: 'via' tells us what Fly's proxy did, not what our client negotiated
  });

  it('test with node:http2 directly for comparison', { timeout: 15_000 }, async () => {
    console.log('\n── Direct HTTP/2 Test ──');
    try {
      const http2 = await import('node:http2');
      const url = new URL(`${GATEWAY_URL}/health`);

      const result = await new Promise<{ protocol: string; status: number; latencyMs: number }>((resolve, reject) => {
        const start = performance.now();
        const client = http2.connect(url.origin);

        client.on('error', reject);

        const req = client.request({
          ':method': 'GET',
          ':path': url.pathname,
          'authorization': `Bearer ${GATEWAY_API_KEY}`,
        });

        let data = '';
        req.on('response', (headers) => {
          const status = headers[':status'] as number;
          req.on('data', (chunk: Buffer) => { data += chunk; });
          req.on('end', () => {
            client.close();
            resolve({
              protocol: 'h2',
              status,
              latencyMs: performance.now() - start,
            });
          });
        });
        req.end();

        setTimeout(() => { client.close(); reject(new Error('timeout')); }, 10_000);
      });

      console.log(`  Protocol: ${result.protocol}`);
      console.log(`  Status: ${result.status}`);
      console.log(`  Latency: ${result.latencyMs.toFixed(0)}ms`);
    } catch (err: any) {
      console.log(`  HTTP/2 direct test failed: ${err.message}`);
    }
  });

  it('compare: 100 concurrent with fetch vs http2 multiplexed', { timeout: 60_000 }, async () => {
    console.log('\n── 100 Concurrent: fetch() vs HTTP/2 Multiplexed ──');

    // 1. fetch() — whatever protocol Bun negotiates
    const fetchStart = performance.now();
    const fetchResults = await Promise.all(
      Array.from({ length: 100 }, async () => {
        const s = performance.now();
        try {
          const r = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${GATEWAY_API_KEY}`,
            },
            body: JSON.stringify({
              model: 'llama-3.3-70b-versatile',
              messages: [{ role: 'user', content: 'reply OK' }],
              max_tokens: 5,
            }),
            signal: AbortSignal.timeout(30_000),
          });
          return { ok: r.status === 200, latencyMs: performance.now() - s };
        } catch {
          return { ok: false, latencyMs: performance.now() - s };
        }
      })
    );
    const fetchWall = performance.now() - fetchStart;
    const fetchOk = fetchResults.filter(r => r.ok);
    const fetchLatencies = fetchOk.map(r => r.latencyMs).sort((a, b) => a - b);
    const fetchP50 = fetchLatencies[Math.floor(fetchLatencies.length * 0.5)] || 0;
    const fetchP95 = fetchLatencies[Math.floor(fetchLatencies.length * 0.95)] || 0;
    console.log(`  fetch():  ${fetchOk.length}/100 OK | p50=${fetchP50.toFixed(0)}ms p95=${fetchP95.toFixed(0)}ms | wall=${fetchWall.toFixed(0)}ms`);

    await new Promise(r => setTimeout(r, 2000));

    // 2. HTTP/2 multiplexed — single connection, all requests multiplexed
    try {
      const http2 = await import('node:http2');
      const url = new URL(GATEWAY_URL);

      const h2Start = performance.now();
      const client = http2.connect(url.origin);

      const h2Results = await Promise.all(
        Array.from({ length: 100 }, (_, i) => {
          return new Promise<{ ok: boolean; latencyMs: number }>((resolve) => {
            const s = performance.now();
            const req = client.request({
              ':method': 'POST',
              ':path': '/v1/chat/completions',
              'content-type': 'application/json',
              'authorization': `Bearer ${GATEWAY_API_KEY}`,
            });

            const body = JSON.stringify({
              model: 'llama-3.3-70b-versatile',
              messages: [{ role: 'user', content: `h2-${i}: reply OK` }],
              max_tokens: 5,
            });

            let data = '';
            req.on('response', (headers) => {
              const status = headers[':status'] as number;
              req.on('data', (chunk: Buffer) => { data += chunk; });
              req.on('end', () => {
                resolve({ ok: status === 200, latencyMs: performance.now() - s });
              });
            });
            req.on('error', () => resolve({ ok: false, latencyMs: performance.now() - s }));
            req.write(body);
            req.end();
          });
        })
      );

      client.close();

      const h2Wall = performance.now() - h2Start;
      const h2Ok = h2Results.filter(r => r.ok);
      const h2Latencies = h2Ok.map(r => r.latencyMs).sort((a, b) => a - b);
      const h2P50 = h2Latencies[Math.floor(h2Latencies.length * 0.5)] || 0;
      const h2P95 = h2Latencies[Math.floor(h2Latencies.length * 0.95)] || 0;
      console.log(`  HTTP/2:   ${h2Ok.length}/100 OK | p50=${h2P50.toFixed(0)}ms p95=${h2P95.toFixed(0)}ms | wall=${h2Wall.toFixed(0)}ms`);

      const diff = fetchP50 - h2P50;
      console.log(`\n  Difference: fetch p50 is ${diff > 0 ? diff.toFixed(0) + 'ms SLOWER' : Math.abs(diff).toFixed(0) + 'ms FASTER'} than HTTP/2`);
    } catch (err: any) {
      console.log(`  HTTP/2 test failed: ${err.message}`);
    }
  });
});
