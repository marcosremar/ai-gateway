#!/usr/bin/env bun
/**
 * RunPod Network Volume — Raw I/O Benchmark
 *
 * Question: Is RunPod's network volume fast enough at large sequential reads
 * to make it worth structuring deploys around it (small base image + model
 * files as flat large blobs on the volume)?
 *
 * Procedure (~10 min, ~$0.10):
 *   1. Create a 50GB volume in EU-RO-1
 *   2. Pod-A (writer): writes 10GB to volume, drops cache, reads it back,
 *      then writes/reads 10GB on container disk for comparison
 *   3. Destroy Pod-A
 *   4. Pod-B (reader, NEW physical host): reads the pre-existing 10GB file
 *      with truly cold cache → the KEY metric
 *   5. Destroy Pod-B + delete volume
 *   6. Report
 */

import { RunpodClient } from '../src/gpu-providers/runpod-client';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

// DC + GPU selection is now DYNAMIC via client.discoverNetworkVolumeDCs()
// (queries RunPod GraphQL for current availability). No hardcoded lists needed.
const VOLUME_SIZE_GB = parseInt(process.env.RUNPOD_BENCH_VOLUME_GB || '50', 10);
const TEST_FILE_GB = parseInt(process.env.RUNPOD_BENCH_FILE_GB || '10', 10);
const IMAGE = process.env.RUNPOD_BENCH_IMAGE || 'python:3.11-slim';
// Fallback GPU list when probe needs alternatives within a discovered DC
const GPU_TYPES = (process.env.RUNPOD_BENCH_GPUS ||
  'NVIDIA GeForce RTX 4090,NVIDIA GeForce RTX 5090,NVIDIA RTX A6000,NVIDIA L40S')
  .split(',').map(s => s.trim());
const FETCH_TIMEOUT_MS = 15 * 60_000; // 15 min for results to appear

const BENCH_SCRIPT = fs.readFileSync(path.join(__dirname, 'runpod-volume-io-bench.sh'), 'utf8');

async function fetchResults(podId: string, timeoutMs: number, log: (m: string) => void): Promise<any | null> {
  const url = `https://${podId}-8000.proxy.runpod.net/results.json`;
  log(`Polling ${url}`);
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    attempt++;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        log(`✓ Got results after ${Math.round((Date.now() - start) / 1000)}s (${attempt} attempts)`);
        return data;
      }
    } catch { /* not ready */ }
    if (attempt % 6 === 0) log(`…waiting (${Math.round((Date.now() - start) / 1000)}s, attempt ${attempt})`);
    await new Promise(r => setTimeout(r, 5000));
  }
  log(`✗ Timeout after ${Math.round(timeoutMs / 1000)}s`);
  return null;
}

/**
 * Find a (DC, GPU) combination that has good network volume support and current
 * GPU availability. Uses RunPod's GraphQL availability data first, then probes
 * the top candidates with actual deploy attempts (since "Medium" stock can still
 * fail with ghost machines).
 */
async function probeAvailableDc(
  client: RunpodClient,
  apiKey: string,
  hfToken: string | undefined,
): Promise<{ dc: string; gpuType: string; probePodId: string } | null> {
  // Be patient with ghost detection — RunPod's scheduler can take 30-60s to assign
  // a machine even when stock is reported as Medium. Increase the wait window.
  process.env.RUNPOD_GHOST_CHECK_DELAY_MS = process.env.RUNPOD_GHOST_CHECK_DELAY_MS || '20000';

  // Step 1: Discover Medium+ first
  console.log('[discover] Querying RunPod GraphQL for DCs with network volume + GPU availability...');
  let candidates = await client.discoverNetworkVolumeDCs({ apiKey }, { minStock: 'Medium' });
  console.log(`[discover] Medium+ stock candidates: ${candidates.length}`);

  // Probe Medium first
  const PROBE_LIMIT = parseInt(process.env.RUNPOD_BENCH_PROBE_LIMIT || '6', 10);
  const tryProbe = async (c: typeof candidates[number]) => {
    // gpuTypeId is already normalized to the REST POST enum by discoverNetworkVolumeDCs
    const gpuType = c.gpuTypeId;
    console.log(`[probe] Trying ${c.dataCenterId} × ${gpuType} (${c.stockStatus})...`);
    try {
      const inst = await client.createInstance({
        dockerImage: IMAGE,
        gpuTypes: [gpuType],
        region: c.dataCenterId,
        dockerStartCmd: 'echo PROBE_OK && sleep infinity',
        machineKey: 'bench-volume-probe',
        ports: ['22/tcp'],
        // Probe optimization: smallest possible footprint to maximize schedulability
        containerDiskInGb: 20, // RunPod GPU minimum
        storageGb: 0,           // no ephemeral volume
      } as any, { apiKey, hfToken });
      console.log(`[probe] ✓ ${c.dataCenterId} × ${gpuType} → pod ${inst.instanceId}`);
      return { dc: c.dataCenterId, gpuType, probePodId: inst.instanceId };
    } catch (e) {
      const msg = (e as Error).message;
      const short = msg.length > 100 ? msg.substring(0, 100) + '…' : msg;
      console.log(`[probe] ✗ ${c.dataCenterId} × ${gpuType}: ${short}`);
      return null;
    }
  };

  // OPTIMIZATION: parallel probes. Each probe takes ~30s sequential due to
  // ghost-check delays. Running 6+ in parallel cuts total wall time by ~6x.
  // The first one to succeed wins; we cancel the rest by deleting their pods.
  const PARALLEL = parseInt(process.env.RUNPOD_BENCH_PROBE_PARALLEL || '6', 10);

  const tryBatchParallel = async (batch: typeof candidates): Promise<{ dc: string; gpuType: string; probePodId: string } | null> => {
    if (batch.length === 0) return null;
    console.log(`[probe] Launching ${batch.length} probes in parallel...`);
    const results = await Promise.allSettled(batch.map(c => tryProbe(c)));
    // Find first success
    let winner: { dc: string; gpuType: string; probePodId: string } | null = null;
    const losers: { dc: string; gpuType: string; probePodId: string }[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        if (!winner) winner = r.value;
        else losers.push(r.value);
      }
    }
    // Tear down losers (don't pay for unused pods)
    if (losers.length > 0) {
      console.log(`[probe] Tearing down ${losers.length} loser pods (parallel)`);
      await Promise.allSettled(losers.map(l =>
        client.deleteInstance(l.probePodId, { apiKey })
          .catch(e => console.log(`  ⚠ ${l.probePodId}: ${(e as Error).message}`)),
      ));
    }
    return winner;
  };

  // ── Round 1: Medium stock (parallel batches) ───────────────────────────
  if (candidates.length > 0) {
    console.log(`\n[probe] Round 1 — Medium stock (${candidates.length} candidates, ${PARALLEL} parallel)`);
    for (let i = 0; i < Math.min(candidates.length, PROBE_LIMIT); i += PARALLEL) {
      const batch = candidates.slice(i, i + PARALLEL);
      const winner = await tryBatchParallel(batch);
      if (winner) return winner;
    }
  }

  // ── Round 2: Low stock fallback (parallel batches) ─────────────────────
  console.log('\n[discover] Medium exhausted — querying Low stock candidates...');
  const lowCandidates = await client.discoverNetworkVolumeDCs({ apiKey }, { minStock: 'Low' });
  const triedKeys = new Set(candidates.map(c => `${c.dataCenterId}:${c.gpuTypeId}`));
  const lowOnly = lowCandidates.filter(c => !triedKeys.has(`${c.dataCenterId}:${c.gpuTypeId}`));
  console.log(`[discover] Low stock new candidates: ${lowOnly.length}`);
  for (let i = 0; i < Math.min(lowOnly.length, PROBE_LIMIT * 2); i += PARALLEL) {
    const batch = lowOnly.slice(i, i + PARALLEL);
    const winner = await tryBatchParallel(batch);
    if (winner) return winner;
  }

  return null;
}

async function deployBenchPod(
  client: RunpodClient,
  apiKey: string,
  hfToken: string | undefined,
  volumeId: string,
  role: 'writer' | 'reader',
  gpuType?: string,
): Promise<{ instanceId: string; endpoint: string } | null> {
  const log = (m: string) => console.log(`[${role}] ${m}`);
  const useGpus = gpuType ? [gpuType, ...GPU_TYPES.filter(g => g !== gpuType)] : GPU_TYPES;
  log(`Deploying pod (image=${IMAGE}, gpus=[${useGpus.slice(0, 3).join(', ')}…], volume=${volumeId.substring(0, 12)}…)`);
  try {
    const inst = await client.createInstance({
      dockerImage: IMAGE,
      gpuTypes: useGpus,
      volumeId,
      env: { BENCH_ROLE: role, BENCH_SIZE_GB: String(TEST_FILE_GB) },
      dockerStartCmd: BENCH_SCRIPT,
      machineKey: `bench-volume-${role}`,
      ports: ['8000/http', '22/tcp'],
    } as any, { apiKey, hfToken });
    log(`pod=${inst.instanceId} endpoint=${inst.endpoint || '(pending)'}`);
    return { instanceId: inst.instanceId, endpoint: inst.endpoint || '' };
  } catch (e) {
    log(`✗ deploy failed: ${(e as Error).message}`);
    return null;
  }
}

function fmtMbps(v: any): string {
  if (v == null || v === 'null') return 'N/A';
  return `${Number(v).toFixed(0)} MB/s`;
}

async function main() {
  const apiKey = process.env.RUNPOD_API_KEY;
  const hfToken = process.env.HF_TOKEN;
  if (!apiKey) { console.error('FATAL: RUNPOD_API_KEY not set'); process.exit(1); }

  console.log('=== RunPod Network Volume — Raw I/O Benchmark ===');
  console.log(`DC selection:  DYNAMIC (via RunPod GraphQL availability)`);
  console.log(`Image:         ${IMAGE}`);
  console.log(`GPU fallback:  ${GPU_TYPES.join(', ')}`);
  console.log(`Volume size:   ${VOLUME_SIZE_GB}GB`);
  console.log(`Test file:     ${TEST_FILE_GB}GB`);
  console.log('');

  const client = new RunpodClient();

  // Phase 0: Probe DCs to find one with availability
  console.log('--- Phase 0: Probe DCs for GPU availability ---');
  const probe = await probeAvailableDc(client, apiKey, hfToken);
  if (!probe) {
    console.error('✗ No DC has any of the candidate GPU types available right now');
    process.exit(1);
  }
  console.log(`✓ Found availability: ${probe.dc} × ${probe.gpuType}`);

  // Delete probe pod immediately — we'll create new ones with the volume attached
  console.log(`[probe] Deleting probe pod ${probe.probePodId}...`);
  await client.deleteInstance(probe.probePodId, { apiKey }).catch(e => console.warn(`  ⚠ ${(e as Error).message}`));
  // Brief wait so RunPod releases the slot
  await new Promise(r => setTimeout(r, 5_000));

  // Phase 1: Create volume in the discovered DC
  console.log(`\n--- Phase 1: Create network volume in ${probe.dc} ---`);
  let volume;
  try {
    volume = await client.createNetworkVolume(`bench-io-${Date.now()}`, VOLUME_SIZE_GB, probe.dc, { apiKey });
    console.log(`✓ Volume ${volume.id} (${volume.size}GB, ${volume.dataCenterId})`);
  } catch (e) {
    console.error(`✗ Failed to create volume: ${(e as Error).message}`);
    process.exit(1);
  }

  let writerPodId: string | null = null;
  let readerPodId: string | null = null;
  let writerResults: any = null;
  let readerResults: any = null;

  const cleanup = async () => {
    console.log('\n--- Cleanup ---');
    if (writerPodId) {
      console.log(`  Deleting writer pod ${writerPodId}`);
      await client.deleteInstance(writerPodId, { apiKey }).catch(e => console.warn(`    ⚠ ${(e as Error).message}`));
    }
    if (readerPodId) {
      console.log(`  Deleting reader pod ${readerPodId}`);
      await client.deleteInstance(readerPodId, { apiKey }).catch(e => console.warn(`    ⚠ ${(e as Error).message}`));
    }
    console.log(`  Deleting volume ${volume.id}`);
    await client.deleteNetworkVolume(volume.id, { apiKey }).catch(e => console.warn(`    ⚠ ${(e as Error).message}`));
  };

  process.on('SIGINT', async () => { console.log('\n[!] SIGINT'); await cleanup(); process.exit(130); });

  try {
    // Phase 2: Writer pod
    console.log('\n--- Phase 2: WRITER pod ---');
    const writer = await deployBenchPod(client, apiKey, hfToken, volume.id, 'writer', probe.gpuType);
    if (!writer) throw new Error('writer deploy failed');
    writerPodId = writer.instanceId;
    writerResults = await fetchResults(writer.instanceId, FETCH_TIMEOUT_MS, m => console.log(`[writer] ${m}`));
    if (writerResults) console.log('[writer] Results:', JSON.stringify(writerResults, null, 2));

    console.log('[writer] Destroying pod...');
    await client.deleteInstance(writerPodId, { apiKey }).catch(e => console.warn(`  ⚠ ${(e as Error).message}`));
    writerPodId = null;

    // Wait for RunPod to release the volume slot
    console.log('Waiting 20s before next deploy...');
    await new Promise(r => setTimeout(r, 20_000));

    // Phase 3: Reader pod (different physical host, same volume)
    console.log('\n--- Phase 3: READER pod (cold cache, NEW physical host) ---');
    const reader = await deployBenchPod(client, apiKey, hfToken, volume.id, 'reader', probe.gpuType);
    if (!reader) throw new Error('reader deploy failed');
    readerPodId = reader.instanceId;
    readerResults = await fetchResults(reader.instanceId, FETCH_TIMEOUT_MS, m => console.log(`[reader] ${m}`));
    if (readerResults) console.log('[reader] Results:', JSON.stringify(readerResults, null, 2));

    // Phase 4: Report
    console.log('\n=== FINAL REPORT ===');
    if (writerResults && readerResults) {
      console.log(`Volume write speed (writer):       ${fmtMbps(writerResults.volume_write_mbps)}`);
      console.log(`Volume read speed (writer warm):   ${fmtMbps(writerResults.volume_read_mbps)}`);
      console.log(`Volume read speed (reader COLD):   ${fmtMbps(readerResults.volume_read_mbps)} ← KEY METRIC`);
      console.log(`Container disk write (writer):     ${fmtMbps(writerResults.container_write_mbps)}`);
      console.log(`Container disk read (writer):      ${fmtMbps(writerResults.container_read_mbps)}`);
      console.log('');
      const coldReadMbps = Number(readerResults.volume_read_mbps);
      if (coldReadMbps > 0) {
        const time10gb = (10 * 1024) / coldReadMbps;
        const dockerHubMbps = 80; // typical
        const dockerHubTime = (10 * 1024) / dockerHubMbps;
        const speedup = dockerHubTime / time10gb;
        console.log(`Estimated read 10GB cold from volume: ${time10gb.toFixed(0)}s`);
        console.log(`Comparable Docker Hub pull (~${dockerHubMbps} MB/s typical): ${dockerHubTime.toFixed(0)}s`);
        console.log(`Volume vs Docker Hub speedup: ${speedup.toFixed(2)}x`);
        console.log('');
        if (speedup > 2.0) console.log('✅ WORTH IT — significant speedup vs Docker pull');
        else if (speedup > 1.3) console.log('⚠ Marginal — depends on volume cost vs deploy frequency');
        else console.log('❌ Not worth it — Docker pull is comparable or faster');
      }
    } else {
      console.error('✗ Missing results — benchmark incomplete');
    }
  } finally {
    await cleanup();
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
