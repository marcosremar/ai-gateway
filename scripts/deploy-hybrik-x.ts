/**
 * Deploy hybrik-x (whole-body SMPL-X pose estimation) via ai-gateway.
 *
 * Uses the gateway HTTP API — never calls Vast.ai or RunPod directly.
 * Image: marcosremar/hybrik-x:latest  (~15GB, models pre-baked)
 * API:   POST /predict  →  55 joint quaternions + SMPL-X params
 */
import 'dotenv/config';

const BASE = process.env.GATEWAY_URL ?? 'http://localhost:4000';
const IMAGE = 'marcosremar/hybrik-x:latest';

// Must be in the gateway allowlist (server/config.ts PREFERRED_GPU_TYPES)
// hybrik-x needs ~4GB VRAM — any of these work
const GPU_TYPES = [
  'NVIDIA GeForce RTX 4090',
  'NVIDIA RTX A6000',
  'NVIDIA A40',
  'NVIDIA L40S',
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
      storageGb: 60,    // image ~15GB compressed; extracted needs ~40GB headroom
      minVramGb: 12,    // hybrik-x needs ~4GB; headroom for batching
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
  // 1×1 white pixel PNG as base64
  const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  console.log('\nTesting POST /predict with 1×1 white image...');
  try {
    const res = await fetch(`${endpoint}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: TINY_PNG, include_vertices: false }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json() as any;
    if (res.ok) {
      console.log(`  theta_quat[0]: ${JSON.stringify(data.theta_quat?.[0])}`);
      console.log(`  betas length: ${data.betas?.length}`);
      console.log(`  joints_3d length: ${data.joints_3d?.length}`);
      console.log('  /predict OK');
    } else {
      // 422 = no person detected in 1x1 image — server is working correctly
      console.log(`  /predict returned ${res.status}: ${data.detail ?? JSON.stringify(data)}`);
      if (res.status === 422) console.log('  (422 = no person in test image — server is healthy)');
    }
  } catch (e: any) {
    console.log(`  /predict error: ${e.message}`);
  }
}

async function main() {
  const force = process.argv.includes('--force');

  console.log(`=== hybrik-x deploy via ai-gateway ===`);
  console.log(`Gateway: ${BASE}`);
  console.log(`Image:   ${IMAGE}\n`);

  // Check current state
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
    console.log(`--force: terminating existing GPU (${status.gpuType}) to deploy hybrik-x...`);
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

  // Poll until ready (image pull ~10min + model load ~2min)
  const POLL_MS = 20_000;
  const TIMEOUT_MS = 30 * 60_000;
  const startAt = Date.now();

  console.log('\nPolling status (20s interval, 30min timeout)...\n');

  while (Date.now() - startAt < TIMEOUT_MS) {
    const s = await getStatus();
    const elapsed = Math.round((Date.now() - startAt) / 1000);
    const ep = s.endpoint ?? '-';
    console.log(`[${elapsed}s] status=${s.status} provider=${s.activeTier ?? '-'} gpu=${s.gpuType ?? '-'} healthy=${s.gpuHealthy} msg=${s.message ?? ''}`);

    if (s.status === 'ready') {
      console.log('\n=== hybrik-x GPU Ready! ===');
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
