#!/usr/bin/env bun
import { RunpodClient } from '../src/gpu-providers/runpod-client';
import type { ProviderCredentials } from '../src/gpu-providers/types';

try {
  const { readFileSync } = await import('fs');
  const env = readFileSync('.env', 'utf-8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const apiKey = process.env.RUNPOD_API_KEY!;
const creds: ProviderCredentials = { apiKey };
const client = new RunpodClient();

console.log('Deploying marcosremar/ultravox-s2s:blackwell → NVIDIA GeForce RTX 5090...');
const t0 = Date.now();
const instance = await client.createInstance(
  {
    gpuTypes: ['NVIDIA GeForce RTX 5090', 'NVIDIA GeForce RTX 4090'],
    gpuCount: 1,
    storageGb: 0,
    dockerImage: 'marcosremar/ultravox-s2s:blackwell',
    ports: ['8000/http'],
    env: { PORT: '8000' },
  },
  creds,
);
console.log(`Pod: ${instance.instanceId}, GPU: ${instance.gpuType}, Endpoint: ${instance.endpoint}`);

// Poll both pod status AND health endpoint
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 10_000));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

  // Check pod status via RunPod client
  const podStatus = await client.getInstanceStatus(instance.instanceId, creds).catch(() => 'error');

  // Check health endpoint
  let health = 'skipped';
  if (podStatus === 'RUNNING') {
    try {
      const res = await fetch(`${instance.endpoint}/health`, { signal: AbortSignal.timeout(5000) });
      const body = await res.text().catch(() => '');
      health = `${res.status} ${body.slice(0, 60)}`;
    } catch (e: unknown) {
      health = e instanceof Error ? e.message.slice(0, 60) : String(e);
    }
  }

  console.log(`[${elapsed}s] pod=${podStatus} health=${health}`);
  if (podStatus === null || podStatus === 'EXITED') {
    console.log('Pod terminated!'); break;
  }
  if (health.startsWith('200')) {
    console.log(`✅ Ready! ${instance.endpoint}`); process.exit(0);
  }
}
console.log('Done monitoring. Pod may still be starting.');
