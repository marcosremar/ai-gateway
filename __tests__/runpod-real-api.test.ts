/**
 * RunPod GPU Provider — Integration Tests (Real API)
 *
 * Tests read-only operations against RunPod's live REST API.
 * Create/delete tests use a minimal ultralight pod to minimize cost.
 *
 * Requires: RUNPOD_API_KEY
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RunpodClient, RUNPOD_GPU_TYPE_MAP, RUNPOD_GPU_FALLBACK } from '../src/gpu-providers/runpod-client';
import type { ProviderCredentials } from '../src/gpu-providers/types';
import { loadEnv, requireEnv, timed } from './helpers';

let creds: ProviderCredentials;
let client: RunpodClient;

// Track pod created during test for cleanup
let createdPodId: string | null = null;

beforeAll(() => {
  loadEnv();
  const apiKey = requireEnv('RUNPOD_API_KEY');
  creds = { apiKey };
  client = new RunpodClient();
});

afterAll(async () => {
  // Cleanup: delete any pod created during tests
  if (createdPodId) {
    try {
      await client.deleteInstance(createdPodId, creds);
      console.log(`  [cleanup] Deleted pod ${createdPodId}`);
    } catch (err) {
      console.warn(`  [cleanup] Failed to delete pod ${createdPodId}:`, err);
    }
  }
});

describe('RunpodClient — Read-Only (Real API)', () => {
  it('lists all pods on account', async () => {
    const { result: pods, ms } = await timed(() => client.listInstances(creds));

    expect(Array.isArray(pods)).toBe(true);
    console.log(`  RunPod listInstances: ${pods.length} pod(s) (${ms}ms)`);

    if (pods.length > 0) {
      const pod = pods[0];
      expect(pod.instanceId).toBeTruthy();
      expect(typeof pod.endpoint).toBe('string');
      expect(typeof pod.status).toBe('string');
      console.log(`    First pod: ${pod.instanceId} — ${pod.status} — ${pod.gpuType || 'unknown GPU'}`);
    }
  });

  it('discovers running instance (if any)', async () => {
    const { result: instance, ms } = await timed(() =>
      client.discoverInstance(creds, ['RTX 4090']),
    );

    if (instance) {
      expect(instance.instanceId).toBeTruthy();
      expect(instance.endpoint).toBeTruthy();
      console.log(`  RunPod discoverInstance: ${instance.instanceId} → ${instance.endpoint} (${ms}ms)`);
    } else {
      console.log(`  RunPod discoverInstance: no running pods (${ms}ms)`);
    }
    // discoverInstance can return null — that's valid
  });

  it('getInstanceStatus returns null for non-existent pod', async () => {
    const status = await client.getInstanceStatus('fake-pod-id-12345', creds);
    expect(status).toBeNull();
  });

  it('resolveInstanceEndpoint returns null for non-existent pod', async () => {
    const endpoint = await client.resolveInstanceEndpoint!('fake-pod-id-12345', creds);
    expect(endpoint).toBeNull();
  });

  it('GPU_TYPE_MAP has expected mappings', () => {
    expect(RUNPOD_GPU_TYPE_MAP['RTX 4090']).toBe('NVIDIA GeForce RTX 4090');
    expect(RUNPOD_GPU_TYPE_MAP['A100']).toBe('NVIDIA A100 80GB PCIe');
    expect(RUNPOD_GPU_TYPE_MAP['RTX A5000']).toBe('NVIDIA RTX A5000');
    // Legacy mappings → cheapest alternative
    expect(RUNPOD_GPU_TYPE_MAP['RTX 3090']).toBe('NVIDIA GeForce RTX 4090');
  });

  it('GPU_FALLBACK has at least 3 GPU types', () => {
    expect(RUNPOD_GPU_FALLBACK.length).toBeGreaterThanOrEqual(3);
    expect(RUNPOD_GPU_FALLBACK[0]).toContain('NVIDIA');
  });
});

describe('RunpodClient — Create & Lifecycle (Real API)', () => {
  it('creates an ultralight pod, checks status, then deletes it', async () => {
    // Use the smallest possible pod: ultralight image, no volume, cheapest GPU
    const { result: instance, ms: createMs } = await timed(() =>
      client.createInstance(
        {
          gpuTypes: ['RTX 4090', 'RTX A5000', 'A40'],
          gpuCount: 1,
          storageGb: 0, // No volume — ultralight
          dockerImage: 'python:3.11-slim',
          env: { TEST_MODE: 'true' },
        },
        creds,
      ),
    );

    createdPodId = instance.instanceId;

    expect(instance.instanceId).toBeTruthy();
    expect(instance.endpoint).toBeTruthy();
    expect(instance.endpoint).toContain('proxy.runpod.net');
    expect(instance.status).toBe('CREATING');
    console.log(`  RunPod CREATE: ${instance.instanceId} → ${instance.endpoint} (${createMs}ms)`);

    // Check status
    const { result: status, ms: statusMs } = await timed(() =>
      client.getInstanceStatus(instance.instanceId, creds),
    );
    expect(status).toBeTruthy(); // Should be CREATING or RUNNING
    console.log(`  RunPod STATUS: ${status} (${statusMs}ms)`);

    // Resolve endpoint
    const { result: endpoint, ms: resolveMs } = await timed(() =>
      client.resolveInstanceEndpoint!(instance.instanceId, creds),
    );
    expect(endpoint).toBeTruthy();
    console.log(`  RunPod ENDPOINT: ${endpoint} (${resolveMs}ms)`);

    // List should include our pod
    const pods = await client.listInstances(creds);
    const ourPod = pods.find((p) => p.instanceId === instance.instanceId);
    expect(ourPod).toBeDefined();

    // Stop the pod
    const { ms: stopMs } = await timed(() =>
      client.stopInstance(instance.instanceId, creds),
    );
    console.log(`  RunPod STOP: ok (${stopMs}ms)`);

    // Delete the pod
    const { ms: deleteMs } = await timed(() =>
      client.deleteInstance(instance.instanceId, creds),
    );
    createdPodId = null; // No cleanup needed — already deleted
    console.log(`  RunPod DELETE: ok (${deleteMs}ms)`);

    // Verify deletion
    const afterStatus = await client.getInstanceStatus(instance.instanceId, creds);
    // Should be null (not found) or EXITED
    expect(afterStatus === null || afterStatus === 'EXITED').toBe(true);
    console.log(`  RunPod VERIFY: status after delete = ${afterStatus}`);
  }, 120_000); // 2 min timeout for full lifecycle

  it('onInstancePersist callback is called', async () => {
    let persisted: Record<string, unknown> | null = null;

    const clientWithPersist = new RunpodClient({
      onInstancePersist: async (_userId, _machineKey, data) => {
        persisted = data;
      },
    });

    const instance = await clientWithPersist.createInstance(
      {
        gpuTypes: ['RTX 4090', 'RTX A5000', 'A40'],
        gpuCount: 1,
        storageGb: 0,
        dockerImage: 'python:3.11-slim',
      },
      creds,
      'test-user-123',
    );

    createdPodId = instance.instanceId;

    expect(persisted).not.toBeNull();
    expect(persisted!.podId).toBe(instance.instanceId);
    expect(persisted!.endpoint).toBeTruthy();
    expect(persisted!.status).toBe('CREATING');
    console.log(`  RunPod onInstancePersist: podId=${persisted!.podId}`);

    // Cleanup
    await client.deleteInstance(instance.instanceId, creds);
    createdPodId = null;
  }, 60_000);
});
