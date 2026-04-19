/**
 * Vast.ai Orphan Sweep — E2E, Destructive
 *
 * Proves the gateway actually terminates Vast.ai machines it doesn't own.
 * This test deliberately creates an instance via the raw VastClient
 * (bypassing the gateway's deploy flow, so the gateway does NOT track it),
 * then calls sweepOrphanInstances() and verifies the instance is killed.
 *
 * DESTRUCTIVE: creates a real Vast.ai instance, incurs real cost (~$0.01).
 * Opt-in via RUN_VAST_E2E=1. Skipped by default so CI doesn't burn money.
 *
 * Requires: VAST_API_KEY, RUN_VAST_E2E=1
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadEnv } from '../helpers';
import { VastClient } from '../../src/gateway/providers/gpu/vast-client';
import { sweepOrphanInstances } from '../../server/gpu-orphan-cleanup';

const ENABLED =
  !!process.env.VAST_API_KEY &&
  process.env.RUN_VAST_E2E === '1' &&
  process.env.SKIP_GPU_TESTS !== '1';
const d = ENABLED ? describe : describe.skip;

// Safety-net: anything we create in this test goes here and is force-deleted
// in afterAll, regardless of whether the sweep got to it first.
const createdInThisTest: string[] = [];

d('Vast.ai orphan sweep — E2E, destructive', () => {
  let client: VastClient;
  let creds: { apiKey: string };

  beforeAll(async () => {
    await loadEnv();
    creds = { apiKey: process.env.VAST_API_KEY! };
    client = new VastClient();
  });

  afterAll(async () => {
    for (const id of createdInThisTest) {
      try { await client.deleteInstance(id, creds); } catch { /* already gone */ }
    }
  });

  it('sweep terminates an untracked Vast.ai instance', async () => {
    // 1. Find the cheapest RTX 4090 offer
    const offers = await client.listOffers({ gpuName: 'RTX 4090' }, creds);
    expect(offers.length).toBeGreaterThan(0);
    const cheapest = offers.sort((a: any, b: any) => a.pricePerHr - b.pricePerHr)[0];

    // 2. Create WITHOUT a gateway prefix — simulates a stray VM.
    const created = await client.createInstance(
      {
        offerId: cheapest.id,
        image: 'nvidia/cuda:12.4.1-base-ubuntu22.04',
        instanceName: 'stray-manual-vm',   // no `parle-autoscale-` / `ai-gateway-`
      },
      creds,
    );
    const strayId = created.instanceId ?? (created as any).id;
    expect(strayId).toBeTruthy();
    createdInThisTest.push(strayId);
    console.log(`[vast-e2e] created stray instance ${strayId}`);

    // 3. Confirm the instance appears in listInstances
    const before = await client.listInstances(creds);
    expect(before.some(i => i.instanceId === strayId)).toBe(true);

    // 4. Run the orphan sweep — MUST terminate our stray VM
    const result = await sweepOrphanInstances();
    console.log(`[vast-e2e] sweep report: found=${result.found} terminated=${result.terminated}`);
    expect(result.terminated).toBeGreaterThan(0);

    // 5. Verify the instance is gone (or already transitioning to deleted).
    //    Vast may take a moment to reflect delete; poll up to 20s.
    let stillThere = true;
    for (let i = 0; i < 10 && stillThere; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const after = await client.listInstances(creds);
      stillThere = after.some(inst => inst.instanceId === strayId && (inst.status ?? '').toLowerCase() !== 'deleted');
    }
    expect(stillThere).toBe(false);
  }, 180_000);

  it('sweep skips the active tracked deploy', async () => {
    // Import tracked state and pin a known ID so the sweep must NOT touch it.
    const { setDeployState } = await import('../../server/state');
    const created = await client.createInstance(
      {
        offerId: (await client.listOffers({ gpuName: 'RTX 4090' }, creds))
          .sort((a: any, b: any) => a.pricePerHr - b.pricePerHr)[0].id,
        image: 'nvidia/cuda:12.4.1-base-ubuntu22.04',
        instanceName: 'tracked-vm',
      },
      creds,
    );
    const trackedId = created.instanceId ?? (created as any).id;
    createdInThisTest.push(trackedId);
    setDeployState({ podId: trackedId, provider: 'vast' });

    try {
      const result = await sweepOrphanInstances();
      // The tracked one must survive regardless of sweep terminating others.
      const after = await client.listInstances(creds);
      const survivor = after.find(i => i.instanceId === trackedId);
      expect(survivor).toBeDefined();
      expect((survivor!.status ?? '').toLowerCase()).not.toBe('deleted');
      console.log(`[vast-e2e] tracked pod preserved through sweep (found=${result.found} terminated=${result.terminated})`);
    } finally {
      setDeployState({ podId: '', provider: '' });
    }
  }, 180_000);
});
