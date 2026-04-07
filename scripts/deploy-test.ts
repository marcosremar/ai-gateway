import { GatewaySDK } from '../src/sdk/client';
import 'dotenv/config';

const BASE = 'http://localhost:4000';

async function deployGpuVastOnly(): Promise<{ status: string; message: string }> {
  const res = await fetch(`${BASE}/v1/gpu/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'vast',
      dockerImage: 'marcosremar/babelcast-subtitle:latest',
      gpuTypes: ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 5090'],
    }),
  });
  return await res.json() as any;
}

async function main() {
  const gw = new GatewaySDK({ baseUrl: BASE });

  console.log('=== AI Gateway SDK Deploy (Vast.ai only) ===\n');

  const status = await gw.gpuStatus();
  console.log(`Current status: ${status.status} (provider: ${status.activeTier})`);

  if (status.status === 'ready') {
    console.log(`GPU already ready! Pod: ${status.podId}, GPU: ${status.gpuType}`);
    return;
  }

  if (status.status !== 'idle' && status.status !== 'error') {
    console.log('Cancelling in-progress deploy...');
    await fetch(`${BASE}/v1/gpu/terminate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('\nDeploying GPU on Vast.ai only...');
  const deployRes = await deployGpuVastOnly();
  console.log(`Response: ${deployRes.status} — ${deployRes.message}`);

  console.log('\nPolling status (15s interval, 30min timeout)...\n');
  const pollInterval = 15_000;
  const timeout = 30 * 60_000;
  const startWait = Date.now();
  while (Date.now() - startWait < timeout) {
    const s = await gw.gpuStatus();
    const elapsed = Math.round((Date.now() - startWait) / 1000);
    console.log(`[${elapsed}s] status=${s.status} provider=${s.activeTier || 'none'} gpu=${s.gpuType || '-'} pod=${s.podId || '-'} endpoint=${s.endpoint || '-'} msg=${s.message}`);
    if (s.status === 'ready') {
      console.log('\n=== GPU Ready! ===');
      console.log(`  GPU Type: ${s.gpuType}`);
      console.log(`  Pod ID: ${s.podId}`);
      console.log(`  Endpoint: ${s.endpoint}`);
      console.log(`  Healthy: ${s.gpuHealthy}`);
      break;
    }
    if (s.status === 'error' || s.status === 'idle') {
      console.log(`\nDeploy ended: ${s.status} — ${s.message}`);
      process.exit(1);
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }

  const health = await gw.health();
  console.log(`\nGateway health: ${health}`);

  await gw.close();
}

main().catch(err => {
  console.error('Deploy failed:', err);
  process.exit(1);
});
