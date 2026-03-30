#!/usr/bin/env bun
/**
 * Vast.ai — Tiered Ranking Live Test (standalone, run with: bun run __tests__/vast-tiered-ranking-run.ts)
 *
 * Tests the tiered offer ranking against real Vast.ai API:
 *   1. Fetches offers and shows tiered re-ordering
 *   2. Creates instance — verifies fast-internet host picked
 *   3. Destroys instance
 */

import { VastClient } from '../src/gpu-providers/vast-client';
import type { ProviderCredentials } from '../src/gpu-providers/types';

// Load .env
const { readFileSync } = await import('fs');
try {
  const env = readFileSync('.env', 'utf-8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2];
  }
} catch {}

const apiKey = process.env.VAST_API_KEY;
if (!apiKey) { console.error('VAST_API_KEY not set'); process.exit(1); }

const client = new VastClient();
const creds: ProviderCredentials = { apiKey };
let instanceId: string | null = null;

try {
  // ── 1. Check balance ──────────────────────────────────────────────────
  const balance = await client.checkBalance(creds);
  console.log(`Balance: $${balance?.balance.toFixed(2) ?? '?'}`);
  if (balance && balance.balance < 0.10) {
    console.error('Insufficient balance (<$0.10), aborting');
    process.exit(1);
  }

  // ── 2. List offers to see tiered ranking in action ────────────────────
  console.log('\n── Offers (RTX 4090/3090) ──');
  const offers = await client.listOffers(
    { gpuTypes: ['RTX 4090', 'RTX 3090', 'RTX A5000', 'RTX 4080'] },
    creds,
  );
  console.log(`Found ${offers.length} GPU types:`);
  for (const o of offers.slice(0, 8)) {
    console.log(`  ${o.gpuType}: $${o.pricePerHr.toFixed(3)}/hr, ${o.available} avail, ↓${o.inetDown ?? '?'}Mbps, ${o.region}`);
  }

  // ── 3. Create instance with tiered ranking ────────────────────────────
  console.log('\n── Creating instance (tiered ranking active) ──');
  console.log('GPU filter: RTX 4090/3090/A5000/4080/A4000');
  console.log('Image: nvidia/cuda:12.4.1-base-ubuntu22.04 (tiny, fast pull)');

  const t0 = Date.now();
  const instance = await client.createInstance(
    {
      gpuTypes: ['RTX 4090', 'RTX 3090', 'RTX A5000', 'RTX 4080', 'RTX A4000', 'A40'],
      gpuCount: 1,
      dockerImage: 'nvidia/cuda:12.4.1-base-ubuntu22.04',
      storageGb: 5,
    },
    creds,
  );
  const createMs = Date.now() - t0;
  instanceId = instance.instanceId;

  const meta = instance.providerMeta as Record<string, unknown> | undefined;

  console.log(`\n✅ Instance created in ${(createMs / 1000).toFixed(1)}s`);
  console.log(`  ID:       ${instance.instanceId}`);
  console.log(`  GPU:      ${instance.gpuType}`);
  console.log(`  Endpoint: ${instance.endpoint || '(pending)'}`);
  console.log(`  IP:       ${instance.ipAddress || 'N/A'}`);
  console.log(`  SSH:      ${instance.sshHost ? `${instance.sshHost}:${instance.sshPort}` : 'N/A'}`);
  if (meta) {
    console.log(`  Price:    $${Number(meta.dphTotal).toFixed(3)}/hr`);
    console.log(`  Net:      ↓${meta.inetDown} / ↑${meta.inetUp} Mbps`);
    console.log(`  Region:   ${meta.region}`);
    console.log(`  VRAM:     ${Number(meta.gpuVramGb).toFixed(0)}GB`);
    console.log(`  Reliab:   ${meta.reliability2 ?? '?'}`);
  }

  // Verify tiered ranking worked — should have fast internet
  if (meta?.inetDown) {
    const speed = Number(meta.inetDown);
    if (speed >= 2000) {
      console.log(`\n✅ Tiered ranking SUCCESS: chose host with ${speed} Mbps (≥2 Gbps)`);
    } else if (speed >= 1000) {
      console.log(`\n⚠️  Tiered ranking OK: chose host with ${speed} Mbps (≥1 Gbps)`);
    } else {
      console.log(`\n❌ Tiered ranking WEAK: chose host with only ${speed} Mbps`);
    }
  }

  // ── 4. Cleanup ────────────────────────────────────────────────────────
  console.log(`\n── Destroying ${instanceId} ──`);
  await client.deleteInstance(instanceId, creds);
  console.log('✅ Destroyed');
  instanceId = null;

  // Final balance
  const finalBalance = await client.checkBalance(creds);
  console.log(`\nFinal balance: $${finalBalance?.balance.toFixed(2) ?? '?'}`);

} catch (err) {
  console.error('\n❌ Test failed:', err);
  if (instanceId) {
    console.log(`Cleanup: destroying ${instanceId}...`);
    try { await client.deleteInstance(instanceId, creds); } catch {}
  }
  process.exit(1);
}
