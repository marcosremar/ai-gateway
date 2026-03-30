#!/usr/bin/env bun
/**
 * Deploy ultravox-s2s:blackwell to RunPod RTX 5090 via SDK client.
 *
 * Run: bun run __tests__/deploy-ultravox-s2s.ts
 */

import { RunpodClient } from '../src/gpu-providers/runpod-client';
import type { ProviderCredentials } from '../src/gpu-providers/types';

// Load .env
try {
  const { readFileSync } = await import('fs');
  const env = readFileSync('.env', 'utf-8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const apiKey = process.env.RUNPOD_API_KEY;
if (!apiKey) { console.error('RUNPOD_API_KEY not set'); process.exit(1); }

const creds: ProviderCredentials = { apiKey };
const client = new RunpodClient();

console.log('============================================================');
console.log('  Deploy: marcosremar/ultravox-s2s:blackwell → RTX 5090');
console.log('============================================================');
console.log('');

const t0 = Date.now();

const instance = await client.createInstance(
  {
    gpuTypes: ['NVIDIA GeForce RTX 5090', 'NVIDIA GeForce RTX 4090'],
    gpuCount: 1,
    storageGb: 0,
    dockerImage: 'marcosremar/ultravox-s2s:blackwell',
    ports: ['8000/http'],
    env: {
      PORT: '8000',
    },
  },
  creds,
);

const createMs = Date.now() - t0;

console.log(`Created in ${(createMs / 1000).toFixed(1)}s`);
console.log(`  ID:       ${instance.instanceId}`);
console.log(`  Status:   ${instance.status}`);
console.log(`  Endpoint: ${instance.endpoint}`);
console.log(`  GPU:      ${instance.gpuType || 'unknown'}`);
console.log('');

// Poll /health until ready (or timeout)
const healthUrl = `${instance.endpoint}/health`;
console.log(`Polling ${healthUrl} until ready...`);
console.log('(models are pre-baked in image — should boot in ~60-90s)');
console.log('');

const POLL_INTERVAL_MS = 10_000;
const TIMEOUT_MS = 10 * 60_000; // 10 min
const deadline = Date.now() + TIMEOUT_MS;
let ready = false;

while (Date.now() < deadline) {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      console.log(`[${elapsed}s] /health → ${res.status} ${JSON.stringify(body)}`);
      if (res.status === 200) { ready = true; break; }
    } else {
      console.log(`[${elapsed}s] /health → ${res.status} (waiting...)`);
    }
  } catch (err: unknown) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[${elapsed}s] /health → ${msg.slice(0, 80)}`);
  }
  await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
}

if (ready) {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log('');
  console.log(`✅ ultravox-s2s:blackwell ready in ${elapsed}s!`);
  console.log(`   Endpoint: ${instance.endpoint}`);
  console.log(`   Pod ID:   ${instance.instanceId}`);
  console.log('');
  console.log('To stop: bun run __tests__/deploy-ultravox-s2s.ts --stop ' + instance.instanceId);
} else {
  console.error('❌ Timed out waiting for /health (10 min)');
  console.error(`   Pod ${instance.instanceId} still running — check RunPod dashboard`);
  process.exit(1);
}
