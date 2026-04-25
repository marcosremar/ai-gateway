#!/usr/bin/env bun
// Bench: POST /core/snapshots/{id}/restore vs classic cold-boot from image.
// Flow:
//   1. cold deploy VM from custom image → measure boot-to-SSH (baseline)
//   2. stop VM
//   3. create snapshot from stopped VM → wait for snapshot COMPLETED
//   4. delete source VM
//   5. restore the snapshot into a brand new VM → measure boot-to-SSH
//   6. cleanup (delete restored VM + snapshot)
//
// Usage: HYPERSTACK_KEY_NAME=codex-criu-test-ca bun scripts/snapshot-bench/snapshot-restore-bench.ts

import 'dotenv/config';
import { HyperstackClient } from '../../src/gateway/providers/gpu/hyperstack-client';
import type { ProviderCredentials } from '../../src/gateway/providers/gpu/types';

const API_KEY = process.env.HYPERSTACK_API_KEY!;
const IMAGE = process.env.HYPERSTACK_BENCH_IMAGE_NAME ?? 'ai-gateway-bench-2026-04-18';
const GPU = process.env.BENCH_GPU ?? 'NVIDIA L40';
const REGION = 'CANADA-1';
const API_BASE = 'https://infrahub-api.nexgencloud.com/v1';

const client = new HyperstackClient({ defaultRegion: REGION });
const creds: ProviderCredentials = { apiKey: API_KEY };

async function waitFor(vmId: string, want: 'running' | 'stopped', timeoutMs: number): Promise<number> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 4_000));
    const st = await client.getInstanceStatus(vmId, creds).catch(() => null);
    if (st === want) return performance.now() - start;
  }
  throw new Error(`VM ${vmId} never reached ${want}`);
}

async function tcpReachable(host: string, timeoutMs: number): Promise<number> {
  const net = await import('node:net');
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>(resolve => {
      const s = new net.Socket();
      let done = false;
      const fin = (r: boolean) => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(r); } };
      s.setTimeout(2000);
      s.once('connect', () => fin(true));
      s.once('timeout', () => fin(false));
      s.once('error', () => fin(false));
      s.connect(22, host);
    });
    if (ok) return performance.now() - start;
    await new Promise(r => setTimeout(r, 1_000));
  }
  throw new Error(`${host}:22 not reachable`);
}

async function pollSnapshot(snapId: number, timeoutMs: number): Promise<number> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 10_000));
    const list = await client.listSnapshots(creds).catch(() => []);
    const snap = list.find((s: any) => s.id === snapId);
    if (!snap) continue;
    const st = String(snap.status || '').toUpperCase();
    if (st === 'ACTIVE' || st === 'COMPLETED' || st === 'AVAILABLE') return performance.now() - start;
    if (st === 'ERROR' || st === 'FAILED') throw new Error(`snapshot ${snapId} failed`);
    process.stdout.write('.');
  }
  throw new Error(`snapshot ${snapId} did not complete`);
}

async function restoreFromSnapshot(snapId: number, newName: string): Promise<number> {
  const res = await fetch(`${API_BASE}/core/snapshots/${snapId}/restore`, {
    method: 'POST',
    headers: { api_key: API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ new_vm_name: newName }),
  });
  if (!res.ok) throw new Error(`restore HTTP ${res.status}: ${await res.text()}`);
  const body: any = await res.json();
  // Find new VM id — try common field names.
  const vmId = String(body.instance?.id ?? body.instances?.[0]?.id ?? body.id ?? '');
  if (!vmId) throw new Error(`restore ok but no vm id: ${JSON.stringify(body).slice(0, 300)}`);
  return Number(vmId);
}

async function main() {
  console.log(`== snapshot-restore bench ==\n  image=${IMAGE} gpu=${GPU}\n`);

  // STEP 1 — cold deploy baseline.
  console.log('[1] cold deploy VM from custom image…');
  const t0 = performance.now();
  const created = await client.createInstance({
    gpuTypes: [GPU], region: REGION, numGpus: 1, storageGb: 40,
    dockerImage: 'marcosremar/babelcast-subtitle:latest',
    hfToken: process.env.HF_TOKEN || '',
    imageName: IMAGE, interruptible: false, deployEnv: {},
    dockerStartCmd: '', onstart: '', containerDiskInGb: 40, volumeId: '', preferSsd: false,
  } as any, creds);
  const vmA = String((created as any).instanceId ?? (created as any).id);
  await waitFor(vmA, 'running', 20 * 60_000);
  const endpointA = await client.resolveInstanceEndpoint(vmA, creds);
  const hostA = new URL(endpointA!).hostname;
  await tcpReachable(hostA, 5 * 60_000);
  const coldDeployMs = performance.now() - t0;
  console.log(`    vm=${vmA} host=${hostA} cold-deploy→SSH = ${(coldDeployMs/1000).toFixed(1)}s\n`);

  // STEP 2 — stop VM.
  console.log('[2] stop VM…');
  const sStop = performance.now();
  await client.stopInstance(vmA, creds);
  await waitFor(vmA, 'stopped', 5 * 60_000);
  console.log(`    stopped in ${((performance.now()-sStop)/1000).toFixed(1)}s\n`);

  // STEP 3 — create snapshot.
  console.log('[3] create snapshot…');
  const sSnap = performance.now();
  const snap = await client.createSnapshot(vmA, `bench-restore-${Date.now()}`, creds, 'snapshot-restore bench');
  console.log(`    snapshot id=${snap.id} status=${snap.status}`);
  await pollSnapshot(snap.id as number, 30 * 60_000);
  const snapMs = performance.now() - sSnap;
  console.log(`\n    snapshot completed in ${(snapMs/1000).toFixed(1)}s\n`);

  // STEP 4 — delete source VM (we don't need it anymore).
  console.log('[4] delete source VM…');
  await client.deleteInstance(vmA, creds).catch(() => {});

  // STEP 5 — restore to NEW VM, measure the path we care about.
  console.log('[5] restore snapshot → new VM (measure wall-time to SSH)…');
  const sRestore = performance.now();
  const vmB = await restoreFromSnapshot(snap.id as number, `bench-restored-${Date.now()}`);
  const apiAcceptedMs = performance.now() - sRestore;
  console.log(`    restore API accepted in ${(apiAcceptedMs/1000).toFixed(2)}s, new vm=${vmB}`);
  await waitFor(String(vmB), 'running', 20 * 60_000);
  const endpointB = await client.resolveInstanceEndpoint(String(vmB), creds);
  const hostB = new URL(endpointB!).hostname;
  await tcpReachable(hostB, 5 * 60_000);
  const restoreMs = performance.now() - sRestore;
  console.log(`    restored vm=${vmB} host=${hostB} restore→SSH = ${(restoreMs/1000).toFixed(1)}s\n`);

  // STEP 6 — cleanup.
  console.log('[6] cleanup…');
  await client.deleteInstance(String(vmB), creds).catch(() => {});
  await client.deleteSnapshot(snap.id as number, creds).catch(() => {});

  // RESULTS.
  console.log('\n== Results ==');
  console.log(`classic cold deploy → SSH:   ${(coldDeployMs/1000).toFixed(1)} s`);
  console.log(`snapshot restore → SSH:      ${(restoreMs/1000).toFixed(1)} s`);
  console.log(`difference:                  ${((coldDeployMs-restoreMs)/1000).toFixed(1)} s`);
  console.log(`speedup (cold/restore):      ${(coldDeployMs/restoreMs).toFixed(2)}×`);
}

main().catch(e => { console.error('FAILED:', e instanceof Error ? e.message : e); process.exit(1); });
