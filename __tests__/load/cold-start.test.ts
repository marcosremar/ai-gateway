/**
 * Cold Start Test: measures time from scale-to-zero to first response.
 *
 * Stops all Fly machines, waits, then sends a request and measures total time.
 * This is the real-world latency a user would experience after idle periods.
 *
 * Run: bunx vitest run __tests__/cold-start.test.ts
 * Set SKIP_LIVE_TESTS=1 to skip.
 *
 * WARNING: This test stops machines! Only run against the loadtest app.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

const GATEWAY_URL = process.env.GATEWAY_URL || process.env.GATEWAY_URL || 'http://localhost:4000';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || 'gw_loadtest_2026';
const FLY_APP = process.env.FLY_APP || 'parle-gateway-loadtest';
const SKIP = process.env.SKIP_LIVE_TESTS === '1';

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${GATEWAY_API_KEY}`,
};

async function timedRequest(
  path: string,
  body?: string,
): Promise<{ ok: boolean; latencyMs: number; status: number }> {
  const start = performance.now();
  try {
    const res = await fetch(`${GATEWAY_URL}${path}`, {
      method: body ? 'POST' : 'GET',
      headers,
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(60_000), // 60s timeout for cold start
    });
    return { ok: res.status === 200, latencyMs: performance.now() - start, status: res.status };
  } catch {
    return { ok: false, latencyMs: performance.now() - start, status: 0 };
  }
}

function stopAllMachines(): boolean {
  try {
    const output = execSync(`flyctl machines list -a ${FLY_APP} --json 2>/dev/null`, {
      encoding: 'utf-8',
    });
    const machines = JSON.parse(output) as Array<{ id: string; state: string }>;
    const running = machines.filter((m) => m.state === 'started' || m.state === 'starting');

    for (const machine of running) {
      console.log(`  Stopping machine ${machine.id}...`);
      execSync(`flyctl machines stop ${machine.id} -a ${FLY_APP} 2>/dev/null`, {
        encoding: 'utf-8',
      });
    }
    return running.length > 0;
  } catch (err: any) {
    console.log(`  Failed to stop machines: ${err.message}`);
    return false;
  }
}

function getMachineStates(): Array<{ id: string; state: string }> {
  try {
    const output = execSync(`flyctl machines list -a ${FLY_APP} --json 2>/dev/null`, {
      encoding: 'utf-8',
    });
    return JSON.parse(output) as Array<{ id: string; state: string }>;
  } catch {
    return [];
  }
}

describe.skipIf(SKIP)('Cold Start — Scale to Zero', { timeout: 300_000 }, () => {
  it('measures cold start latency (health endpoint)', { timeout: 120_000 }, async () => {
    console.log('\n── Cold Start: /health ──');

    // 1. Stop all machines
    console.log('  Stopping all machines...');
    stopAllMachines();

    // 2. Wait for machines to fully stop
    console.log('  Waiting 10s for machines to stop...');
    await new Promise((r) => setTimeout(r, 10_000));

    const states = getMachineStates();
    console.log(
      `  Machine states: ${states.map((m) => `${m.id.slice(0, 6)}=${m.state}`).join(', ')}`,
    );

    // 3. Send request and measure total cold start time
    console.log('  Sending cold request...');
    const result = await timedRequest('/health');

    console.log(
      `  Cold start health: status=${result.status} latency=${result.latencyMs.toFixed(0)}ms`,
    );
    expect(result.ok).toBe(true);

    // Cold start should be under 10 seconds (Fly VM boot + Bun startup)
    expect(result.latencyMs).toBeLessThan(10_000);
    console.log(`  ✓ Cold start: ${result.latencyMs.toFixed(0)}ms`);
  });

  it('measures cold start latency (chat endpoint)', { timeout: 120_000 }, async () => {
    console.log('\n── Cold Start: /v1/chat/completions ──');

    // Stop all machines
    stopAllMachines();
    await new Promise((r) => setTimeout(r, 10_000));

    const chatBody = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'reply OK' }],
      max_tokens: 5,
    });

    console.log('  Sending cold chat request...');
    const result = await timedRequest('/v1/chat/completions', chatBody);
    console.log(
      `  Cold start chat: status=${result.status} latency=${result.latencyMs.toFixed(0)}ms`,
    );
    expect(result.ok).toBe(true);

    // Includes Fly boot + Bun start + Groq API call
    expect(result.latencyMs).toBeLessThan(15_000);
    console.log(`  ✓ Cold start + Groq: ${result.latencyMs.toFixed(0)}ms`);
  });

  it('cold start then immediate burst', { timeout: 120_000 }, async () => {
    console.log('\n── Cold Start → Immediate 50-request burst ──');

    stopAllMachines();
    await new Promise((r) => setTimeout(r, 10_000));

    const chatBody = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'reply OK' }],
      max_tokens: 5,
    });

    // Fire 50 requests at once — first one triggers cold start, rest queue
    console.log('  Firing 50 requests at stopped machine...');
    const start = performance.now();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => timedRequest('/v1/chat/completions', chatBody)),
    );
    const wallTime = performance.now() - start;

    const ok = results.filter((r) => r.ok);
    const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
    const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : 0;
    const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : 0;

    console.log(
      `  ${ok.length}/50 OK | p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms | wall=${wallTime.toFixed(0)}ms`,
    );
    console.log(
      `  First response: ${latencies[0]?.toFixed(0)}ms | Last: ${latencies.at(-1)?.toFixed(0)}ms`,
    );

    // Most should succeed even with cold start
    expect(ok.length).toBeGreaterThan(25);
  });

  it('warm → stop → warm: measure restart penalty', { timeout: 120_000 }, async () => {
    console.log('\n── Restart Penalty: warm → stop → warm ──');

    // 1. Warm request
    const warm1 = await timedRequest(
      '/v1/chat/completions',
      JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'warm1' }],
        max_tokens: 5,
      }),
    );
    console.log(`  Warm request: ${warm1.latencyMs.toFixed(0)}ms`);

    // 2. Stop
    stopAllMachines();
    await new Promise((r) => setTimeout(r, 10_000));

    // 3. Cold request
    const cold = await timedRequest(
      '/v1/chat/completions',
      JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'cold' }],
        max_tokens: 5,
      }),
    );
    console.log(`  Cold request: ${cold.latencyMs.toFixed(0)}ms`);

    // 4. Warm again
    const warm2 = await timedRequest(
      '/v1/chat/completions',
      JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'warm2' }],
        max_tokens: 5,
      }),
    );
    console.log(`  Re-warm request: ${warm2.latencyMs.toFixed(0)}ms`);

    const penalty = cold.latencyMs - warm1.latencyMs;
    console.log(`\n  Cold start penalty: ~${penalty.toFixed(0)}ms`);

    expect(warm1.ok).toBe(true);
    expect(cold.ok).toBe(true);
    expect(warm2.ok).toBe(true);
  });
});
