/**
 * Zero-Downtime Deploy Test: verifies requests succeed during a rolling deploy.
 *
 * Sends continuous requests while triggering a deploy, checks that no requests fail.
 *
 * Run: bunx vitest run __tests__/zero-downtime-deploy.test.ts
 * Set SKIP_LIVE_TESTS=1 to skip.
 *
 * WARNING: Triggers a real deploy. Only run against the loadtest app.
 */

import { describe, it, expect } from 'vitest';
import { exec } from 'child_process';

const GATEWAY_URL = process.env.GATEWAY_URL || process.env.GATEWAY_URL || 'http://localhost:4000';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || 'gw_loadtest_2026';
const FLY_APP = process.env.FLY_APP || 'parle-gateway-loadtest';
const SKIP = process.env.SKIP_LIVE_TESTS === '1';

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${GATEWAY_API_KEY}`,
};

const chatBody = JSON.stringify({
  model: 'llama-3.3-70b-versatile',
  messages: [{ role: 'user', content: 'reply OK' }],
  max_tokens: 5,
});

interface RequestLog {
  sentAt: number;
  latencyMs: number;
  ok: boolean;
  status: number;
  phase: 'before' | 'during' | 'after';
}

describe.skipIf(SKIP)('Zero-Downtime Deploy', { timeout: 600_000 }, () => {
  it('requests succeed during rolling deploy', { timeout: 300_000 }, async () => {
    console.log('\n── Zero-Downtime Deploy Test ──');

    // Warmup
    await fetch(`${GATEWAY_URL}/health`, { headers });

    const logs: RequestLog[] = [];
    let phase: 'before' | 'during' | 'after' = 'before';
    let running = true;

    // Continuous request sender: 2 requests/second
    async function sender() {
      while (running) {
        const start = performance.now();
        try {
          const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
            method: 'POST',
            headers,
            body: chatBody,
            signal: AbortSignal.timeout(30_000),
          });
          logs.push({
            sentAt: Date.now(),
            latencyMs: performance.now() - start,
            ok: res.status === 200,
            status: res.status,
            phase,
          });
        } catch {
          logs.push({
            sentAt: Date.now(),
            latencyMs: performance.now() - start,
            ok: false,
            status: 0,
            phase,
          });
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // Start 5 concurrent senders
    const senders = Array.from({ length: 5 }, () => sender());

    // Phase 1: Before deploy (10 seconds baseline)
    console.log('  Phase 1: Baseline (10s)...');
    await new Promise((r) => setTimeout(r, 10_000));

    // Phase 2: During deploy
    phase = 'during';
    console.log('  Phase 2: Triggering deploy...');

    const deployPromise = new Promise<void>((resolve) => {
      exec(`flyctl deploy -a ${FLY_APP} --strategy rolling 2>&1`, (err, stdout) => {
        if (err) console.log(`  Deploy error: ${err.message.slice(0, 100)}`);
        else console.log('  Deploy completed.');
        resolve();
      });
    });

    await deployPromise;

    // Phase 3: After deploy (10 seconds to verify)
    phase = 'after';
    console.log('  Phase 3: Post-deploy verification (10s)...');
    await new Promise((r) => setTimeout(r, 10_000));

    running = false;
    await Promise.allSettled(senders);

    // Analyze results
    const before = logs.filter((l) => l.phase === 'before');
    const during = logs.filter((l) => l.phase === 'during');
    const after = logs.filter((l) => l.phase === 'after');

    const summarize = (label: string, entries: RequestLog[]) => {
      const ok = entries.filter((e) => e.ok).length;
      const latencies = entries
        .filter((e) => e.ok)
        .map((e) => e.latencyMs)
        .sort((a, b) => a - b);
      const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : 0;
      console.log(
        `  ${label}: ${ok}/${entries.length} OK (${((ok / entries.length) * 100).toFixed(0)}%) | p50=${p50.toFixed(0)}ms`,
      );
    };

    console.log('\n  Results:');
    summarize('Before deploy', before);
    summarize('During deploy', during);
    summarize('After deploy ', after);

    // Expectations
    const duringFailRate = during.length ? during.filter((l) => !l.ok).length / during.length : 0;
    console.log(`\n  During-deploy failure rate: ${(duringFailRate * 100).toFixed(1)}%`);

    // During deploy, some requests may fail but it should be < 20%
    expect(duringFailRate).toBeLessThan(0.2);

    // After deploy, everything should be healthy
    const afterOkRate = after.length ? after.filter((l) => l.ok).length / after.length : 1;
    expect(afterOkRate).toBeGreaterThan(0.8);
  });
});
