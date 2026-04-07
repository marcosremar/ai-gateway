/**
 * RunPod Network Volume Benchmark
 *
 * Question: does keeping models cached on a RunPod network volume make
 * deploys meaningfully faster? Worth migrating from Vast.ai?
 *
 * Approach:
 *   Phase 1 — COLD: deploy without volume, measure boot+app-ready time
 *   Phase 2 — WARM-1 (populate): deploy with volume, let HF cache populate, destroy
 *   Phase 3 — WARM-2 (reuse): deploy again with same volume, measure
 *   Phase 4 — Cleanup: destroy volume, destroy any leftover pods
 *
 * Assumptions:
 *   - Image: a small base that downloads models at runtime to /workspace
 *   - We can't use babelcast-subtitle (pre-baked) — its models are inside
 *     the image, not on /workspace, so volume gives zero benefit.
 *
 * Cost estimate (RTX 4090):
 *   - 3 deploys × ~15min × $0.40/hr = ~$0.30 in compute
 *   - Volume 50GB × 1 day × $0.07/GB/30days ≈ $0.12
 *   - Total: ~$0.42
 *
 * Usage:
 *   bun run scripts/runpod-volume-benchmark.ts [--dry-run]
 *   bun run scripts/runpod-volume-benchmark.ts --image <docker-image> --dc EU-RO-1 --gpu "NVIDIA GeForce RTX 4090"
 */

import { RunpodClient } from '../src/gpu-providers/runpod-client';
import 'dotenv/config';

interface BenchOptions {
  image: string;
  gpuType: string;
  dataCenterId: string;
  volumeSizeGb: number;
  dryRun: boolean;
  deleteVolumeAfter: boolean;
  bootTimeoutMs: number;
  healthPath: string;
}

const DEFAULT_OPTS: BenchOptions = {
  // Lightweight image that downloads HF models at runtime to HF_HOME=/workspace/huggingface.
  // Default uses ai-gateway-dockers/babelcast-runtime which is structured for this.
  // If unavailable, swap for any image that respects HF_HOME and downloads models lazily.
  image: 'marcosremar/babelcast-subtitle:latest',
  gpuType: 'NVIDIA GeForce RTX 4090',
  dataCenterId: 'EU-RO-1',
  volumeSizeGb: 50,
  dryRun: false,
  deleteVolumeAfter: true,
  bootTimeoutMs: 25 * 60_000, // 25 min
  healthPath: '/health',
};

function parseArgs(): BenchOptions {
  const opts = { ...DEFAULT_OPTS };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--keep-volume') opts.deleteVolumeAfter = false;
    else if (a === '--image') opts.image = args[++i];
    else if (a === '--gpu') opts.gpuType = args[++i];
    else if (a === '--dc') opts.dataCenterId = args[++i];
    else if (a === '--size') opts.volumeSizeGb = parseInt(args[++i], 10);
    else if (a === '--health') opts.healthPath = args[++i];
  }
  return opts;
}

async function probeUntilReady(endpoint: string, healthPath: string, timeoutMs: number, log: (m: string) => void): Promise<number | null> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    attempt++;
    try {
      const res = await fetch(`${endpoint}${healthPath}`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const elapsed = Date.now() - start;
        log(`  ✓ Healthy after ${(elapsed / 1000).toFixed(1)}s (${attempt} probes)`);
        return elapsed;
      }
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 5000));
    if (attempt % 6 === 0) log(`  …still waiting (${Math.round((Date.now() - start) / 1000)}s, attempt ${attempt})`);
  }
  log(`  ✗ Timeout after ${(timeoutMs / 1000).toFixed(0)}s`);
  return null;
}

async function deployAndMeasure(
  client: RunpodClient,
  apiKey: string,
  hfToken: string | undefined,
  opts: BenchOptions,
  volumeId?: string,
  label = 'deploy',
): Promise<{ podId: string | null; bootMs: number | null; healthMs: number | null; totalMs: number | null }> {
  const log = (m: string) => console.log(`[${label}] ${m}`);
  const t0 = Date.now();

  log(`Creating pod (image=${opts.image}, gpu=${opts.gpuType}, dc=${opts.dataCenterId}, volume=${volumeId ?? 'none'})...`);

  let inst;
  try {
    inst = await client.createInstance({
      dockerImage: opts.image,
      gpuTypes: [opts.gpuType],
      region: opts.dataCenterId,
      ...(volumeId ? { volumeId } : {}),
      hfToken,
      machineKey: 'benchmark-runpod-volume',
    } as any, { apiKey, hfToken });
  } catch (e) {
    log(`  ✗ createInstance failed: ${(e as Error).message}`);
    return { podId: null, bootMs: null, healthMs: null, totalMs: null };
  }

  const bootMs = Date.now() - t0;
  log(`  pod created: ${inst.instanceId} → ${inst.endpoint || '(pending)'}  [API call took ${bootMs}ms]`);

  if (!inst.endpoint) {
    log('  ✗ no endpoint returned, aborting');
    await client.deleteInstance(inst.instanceId, { apiKey }).catch(() => {});
    return { podId: inst.instanceId, bootMs, healthMs: null, totalMs: null };
  }

  log(`  Probing ${inst.endpoint}${opts.healthPath} until ready...`);
  const healthMs = await probeUntilReady(inst.endpoint, opts.healthPath, opts.bootTimeoutMs, log);
  const totalMs = Date.now() - t0;

  log(`  → bootMs=${bootMs} healthMs=${healthMs} total=${totalMs} (${(totalMs / 1000).toFixed(1)}s)`);

  return { podId: inst.instanceId, bootMs, healthMs, totalMs };
}

async function main() {
  const opts = parseArgs();
  const apiKey = process.env.RUNPOD_API_KEY;
  const hfToken = process.env.HF_TOKEN;
  if (!apiKey) {
    console.error('FATAL: RUNPOD_API_KEY not set in env');
    process.exit(1);
  }

  console.log('=== RunPod Network Volume Benchmark ===');
  console.log(`Image:    ${opts.image}`);
  console.log(`GPU:      ${opts.gpuType}`);
  console.log(`DC:       ${opts.dataCenterId}`);
  console.log(`Volume:   ${opts.volumeSizeGb}GB`);
  console.log(`Dry-run:  ${opts.dryRun}`);
  console.log('');

  if (opts.dryRun) {
    console.log('DRY-RUN — would execute these phases:');
    console.log('  1. createNetworkVolume(name, sizeGb, dc)');
    console.log('  2. COLD deploy (no volume) → measure → destroy pod');
    console.log('  3. WARM-1 deploy with volume (populate) → wait → destroy pod (keep volume)');
    console.log('  4. WARM-2 deploy with volume (reuse) → measure → destroy pod');
    console.log('  5. Cleanup: delete volume');
    console.log('Estimated cost: ~$0.30-0.50');
    return;
  }

  const client = new RunpodClient();
  const results: Record<string, any> = {};

  // ── Phase 1: Create volume ──────────────────────────────────────────────
  console.log('\n--- Phase 1: Create network volume ---');
  const volumeName = `benchmark-${Date.now()}`;
  let volume;
  try {
    volume = await client.createNetworkVolume(volumeName, opts.volumeSizeGb, opts.dataCenterId, { apiKey });
    console.log(`  ✓ Created volume ${volume.id} (${volume.name}, ${volume.size}GB, ${volume.dataCenterId})`);
    results.volume = volume;
  } catch (e) {
    console.error(`  ✗ Failed to create volume: ${(e as Error).message}`);
    process.exit(1);
  }

  const cleanup = async () => {
    try {
      console.log('\n--- Cleanup ---');
      const list = await client.listInstances({ apiKey });
      for (const inst of list) {
        if (inst.instanceName?.includes('benchmark') || inst.instanceName?.includes('parle-autoscale')) {
          console.log(`  Deleting leftover pod ${inst.instanceId}`);
          await client.deleteInstance(inst.instanceId, { apiKey }).catch(e => console.warn(`  ⚠ ${(e as Error).message}`));
        }
      }
      if (opts.deleteVolumeAfter && volume) {
        console.log(`  Deleting volume ${volume.id}`);
        await client.deleteNetworkVolume(volume.id, { apiKey }).catch(e => console.warn(`  ⚠ ${(e as Error).message}`));
      } else if (volume) {
        console.log(`  Keeping volume ${volume.id} (--keep-volume flag)`);
      }
    } catch (e) {
      console.warn(`Cleanup error: ${(e as Error).message}`);
    }
  };

  process.on('SIGINT', async () => {
    console.log('\n[!] SIGINT received — cleaning up...');
    await cleanup();
    process.exit(130);
  });

  try {
    // ── Phase 2: COLD deploy ─────────────────────────────────────────────
    console.log('\n--- Phase 2: COLD deploy (no volume) ---');
    const cold = await deployAndMeasure(client, apiKey, hfToken, opts, undefined, 'cold');
    results.cold = cold;
    if (cold.podId) {
      console.log(`  Destroying cold pod ${cold.podId}`);
      await client.deleteInstance(cold.podId, { apiKey }).catch(e => console.warn(`  ⚠ ${(e as Error).message}`));
      // Give RunPod a moment before next deploy
      await new Promise(r => setTimeout(r, 10_000));
    }

    // ── Phase 3: WARM-1 (populate volume) ────────────────────────────────
    console.log('\n--- Phase 3: WARM-1 deploy (populate volume cache) ---');
    const warm1 = await deployAndMeasure(client, apiKey, hfToken, opts, volume.id, 'warm1');
    results.warm1 = warm1;
    if (warm1.podId) {
      // Let it run a bit longer to ensure all caches are flushed to /workspace
      console.log('  Letting cache settle for 60s before destroying...');
      await new Promise(r => setTimeout(r, 60_000));
      console.log(`  Destroying warm1 pod ${warm1.podId}`);
      await client.deleteInstance(warm1.podId, { apiKey }).catch(e => console.warn(`  ⚠ ${(e as Error).message}`));
      await new Promise(r => setTimeout(r, 10_000));
    }

    // ── Phase 4: WARM-2 (reuse populated volume) ─────────────────────────
    console.log('\n--- Phase 4: WARM-2 deploy (reuse cached volume) ---');
    const warm2 = await deployAndMeasure(client, apiKey, hfToken, opts, volume.id, 'warm2');
    results.warm2 = warm2;
    if (warm2.podId) {
      console.log(`  Destroying warm2 pod ${warm2.podId}`);
      await client.deleteInstance(warm2.podId, { apiKey }).catch(e => console.warn(`  ⚠ ${(e as Error).message}`));
    }

    // ── Phase 5: Report ──────────────────────────────────────────────────
    console.log('\n=== Results ===');
    const fmt = (ms: number | null) => ms == null ? 'FAILED' : `${(ms / 1000).toFixed(1)}s`;
    console.log(`  COLD   total: ${fmt(cold.totalMs)} (api ${cold.bootMs}ms + health ${fmt(cold.healthMs)})`);
    console.log(`  WARM-1 total: ${fmt(warm1.totalMs)} (api ${warm1.bootMs}ms + health ${fmt(warm1.healthMs)}) — populating volume`);
    console.log(`  WARM-2 total: ${fmt(warm2.totalMs)} (api ${warm2.bootMs}ms + health ${fmt(warm2.healthMs)}) — reusing volume`);

    if (cold.totalMs && warm2.totalMs) {
      const speedup = cold.totalMs / warm2.totalMs;
      const savings = cold.totalMs - warm2.totalMs;
      console.log(`\n  Speedup (cold/warm2): ${speedup.toFixed(2)}x`);
      console.log(`  Time saved: ${(savings / 1000).toFixed(1)}s per deploy`);
      if (speedup > 1.5) {
        console.log('  ✅ Worth it — significant speedup');
      } else if (speedup > 1.1) {
        console.log('  ⚠ Marginal — depends on volume cost vs deploy frequency');
      } else {
        console.log('  ❌ No meaningful speedup — image likely pre-bakes models');
      }
    }
    console.log('\n  JSON:');
    console.log('  ' + JSON.stringify(results, null, 2).replace(/\n/g, '\n  '));
  } finally {
    await cleanup();
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
