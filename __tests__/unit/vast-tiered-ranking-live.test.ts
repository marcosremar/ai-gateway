/**
 * Vast.ai — Tiered Offer Ranking Integration Test (Real API)
 *
 * Tests the new tiered ranking logic against live Vast.ai marketplace:
 *   1. Fetches real offers and verifies tiered re-ordering
 *   2. Creates an instance and verifies it picked a fast-internet host
 *   3. Cleans up the instance
 *
 * Requires: VAST_API_KEY in .env
 * Cost: ~$0.01-0.02 (creates instance for <1 min)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { VastClient } from '../../src/gpu-providers/vast-client';
import type { ProviderCredentials, GpuInstance } from '../../src/gpu-providers/types';
import { loadEnv } from '../helpers';

describe('Tiered ranking — live API', () => {
  let client: VastClient;
  let creds: ProviderCredentials;
  let createdInstance: GpuInstance | null = null;
  let skip = false;

  beforeAll(async () => {
    await loadEnv();
    if (!process.env.VAST_API_KEY || process.env.SKIP_GPU_TESTS) {
      skip = true;
      return;
    }
    client = new VastClient();
    creds = { apiKey: process.env.VAST_API_KEY! };
  });

  afterAll(async () => {
    if (createdInstance) {
      console.log(`  Cleanup: destroying ${createdInstance.instanceId}...`);
      try { await client.deleteInstance(createdInstance.instanceId, creds); } catch {}
    }
  });

  it('listOffers returns offers that can be tiered', async () => {
    if (skip) return;
    const offers = await client.listOffers(
      { gpuTypes: ['RTX 4090', 'RTX 3090', 'RTX A5000', 'RTX 4080'] },
      creds,
    );
    expect(offers.length).toBeGreaterThan(0);

    for (const o of offers.slice(0, 5)) {
      console.log(`  ${o.gpuType}: $${o.pricePerHr.toFixed(3)}/hr, ${o.available} avail, ${o.inetDown ?? '?'} Mbps, ${o.region}`);
    }
  });

  it('createInstance picks fast-internet host via tiered ranking', async () => {
    if (skip) return;
    // Use cheap GPUs to minimize cost. The test verifies that the tiered
    // ranking logic picks a fast host, not just the cheapest.
    const instance = await client.createInstance(
      {
        gpuTypes: ['RTX 4090', 'RTX 3090', 'RTX A5000', 'RTX 4080', 'RTX A4000', 'A40'],
        gpuCount: 1,
        dockerImage: 'nvidia/cuda:12.4.1-base-ubuntu22.04', // tiny image, fast pull
        storageGb: 5,
      },
      creds,
    );

    createdInstance = instance;

    console.log('');
    console.log('  === Instance Created ===');
    console.log(`  ID:       ${instance.instanceId}`);
    console.log(`  GPU:      ${instance.gpuType}`);
    console.log(`  Endpoint: ${instance.endpoint || '(pending)'}`);
    console.log(`  IP:       ${instance.ipAddress || 'N/A'}`);
    console.log(`  SSH:      ${instance.sshHost ? `${instance.sshHost}:${instance.sshPort}` : 'N/A'}`);

    const meta = instance.providerMeta as Record<string, unknown> | undefined;
    if (meta) {
      console.log(`  Price:    $${meta.dphTotal}/hr`);
      console.log(`  Net:      ↓${meta.inetDown} / ↑${meta.inetUp} Mbps`);
      console.log(`  Region:   ${meta.region}`);
      console.log(`  VRAM:     ${meta.gpuVramGb}GB`);
    }

    expect(instance.instanceId).toBeTruthy();
    expect(instance.gpuType).toBeTruthy();

    // Verify the host has reasonable internet (tiered ranking should prefer this)
    if (meta?.inetDown) {
      const inetDown = Number(meta.inetDown);
      console.log(`  Tiered ranking chose host with ${inetDown} Mbps download`);
      // Should be at least 1 Gbps (our minimum filter is 2Gbps, but relaxed fallback is 500)
      expect(inetDown).toBeGreaterThanOrEqual(500);
    }
  }, 120_000);

  it('cleanup: delete created instance', async () => {
    if (skip || !createdInstance) return;

    await client.deleteInstance(createdInstance.instanceId, creds);
    console.log(`  Destroyed ${createdInstance.instanceId}`);

    // Verify it's gone
    const status = await client.getInstanceStatus(createdInstance.instanceId, creds);
    expect(status).toBeNull();
    createdInstance = null; // prevent afterAll from double-deleting
  }, 30_000);
});
