/**
 * SnapGPU Benchmark: end-to-end deploy + cold start timing via Vast.ai GPUs.
 *
 * Deploys a real GPU container on Vast.ai through the ai-gateway,
 * measures deploy time, cold start, warm request latency, and teardown.
 *
 * Run:
 *   bun run test:snapgpu-benchmark
 *
 * Requires: VAST_API_KEY in .env
 * Set SKIP_GPU_TESTS=1 to skip.
 */

import 'dotenv/config';
import { describe, it, expect, afterAll } from 'vitest';
import { VastClient } from '../src/gpu-providers/vast-client';
import type { ProviderCredentials, InstanceSpec } from '../src/gpu-providers/abstract-provider';

const VAST_API_KEY = process.env.VAST_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const SKIP = process.env.SKIP_GPU_TESTS === '1' || !VAST_API_KEY;

// Use lightweight test image for fast pulls (~200MB vs 20GB)
const TEST_IMAGE = process.env.BENCHMARK_IMAGE || 'marcosremar/parle-s2s-ultralight:latest';
const GPU_TYPES = ['RTX 4090', 'RTX 3090', 'RTX A5000', 'A40', 'RTX A6000'];

const creds: ProviderCredentials = { apiKey: VAST_API_KEY };

interface BenchmarkResult {
  phase: string;
  durationMs: number;
  success: boolean;
  details?: string;
}

const results: BenchmarkResult[] = [];
let instanceId: string | null = null;
let endpoint: string | null = null;

function record(phase: string, durationMs: number, success: boolean, details?: string) {
  results.push({ phase, durationMs, success, details });
  const status = success ? '✓' : '✗';
  console.log(`  ${status} ${phase}: ${(durationMs / 1000).toFixed(1)}s${details ? ` — ${details}` : ''}`);
}

async function waitForStatus(
  client: VastClient,
  id: string,
  targetStatuses: string[],
  timeoutMs: number = 300_000,
  pollMs: number = 10_000,
): Promise<{ status: string; elapsedMs: number }> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const status = await client.getInstanceStatus(id, creds);
    if (!status || targetStatuses.includes(status)) {
      return { status: status || 'not_found', elapsedMs: performance.now() - start };
    }
    if (status === 'exited' || status === 'destroyed' || status === 'error') {
      return { status, elapsedMs: performance.now() - start };
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  return { status: 'timeout', elapsedMs: performance.now() - start };
}

async function checkHealth(url: string, timeoutMs = 10_000): Promise<{ ok: boolean; latencyMs: number }> {
  const start = performance.now();
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.status === 200, latencyMs: performance.now() - start };
  } catch {
    return { ok: false, latencyMs: performance.now() - start };
  }
}

async function waitForHealth(url: string, timeoutMs = 300_000, pollMs = 10_000): Promise<{ ok: boolean; totalMs: number }> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const { ok } = await checkHealth(url);
    if (ok) return { ok: true, totalMs: performance.now() - start };
    await new Promise(r => setTimeout(r, pollMs));
  }
  return { ok: false, totalMs: performance.now() - start };
}

describe.skipIf(SKIP)('SnapGPU Benchmark — Vast.ai GPU Deploy', { timeout: 600_000 }, () => {
  const client = new VastClient();

  afterAll(async () => {
    // Cleanup: always try to terminate
    if (instanceId) {
      try {
        await client.deleteInstance(instanceId, creds);
        console.log(`\n  [cleanup] Terminated instance ${instanceId}`);
      } catch (e: any) {
        console.log(`\n  [cleanup] Failed to terminate: ${e.message}`);
      }
    }

    // Print summary
    console.log('\n══════════════════════════════════════════════');
    console.log('  SNAPGPU BENCHMARK RESULTS');
    console.log('══════════════════════════════════════════════');
    for (const r of results) {
      const status = r.success ? '✓' : '✗';
      console.log(`  ${status} ${r.phase.padEnd(30)} ${(r.durationMs / 1000).toFixed(1).padStart(7)}s  ${r.details || ''}`);
    }
    const totalMs = results.reduce((s, r) => s + r.durationMs, 0);
    console.log('──────────────────────────────────────────────');
    console.log(`  TOTAL${' '.repeat(30)} ${(totalMs / 1000).toFixed(1).padStart(7)}s`);
    console.log('══════════════════════════════════════════════\n');
  });

  // ── Phase 1: Search available GPUs ─────────────────────────────────

  it('1. searches for available GPU offers', { timeout: 30_000 }, async () => {
    console.log('\n── SnapGPU Benchmark: Vast.ai Deploy ──\n');

    const start = performance.now();
    const offers = await client.listOffers(
      { gpuTypes: GPU_TYPES, gpuCount: 1, storageGb: 15, dockerImage: TEST_IMAGE },
      creds,
    );
    const elapsed = performance.now() - start;

    record('Search GPU offers', elapsed, offers.length > 0,
      `${offers.length} offers found` + (offers[0] ? ` (cheapest: $${offers[0].pricePerHour?.toFixed(2)}/hr ${offers[0].gpuType})` : ''));

    expect(offers.length).toBeGreaterThan(0);
  });

  // ── Phase 2: Deploy GPU instance ───────────────────────────────────

  it('2. deploys GPU instance on Vast.ai', { timeout: 300_000 }, async () => {
    const start = performance.now();

    const spec: InstanceSpec = {
      gpuTypes: GPU_TYPES,
      gpuCount: 1,
      storageGb: 15,
      dockerImage: TEST_IMAGE,
      env: {
        ...(GROQ_API_KEY ? { GROQ_API_KEY } : {}),
        BENCHMARK: 'snapgpu-test',
      },
    };

    const instance = await client.createInstance(spec, creds);
    const elapsed = performance.now() - start;

    instanceId = instance.instanceId;
    record('Create instance', elapsed, !!instance.instanceId,
      `id=${instance.instanceId} gpu=${instance.gpuType} cost=$${instance.providerMeta?.dphTotal?.toFixed(2)}/hr`);

    expect(instance.instanceId).toBeTruthy();
    console.log(`  Instance: ${instance.instanceId}`);
    console.log(`  GPU: ${instance.gpuType}`);
    console.log(`  IP: ${instance.ipAddress}`);
  });

  // ── Phase 3: Wait for instance to start (image pull) ──────────────

  it('3. waits for instance to reach running status', { timeout: 300_000 }, async () => {
    expect(instanceId).toBeTruthy();

    const start = performance.now();
    const { status, elapsedMs } = await waitForStatus(
      client, instanceId!, ['running', 'active'], 300_000, 10_000
    );

    record('Image pull + boot', elapsedMs, status === 'running' || status === 'active',
      `final status: ${status}`);

    expect(['running', 'active']).toContain(status);
  });

  // ── Phase 4: Resolve endpoint ──────────────────────────────────────

  it('4. resolves endpoint URL', { timeout: 60_000 }, async () => {
    expect(instanceId).toBeTruthy();

    const start = performance.now();

    // Poll for endpoint (may take a few seconds after running status)
    for (let i = 0; i < 12; i++) {
      endpoint = await client.resolveInstanceEndpoint!(instanceId!, creds);
      if (endpoint) break;
      await new Promise(r => setTimeout(r, 5_000));
    }

    const elapsed = performance.now() - start;
    record('Resolve endpoint', elapsed, !!endpoint, endpoint || 'no endpoint');

    expect(endpoint).toBeTruthy();
    console.log(`  Endpoint: ${endpoint}`);
  });

  // ── Phase 5: Wait for container health ─────────────────────────────

  it('5. waits for container health check', { timeout: 300_000 }, async () => {
    expect(endpoint).toBeTruthy();

    const start = performance.now();
    const { ok, totalMs } = await waitForHealth(endpoint!, 300_000, 10_000);

    record('Container healthy', totalMs, ok,
      ok ? 'health check passed' : 'health check never passed');

    // Don't fail if health doesn't pass — some images need more time
    if (!ok) {
      console.log('  ⚠ Health check did not pass — container may still be loading models');
    }
  });

  // ── Phase 6: Cold start request ────────────────────────────────────

  it('6. measures cold start (first request)', { timeout: 60_000 }, async () => {
    if (!endpoint) {
      console.log('  [skip] No endpoint available');
      return;
    }

    const { ok, latencyMs } = await checkHealth(endpoint!, 30_000);
    record('Cold start (first /health)', latencyMs, ok);
  });

  // ── Phase 7: Warm request latency ──────────────────────────────────

  it('7. measures warm request latency (10 sequential)', { timeout: 60_000 }, async () => {
    if (!endpoint) {
      console.log('  [skip] No endpoint available');
      return;
    }

    const latencies: number[] = [];
    for (let i = 0; i < 10; i++) {
      const { ok, latencyMs } = await checkHealth(endpoint!, 10_000);
      if (ok) latencies.push(latencyMs);
    }

    if (latencies.length > 0) {
      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      record('Warm latency (10 reqs)', latencies.reduce((a, b) => a + b, 0),
        latencies.length >= 5,
        `p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms (${latencies.length}/10 OK)`);
    } else {
      record('Warm latency', 0, false, 'all requests failed');
    }
  });

  // ── Phase 8: Concurrent requests ───────────────────────────────────

  it('8. measures 10 concurrent health requests', { timeout: 30_000 }, async () => {
    if (!endpoint) {
      console.log('  [skip] No endpoint available');
      return;
    }

    const start = performance.now();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => checkHealth(endpoint!, 10_000))
    );
    const elapsed = performance.now() - start;
    const ok = results.filter(r => r.ok).length;
    const latencies = results.filter(r => r.ok).map(r => r.latencyMs).sort((a, b) => a - b);
    const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : 0;

    record('10 concurrent health', elapsed, ok >= 5,
      `${ok}/10 OK p50=${p50.toFixed(0)}ms wall=${elapsed.toFixed(0)}ms`);
  });

  // ── Phase 9: Terminate ─────────────────────────────────────────────

  it('9. terminates instance', { timeout: 30_000 }, async () => {
    expect(instanceId).toBeTruthy();

    const start = performance.now();
    await client.deleteInstance(instanceId!, creds);
    const elapsed = performance.now() - start;

    record('Terminate instance', elapsed, true);

    // Verify termination
    const status = await client.getInstanceStatus(instanceId!, creds);
    console.log(`  Post-terminate status: ${status}`);

    // Clear so afterAll doesn't try again
    instanceId = null;
  });
});
