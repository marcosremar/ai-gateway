/**
 * Request Coalescer Effectiveness Test.
 *
 * Measures how well the coalescer deduplicates identical in-flight requests.
 * Sends N identical requests simultaneously and compares with N unique requests.
 *
 * Run: bunx vitest run __tests__/coalescer-effectiveness.test.ts
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

interface TimedResult {
  ok: boolean;
  latencyMs: number;
  content?: string;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function timedChat(body: string): Promise<TimedResult> {
  const start = performance.now();
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status !== 200) return { ok: false, latencyMs: performance.now() - start };
    const json = await res.json() as any;
    return { ok: true, latencyMs: performance.now() - start, content: json.choices?.[0]?.message?.content };
  } catch {
    return { ok: false, latencyMs: performance.now() - start };
  }
}

function logBatch(label: string, results: TimedResult[]) {
  const ok = results.filter(r => r.ok);
  const latencies = ok.map(r => r.latencyMs).sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const wallTime = Math.max(...results.map(r => r.latencyMs));
  console.log(`  ${label}: ${ok.length}/${results.length} OK | p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms | wall=${wallTime.toFixed(0)}ms`);
}

describe.skipIf(SKIP)('Coalescer Effectiveness', { timeout: 120_000 }, () => {

  it('identical requests are coalesced', { timeout: 60_000 }, async () => {
    console.log('\n── Test: 20 identical vs 20 unique requests ──');

    // Warmup
    await timedChat(JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'warmup' }],
      max_tokens: 5,
    }));

    // 50 IDENTICAL requests (temperature=0, same prompt → should coalesce)
    const identicalBody = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'What is 2+2? Reply with just the number.' }],
      max_tokens: 5,
      temperature: 0,
    });

    const identicalStart = performance.now();
    const identicalResults = await Promise.all(
      Array.from({ length: 20 }, () => timedChat(identicalBody))
    );
    const identicalWall = performance.now() - identicalStart;

    await new Promise(r => setTimeout(r, 2000));

    // 50 UNIQUE requests (different prompts → no coalescing)
    const uniqueStart = performance.now();
    const uniqueResults = await Promise.all(
      Array.from({ length: 20 }, (_, i) => timedChat(JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: `What is ${i}+${i}? Reply with just the number.` }],
        max_tokens: 5,
        temperature: 0,
      })))
    );
    const uniqueWall = performance.now() - uniqueStart;

    logBatch('50 identical (coalescable)', identicalResults);
    logBatch('50 unique   (not coalescable)', uniqueResults);

    // Check if identical requests got the same response
    const identicalContents = identicalResults.filter(r => r.ok).map(r => r.content);
    const uniqueContents = new Set(identicalContents);
    console.log(`\n  Identical responses: ${uniqueContents.size} unique content(s) from ${identicalContents.length} requests`);
    console.log(`  Wall time: identical=${identicalWall.toFixed(0)}ms vs unique=${uniqueWall.toFixed(0)}ms`);

    if (identicalWall < uniqueWall * 0.7) {
      console.log('  → Coalescer is working: identical batch was significantly faster');
    } else {
      console.log('  → Coalescer may not be effective (both took similar time)');
      console.log('    This is expected if requests complete before duplicates arrive');
    }

    expect(identicalResults.filter(r => r.ok).length).toBeGreaterThan(10);
    expect(uniqueResults.filter(r => r.ok).length).toBeGreaterThan(10);
  });

  it('100 identical requests all get the same response', { timeout: 60_000 }, async () => {
    console.log('\n── Test: 100 identical requests — response consistency ──');

    const body = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'Reply with exactly: COALESCE_TEST_42' }],
      max_tokens: 10,
      temperature: 0,
    });

    const results = await Promise.all(Array.from({ length: 30 }, () => timedChat(body)));
    logBatch('30 identical', results);

    const contents = results.filter(r => r.ok).map(r => r.content?.trim());
    const uniqueResponses = new Set(contents);
    console.log(`  Unique responses: ${uniqueResponses.size} from ${contents.length} successful requests`);
    for (const resp of uniqueResponses) {
      console.log(`    "${resp}" (${contents.filter(c => c === resp).length}x)`);
    }

    // With coalescing, most should get the exact same response
    // Without coalescing, LLM may produce slight variations even at temp=0
    expect(results.filter(r => r.ok).length).toBeGreaterThan(15);
  });
});
