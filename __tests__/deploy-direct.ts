#!/usr/bin/env bun
/**
 * Deploy ultravox-s2s:blackwell with direct uvicorn start (bypass start.sh)
 * to check if start.sh is the bottleneck.
 */
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

// Direct uvicorn start — no start.sh overhead
const startCmd = 'cd /app/api && HF_HOME=/app/.cache/huggingface HF_XET_HIGH_PERFORMANCE=1 HF_XET_FIXED_DOWNLOAD_CONCURRENCY=50 python3 -m uvicorn server:app --host 0.0.0.0 --port 8000 --workers 1 --log-level info';

console.log('Deploying with direct uvicorn (no start.sh)...');
const t0 = Date.now();
const instance = await client.createInstance(
  {
    gpuTypes: ['NVIDIA GeForce RTX 5090', 'NVIDIA GeForce RTX 4090'],
    gpuCount: 1,
    storageGb: 0,
    dockerImage: 'marcosremar/ultravox-s2s:blackwell',
    ports: ['8000/http', '22/tcp'],
    dockerStartCmd: startCmd,
  },
  creds,
);
console.log(`Pod: ${instance.instanceId}, GPU: ${instance.gpuType}`);
console.log(`Endpoint: ${instance.endpoint}`);

for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 10_000));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  const podStatus = await client.getInstanceStatus(instance.instanceId, creds).catch(() => 'error');
  let health = 'skipped';
  if (podStatus === 'RUNNING') {
    try {
      const res = await fetch(`${instance.endpoint}/health`, { signal: AbortSignal.timeout(5000) });
      const body = await res.text().catch(() => '');
      health = `${res.status} ${body.slice(0, 80)}`;
    } catch (e: unknown) {
      health = e instanceof Error ? e.message.slice(0, 60) : String(e);
    }
  }
  console.log(`[${elapsed}s] pod=${podStatus} health=${health}`);
  if (podStatus === null || podStatus === 'EXITED') { console.log('Pod terminated!'); break; }
  if (health.startsWith('200')) { console.log(`✅ READY: ${instance.endpoint}`); break; }
}
console.log(`Pod ID: ${instance.instanceId}`);
