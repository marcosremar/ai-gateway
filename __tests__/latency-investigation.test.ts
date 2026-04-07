/**
 * Latency Investigation: Why does 100 concurrent get slower?
 *
 * Hypotheses:
 * 1. Fly.io cold start — second machine wakes up on first big batch
 * 2. Groq rate limiting — 429s add latency via retries
 * 3. Connection queuing — TCP/TLS handshake overhead at high concurrency
 * 4. Event loop saturation — single-threaded Node.js blocks on body parsing
 *
 * This test isolates each variable.
 */

import { describe, it, expect } from 'vitest';
import { GatewayHttpClient } from '../sdk/node';

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://parle-gateway-loadtest.fly.dev';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || 'gw_loadtest_2026';
const SKIP = process.env.SKIP_LIVE_TESTS === '1';

function makeClient(): GatewayHttpClient {
  return new GatewayHttpClient({
    baseUrl: GATEWAY_URL,
    apiKey: GATEWAY_API_KEY,
    timeouts: { sttMs: 30_000, translateMs: 30_000, pipelineMs: 60_000, healthMs: 10_000 },
    retry: { maxRetries: 0, backoffMs: 0 },
    circuitBreaker: { failureThreshold: 50, resetTimeoutMs: 5_000, halfOpenMaxAttempts: 5 },
  });
}

interface TimedResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function timedChat(gw: GatewayHttpClient, msg: string): Promise<TimedResult> {
  const start = performance.now();
  try {
    await gw.chat([{ role: 'user', content: msg }], 'llama-3.3-70b-versatile', { maxTokens: 5 });
    return { ok: true, latencyMs: performance.now() - start };
  } catch (err: any) {
    return { ok: false, latencyMs: performance.now() - start, error: err.message?.slice(0, 100) };
  }
}

async function timedHealth(gw: GatewayHttpClient): Promise<TimedResult> {
  const start = performance.now();
  try {
    const h = await gw.health();
    return { ok: h.isHealthy, latencyMs: performance.now() - start };
  } catch (err: any) {
    return { ok: false, latencyMs: performance.now() - start, error: err.message?.slice(0, 100) };
  }
}

function logResults(label: string, results: TimedResult[]) {
  const ok = results.filter(r => r.ok);
  const latencies = ok.map(r => r.latencyMs).sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  console.log(`  ${label}: ${ok.length}/${results.length} OK | p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms p99=${p99.toFixed(0)}ms | min=${latencies[0]?.toFixed(0)}ms max=${latencies.at(-1)?.toFixed(0)}ms`);
  if (results.some(r => !r.ok)) {
    const errors = results.filter(r => !r.ok).map(r => r.error).slice(0, 3);
    console.log(`    errors: ${errors.join(', ')}`);
  }
}

describe.skipIf(SKIP)('Latency Investigation', { timeout: 600_000 }, () => {

  // ── Hypothesis 1: Cold start ──────────────────────────────────────────
  // If the first batch is slow because Fly machines are waking up,
  // a warmup followed by identical batches should show the first is slower.

  it('cold start vs warm: back-to-back 100-request batches', { timeout: 120_000 }, async () => {
    console.log('\n── Test 1: Cold Start Effect ──');

    // Warmup: wake both machines with a few requests
    const warmupGw = makeClient();
    console.log('  Warming up...');
    for (let i = 0; i < 5; i++) {
      await timedChat(warmupGw, `warmup-${i}`);
    }
    console.log('  Warmup done. Running identical batches:');

    // Batch 1 (after warmup)
    const gw1 = makeClient();
    const batch1Start = performance.now();
    const batch1 = await Promise.all(
      Array.from({ length: 100 }, (_, i) => timedChat(gw1, `batch1-${i}: reply OK`))
    );
    const batch1Time = performance.now() - batch1Start;
    logResults('Batch 1 (post-warmup)', batch1);
    console.log(`  Batch 1 wall time: ${batch1Time.toFixed(0)}ms`);

    // Brief pause
    await new Promise(r => setTimeout(r, 2000));

    // Batch 2 (everything warm)
    const gw2 = makeClient();
    const batch2Start = performance.now();
    const batch2 = await Promise.all(
      Array.from({ length: 100 }, (_, i) => timedChat(gw2, `batch2-${i}: reply OK`))
    );
    const batch2Time = performance.now() - batch2Start;
    logResults('Batch 2 (fully warm)', batch2);
    console.log(`  Batch 2 wall time: ${batch2Time.toFixed(0)}ms`);

    // Batch 3 (still warm)
    const gw3 = makeClient();
    const batch3Start = performance.now();
    const batch3 = await Promise.all(
      Array.from({ length: 100 }, (_, i) => timedChat(gw3, `batch3-${i}: reply OK`))
    );
    const batch3Time = performance.now() - batch3Start;
    logResults('Batch 3 (still warm)', batch3);
    console.log(`  Batch 3 wall time: ${batch3Time.toFixed(0)}ms`);

    expect(batch1.filter(r => r.ok).length).toBeGreaterThan(30);
  });

  // ── Hypothesis 2: Groq rate limiting ──────────────────────────────────
  // If Groq is the bottleneck, health endpoint (no Groq) should stay fast.

  it('gateway overhead vs Groq: health vs chat at 100 concurrent', { timeout: 60_000 }, async () => {
    console.log('\n── Test 2: Gateway vs Groq Latency ──');

    // 100 concurrent health checks (no Groq call)
    const gw = makeClient();
    const healthResults = await Promise.all(
      Array.from({ length: 100 }, () => timedHealth(gw))
    );
    logResults('100x /health (no Groq)', healthResults);

    // 100 concurrent chat requests (hits Groq)
    const gw2 = makeClient();
    const chatResults = await Promise.all(
      Array.from({ length: 100 }, (_, i) => timedChat(gw2, `groq-test-${i}: reply OK`))
    );
    logResults('100x /chat  (hits Groq)', chatResults);

    const healthP50 = percentile(healthResults.filter(r => r.ok).map(r => r.latencyMs).sort((a, b) => a - b), 50);
    const chatP50 = percentile(chatResults.filter(r => r.ok).map(r => r.latencyMs).sort((a, b) => a - b), 50);
    console.log(`  Gateway overhead (health p50): ${healthP50.toFixed(0)}ms`);
    console.log(`  Groq added latency: ~${(chatP50 - healthP50).toFixed(0)}ms`);
  });

  // ── Hypothesis 3: Concurrency scaling ─────────────────────────────────
  // Test increasing concurrency to find the inflection point.

  it('concurrency scaling: 10 → 25 → 50 → 75 → 100 → 150 → 200', { timeout: 180_000 }, async () => {
    console.log('\n── Test 3: Concurrency Scaling ──');

    // Warmup first
    const warmGw = makeClient();
    for (let i = 0; i < 3; i++) await timedChat(warmGw, `warmup-${i}`);

    const levels = [10, 25, 50, 75, 100, 150, 200];

    for (const n of levels) {
      const gw = makeClient();
      const start = performance.now();
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) => timedChat(gw, `scale-${n}-${i}: OK`))
      );
      const wallTime = performance.now() - start;
      const ok = results.filter(r => r.ok);
      const latencies = ok.map(r => r.latencyMs).sort((a, b) => a - b);
      const p50 = percentile(latencies, 50);
      const p95 = percentile(latencies, 95);

      console.log(`  n=${String(n).padStart(3)}: ${ok.length}/${n} OK | p50=${p50.toFixed(0).padStart(5)}ms | p95=${p95.toFixed(0).padStart(5)}ms | wall=${wallTime.toFixed(0).padStart(5)}ms | throughput=${(n / (wallTime / 1000)).toFixed(0)} req/s`);

      // Brief pause to let Groq rate limits reset
      await new Promise(r => setTimeout(r, 1000));
    }
  });

  // ── Hypothesis 4: Per-request latency breakdown ───────────────────────
  // Track individual request timings to see if there's a bimodal distribution.

  it('per-request latency histogram at 100 concurrent', { timeout: 60_000 }, async () => {
    console.log('\n── Test 4: Latency Histogram (100 concurrent) ──');

    // Warmup
    const warmGw = makeClient();
    for (let i = 0; i < 3; i++) await timedChat(warmGw, `warmup-${i}`);

    const gw = makeClient();
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => timedChat(gw, `hist-${i}: OK`))
    );

    const latencies = results.filter(r => r.ok).map(r => r.latencyMs).sort((a, b) => a - b);

    // Histogram: buckets of 50ms
    const buckets: Record<string, number> = {};
    for (const l of latencies) {
      const bucket = Math.floor(l / 50) * 50;
      const key = `${bucket}-${bucket + 50}ms`;
      buckets[key] = (buckets[key] || 0) + 1;
    }

    console.log('  Histogram (50ms buckets):');
    for (const [range, count] of Object.entries(buckets).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
      const bar = '#'.repeat(Math.min(count, 50));
      console.log(`    ${range.padStart(12)}: ${bar} (${count})`);
    }

    // Check for bimodal distribution
    const below300 = latencies.filter(l => l < 300).length;
    const above300 = latencies.filter(l => l >= 300).length;
    console.log(`\n  Below 300ms: ${below300} | Above 300ms: ${above300}`);
    if (above300 > 20) {
      console.log('  → Likely bimodal: some requests hit a different code path or queued');
    }
  });

});
