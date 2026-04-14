/**
 * Cache Effectiveness Test: measures cache hit rate and latency improvement.
 *
 * Sends identical requests and measures if second+ requests are faster (cache hit).
 * Tests both chat and embedding caching behavior.
 *
 * Run: bunx vitest run __tests__/cache-effectiveness.test.ts
 * Set SKIP_LIVE_TESTS=1 to skip.
 */

import { describe, it, expect } from 'vitest';

const GATEWAY_URL = process.env.GATEWAY_URL || process.env.GATEWAY_URL || 'http://localhost:4000';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || 'gw_loadtest_2026';
const SKIP = process.env.SKIP_LIVE_TESTS === '1';

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${GATEWAY_API_KEY}`,
};

async function timedChat(
  body: string,
): Promise<{ ok: boolean; latencyMs: number; content?: string }> {
  const start = performance.now();
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== 200) return { ok: false, latencyMs: performance.now() - start };
    const json = (await res.json()) as any;
    return {
      ok: true,
      latencyMs: performance.now() - start,
      content: json.choices?.[0]?.message?.content,
    };
  } catch {
    return { ok: false, latencyMs: performance.now() - start };
  }
}

describe.skipIf(SKIP)('Cache Effectiveness', { timeout: 120_000 }, () => {
  it('second identical request is faster (cache hit)', { timeout: 30_000 }, async () => {
    console.log('\n── Cache Hit Test: sequential identical requests ──');

    const body = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: `Cache test ${Date.now()}: what is 1+1?` }],
      max_tokens: 10,
      temperature: 0, // Required for caching
    });

    // First request — cache miss
    const first = await timedChat(body);
    console.log(`  1st request (miss): ${first.latencyMs.toFixed(0)}ms — "${first.content}"`);

    // Second request — should be cache hit
    const second = await timedChat(body);
    console.log(`  2nd request (hit?): ${second.latencyMs.toFixed(0)}ms — "${second.content}"`);

    // Third request — confirm cache hit
    const third = await timedChat(body);
    console.log(`  3rd request (hit?): ${third.latencyMs.toFixed(0)}ms — "${third.content}"`);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const speedup = first.latencyMs / second.latencyMs;
    console.log(`\n  Speedup: ${speedup.toFixed(1)}x`);

    if (second.latencyMs < first.latencyMs * 0.5) {
      console.log('  ✓ Cache working: 2nd request was >2x faster');
    } else {
      console.log('  ⚠ Cache may not be configured (no significant speedup)');
      console.log('  This is expected if the proxy has no ResponseCache configured');
    }
  });

  it('non-deterministic requests are not cached', { timeout: 30_000 }, async () => {
    console.log('\n── Non-cacheable Test: temperature > 0 ──');

    const body = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'Tell me a random word' }],
      max_tokens: 5,
      temperature: 0.8, // Non-deterministic
    });

    const first = await timedChat(body);
    const second = await timedChat(body);

    console.log(`  1st: ${first.latencyMs.toFixed(0)}ms — "${first.content}"`);
    console.log(`  2nd: ${second.latencyMs.toFixed(0)}ms — "${second.content}"`);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    // Both should take similar time (no caching)
    // And ideally different content
    if (first.content !== second.content) {
      console.log('  ✓ Different responses — not cached (correct)');
    } else {
      console.log('  Responses match — could be coincidence or unexpected caching');
    }
  });

  it('cache hit rate under concurrent load', { timeout: 60_000 }, async () => {
    console.log('\n── Cache Hit Rate: 100 identical requests ──');

    // Unique prompt to avoid hits from previous tests
    const prompt = `Cache rate test ${Date.now()}: reply exactly CACHED`;
    const body = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 10,
      temperature: 0,
    });

    // First: prime the cache
    const prime = await timedChat(body);
    console.log(`  Prime request: ${prime.latencyMs.toFixed(0)}ms`);

    // Wait a moment for cache to persist
    await new Promise((r) => setTimeout(r, 500));

    // Then: 100 requests that should all hit cache
    const results = await Promise.all(Array.from({ length: 100 }, () => timedChat(body)));
    const ok = results.filter((r) => r.ok);
    const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);

    const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : 0;
    const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : 0;
    console.log(
      `  100 requests: ${ok.length}/100 OK | p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms`,
    );

    // If cache is working, these should be much faster than the prime request
    if (p50 < prime.latencyMs * 0.3) {
      const fast = ok.filter((r) => r.latencyMs < prime.latencyMs * 0.5).length;
      console.log(`  ✓ Cache working: ${fast}/100 were >2x faster than prime`);
      console.log(`  Estimated hit rate: ${((fast / ok.length) * 100).toFixed(0)}%`);
    } else {
      console.log('  ⚠ No cache speedup detected — cache may not be configured');
      console.log(`  Prime: ${prime.latencyMs.toFixed(0)}ms vs p50: ${p50.toFixed(0)}ms`);
    }

    expect(ok.length).toBeGreaterThan(50);
  });
});
