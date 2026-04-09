/**
 * Deploy hy-motion (Tencent HY-Motion-1.0 text-to-3D-motion) via ai-gateway.
 *
 * Uses the gateway HTTP API — never calls Vast.ai directly.
 * Image: marcosremar/hy-motion:latest  (~50GB extracted, models pre-baked)
 * API:   POST /predict  →  base64-encoded BVH or GLTF motion file
 *
 * Targets RTX 5090 (Blackwell, sm_120). The Dockerfile is built with CUDA
 * 12.8 + PyTorch 2.7 — older stacks lack Blackwell kernels and will fail at
 * model load with "CUDA error: no kernel image is available for execution".
 *
 * Usage:
 *   bun run scripts/deploy-hy-motion.ts                # boot if not running
 *   bun run scripts/deploy-hy-motion.ts --force        # always re-deploy
 *   bun run scripts/deploy-hy-motion.ts terminate      # tear down
 *   bun run scripts/deploy-hy-motion.ts test           # test /predict only
 */
import 'dotenv/config';

const BASE = process.env.GATEWAY_URL ?? 'http://localhost:4000';
const IMAGE = 'marcosremar/hy-motion:latest';

// Blackwell-only allowlist. RTX 5090 (32GB) is the primary target — it's the
// cheapest Blackwell on Vast.ai with enough VRAM for the full HY-Motion +
// Qwen3-8B encoder pipeline (needs ~22-25 GB).
//
// We do NOT include RTX 4090 / Ada Lovelace cards because the image is built
// with CUDA 12.8 + PyTorch 2.7 (cu128). PyTorch 2.7 still works on Ada/Hopper
// in theory, but the layered FS + 32GB VRAM headroom is what RTX 5090 brings
// at the lowest hourly cost.
const GPU_TYPES = [
  'NVIDIA GeForce RTX 5090',
];

async function getStatus() {
  const res = await fetch(`${BASE}/v1/gpu/status`);
  return await res.json() as Record<string, any>;
}

async function deploy() {
  const res = await fetch(`${BASE}/v1/gpu/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'vast',
      dockerImage: IMAGE,
      gpuTypes: GPU_TYPES,
      // Image is ~25GB compressed / ~50GB extracted; need at least 80GB for
      // pull + extract + runtime output dir + headroom. 120GB is comfortable.
      storageGb: 120,
      // HY-Motion + Qwen3-8B together need ~22-25 GB; 28 forces RTX 5090 / A100.
      minVramGb: 28,
    }),
  });
  return await res.json() as Record<string, any>;
}

async function terminate() {
  const res = await fetch(`${BASE}/v1/gpu/terminate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return await res.json() as Record<string, any>;
}

async function testPredict(endpoint: string) {
  // Tiny safe prompt — generates a 2s motion (~60 frames at 30 fps).
  console.log('\nTesting POST /predict with sample prompt...');
  try {
    const res = await fetch(`${endpoint}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'a person walks forward then waves their right hand',
        duration: 2.0,
        cfg_scale: 5.0,
        num_seeds: 1,
        format: 'bvh',
      }),
      // First inference can take 30-60s on cold caches even after model load.
      signal: AbortSignal.timeout(180_000),
    });
    const data = await res.json() as any;
    if (res.ok) {
      const bytes = data.data_base64 ? Math.round(data.data_base64.length * 0.75) : 0;
      console.log(`  format:    ${data.format}`);
      console.log(`  duration:  ${data.duration}s`);
      console.log(`  latency:   ${data.latency_ms}ms`);
      console.log(`  data size: ${bytes} bytes`);
      console.log('  /predict OK');
    } else {
      console.log(`  /predict returned ${res.status}: ${data.detail ?? JSON.stringify(data)}`);
    }
  } catch (e: any) {
    console.log(`  /predict error: ${e.message}`);
  }
}

async function main() {
  const cmd = process.argv[2];
  const force = process.argv.includes('--force');

  console.log(`=== hy-motion deploy via ai-gateway ===`);
  console.log(`Gateway: ${BASE}`);
  console.log(`Image:   ${IMAGE}`);
  console.log(`GPU:     ${GPU_TYPES.join(', ')}\n`);

  if (cmd === 'terminate') {
    const t = await terminate();
    console.log(`Terminate: ${JSON.stringify(t)}`);
    return;
  }

  if (cmd === 'status') {
    const s = await getStatus();
    console.log(JSON.stringify(s, null, 2));
    return;
  }

  if (cmd === 'test') {
    const s = await getStatus();
    if (s.status !== 'ready' || !s.endpoint) {
      console.error('GPU not ready. Deploy first.');
      process.exit(1);
    }
    await testPredict(s.endpoint);
    return;
  }

  // Default: deploy if not already up
  const status = await getStatus();
  console.log(`Current GPU status: ${status.status} (provider: ${status.activeTier ?? 'none'})`);

  if (status.status === 'ready') {
    const ep = status.endpoint as string;
    if (!force) {
      console.log(`GPU already ready — endpoint: ${ep}, gpu: ${status.gpuType}`);
      console.log(`\nIf this is a different image, use --force to terminate and redeploy.`);
      await testPredict(ep);
      return;
    }
    console.log(`--force: terminating existing GPU (${status.gpuType}) to deploy hy-motion...`);
    const t = await terminate();
    console.log(`Terminate: ${JSON.stringify(t)}`);
    await new Promise(r => setTimeout(r, 5000));
  }

  if (status.status !== 'idle' && status.status !== 'error' && status.status !== 'ready') {
    console.log(`Cancelling in-progress deploy (status: ${status.status})...`);
    const t = await terminate();
    console.log(`Terminate: ${JSON.stringify(t)}`);
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('\nSending deploy request to ai-gateway...');
  const deployRes = await deploy();
  console.log(`Response: ${deployRes.status} — ${deployRes.message}`);

  if (deployRes.status === 'error') {
    console.error('Deploy rejected:', deployRes.message);
    process.exit(1);
  }

  // Poll until ready. HY-Motion image is BIG: pull alone is 5-10 min, plus
  // 2-4 min model load (Qwen3-8B is 16GB on disk + load to VRAM).
  const POLL_MS = 30_000;
  const TIMEOUT_MS = 45 * 60_000;
  const startAt = Date.now();

  console.log('\nPolling status (30s interval, 45min timeout)...\n');

  while (Date.now() - startAt < TIMEOUT_MS) {
    const s = await getStatus();
    const elapsed = Math.round((Date.now() - startAt) / 1000);
    const ep = s.endpoint ?? '-';
    console.log(`[${elapsed}s] status=${s.status} provider=${s.activeTier ?? '-'} gpu=${s.gpuType ?? '-'} healthy=${s.gpuHealthy} msg=${s.message ?? ''}`);

    if (s.status === 'ready') {
      console.log('\n=== hy-motion GPU Ready! ===');
      console.log(`  GPU:      ${s.gpuType}`);
      console.log(`  Pod:      ${s.podId}`);
      console.log(`  Endpoint: ${ep}`);
      await testPredict(ep);
      break;
    }

    if (s.status === 'error' || s.status === 'idle') {
      console.error(`\nDeploy ended with: ${s.status} — ${s.message}`);
      process.exit(1);
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
