/**
 * Breaking Point Test: finds the maximum concurrency the gateway can handle.
 *
 * Ramps from 100 → 200 → 500 → 1000 concurrent requests and measures
 * at what point error rate exceeds 20%.
 *
 * Run: bunx vitest run __tests__/breaking-point.test.ts
 * Set SKIP_LIVE_TESTS=1 to skip.
 */

import { describe, it, expect } from 'vitest';

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://parle-gateway-loadtest.fly.dev';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || 'gw_loadtest_2026';
const SKIP = process.env.SKIP_LIVE_TESTS === '1';

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${GATEWAY_API_KEY}`,
};

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function timedChat(msg: string): Promise<{ ok: boolean; latencyMs: number; status: number }> {
  const start = performance.now();
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: msg }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    return { ok: res.status === 200, latencyMs: performance.now() - start, status: res.status };
  } catch {
    return { ok: false, latencyMs: performance.now() - start, status: 0 };
  }
}

async function timedHealth(): Promise<{ ok: boolean; latencyMs: number }> {
  const start = performance.now();
  try {
    const res = await fetch(`${GATEWAY_URL}/health`, { headers, signal: AbortSignal.timeout(10_000) });
    return { ok: res.status === 200, latencyMs: performance.now() - start };
  } catch {
    return { ok: false, latencyMs: performance.now() - start };
  }
}

describe.skipIf(SKIP)('Breaking Point', { timeout: 600_000 }, () => {

  it('finds maximum concurrency', { timeout: 300_000 }, async () => {
    console.log('\n── Breaking Point: Ramp-up concurrency ──');

    // Warmup
    await timedChat('warmup');

    const levels = [100, 200, 300, 500, 750, 1000];
    let breakingPoint: number | null = null;

    for (const n of levels) {
      const start = performance.now();
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) => timedChat(`bp-${n}-${i}: OK`))
      );
      const wallTime = performance.now() - start;

      const ok = results.filter(r => r.ok);
      const failed = results.filter(r => !r.ok);
      const errorRate = failed.length / results.length;
      const latencies = ok.map(r => r.latencyMs).sort((a, b) => a - b);
      const p50 = percentile(latencies, 50);
      const p95 = percentile(latencies, 95);

      // Count error types
      const by429 = failed.filter(r => r.status === 429).length;
      const by5xx = failed.filter(r => r.status >= 500).length;
      const byTimeout = failed.filter(r => r.status === 0).length;

      console.log(`  n=${String(n).padStart(4)}: ${ok.length}/${n} OK (${(errorRate * 100).toFixed(0)}% err) | p50=${p50.toFixed(0).padStart(5)}ms p95=${p95.toFixed(0).padStart(5)}ms | wall=${wallTime.toFixed(0).padStart(6)}ms | 429=${by429} 5xx=${by5xx} timeout=${byTimeout}`);

      if (errorRate > 0.2 && !breakingPoint) {
        breakingPoint = n;
        console.log(`  ⚠ Breaking point reached at n=${n} (error rate ${(errorRate * 100).toFixed(0)}%)`);
      }

      // Check health between levels
      const health = await timedHealth();
      if (!health.ok) {
        console.log(`  ✗ Gateway unhealthy after n=${n}! Health check: ${health.latencyMs.toFixed(0)}ms`);
        break;
      }

      // Pause between levels for rate limit recovery
      await new Promise(r => setTimeout(r, 3000));
    }

    if (!breakingPoint) {
      console.log(`\n  ✓ Gateway survived all levels (up to ${levels.at(-1)} concurrent)`);
    } else {
      console.log(`\n  Breaking point: ${breakingPoint} concurrent requests`);
    }

    // Gateway should at least handle 100
    const health = await timedHealth();
    console.log(`  Post-test health: ${health.ok ? 'OK' : 'FAILED'} (${health.latencyMs.toFixed(0)}ms)`);
    expect(health.ok).toBe(true);
  });

  it('health endpoint breaking point (no Groq dependency)', { timeout: 120_000 }, async () => {
    console.log('\n── Health Endpoint Breaking Point ──');

    const levels = [100, 500, 1000, 2000, 5000];

    for (const n of levels) {
      const start = performance.now();
      const results = await Promise.all(
        Array.from({ length: n }, () => timedHealth())
      );
      const wallTime = performance.now() - start;

      const ok = results.filter(r => r.ok);
      const latencies = ok.map(r => r.latencyMs).sort((a, b) => a - b);
      const p50 = percentile(latencies, 50);
      const p95 = percentile(latencies, 95);
      const errorRate = (n - ok.length) / n;

      console.log(`  n=${String(n).padStart(5)}: ${ok.length}/${n} OK (${(errorRate * 100).toFixed(0)}% err) | p50=${p50.toFixed(0).padStart(5)}ms p95=${p95.toFixed(0).padStart(5)}ms | wall=${wallTime.toFixed(0).padStart(6)}ms | throughput=${(n / (wallTime / 1000)).toFixed(0)} req/s`);

      if (errorRate > 0.5) {
        console.log(`  ⚠ Health endpoint failing at n=${n}`);
        break;
      }

      await new Promise(r => setTimeout(r, 1000));
    }
  });
});
