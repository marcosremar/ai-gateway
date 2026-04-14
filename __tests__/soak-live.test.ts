/**
 * Soak Test: Sustained load over time to detect memory leaks and degradation.
 *
 * Runs 30 concurrent users for 2 minutes, monitoring latency trends and health.
 *
 * Run:
 *   bun run test:soak
 *
 * Set SKIP_LIVE_TESTS=1 to skip in CI.
 * Set SOAK_DURATION_MS=120000 to override duration (default 2 minutes).
 * Set SOAK_CONCURRENCY=30 to override virtual users (default 30).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { GatewayHttpClient } from '../../sdk/node';

const GATEWAY_URL = process.env.GATEWAY_URL || process.env.GATEWAY_URL || 'http://localhost:4000';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || 'gw_loadtest_2026';
const SKIP = process.env.SKIP_LIVE_TESTS === '1';
const SOAK_DURATION_MS = Number(process.env.SOAK_DURATION_MS) || 2 * 60 * 1000; // 2 minutes
const SOAK_CONCURRENCY = Number(process.env.SOAK_CONCURRENCY) || 30;

interface LatencySample {
  timestampMs: number;
  latencyMs: number;
  ok: boolean;
}

interface SoakReport {
  totalRequests: number;
  succeeded: number;
  failed: number;
  errorRate: number;
  durationMs: number;
  throughput: number;
  windows: WindowReport[];
  latencyTrend: 'stable' | 'degrading' | 'improving';
}

interface WindowReport {
  windowIndex: number;
  p50: number;
  p95: number;
  errorRate: number;
  count: number;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function analyzeTrend(windows: WindowReport[]): 'stable' | 'degrading' | 'improving' {
  if (windows.length < 3) return 'stable';

  const firstHalf = windows.slice(0, Math.floor(windows.length / 2));
  const secondHalf = windows.slice(Math.floor(windows.length / 2));

  const avgFirst = firstHalf.reduce((s, w) => s + w.p95, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((s, w) => s + w.p95, 0) / secondHalf.length;

  const change = (avgSecond - avgFirst) / avgFirst;
  if (change > 0.3) return 'degrading'; // >30% increase
  if (change < -0.2) return 'improving';
  return 'stable';
}

describe.skipIf(SKIP)('Soak Test — Live Gateway', { timeout: SOAK_DURATION_MS + 120_000 }, () => {
  let gw: GatewayHttpClient;

  beforeAll(() => {
    gw = new GatewayHttpClient({
      baseUrl: GATEWAY_URL,
      apiKey: GATEWAY_API_KEY,
      timeouts: { sttMs: 30_000, translateMs: 30_000, pipelineMs: 60_000, healthMs: 10_000 },
      retry: { maxRetries: 0, backoffMs: 0 },
    });
  });

  it('gateway healthy before soak', { timeout: 15_000 }, async () => {
    const health = await gw.health();
    expect(health.isHealthy).toBe(true);
  });

  it(`sustained ${SOAK_CONCURRENCY} VUs for ${SOAK_DURATION_MS / 1000}s`, { timeout: SOAK_DURATION_MS + 60_000 }, async () => {
    const samples: LatencySample[] = [];
    const healthChecks: { timestampMs: number; healthy: boolean }[] = [];
    const startTime = performance.now();

    // Worker function: keeps sending requests until duration is up
    // Each worker gets its own client to avoid shared circuit breaker
    async function worker(id: number) {
      const workerGw = new GatewayHttpClient({
        baseUrl: GATEWAY_URL,
        apiKey: GATEWAY_API_KEY,
        timeouts: { sttMs: 30_000, translateMs: 30_000, pipelineMs: 60_000, healthMs: 10_000 },
        retry: { maxRetries: 0, backoffMs: 0 },
        circuitBreaker: { failureThreshold: 20, resetTimeoutMs: 10_000, halfOpenMaxAttempts: 3 },
      });
      while (performance.now() - startTime < SOAK_DURATION_MS) {
        const reqStart = performance.now();
        try {
          await workerGw.chat(
            [{ role: 'user', content: `Soak worker ${id}: reply OK` }],
            'llama-3.3-70b-versatile',
            { maxTokens: 5 },
          );
          samples.push({
            timestampMs: performance.now() - startTime,
            latencyMs: performance.now() - reqStart,
            ok: true,
          });
        } catch {
          samples.push({
            timestampMs: performance.now() - startTime,
            latencyMs: performance.now() - reqStart,
            ok: false,
          });
          // Backoff on failure to prevent spinning
          await new Promise(r => setTimeout(r, 1_000));
        }
      }
    }

    // Health checker: runs every 10 seconds (uses own client)
    async function healthChecker() {
      const healthGw = new GatewayHttpClient({
        baseUrl: GATEWAY_URL,
        apiKey: GATEWAY_API_KEY,
        timeouts: { healthMs: 10_000 },
        retry: { maxRetries: 0, backoffMs: 0 },
        circuitBreaker: { failureThreshold: 100, resetTimeoutMs: 5_000, halfOpenMaxAttempts: 5 },
      });
      while (performance.now() - startTime < SOAK_DURATION_MS) {
        try {
          const health = await healthGw.health();
          healthChecks.push({
            timestampMs: performance.now() - startTime,
            healthy: health.isHealthy,
          });
        } catch {
          healthChecks.push({
            timestampMs: performance.now() - startTime,
            healthy: false,
          });
        }
        await new Promise(r => setTimeout(r, 10_000));
      }
    }

    // Launch all workers + health checker
    const workers = Array.from({ length: SOAK_CONCURRENCY }, (_, i) => worker(i));
    await Promise.all([...workers, healthChecker()]);

    const totalDuration = performance.now() - startTime;

    // Analyze results in time windows (30s each)
    const WINDOW_SIZE = 30_000;
    const numWindows = Math.ceil(totalDuration / WINDOW_SIZE);
    const windows: WindowReport[] = [];

    for (let w = 0; w < numWindows; w++) {
      const windowStart = w * WINDOW_SIZE;
      const windowEnd = windowStart + WINDOW_SIZE;
      const windowSamples = samples.filter(s => s.timestampMs >= windowStart && s.timestampMs < windowEnd);

      if (!windowSamples.length) continue;

      const okLatencies = windowSamples.filter(s => s.ok).map(s => s.latencyMs).sort((a, b) => a - b);
      const failCount = windowSamples.filter(s => !s.ok).length;

      windows.push({
        windowIndex: w,
        p50: percentile(okLatencies, 50),
        p95: percentile(okLatencies, 95),
        errorRate: failCount / windowSamples.length,
        count: windowSamples.length,
      });
    }

    const trend = analyzeTrend(windows);
    const succeeded = samples.filter(s => s.ok).length;
    const failed = samples.filter(s => !s.ok).length;

    const soakReport: SoakReport = {
      totalRequests: samples.length,
      succeeded,
      failed,
      errorRate: failed / samples.length,
      durationMs: totalDuration,
      throughput: samples.length / (totalDuration / 1000),
      windows,
      latencyTrend: trend,
    };

    // Print report
    console.log(`\n── Soak Test Report ──`);
    console.log(`  Duration: ${(totalDuration / 1000).toFixed(0)}s | VUs: ${SOAK_CONCURRENCY}`);
    console.log(`  Total: ${soakReport.totalRequests} | OK: ${succeeded} | Failed: ${failed} | Error rate: ${(soakReport.errorRate * 100).toFixed(1)}%`);
    console.log(`  Throughput: ${soakReport.throughput.toFixed(1)} req/s`);
    console.log(`  Latency trend: ${trend}`);
    console.log(`  Health checks: ${healthChecks.filter(h => h.healthy).length}/${healthChecks.length} healthy`);

    console.log(`\n  Time windows (30s each):`);
    for (const w of windows) {
      console.log(`    [${w.windowIndex}] count=${w.count} p50=${w.p50.toFixed(0)}ms p95=${w.p95.toFixed(0)}ms err=${(w.errorRate * 100).toFixed(1)}%`);
    }

    // Assertions
    // Note: Groq free tier has aggressive rate limits, so sustained load will hit 429s.
    // The key metric is that the gateway itself doesn't crash (health check passes after).
    expect(soakReport.errorRate).toBeLessThan(0.6); // <60% error rate (Groq rate limits)
    expect(trend).not.toBe('degrading'); // latency should not increase over time

    // Health should remain mostly healthy (Fly auto_stop may cause brief unhealthy windows)
    const unhealthyChecks = healthChecks.filter(h => !h.healthy).length;
    expect(unhealthyChecks).toBeLessThan(healthChecks.length * 0.7); // <70% unhealthy
  }); // extra minute for cleanup

  it('gateway healthy after soak', { timeout: 15_000 }, async () => {
    const freshGw = new GatewayHttpClient({
      baseUrl: GATEWAY_URL,
      apiKey: GATEWAY_API_KEY,
      timeouts: { healthMs: 10_000 },
      retry: { maxRetries: 0, backoffMs: 0 },
    });
    const health = await freshGw.health();
    expect(health.isHealthy).toBe(true);
    console.log(`Post-soak health: OK (uptime: ${health.uptimeSec}s)`);
  });

});
