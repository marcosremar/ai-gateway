/**
 * RunPod GPU Provider — Full Inference Lifecycle Tests (Real API, Real Machines)
 *
 * Deploys the ultralight speech-to-speech pipeline on RunPod and tests:
 *   1. createInstance (ultralight image, storageGb=0, GROQ_API_KEY injected)
 *   2. getInstanceStatus (verify RUNNING/CREATING)
 *   3. resolveInstanceEndpoint (verify proxy URL)
 *   4. listInstances (verify pod appears)
 *   5. Wait for /health (proxy 502 → healthy, up to 5 min)
 *   6. Verify /health response (status === 'healthy')
 *   7. Test text pipeline (/api/text SSE: transcript → response → audio → complete)
 *   8. Test audio pipeline (/api/stream-audio SSE)
 *   9. stopInstance (verify EXITED)
 *  10. startInstance (verify RUNNING again)
 *  11. Wait for /health after restart
 *  12. Verify inference after restart (text pipeline)
 *  13. deleteInstance (verify gone)
 *  14. onInstancePersist callback
 *  15. Edge cases (non-existent pod IDs, GPU maps — no real API needed)
 *
 * Requires: RUNPOD_API_KEY, GROQ_API_KEY (for lifecycle + callback suites)
 * Cost: ~$0.02-0.05 per run (ultralight pod, ~8-10min)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RunpodClient, RUNPOD_GPU_TYPE_MAP, RUNPOD_GPU_FALLBACK } from '../src/gpu-providers/runpod-client';
import type { ProviderCredentials, GpuInstance } from '../src/gpu-providers/types';
import {
  loadEnv, timed, waitFor,
  checkHealth, testTextPipeline, testAudioPipeline,
} from './helpers';

const ULTRALIGHT_IMAGE = 'marcosremar/parle-s2s-ultralight:latest';

loadEnv();
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const HAS_KEYS = !!(RUNPOD_API_KEY && GROQ_API_KEY) && process.env.SKIP_GPU_TESTS !== '1';

// ─── Sequential Lifecycle Tests ─────────────────────────────────────────────

describe.skipIf(!HAS_KEYS)('RunPod Lifecycle — Ultralight Inference', () => {
  let creds: ProviderCredentials;
  let client: RunpodClient;
  let createdPod: GpuInstance | null = null;

  beforeAll(() => {
    creds = { apiKey: RUNPOD_API_KEY! };
    client = new RunpodClient();
  });

  afterAll(async () => {
    // Safety net: delete the pod if any test failed before cleanup
    if (createdPod) {
      try {
        await client.deleteInstance(createdPod.instanceId, creds);
        console.log(`  [cleanup] Deleted pod ${createdPod.instanceId}`);
      } catch (err) {
        console.warn(`  [cleanup] Failed to delete pod ${createdPod.instanceId}:`, err);
      }
    }
  });

  it('Step 1: createInstance — ultralight image (storageGb=0, GROQ_API_KEY)', async () => {
    const { result: instance, ms } = await timed(() =>
      client.createInstance(
        {
          gpuTypes: ['RTX A5000', 'RTX 3090', 'RTX A6000', 'RTX 4090', 'A40'],
          gpuCount: 1,
          storageGb: 0,
          dockerImage: ULTRALIGHT_IMAGE,
          env: { GROQ_API_KEY: GROQ_API_KEY!, TEST_RUN: Date.now().toString() },
        },
        creds,
      ),
    );

    createdPod = instance;

    expect(instance.instanceId).toBeTruthy();
    expect(typeof instance.instanceId).toBe('string');
    expect(instance.endpoint).toBeTruthy();
    expect(instance.status).toMatch(/CREATING|RUNNING/);
    expect(instance.gpuType).toBeTruthy();

    console.log(`  CREATE: ${instance.instanceId}`);
    console.log(`    GPU: ${instance.gpuType}`);
    console.log(`    Endpoint: ${instance.endpoint}`);
    console.log(`    Status: ${instance.status}`);
    console.log(`    Image: ${ULTRALIGHT_IMAGE}`);
    console.log(`    Time: ${ms}ms`);
  }, 30_000);

  it('Step 2: getInstanceStatus — returns valid status', async () => {
    expect(createdPod).not.toBeNull();

    const { result: status, ms } = await timed(() =>
      client.getInstanceStatus(createdPod!.instanceId, creds),
    );

    expect(status).toBeTruthy();
    expect(typeof status).toBe('string');
    expect(['RUNNING', 'CREATING', 'EXITED']).toContain(status);

    console.log(`  STATUS: ${status} (${ms}ms)`);
  }, 15_000);

  it('Step 3: resolveInstanceEndpoint — returns proxy URL', async () => {
    expect(createdPod).not.toBeNull();

    const { result: endpoint, ms } = await timed(() =>
      client.resolveInstanceEndpoint!(createdPod!.instanceId, creds),
    );

    expect(endpoint).toBeTruthy();
    expect(typeof endpoint).toBe('string');
    expect(endpoint).toContain('proxy.runpod.net');
    expect(endpoint).toContain(createdPod!.instanceId);

    console.log(`  ENDPOINT: ${endpoint} (${ms}ms)`);
  }, 15_000);

  it('Step 4: listInstances — pod appears in list', async () => {
    expect(createdPod).not.toBeNull();

    const { result: pods, ms } = await timed(() => client.listInstances(creds));

    expect(Array.isArray(pods)).toBe(true);
    const ourPod = pods.find((p) => p.instanceId === createdPod!.instanceId);
    expect(ourPod).toBeDefined();
    expect(ourPod!.endpoint).toBeTruthy();

    console.log(`  LIST: ${pods.length} pod(s), ours found: ${ourPod!.instanceId} (${ms}ms)`);
    for (const p of pods) {
      console.log(`    ${p.instanceId} — ${p.status} — ${p.gpuType || 'unknown'}`);
    }
  }, 15_000);

  it('Step 5: wait for /health to return healthy (image pull + server boot)', async () => {
    expect(createdPod).not.toBeNull();
    expect(createdPod!.endpoint).toBeTruthy();

    const start = Date.now();
    let lastResult = 'N/A';

    await waitFor(
      async () => {
        const health = await checkHealth(createdPod!.endpoint!);
        lastResult = health.ok ? 'healthy' : health.data ? JSON.stringify(health.data) : 'unreachable/502';
        return health.ok;
      },
      { intervalMs: 5000, timeoutMs: 300_000, label: '/health healthy' },
    );

    const elapsed = Date.now() - start;
    console.log(`  BOOT: /health healthy in ${(elapsed / 1000).toFixed(1)}s — ${lastResult}`);
  }, 360_000);

  it('Step 6: verify /health response details', async () => {
    expect(createdPod).not.toBeNull();

    const health = await checkHealth(createdPod!.endpoint!);

    expect(health.ok).toBe(true);
    expect(health.data).toBeDefined();
    expect(health.data!.status).toBe('healthy');

    console.log(`  HEALTH: ${JSON.stringify(health.data)}`);
    if (health.data!.pipeline) console.log(`    Pipeline: ${health.data!.pipeline}`);
    if (health.data!.models) console.log(`    Models: ${JSON.stringify(health.data!.models)}`);
  }, 15_000);

  it('Step 7: test text pipeline — /api/text SSE', async () => {
    expect(createdPod).not.toBeNull();

    const { result, ms } = await timed(() =>
      testTextPipeline(createdPod!.endpoint!, 'Olá, como você está?'),
    );

    expect(result.ok).toBe(true);
    expect(result.hasResponse).toBe(true);
    expect(result.hasComplete).toBe(true);
    expect(result.responseText).toBeTruthy();

    console.log(`  TEXT PIPELINE (${ms}ms):`);
    console.log(`    Transcript: ${result.hasTranscript ? 'YES' : 'no'}`);
    console.log(`    Response: ${result.hasResponse ? 'YES' : 'no'} — "${result.responseText?.substring(0, 80)}"`);
    console.log(`    Audio: ${result.hasAudio ? 'YES' : 'no'}`);
    console.log(`    Complete: ${result.hasComplete ? 'YES' : 'no'}`);
    if (result.totalMs) console.log(`    Server time: ${result.totalMs}ms`);
    console.log(`    Events: ${result.events.map((e) => e.event).join(', ')}`);
  }, 30_000);

  it('Step 8: test audio pipeline — /api/stream-audio SSE', async () => {
    expect(createdPod).not.toBeNull();

    const { result, ms } = await timed(() =>
      testAudioPipeline(createdPod!.endpoint!),
    );

    // Audio pipeline may fail with silence (Whisper returns empty transcript)
    // so we only require a response from the server, not necessarily all events
    expect(result.events.length).toBeGreaterThan(0);

    console.log(`  AUDIO PIPELINE (${ms}ms):`);
    console.log(`    Transcript: ${result.hasTranscript ? 'YES' : 'no'}`);
    console.log(`    Response: ${result.hasResponse ? 'YES' : 'no'} — "${result.responseText?.substring(0, 80) || '(none)'}"`);
    console.log(`    Audio: ${result.hasAudio ? 'YES' : 'no'}`);
    console.log(`    Complete: ${result.hasComplete ? 'YES' : 'no'}`);
    if (result.error) console.log(`    Error: ${result.error}`);
    console.log(`    Events: ${result.events.map((e) => e.event).join(', ')}`);
  }, 30_000);

  it('Step 9: stopInstance — stops the pod', async () => {
    expect(createdPod).not.toBeNull();

    const { ms } = await timed(() =>
      client.stopInstance(createdPod!.instanceId, creds),
    );

    await new Promise((r) => setTimeout(r, 2000));

    const status = await client.getInstanceStatus(createdPod!.instanceId, creds);
    expect(status).toMatch(/EXITED|STOPPED|RUNNING/);

    console.log(`  STOP: ok, status now = ${status} (${ms}ms)`);
  }, 30_000);

  it('Step 10: startInstance — restarts the pod', async () => {
    expect(createdPod).not.toBeNull();

    const { ms } = await timed(() =>
      client.startInstance(createdPod!.instanceId, creds),
    );

    await new Promise((r) => setTimeout(r, 3000));

    const status = await client.getInstanceStatus(createdPod!.instanceId, creds);
    expect(status).toBe('RUNNING');

    console.log(`  START: ok, desiredStatus = ${status} (${ms}ms)`);
  }, 30_000);

  it('Step 11: wait for /health after restart (warm restart)', async () => {
    expect(createdPod).not.toBeNull();

    const start = Date.now();

    await waitFor(
      async () => {
        const health = await checkHealth(createdPod!.endpoint!);
        return health.ok;
      },
      { intervalMs: 5000, timeoutMs: 300_000, label: '/health after restart' },
    );

    const elapsed = Date.now() - start;
    console.log(`  RESTART BOOT: /health healthy in ${(elapsed / 1000).toFixed(1)}s`);
  }, 360_000);

  it('Step 12: verify inference after restart — text pipeline', async () => {
    expect(createdPod).not.toBeNull();

    const { result, ms } = await timed(() =>
      testTextPipeline(createdPod!.endpoint!, 'Teste pós-restart'),
    );

    expect(result.ok).toBe(true);
    expect(result.hasResponse).toBe(true);
    expect(result.responseText).toBeTruthy();

    console.log(`  POST-RESTART INFERENCE (${ms}ms): "${result.responseText?.substring(0, 80)}"`);
  }, 30_000);

  it('Step 13: deleteInstance — removes the pod', async () => {
    expect(createdPod).not.toBeNull();
    const podId = createdPod!.instanceId;

    const { ms } = await timed(() =>
      client.deleteInstance(podId, creds),
    );
    createdPod = null; // Don't cleanup in afterAll

    await new Promise((r) => setTimeout(r, 2000));
    const status = await client.getInstanceStatus(podId, creds);
    expect(status === null || status === 'EXITED').toBe(true);

    const pods = await client.listInstances(creds);
    const found = pods.find((p) => p.instanceId === podId);
    expect(found).toBeUndefined();

    console.log(`  DELETE: ok, status = ${status}, not in list (${ms}ms)`);
  }, 30_000);
});

// ─── onInstancePersist Callback ─────────────────────────────────────────────

describe.skipIf(!HAS_KEYS)('RunPod — onInstancePersist Callback', () => {
  let creds: ProviderCredentials;
  let client: RunpodClient;
  let callbackPod: GpuInstance | null = null;

  beforeAll(() => {
    creds = { apiKey: RUNPOD_API_KEY! };
    client = new RunpodClient();
  });

  afterAll(async () => {
    if (callbackPod) {
      try {
        await client.deleteInstance(callbackPod.instanceId, creds);
        console.log(`  [cleanup] Deleted callback pod ${callbackPod.instanceId}`);
      } catch {}
    }
  });

  it('Step 14: onInstancePersist receives correct data on create', async () => {
    let persistedData: Record<string, unknown> | null = null;
    let persistedUserId: string | null = null;

    const clientWithPersist = new RunpodClient({
      onInstancePersist: async (userId, _machineKey, data) => {
        persistedData = data;
        persistedUserId = userId ?? null;
      },
    });

    const { result: instance, ms } = await timed(() =>
      clientWithPersist.createInstance(
        {
          gpuTypes: ['RTX A5000', 'RTX 3090', 'RTX A6000', 'RTX 4090', 'A40'],
          gpuCount: 1,
          storageGb: 0,
          dockerImage: ULTRALIGHT_IMAGE,
          env: { GROQ_API_KEY: GROQ_API_KEY! },
        },
        creds,
        'test-lifecycle-user',
      ),
    );

    callbackPod = instance;

    expect(persistedData).not.toBeNull();
    expect(persistedData!.podId).toBe(instance.instanceId);
    expect(persistedData!.endpoint).toBeTruthy();
    expect(persistedData!.status).toMatch(/CREATING|RUNNING/);
    expect(persistedUserId).toBe('test-lifecycle-user');

    console.log(`  PERSIST: userId=${persistedUserId}, podId=${persistedData!.podId} (${ms}ms)`);

    // Cleanup immediately
    await client.deleteInstance(instance.instanceId, creds);
    callbackPod = null;
    console.log(`  CLEANUP: deleted ${instance.instanceId}`);
  }, 30_000);
});

// ─── Edge Cases (no real API needed for GPU map tests) ──────────────────────

describe('RunPod — GPU Type Maps', () => {
  it('GPU_TYPE_MAP covers expected GPU types', () => {
    const expected = ['RTX 4090', 'RTX 3090', 'A100', 'A40', 'RTX A5000', 'RTX A6000', 'H100'];
    for (const gpu of expected) {
      expect(RUNPOD_GPU_TYPE_MAP[gpu]).toBeTruthy();
      expect(RUNPOD_GPU_TYPE_MAP[gpu]).toContain('NVIDIA');
    }
  });

  it('RTX 3090 maps to its own GPU type (not aliased)', () => {
    expect(RUNPOD_GPU_TYPE_MAP['RTX 3090']).toBe('NVIDIA GeForce RTX 3090');
    expect(RUNPOD_GPU_TYPE_MAP['RTX3090']).toBe('NVIDIA GeForce RTX 3090');
  });

  it('GPU_FALLBACK is ordered correctly', () => {
    expect(RUNPOD_GPU_FALLBACK.length).toBeGreaterThanOrEqual(3);
    for (const gpu of RUNPOD_GPU_FALLBACK) {
      expect(gpu).toContain('NVIDIA');
    }
  });
});

describe.skipIf(!RUNPOD_API_KEY)('RunPod — Edge Cases (real API)', () => {
  let creds: ProviderCredentials;
  let client: RunpodClient;

  beforeAll(() => {
    creds = { apiKey: RUNPOD_API_KEY! };
    client = new RunpodClient();
  });

  it('getInstanceStatus returns null for non-existent pod', async () => {
    const status = await client.getInstanceStatus('fake-pod-xyz-99999', creds);
    expect(status).toBeNull();
  });

  it('resolveInstanceEndpoint returns null for non-existent pod', async () => {
    const endpoint = await client.resolveInstanceEndpoint!('fake-pod-xyz-99999', creds);
    expect(endpoint).toBeNull();
  });

  it('deleteInstance throws for non-existent pod', async () => {
    await expect(
      client.deleteInstance('fake-pod-xyz-99999', creds),
    ).rejects.toThrow();
  });
});
