#!/usr/bin/env bun
// Live hibernate benchmark. Deploy a small Hyperstack VM, hibernate it,
// restore it, measure each phase. Intended as a sanity check that the
// gateway's new hibernate path actually saves money AND returns the VM
// faster than a cold boot.
//
// Usage:  bun scripts/snapshot-bench/hibernate-bench.ts

import 'dotenv/config';
import { HyperstackClient } from '../../src/gateway/providers/gpu/hyperstack-client';
import type { ProviderCredentials } from '../../src/gateway/providers/gpu/types';

const API_KEY = process.env.HYPERSTACK_API_KEY;
if (!API_KEY) { console.error('HYPERSTACK_API_KEY missing'); process.exit(2); }

const KEY_NAME = process.env.HYPERSTACK_KEY_NAME ?? 'codex-criu-test-ca';
const IMAGE_NAME = process.env.HYPERSTACK_BENCH_IMAGE_NAME ?? 'ai-gateway-bench-2026-04-18';
const REGION = 'CANADA-1';
const GPU = process.env.BENCH_GPU ?? 'NVIDIA RTX A4000';

const client = new HyperstackClient({ defaultRegion: REGION });
const creds: ProviderCredentials = { apiKey: API_KEY };

type PollResult = 'ready' | 'stopped' | 'hibernated' | 'deleted' | 'unknown';

async function pollFor(
  vmId: string,
  want: PollResult[],
  timeoutMs: number,
): Promise<{ reached: PollResult; elapsedMs: number }> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 4_000));
    const raw = await fetch(`https://infrahub-api.nexgencloud.com/v1/core/virtual-machines/${vmId}`, {
      headers: { api_key: API_KEY!, Accept: 'application/json' },
    }).then((r) => r.json()).catch(() => ({}));
    const inst = (raw as { instance?: { status?: string; power_state?: string } }).instance ?? {};
    const status = String(inst.status || '').toUpperCase();
    const power = String(inst.power_state || '').toUpperCase();
    const reached: PollResult =
      status === 'HIBERNATED' || power === 'HIBERNATED' ? 'hibernated'
      : status === 'ACTIVE' && (power === 'RUNNING' || power === '') ? 'ready'
      : status === 'SHUTOFF' || status === 'STOPPED' ? 'stopped'
      : status === 'DELETED' || status === 'DELETING' ? 'deleted'
      : 'unknown';
    if (want.includes(reached)) {
      return { reached, elapsedMs: performance.now() - start };
    }
  }
  return { reached: 'unknown', elapsedMs: timeoutMs };
}

async function main() {
  console.log('== Hyperstack hibernate bench ==');
  console.log(`  image:  ${IMAGE_NAME}`);
  console.log(`  gpu:    ${GPU} @ ${REGION}`);

  // 1. Deploy fresh VM from pre-baked image.
  const deployStart = performance.now();
  console.log('[1/5] deploy…');
  const created = await client.createInstance(
    {
      gpuTypes: [GPU],
      region: REGION,
      numGpus: 1,
      storageGb: 40,
      dockerImage: 'marcosremar/babelcast-subtitle:latest',
      hfToken: process.env.HF_TOKEN || '',
      imageName: IMAGE_NAME,
      interruptible: false,
      deployEnv: {},
      dockerStartCmd: '',
      onstart: '',
      containerDiskInGb: 40,
      volumeId: '',
      preferSsd: false,
    } as any,
    creds,
  );
  const vmId = String(created.instanceId ?? (created as any).id ?? '');
  if (!vmId) throw new Error(`no vmId in createInstance result: ${JSON.stringify(created)}`);
  console.log(`    vmId=${vmId}`);

  const active = await pollFor(vmId, ['ready'], 20 * 60_000);
  const deployMs = performance.now() - deployStart;
  console.log(`    → ACTIVE in ${(deployMs / 1000).toFixed(1)}s (poll phase ${(active.elapsedMs / 1000).toFixed(1)}s)`);

  // Small settle delay so Hyperstack accepts the hibernate call.
  await new Promise((r) => setTimeout(r, 10_000));

  // 2. Hibernate.
  console.log('[2/5] hibernate…');
  const hibStart = performance.now();
  await client.hibernate(vmId, creds);
  const hibAccepted = performance.now() - hibStart;
  const hibReached = await pollFor(vmId, ['hibernated', 'stopped'], 10 * 60_000);
  const hibTotalMs = performance.now() - hibStart;
  console.log(`    API accepted in ${(hibAccepted / 1000).toFixed(2)}s; provider reached=${hibReached.reached} in ${(hibTotalMs / 1000).toFixed(1)}s`);

  // 3. Resume.
  console.log('[3/5] hibernate-restore…');
  const restStart = performance.now();
  await client.hibernateRestore(vmId, creds);
  const restAccepted = performance.now() - restStart;
  const restReached = await pollFor(vmId, ['ready'], 15 * 60_000);
  const restTotalMs = performance.now() - restStart;
  console.log(`    API accepted in ${(restAccepted / 1000).toFixed(2)}s; ACTIVE again in ${(restTotalMs / 1000).toFixed(1)}s`);

  // 4. Terminate.
  console.log('[4/5] terminate…');
  await client.deleteInstance(vmId, creds).catch(() => {});

  // 5. Report.
  console.log('\n== Results ==');
  console.log(`cold deploy (create → ACTIVE):   ${(deployMs / 1000).toFixed(1)} s`);
  console.log(`hibernate (call → HIBERNATED):   ${(hibTotalMs / 1000).toFixed(1)} s`);
  console.log(`resume    (call → ACTIVE):       ${(restTotalMs / 1000).toFixed(1)} s`);
  const speedup = deployMs / restTotalMs;
  console.log(`speedup vs cold deploy:          ${speedup.toFixed(2)}×`);
  console.log(`(expected ~1.5-3× in our earlier live runs on CANADA-1 L40S)`);
}

main().catch((e) => {
  console.error('bench failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
