#!/usr/bin/env bun
// Benchmark: how fast can Hyperstack start a STOPPED VM vs create a new one?
// Deploy VM → stop → start → measure wall time to ACTIVE + SSH.
// Repeats N times to gauge variance.
//
// Usage: HYPERSTACK_KEY_NAME=codex-criu-test-ca bun scripts/snapshot-bench/stopped-start-bench.ts

import 'dotenv/config';
import { HyperstackClient } from '../../src/gateway/providers/gpu/hyperstack-client';
import type { ProviderCredentials } from '../../src/gateway/providers/gpu/types';

const API_KEY = process.env.HYPERSTACK_API_KEY!;
const IMAGE = process.env.HYPERSTACK_BENCH_IMAGE_NAME ?? 'ai-gateway-bench-2026-04-18';
const GPU = process.env.BENCH_GPU ?? 'NVIDIA L40';
const REGION = 'CANADA-1';
const CYCLES = Number(process.env.BENCH_CYCLES ?? 2);

const client = new HyperstackClient({ defaultRegion: REGION });
const creds: ProviderCredentials = { apiKey: API_KEY };

async function waitFor(vmId: string, want: 'running' | 'stopped', timeoutMs: number): Promise<number> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3_000));
    const st = await client.getInstanceStatus(vmId, creds).catch(() => null);
    if (st === want) return performance.now() - start;
  }
  throw new Error(`VM ${vmId} did not reach ${want} within ${timeoutMs/1000}s`);
}

async function tcpPortReachable(host: string, port: number, timeoutMs: number): Promise<number> {
  const net = await import('node:net');
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = new net.Socket();
      let done = false;
      const finish = (r: boolean) => { if (!done) { done = true; try { s.destroy(); } catch {}; resolve(r); } };
      s.setTimeout(2000);
      s.once('connect', () => finish(true));
      s.once('timeout', () => finish(false));
      s.once('error', () => finish(false));
      s.connect(port, host);
    });
    if (ok) return performance.now() - start;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`${host}:${port} not reachable`);
}

async function main() {
  console.log(`== stopped-start bench ==\n  image=${IMAGE} gpu=${GPU} cycles=${CYCLES}\n`);

  // 1. Cold deploy once.
  console.log('[0] cold deploy (baseline) …');
  const coldStart = performance.now();
  const created = await client.createInstance({
    gpuTypes: [GPU], region: REGION, numGpus: 1, storageGb: 40,
    dockerImage: 'marcosremar/babelcast-subtitle:latest',
    hfToken: process.env.HF_TOKEN || '',
    imageName: IMAGE, interruptible: false, deployEnv: {},
    dockerStartCmd: '', onstart: '', containerDiskInGb: 40, volumeId: '', preferSsd: false,
  } as any, creds);
  const vmId = String((created as any).instanceId ?? (created as any).id);
  await waitFor(vmId, 'running', 20 * 60_000);
  const endpoint = await client.resolveInstanceEndpoint(vmId, creds);
  const host = new URL(endpoint!).hostname;
  await tcpPortReachable(host, 22, 5 * 60_000);
  const coldDeployMs = performance.now() - coldStart;
  console.log(`   vm=${vmId} host=${host} cold_deploy=${(coldDeployMs/1000).toFixed(1)}s\n`);

  const cycles: Array<{ stopMs: number; startToActiveMs: number; startToSshMs: number }> = [];
  for (let i = 1; i <= CYCLES; i++) {
    console.log(`[${i}] stop → start cycle`);
    const sStart = performance.now();
    await client.stopInstance(vmId, creds);
    const stopMs = await waitFor(vmId, 'stopped', 5 * 60_000);
    console.log(`   stop: ${(stopMs/1000).toFixed(1)}s`);

    // A small settle window so Hyperstack accepts the start call.
    await new Promise((r) => setTimeout(r, 5_000));

    const startStart = performance.now();
    await client.startInstance(vmId, creds);
    const startToActiveMs = await waitFor(vmId, 'running', 10 * 60_000);
    const startToSshMs = await tcpPortReachable(host, 22, 5 * 60_000) + startToActiveMs;
    console.log(`   start → ACTIVE: ${(startToActiveMs/1000).toFixed(1)}s; start → SSH open: ${(startToSshMs/1000).toFixed(1)}s`);
    cycles.push({ stopMs, startToActiveMs, startToSshMs });
  }

  console.log('\n[cleanup] terminate');
  await client.deleteInstance(vmId, creds).catch(() => {});

  console.log('\n== Results (Phi-3.5-mini L40 CANADA-1) ==');
  console.log(`cold deploy (create → SSH):            ${(coldDeployMs/1000).toFixed(1)} s`);
  const avgStopMs = cycles.reduce((s, c) => s + c.stopMs, 0) / cycles.length;
  const avgStartActive = cycles.reduce((s, c) => s + c.startToActiveMs, 0) / cycles.length;
  const avgStartSsh = cycles.reduce((s, c) => s + c.startToSshMs, 0) / cycles.length;
  console.log(`avg stop                               ${(avgStopMs/1000).toFixed(1)} s`);
  console.log(`avg start (STOPPED → ACTIVE):          ${(avgStartActive/1000).toFixed(1)} s`);
  console.log(`avg start (STOPPED → SSH reachable):   ${(avgStartSsh/1000).toFixed(1)} s`);
  console.log(`speedup vs cold deploy (SSH metric):   ${(coldDeployMs / avgStartSsh).toFixed(2)}×`);
  console.log('\nRaw cycles:');
  for (const c of cycles) {
    console.log(`  stop=${(c.stopMs/1000).toFixed(1)}s start→active=${(c.startToActiveMs/1000).toFixed(1)}s start→ssh=${(c.startToSshMs/1000).toFixed(1)}s`);
  }
}

main().catch(e => { console.error('FAILED:', e instanceof Error ? e.message : e); process.exit(1); });
