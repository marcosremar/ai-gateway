/**
 * Memory Soak Test: monitors memory usage under sustained load.
 *
 * Sends requests for several minutes and polls /health or a memory endpoint
 * to detect RSS growth (memory leaks).
 *
 * Run: bunx vitest run __tests__/memory-soak.test.ts
 * Set SKIP_LIVE_TESTS=1 to skip.
 * Set MEMORY_SOAK_DURATION_MS=120000 for duration (default 2 min).
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://parle-gateway-loadtest.fly.dev';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || 'gw_loadtest_2026';
const FLY_APP = process.env.FLY_APP || 'parle-gateway-loadtest';
const SKIP = process.env.SKIP_LIVE_TESTS === '1';
const DURATION_MS = Number(process.env.MEMORY_SOAK_DURATION_MS) || 2 * 60 * 1000;

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${GATEWAY_API_KEY}`,
};

interface MemorySample {
  timestampMs: number;
  rssKb: number | null;
  requestsOk: number;
  requestsFailed: number;
}

function getMachineMemory(): number | null {
  try {
    const output = execSync(
      `flyctl ssh console -a ${FLY_APP} -C "cat /proc/1/status 2>/dev/null | grep VmRSS" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 10_000 },
    );
    const match = output.match(/VmRSS:\s+(\d+)/);
    return match ? parseInt(match[1]) : null;
  } catch {
    return null;
  }
}

function getMachineMemoryViaTop(): number | null {
  try {
    const output = execSync(
      `flyctl ssh console -a ${FLY_APP} -C "ps -o rss= -p 1" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 10_000 },
    );
    const kb = parseInt(output.trim());
    return isNaN(kb) ? null : kb;
  } catch {
    return null;
  }
}

describe.skipIf(SKIP)('Memory Soak', { timeout: DURATION_MS + 120_000 }, () => {

  it(`monitors memory under load for ${DURATION_MS / 1000}s`, { timeout: DURATION_MS + 60_000 }, async () => {
    console.log(`\n── Memory Soak: ${DURATION_MS / 1000}s, 10 concurrent workers ──`);

    const samples: MemorySample[] = [];
    const startTime = performance.now();
    let totalOk = 0;
    let totalFailed = 0;
    let running = true;

    // Worker: sends requests continuously
    async function worker() {
      while (running) {
        try {
          const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: 'llama-3.3-70b-versatile',
              messages: [{ role: 'user', content: `mem-test-${Date.now()}: reply OK` }],
              max_tokens: 5,
            }),
            signal: AbortSignal.timeout(15_000),
          });
          if (res.status === 200) totalOk++;
          else totalFailed++;
        } catch {
          totalFailed++;
          await new Promise(r => setTimeout(r, 1_000));
        }
      }
    }

    // Memory sampler: every 15 seconds
    async function sampler() {
      while (running) {
        const rss = getMachineMemory() ?? getMachineMemoryViaTop();
        samples.push({
          timestampMs: performance.now() - startTime,
          rssKb: rss,
          requestsOk: totalOk,
          requestsFailed: totalFailed,
        });
        await new Promise(r => setTimeout(r, 15_000));
      }
    }

    // Take initial sample
    const initialRss = getMachineMemory() ?? getMachineMemoryViaTop();
    console.log(`  Initial RSS: ${initialRss ? `${(initialRss / 1024).toFixed(1)}MB` : 'N/A (SSH not available)'}`);

    // Start workers + sampler
    const workers = Array.from({ length: 10 }, () => worker());
    const samplerPromise = sampler();

    // Run for duration
    await new Promise(r => setTimeout(r, DURATION_MS));
    running = false;
    await Promise.allSettled([...workers, samplerPromise]);

    // Final sample
    const finalRss = getMachineMemory() ?? getMachineMemoryViaTop();

    // Report
    console.log(`\n  Duration: ${((performance.now() - startTime) / 1000).toFixed(0)}s`);
    console.log(`  Requests: ${totalOk} OK, ${totalFailed} failed`);
    console.log(`  Final RSS: ${finalRss ? `${(finalRss / 1024).toFixed(1)}MB` : 'N/A'}`);

    if (samples.some(s => s.rssKb !== null)) {
      console.log('\n  Memory timeline:');
      for (const s of samples) {
        const rss = s.rssKb ? `${(s.rssKb / 1024).toFixed(1)}MB` : 'N/A';
        console.log(`    t=${(s.timestampMs / 1000).toFixed(0).padStart(4)}s: RSS=${rss.padStart(8)} | ok=${s.requestsOk} fail=${s.requestsFailed}`);
      }

      // Check for memory growth
      const rssValues = samples.filter(s => s.rssKb !== null).map(s => s.rssKb!);
      if (rssValues.length >= 3) {
        const firstThird = rssValues.slice(0, Math.floor(rssValues.length / 3));
        const lastThird = rssValues.slice(-Math.floor(rssValues.length / 3));
        const avgFirst = firstThird.reduce((a, b) => a + b, 0) / firstThird.length;
        const avgLast = lastThird.reduce((a, b) => a + b, 0) / lastThird.length;
        const growth = ((avgLast - avgFirst) / avgFirst) * 100;

        console.log(`\n  Memory growth: ${growth.toFixed(1)}%`);
        if (growth > 50) {
          console.log('  ⚠ Possible memory leak detected (>50% growth)');
        } else {
          console.log('  ✓ Memory stable');
        }

        // Memory shouldn't grow more than 100% over the test duration
        expect(growth).toBeLessThan(100);
      }
    } else {
      console.log('\n  ⚠ SSH not available — could not measure memory directly');
      console.log('  Check Fly.io dashboard: https://fly.io/apps/' + FLY_APP + '/monitoring');
    }

    // Gateway should be healthy after soak
    const health = await fetch(`${GATEWAY_URL}/health`, { headers });
    expect(health.status).toBe(200);
  });
});
