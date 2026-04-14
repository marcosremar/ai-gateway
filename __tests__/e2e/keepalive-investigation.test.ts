/**
 * Keep-alive Investigation: Is connection reuse the reason subsequent batches are faster?
 *
 * Tests the same batch size with:
 * 1. Fresh connections (new fetch, no keep-alive reuse)
 * 2. Warm connections (reuse from previous batch)
 * 3. Forced no-keepalive (Connection: close)
 */

import { describe, it, expect } from 'vitest';

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://parle-gateway-loadtest.fly.dev';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || 'gw_loadtest_2026';
const SKIP = process.env.SKIP_LIVE_TESTS === '1';

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${GATEWAY_API_KEY}`,
};

const chatBody = JSON.stringify({
  model: 'llama-3.3-70b-versatile',
  messages: [{ role: 'user', content: 'reply OK' }],
  max_tokens: 5,
});

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function timedFetch(extraHeaders: Record<string, string> = {}): Promise<{ ok: boolean; latencyMs: number }> {
  const start = performance.now();
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...headers, ...extraHeaders },
      body: chatBody,
      signal: AbortSignal.timeout(30_000),
    });
    return { ok: res.status === 200, latencyMs: performance.now() - start };
  } catch {
    return { ok: false, latencyMs: performance.now() - start };
  }
}

function logBatch(label: string, results: { ok: boolean; latencyMs: number }[]) {
  const ok = results.filter(r => r.ok);
  const latencies = ok.map(r => r.latencyMs).sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  console.log(`  ${label}: ${ok.length}/${results.length} OK | p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms | min=${latencies[0]?.toFixed(0)}ms max=${latencies.at(-1)?.toFixed(0)}ms`);
}

describe.skipIf(SKIP)('Keep-alive Investigation', { timeout: 300_000 }, () => {

  it('connection reuse effect: 5 identical batches of 100', { timeout: 120_000 }, async () => {
    console.log('\n── Test: 5x100 requests (same process, connections reused) ──');

    for (let batch = 1; batch <= 5; batch++) {
      const results = await Promise.all(
        Array.from({ length: 100 }, () => timedFetch())
      );
      logBatch(`Batch ${batch}`, results);
      // Small pause between batches
      await new Promise(r => setTimeout(r, 500));
    }
  });

  it('forced no-keepalive vs default', { timeout: 120_000 }, async () => {
    console.log('\n── Test: Connection: close (no keep-alive) vs default ──');

    // Warmup with a single request
    await timedFetch();

    // Batch with keep-alive (default)
    const keepAliveResults = await Promise.all(
      Array.from({ length: 100 }, () => timedFetch())
    );
    logBatch('With keep-alive', keepAliveResults);

    await new Promise(r => setTimeout(r, 1000));

    // Batch with Connection: close (forces new TCP+TLS for each)
    const noKeepAliveResults = await Promise.all(
      Array.from({ length: 100 }, () => timedFetch({ 'Connection': 'close' }))
    );
    logBatch('No keep-alive ', noKeepAliveResults);
  });

  it('sequential warmup then burst: isolating TLS overhead', { timeout: 60_000 }, async () => {
    console.log('\n── Test: TLS warmup effect ──');

    // Cold: measure first single request latency
    const cold = await timedFetch();
    console.log(`  Cold single request: ${cold.latencyMs.toFixed(0)}ms`);

    // Warm: measure second single request (TLS session reuse)
    const warm = await timedFetch();
    console.log(`  Warm single request: ${warm.latencyMs.toFixed(0)}ms`);
    console.log(`  TLS overhead: ~${(cold.latencyMs - warm.latencyMs).toFixed(0)}ms`);

    // Now burst 100 (connections already warm)
    const burstResults = await Promise.all(
      Array.from({ length: 100 }, () => timedFetch())
    );
    logBatch('100 burst (warm)', burstResults);
  });

});
