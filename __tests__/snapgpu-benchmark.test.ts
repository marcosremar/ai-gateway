/**
 * SnapGPU Benchmark: end-to-end deploy + cold start via Vast.ai GPUs.
 *
 * Uses VastClient.createInstance which handles SSH tunnels automatically
 * for hosts without direct ports. Filters for direct-port hosts to ensure
 * endpoint is accessible from the test runner.
 *
 * Run:
 *   SKIP_GPU_TESTS=0 bun run test:snapgpu-benchmark
 *
 * Requires: VAST_API_KEY in .env
 */

import 'dotenv/config';
import { describe, it, expect, afterAll } from 'vitest';
import { VastClient } from '../src/gpu-providers/vast-client';
import type { ProviderCredentials } from '../src/gpu-providers/abstract-provider';

const VAST_API_KEY = process.env.VAST_API_KEY || '';
const SKIP = process.env.SKIP_GPU_TESTS === '1' || !VAST_API_KEY;

const TEST_IMAGE = 'marcosremar/parle-s2s-ultralight:latest';
// GPUs with direct HTTP ports available (verified via Vast.ai search)
const GPU_TYPES = ['RTX 3090', 'RTX 3080 Ti', 'RTX 4080S', 'RTX 4080', 'RTX 4090', 'RTX A4000'];
const creds: ProviderCredentials = { apiKey: VAST_API_KEY };

interface BenchResult { phase: string; ms: number; ok: boolean; detail?: string }
const log: BenchResult[] = [];
let instanceId: string | null = null;
let endpoint: string | null = null;

function rec(phase: string, ms: number, ok: boolean, detail?: string) {
  log.push({ phase, ms, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${phase}: ${(ms / 1000).toFixed(1)}s${detail ? ` — ${detail}` : ''}`);
}

async function probe(url: string, ms = 8_000): Promise<{ ok: boolean; ms: number; status?: number; body?: any }> {
  const t = performance.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    const body = await r.json().catch(() => null);
    return { ok: r.status === 200, ms: performance.now() - t, status: r.status, body };
  } catch {
    return { ok: false, ms: performance.now() - t };
  }
}

/** Poll until fn returns true, with interval and timeout */
async function poll(fn: () => Promise<boolean>, intervalMs: number, timeoutMs: number): Promise<{ ok: boolean; ms: number }> {
  const t = performance.now();
  while (performance.now() - t < timeoutMs) {
    if (await fn()) return { ok: true, ms: performance.now() - t };
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { ok: false, ms: performance.now() - t };
}

describe.skipIf(SKIP)('SnapGPU Benchmark — Vast.ai GPU', { timeout: 900_000 }, () => {
  const client = new VastClient();

  afterAll(async () => {
    if (instanceId) {
      try { await client.deleteInstance(instanceId, creds); } catch {}
      console.log(`  [cleanup] Terminated ${instanceId}`);
    }
    console.log('\n══════════════════════════════════════════════════════');
    console.log('  SNAPGPU BENCHMARK RESULTS');
    console.log('══════════════════════════════════════════════════════');
    for (const r of log) {
      console.log(`  ${r.ok ? '✓' : '✗'} ${r.phase.padEnd(38)} ${(r.ms / 1000).toFixed(1).padStart(7)}s  ${r.detail || ''}`);
    }
    const total = log.reduce((s, r) => s + r.ms, 0);
    console.log('──────────────────────────────────────────────────────');
    console.log(`  TOTAL${' '.repeat(38)} ${(total / 1000).toFixed(1).padStart(7)}s`);
    console.log('══════════════════════════════════════════════════════\n');
  });

  // ── 1. Search ──────────────────────────────────────────────────────

  it('1. search GPU offers', { timeout: 30_000 }, async () => {
    console.log('\n── SnapGPU Benchmark: Vast.ai Deploy ──\n');
    const t = performance.now();
    const offers = await client.listOffers(
      { gpuTypes: GPU_TYPES, gpuCount: 1, storageGb: 10, dockerImage: TEST_IMAGE },
      creds,
    );
    rec('Search GPU offers', performance.now() - t, offers.length > 0, `${offers.length} offers`);
    expect(offers.length).toBeGreaterThan(0);
  });

  // ── 2. Deploy (create + wait for endpoint) ─────────────────────────

  it('2. deploy instance', { timeout: 300_000 }, async () => {
    const t = performance.now();
    const instance = await client.createInstance(
      { gpuTypes: GPU_TYPES, gpuCount: 1, storageGb: 10, dockerImage: TEST_IMAGE,
        env: { BENCHMARK: '1' } },
      creds,
    );
    const ms = performance.now() - t;
    instanceId = instance.instanceId;
    endpoint = instance.endpoint;
    rec('Deploy (create + wait)', ms, !!instanceId,
      `gpu=${instance.gpuType} $${instance.providerMeta?.dphTotal?.toFixed(2)}/hr` +
      (endpoint ? ` endpoint=${endpoint}` : ' (no direct endpoint)'));
    expect(instanceId).toBeTruthy();
  });

  // ── 3. Resolve endpoint (if not yet available) ─────────────────────

  it('3. resolve endpoint', { timeout: 60_000 }, async () => {
    if (endpoint) {
      rec('Resolve endpoint', 0, true, `already have: ${endpoint}`);
      return;
    }
    expect(instanceId).toBeTruthy();
    const t = performance.now();
    for (let i = 0; i < 12; i++) {
      endpoint = await client.resolveInstanceEndpoint!(instanceId!, creds);
      if (endpoint) break;
      await new Promise(r => setTimeout(r, 5_000));
    }
    rec('Resolve endpoint', performance.now() - t, !!endpoint, endpoint || 'none');
    expect(endpoint).toBeTruthy();
  });

  // ── 4. Cold start: poll /health until responds ─────────────────────

  it('4. cold start (/health first response)', { timeout: 600_000 }, async () => {
    expect(endpoint).toBeTruthy();
    const t = performance.now();
    const { ok, ms } = await poll(
      async () => (await probe(`${endpoint}/health`, 10_000)).ok,
      5_000, 540_000 // poll every 5s, max 9 min
    );
    rec('Cold start (/health)', ms, ok,
      ok ? `healthy after ${(ms / 1000).toFixed(1)}s` : 'never responded');
    expect(ok).toBe(true);
  });

  // ── 5. Warm latency ────────────────────────────────────────────────

  it('5. warm latency (20 sequential)', { timeout: 60_000 }, async () => {
    expect(endpoint).toBeTruthy();
    const latencies: number[] = [];
    for (let i = 0; i < 20; i++) {
      const { ok, ms } = await probe(`${endpoint}/health`);
      if (ok) latencies.push(ms);
    }
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
    const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
    const total = latencies.reduce((a, b) => a + b, 0);
    rec('Warm latency (20 seq)', total, latencies.length >= 10,
      `p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms (${latencies.length}/20 OK)`);
    expect(latencies.length).toBeGreaterThanOrEqual(10);
  });

  // ── 6. Concurrent requests ─────────────────────────────────────────

  it('6. concurrent (20 parallel)', { timeout: 30_000 }, async () => {
    expect(endpoint).toBeTruthy();
    const t = performance.now();
    const results = await Promise.all(Array.from({ length: 20 }, () => probe(`${endpoint}/health`)));
    const wall = performance.now() - t;
    const ok = results.filter(r => r.ok).length;
    const lats = results.filter(r => r.ok).map(r => r.ms).sort((a, b) => a - b);
    const p50 = lats.length ? lats[Math.floor(lats.length * 0.5)] : 0;
    rec('20 concurrent /health', wall, ok >= 10,
      `${ok}/20 OK p50=${p50.toFixed(0)}ms wall=${wall.toFixed(0)}ms`);
    expect(ok).toBeGreaterThanOrEqual(10);
  });

  // ── 7. Inference: STT ──────────────────────────────────────────────

  it('7. inference: STT', { timeout: 30_000 }, async () => {
    expect(endpoint).toBeTruthy();
    // Minimal WAV: 1s silence
    const buf = new ArrayBuffer(44 + 32000);
    const v = new DataView(buf);
    const e = new TextEncoder();
    let o = 0;
    for (const b of e.encode('RIFF')) v.setUint8(o++, b);
    v.setUint32(o, 36 + 32000, true); o += 4;
    for (const b of e.encode('WAVE')) v.setUint8(o++, b);
    for (const b of e.encode('fmt ')) v.setUint8(o++, b);
    v.setUint32(o, 16, true); o += 4;
    v.setUint16(o, 1, true); o += 2;
    v.setUint16(o, 1, true); o += 2;
    v.setUint32(o, 16000, true); o += 4;
    v.setUint32(o, 32000, true); o += 4;
    v.setUint16(o, 2, true); o += 2;
    v.setUint16(o, 16, true); o += 2;
    for (const b of e.encode('data')) v.setUint8(o++, b);
    v.setUint32(o, 32000, true);

    const t = performance.now();
    try {
      const res = await fetch(`${endpoint}/v1/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: new Uint8Array(buf),
        signal: AbortSignal.timeout(15_000),
      });
      const ms = performance.now() - t;
      const data = await res.json().catch(() => null) as any;
      rec('Inference: STT', ms, res.status === 200,
        `"${data?.text?.slice(0, 60) || 'n/a'}" (${ms.toFixed(0)}ms)`);
      expect(res.status).toBe(200);
    } catch (err: any) {
      rec('Inference: STT', performance.now() - t, false, err.message?.slice(0, 60));
    }
  });

  // ── 8. Inference: translate ────────────────────────────────────────

  it('8. inference: translate', { timeout: 30_000 }, async () => {
    expect(endpoint).toBeTruthy();
    const t = performance.now();
    try {
      const res = await fetch(`${endpoint}/v1/translate/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Bonjour le monde', source_lang: 'fr', target_lang: 'en' }),
        signal: AbortSignal.timeout(15_000),
      });
      const ms = performance.now() - t;
      const data = await res.json().catch(() => null) as any;
      rec('Inference: translate', ms, res.status === 200,
        `"${data?.translated_text?.slice(0, 60) || 'n/a'}" (${ms.toFixed(0)}ms)`);
      expect(res.status).toBe(200);
    } catch (err: any) {
      rec('Inference: translate', performance.now() - t, false, err.message?.slice(0, 60));
    }
  });

  // ── 9. Terminate ───────────────────────────────────────────────────

  it('9. terminate', { timeout: 30_000 }, async () => {
    expect(instanceId).toBeTruthy();
    const t = performance.now();
    await client.deleteInstance(instanceId!, creds);
    rec('Terminate', performance.now() - t, true);
    instanceId = null;
  });
});
