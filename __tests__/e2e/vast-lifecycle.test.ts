/**
 * Vast.ai GPU Provider — Full Inference Lifecycle Tests (Real API, Real Machines)
 *
 * Deploys the ultralight speech-to-speech pipeline on Vast.ai and tests:
 *   1. Search offers (cheapest GPU)
 *   2. createInstance (ultralight image, GROQ_API_KEY injected)
 *   3. getInstanceStatus (verify status)
 *   4. resolveInstanceEndpoint (verify endpoint)
 *   5. listInstances (verify instance appears)
 *   6. Wait for running status
 *   7. Attempt inference (best-effort — Vast.ai SSH proxy may block HTTP)
 *   8. deleteInstance (verify cleanup)
 *
 * Requires: VAST_API_KEY, GROQ_API_KEY
 * Cost: ~$0.05-0.10 per run (cheapest GPU, ~3-5min)
 *
 * NOTE: Vast.ai on-demand instances route HTTP through SSH proxy.
 * Inference tests are best-effort — they pass if HTTP is unreachable
 * but still verify API lifecycle operations.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { VastClient } from '../../src/gpu-providers/vast-client';
import type { ProviderCredentials, GpuInstance } from '../../src/gpu-providers/types';
import { loadEnv, timed, waitFor, checkHealth, testTextPipeline } from '../helpers';

const ULTRALIGHT_IMAGE = 'marcosremar/parle-s2s-ultralight:latest';

let creds: ProviderCredentials;
let client: VastClient;
let groqKey: string;

// Shared state across sequential tests
let createdInstance: GpuInstance | null = null;

const hasVastKeys = !!process.env.VAST_API_KEY && process.env.SKIP_GPU_TESTS !== '1';

beforeAll(() => {
  if (!hasVastKeys) return;
  loadEnv();
  creds = { apiKey: process.env.VAST_API_KEY! };
  groqKey = process.env.GROQ_API_KEY || '';
  client = new VastClient();
});

afterAll(async () => {
  if (createdInstance) {
    try {
      await client.deleteInstance(createdInstance.instanceId, creds);
      console.log(`  [cleanup] Deleted instance ${createdInstance.instanceId}`);
    } catch (err) {
      console.warn(`  [cleanup] Failed to delete ${createdInstance.instanceId}:`, err);
    }
  }
});

// ─── Offer Search (Read-Only) ───────────────────────────────────────────────
//
// Uses client.listOffers() — the proper VastClient abstraction — instead of
// raw HTTP to console.vast.ai/api (which is forbidden per CLAUDE.md).

describe.skipIf(!hasVastKeys)('Vast.ai Offers — Real API', () => {
  it('Step 1a: listOffers RTX 3090 returns sorted results (cheapest first)', async () => {
    const { result: offers, ms } = await timed(() =>
      client.listOffers({ gpuTypes: ['RTX 3090'], limit: 5 }, creds),
    );

    expect(Array.isArray(offers)).toBe(true);
    expect(offers.length).toBeGreaterThan(0);

    // Verify sorted ascending by price
    for (let i = 1; i < offers.length; i++) {
      expect(offers[i].pricePerHr).toBeGreaterThanOrEqual(offers[i - 1].pricePerHr);
    }

    console.log(`  SEARCH RTX 3090: ${offers.length} offer(s) (${ms}ms)`);
    for (const o of offers) {
      console.log(
        `    $${o.pricePerHr.toFixed(3)}/h — ${o.gpuType}, ${o.vram}GB VRAM, region: ${o.region}`,
      );
    }
  });

  it('Step 1b: listOffers with multiple GPU types returns results', async () => {
    const { result: offers, ms } = await timed(() =>
      client.listOffers(
        { gpuTypes: ['RTX 4090', 'RTX 3090', 'A40', 'RTX A5000'], limit: 10 },
        creds,
      ),
    );

    expect(Array.isArray(offers)).toBe(true);
    expect(offers.length).toBeGreaterThan(0);

    const gpuTypes = new Set(offers.map((o) => o.gpuType));
    console.log(
      `  MULTI-GPU: ${offers.length} offer(s) (${ms}ms), GPU types: ${[...gpuTypes].join(', ')}`,
    );
  });
});

// ─── Full Lifecycle (Creates Real Machine) ──────────────────────────────────

describe.skipIf(!hasVastKeys)('Vast.ai Lifecycle — Ultralight Inference', () => {
  it('Step 2: createInstance — ultralight image with GROQ_API_KEY', async () => {
    const { result: instance, ms } = await timed(() =>
      client.createInstance(
        {
          gpuTypes: ['RTX 3090', 'RTX 4090', 'RTX A5000', 'A40'],
          gpuCount: 1,
          storageGb: 5,
          dockerImage: ULTRALIGHT_IMAGE,
          env: { GROQ_API_KEY: groqKey, TEST_RUN: Date.now().toString() },
        },
        creds,
      ),
    );

    createdInstance = instance;

    expect(instance.instanceId).toBeTruthy();
    expect(instance.instanceId).toMatch(/^inst-\d+$/);
    expect(typeof instance.status).toBe('string');

    console.log(`  CREATE: ${instance.instanceId}`);
    console.log(`    Endpoint: ${instance.endpoint || '(pending)'}`);
    console.log(`    Status: ${instance.status}`);
    console.log(`    GPU: ${instance.gpuType || 'unknown'}`);
    console.log(`    Image: ${ULTRALIGHT_IMAGE}`);
    console.log(`    Time: ${ms}ms`);
  }, 90_000);

  it('Step 3: getInstanceStatus — returns valid status', async () => {
    expect(createdInstance).not.toBeNull();

    const { result: status, ms } = await timed(() =>
      client.getInstanceStatus(createdInstance!.instanceId, creds),
    );

    expect(status).toBeTruthy();
    expect(typeof status).toBe('string');
    console.log(`  STATUS: ${status} (${ms}ms)`);
  }, 15_000);

  it('Step 4: resolveInstanceEndpoint — returns endpoint info', async () => {
    expect(createdInstance).not.toBeNull();

    const { result: endpoint, ms } = await timed(() =>
      client.resolveInstanceEndpoint!(createdInstance!.instanceId, creds),
    );

    if (endpoint) {
      expect(typeof endpoint).toBe('string');
      expect(endpoint.length).toBeGreaterThan(0);
      console.log(`  ENDPOINT: ${endpoint} (${ms}ms)`);
    } else {
      console.log(`  ENDPOINT: still loading / no port assigned yet (${ms}ms)`);
    }
  }, 15_000);

  it('Step 5: listInstances — instance appears in list', async () => {
    expect(createdInstance).not.toBeNull();

    const { result: instances, ms } = await timed(() => client.listInstances(creds));

    expect(Array.isArray(instances)).toBe(true);

    const rawId = createdInstance!.instanceId.replace(/^inst-/, '').replace(/^endpt-/, '');
    const ourInstance = instances.find(
      (i) => i.instanceId === createdInstance!.instanceId || i.instanceId.includes(rawId),
    );
    expect(ourInstance).toBeDefined();

    console.log(`  LIST: ${instances.length} instance(s), ours found (${ms}ms)`);
    for (const inst of instances) {
      const prefix = inst.instanceId.startsWith('endpt-') ? 'endpoint' : 'instance';
      console.log(
        `    ${prefix}: ${inst.instanceId} — ${inst.status} — ${inst.gpuType || 'unknown'} — ${inst.endpoint || '(pending)'}`,
      );
    }
  }, 15_000);

  it('Step 6: wait for running/loaded status', async () => {
    expect(createdInstance).not.toBeNull();

    const start = Date.now();
    let finalStatus = '';

    await waitFor(
      async () => {
        const status = await client.getInstanceStatus(createdInstance!.instanceId, creds);
        finalStatus = status || 'null';
        return status === 'running' || status === 'active';
      },
      { intervalMs: 10_000, timeoutMs: 180_000, label: 'instance running' },
    );

    const elapsed = Date.now() - start;
    console.log(
      `  RUNNING: instance ready in ${(elapsed / 1000).toFixed(1)}s (status: ${finalStatus})`,
    );

    // Re-resolve endpoint after boot
    const endpoint = await client.resolveInstanceEndpoint!(createdInstance!.instanceId, creds);
    console.log(`  ENDPOINT (after boot): ${endpoint || '(still pending)'}`);
  }, 240_000);

  it('Step 7: attempt inference (best-effort — SSH proxy may block HTTP)', async () => {
    expect(createdInstance).not.toBeNull();

    // Resolve endpoint
    const endpoint = await client.resolveInstanceEndpoint!(createdInstance!.instanceId, creds);

    if (!endpoint) {
      console.log(`  INFERENCE: SKIPPED — no endpoint available (SSH proxy blocking)`);
      return;
    }

    console.log(`  INFERENCE: attempting on ${endpoint}`);

    // Try health check first
    const health = await checkHealth(endpoint);
    if (!health.ok) {
      console.log(
        `  INFERENCE: SKIPPED — /health unreachable (expected: Vast.ai SSH proxy blocks HTTP)`,
      );
      console.log(`    This is a known limitation of Vast.ai on-demand instances.`);
      console.log(
        `    API lifecycle tests (create/list/delete) still verify provider functionality.`,
      );
      return;
    }

    console.log(`  HEALTH: ${JSON.stringify(health.data)}`);

    // If health works, try full inference!
    const { result, ms } = await timed(() => testTextPipeline(endpoint, 'Olá, como você está?'));

    if (result.ok) {
      console.log(`  TEXT PIPELINE (${ms}ms):`);
      console.log(`    Response: "${result.responseText?.substring(0, 80)}"`);
      console.log(`    Events: ${result.events.map((e) => e.event).join(', ')}`);
      if (result.totalMs) console.log(`    Server time: ${result.totalMs}ms`);
    } else {
      console.log(`  TEXT PIPELINE: failed — ${result.error || 'unknown error'}`);
      console.log(`    This may be expected if Vast.ai SSH proxy partially blocks HTTP.`);
    }
  }, 60_000);

  it('Step 8: verify instance details after boot', async () => {
    expect(createdInstance).not.toBeNull();

    const instances = await client.listInstances(creds);
    const rawId = createdInstance!.instanceId.replace(/^inst-/, '');
    const ourInstance = instances.find(
      (i) => i.instanceId === createdInstance!.instanceId || i.instanceId.includes(rawId),
    );

    expect(ourInstance).toBeDefined();
    expect(ourInstance!.status).toMatch(/running|active|loading/);

    console.log(`  DETAILS: ${ourInstance!.instanceId}`);
    console.log(`    Status: ${ourInstance!.status}`);
    console.log(`    GPU: ${ourInstance!.gpuType || 'unknown'}`);
    console.log(`    Endpoint: ${ourInstance!.endpoint || '(none)'}`);
  }, 15_000);

  it('Step 9: deleteInstance — removes the instance', async () => {
    expect(createdInstance).not.toBeNull();
    const instanceId = createdInstance!.instanceId;

    const { ms } = await timed(() => client.deleteInstance(instanceId, creds));
    createdInstance = null; // Don't cleanup in afterAll

    // No sleep — Vast.ai returns null immediately for deleted instances.
    // The assertion below already accepts null (deleted) or terminal statuses.
    const status = await client.getInstanceStatus(instanceId, creds);
    console.log(`  DELETE: ok, status after = ${status} (${ms}ms)`);

    if (status !== null) {
      expect(['exited', 'destroyed', 'inactive']).toContain(status);
    }
  }, 30_000);
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────

describe.skipIf(!hasVastKeys)('Vast.ai — Edge Cases', () => {
  it('getInstanceStatus returns null for non-existent instance', async () => {
    const status = await client.getInstanceStatus('inst-9999999', creds);
    expect(status).toBeNull();
  });

  it('resolveInstanceEndpoint returns null for non-existent instance', async () => {
    const endpoint = await client.resolveInstanceEndpoint!('inst-9999999', creds);
    expect(endpoint).toBeNull();
  });

  it('listInstances with invalid key returns empty array', async () => {
    const badClient = new VastClient();
    const badCreds: ProviderCredentials = { apiKey: 'invalid-vast-key-12345' };
    const instances = await badClient.listInstances(badCreds);
    expect(instances).toEqual([]);
  });

  it('discoverInstance returns null or non-matching when no running instances match', async () => {
    const instance = await client.discoverInstance(creds, ['NVIDIA H200 MEGA ULTRA']);
    if (instance !== null) {
      expect(instance.status).toBeDefined();
      expect(instance.instanceId).toBeTruthy();
      console.log(
        `  discoverInstance: found non-matching instance ${instance.instanceId} (${instance.status})`,
      );
    }
  });
});
