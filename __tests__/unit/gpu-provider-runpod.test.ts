import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RunpodClient, RUNPOD_GPU_FALLBACK, RUNPOD_GPU_TYPE_MAP } from '@ai-gateway/gpu-providers/runpod-client';
import { AbstractGpuProvider } from '@ai-gateway/gpu-providers/abstract-provider';
import type { ProviderCredentials, InstanceSpec } from '@ai-gateway/gpu-providers/types';

const API_BASE = 'https://rest.runpod.io/v1';

const creds: ProviderCredentials = { apiKey: 'test-key-123' };
const credsWithHf: ProviderCredentials = { apiKey: 'test-key-123', hfToken: 'hf_test_token' };

function mockFetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetchText(text: string, status: number): Response {
  return new Response(text, { status });
}

describe('RunpodClient', () => {
  let client: RunpodClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  /** Mock the preflight GraphQL call that createInstance now does before POST /pods. */
  const mockPreflight = () => mockFetchResponse({
    data: { myself: { id: '1', email: 'test@test.com', machineQuota: 10, clientBalance: 100, currentSpendPerHr: 0, pods: [] } },
  });

  beforeEach(() => {
    client = new RunpodClient();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // Prevent Docker Hub calls during createInstance — return fixed disk size
    vi.spyOn(AbstractGpuProvider, 'estimateImageDiskGb').mockResolvedValue(20);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Constants ────────────────────────────────────────────────────────────

  describe('constants', () => {
    it('GPU_FALLBACK contains expected GPU types', () => {
      expect(RUNPOD_GPU_FALLBACK).toContain('NVIDIA GeForce RTX 4090');
      expect(RUNPOD_GPU_FALLBACK).toContain('NVIDIA RTX A5000');
      expect(RUNPOD_GPU_FALLBACK.length).toBeGreaterThanOrEqual(3);
    });

    it('GPU_TYPE_MAP maps short names to full names', () => {
      expect(RUNPOD_GPU_TYPE_MAP['RTX 4090']).toBe('NVIDIA GeForce RTX 4090');
      expect(RUNPOD_GPU_TYPE_MAP['A40']).toBe('NVIDIA A40');
      expect(RUNPOD_GPU_TYPE_MAP['RTX A5000']).toBe('NVIDIA RTX A5000');
    });

    it('legacy GPU names map to available alternatives', () => {
      // RTX 4080 and RTX A4000 are legacy → map to newer alternatives
      expect(RUNPOD_GPU_TYPE_MAP['RTX 4080']).toBe('NVIDIA GeForce RTX 4090');
      expect(RUNPOD_GPU_TYPE_MAP['RTX A4000']).toBe('NVIDIA RTX A5000');
    });

    it('bootTimeSecs is 1200', () => {
      expect(client.bootTimeSecs).toBe(1200);
    });

    it('providerId is runpod', () => {
      expect(client.providerId).toBe('runpod');
    });
  });

  // ── resolveEndpoint (tested via discoverInstance / listInstances) ──────

  describe('discoverInstance', () => {
    it('returns running pod with runtime ports endpoint', async () => {
      const pods = [
        {
          id: 'pod-1',
          desiredStatus: 'RUNNING',
          runtime: { ports: [{ ip: '1.2.3.4', privatePort: 8000, publicPort: 18000 }] },
        },
      ];
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(pods));

      const result = await client.discoverInstance(creds, []);
      expect(result).toEqual({
        instanceId: 'pod-1',
        endpoint: 'http://1.2.3.4:18000',
        status: 'RUNNING',
      });
    });

    it('uses publicIp + portMappings when runtime ports unavailable', async () => {
      const pods = [
        {
          id: 'pod-2',
          desiredStatus: 'RUNNING',
          runtime: {},
          publicIp: '5.6.7.8',
          portMappings: { '8000': 28000 },
        },
      ];
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(pods));

      const result = await client.discoverInstance(creds, []);
      expect(result).toEqual({
        instanceId: 'pod-2',
        endpoint: 'http://5.6.7.8:28000',
        status: 'RUNNING',
      });
    });

    it('falls back to proxy URL when no ports available', async () => {
      const pods = [{ id: 'pod-3', desiredStatus: 'RUNNING' }];
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(pods));

      const result = await client.discoverInstance(creds, []);
      expect(result).toEqual({
        instanceId: 'pod-3',
        endpoint: 'https://pod-3-8000.proxy.runpod.net',
        status: 'RUNNING',
      });
    });

    it('prefers running pod with runtime over running without', async () => {
      const pods = [
        { id: 'pod-no-runtime', desiredStatus: 'RUNNING' },
        { id: 'pod-with-runtime', desiredStatus: 'RUNNING', runtime: { ports: [{ ip: '1.1.1.1', privatePort: 8000, publicPort: 9000 }] } },
      ];
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(pods));

      const result = await client.discoverInstance(creds, []);
      expect(result!.instanceId).toBe('pod-with-runtime');
    });

    it('returns null for empty pods array', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse([]));
      expect(await client.discoverInstance(creds, [])).toBeNull();
    });

    it('returns null on HTTP error', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchText('Unauthorized', 401));
      expect(await client.discoverInstance(creds, [])).toBeNull();
    });

    it('returns null on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network error'));
      expect(await client.discoverInstance(creds, [])).toBeNull();
    });
  });

  // ── createInstance ─────────────────────────────────────────────────────

  describe('createInstance', () => {
    const baseSpec: InstanceSpec = { gpuTypes: [], dockerImage: 'test/image:latest' };

    // NOTE: createInstance now calls _runPreflight() (GraphQL account check)
    // before POST /pods. Every createInstance test must mock the preflight
    // response first, then the actual pod create response.

    it('uses GPU_FALLBACK when no gpuTypes specified', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockPreflight())          // preflight
        .mockResolvedValueOnce(mockFetchResponse({ id: 'new-pod' }));

      await client.createInstance(baseSpec, creds);

      // calls[0] = preflight GraphQL, calls[1] = POST /pods
      const call = fetchSpy.mock.calls[1];
      const body = JSON.parse(call[1].body);
      expect(body.gpuTypeIds).toEqual([RUNPOD_GPU_FALLBACK[0]]);
    });

    it('maps short GPU names to full RunPod names', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockPreflight())
        .mockResolvedValueOnce(mockFetchResponse({ id: 'new-pod' }));

      await client.createInstance({ gpuTypes: ['RTX 3090'], dockerImage: 'test/image:latest' }, creds);

      const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(body.gpuTypeIds).toEqual(['NVIDIA GeForce RTX 3090']);
    });

    it('falls back to next GPU on "no instances" error', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockPreflight())                                    // preflight
        .mockResolvedValueOnce(mockFetchText('no instances available', 400))        // RTX 4090 → error
        .mockResolvedValueOnce(mockFetchResponse({ id: 'pod-fallback' }))           // RTX A5000 → success
        .mockResolvedValueOnce(mockFetchResponse({ machine: { id: 'machine-1' }, runtime: null })); // ghost check

      const result = await client.createInstance(
        { gpuTypes: ['RTX 4090', 'RTX A5000'], dockerImage: 'test/image:latest' },
        creds,
      );

      expect(result.instanceId).toBe('pod-fallback');
      expect(fetchSpy).toHaveBeenCalledTimes(4); // preflight + create×2 + ghost-check×1
    });

    it('throws when all GPU types exhausted', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockPreflight())
        .mockResolvedValue(mockFetchText('no instances', 400));

      await expect(
        client.createInstance({ gpuTypes: ['RTX 4090'], dockerImage: 'test/image:latest' }, creds),
      ).rejects.toThrow('No GPU types available on RunPod');
    });

    it('calls onInstancePersist when userId provided', async () => {
      const onPersist = vi.fn().mockResolvedValue(undefined);
      const clientWithPersist = new RunpodClient({ onInstancePersist: onPersist });
      vi.stubGlobal('fetch', fetchSpy);
      fetchSpy
        .mockResolvedValueOnce(mockPreflight())
        .mockResolvedValueOnce(mockFetchResponse({ id: 'pod-persist' }));

      await clientWithPersist.createInstance(baseSpec, creds, 'user-1');

      expect(onPersist).toHaveBeenCalledWith('user-1', 'runpodPod', expect.objectContaining({
        podId: 'pod-persist',
        status: 'CREATING',
      }));
    });

    it('storageGb=0 skips volume and dockerStartCmd', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockPreflight())
        .mockResolvedValueOnce(mockFetchResponse({ id: 'light-pod' }));

      await client.createInstance({ gpuTypes: ['RTX 4090'], storageGb: 0, dockerImage: 'test/image:latest' }, creds);

      // calls[0] = preflight, calls[1] = POST /pods
      const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(body.volumeInGb).toBe(0);
      expect(body.volumeMountPath).toBeUndefined();
      expect(body.dockerStartCmd).toBeUndefined();
      expect(body.containerDiskInGb).toBeGreaterThanOrEqual(10);
    });

    it('storageGb>0 adds volume and mounts at /workspace', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockPreflight())
        .mockResolvedValueOnce(mockFetchResponse({ id: 'full-pod' }));

      await client.createInstance({ gpuTypes: ['RTX 4090'], storageGb: 50, dockerImage: 'test/image:latest' }, creds);

      const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(body.volumeInGb).toBeGreaterThanOrEqual(50);
      expect(body.volumeMountPath).toBe('/workspace');
      expect(body.containerDiskInGb).toBeGreaterThanOrEqual(50);
    });

    it('injects HF_TOKEN from credentials', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockPreflight())
        .mockResolvedValueOnce(mockFetchResponse({ id: 'hf-pod' }));

      await client.createInstance(baseSpec, credsWithHf);

      const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(body.env.HF_TOKEN).toBe('hf_test_token');
    });

    it('injects spec.env overrides', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockPreflight())
        .mockResolvedValueOnce(mockFetchResponse({ id: 'env-pod' }));

      await client.createInstance(
        { gpuTypes: ['RTX 4090'], env: { CUSTOM_VAR: 'custom_val' }, dockerImage: 'test/image:latest' },
        creds,
      );

      const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(body.env.CUSTOM_VAR).toBe('custom_val');
    });

    it('uses correct ports: 8000/http + 22/tcp', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockPreflight())
        .mockResolvedValueOnce(mockFetchResponse({ id: 'port-pod' }));

      await client.createInstance(baseSpec, creds);

      const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(body.ports).toContain('8000/http');
      expect(body.ports).toContain('22/tcp');
    });
  });

  // ── start/stop/deleteInstance ──────────────────────────────────────────

  describe('startInstance', () => {
    it('POSTs to start endpoint', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));
      await client.startInstance('pod-1', creds);
      expect(fetchSpy).toHaveBeenCalledWith(
        `${API_BASE}/pods/pod-1/start`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('throws on error', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchText('Server Error', 500));
      await expect(client.startInstance('pod-1', creds)).rejects.toThrow('RunPod start failed: HTTP 500');
    });
  });

  describe('stopInstance', () => {
    it('POSTs to stop endpoint', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));
      await client.stopInstance('pod-1', creds);
      expect(fetchSpy).toHaveBeenCalledWith(
        `${API_BASE}/pods/pod-1/stop`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('throws on error', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchText('Not Found', 404));
      await expect(client.stopInstance('pod-1', creds)).rejects.toThrow('RunPod stop failed: HTTP 404');
    });
  });

  describe('deleteInstance', () => {
    it('DELETEs the pod', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));
      await client.deleteInstance('pod-1', creds);
      expect(fetchSpy).toHaveBeenCalledWith(
        `${API_BASE}/pods/pod-1`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('throws on error', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchText('Forbidden', 403));
      await expect(client.deleteInstance('pod-1', creds)).rejects.toThrow('RunPod delete failed: HTTP 403');
    });
  });

  // ── listInstances ─────────────────────────────────────────────────────

  describe('listInstances', () => {
    it('parses pods with resolved endpoints', async () => {
      const pods = [
        { id: 'pod-a', name: 'my-pod', desiredStatus: 'RUNNING', gpuDisplayName: 'RTX 4090' },
        { id: 'pod-b', desiredStatus: 'STOPPED' },
      ];
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(pods));

      const result = await client.listInstances(creds);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        instanceId: 'pod-a',
        instanceName: 'my-pod',
        endpoint: 'https://pod-a-8000.proxy.runpod.net',
        status: 'RUNNING',
        gpuType: 'RTX 4090',
      });
      expect(result[1].status).toBe('STOPPED');
    });

    it('returns empty array on HTTP error', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchText('Unauthorized', 401));
      expect(await client.listInstances(creds)).toEqual([]);
    });

    it('returns empty array on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      expect(await client.listInstances(creds)).toEqual([]);
    });
  });

  // ── getInstanceStatus ─────────────────────────────────────────────────

  describe('getInstanceStatus', () => {
    it('returns desiredStatus', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ desiredStatus: 'RUNNING' }));
      expect(await client.getInstanceStatus('pod-1', creds)).toBe('RUNNING');
    });

    it('returns null on 404', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 404 }));
      expect(await client.getInstanceStatus('pod-1', creds)).toBeNull();
    });

    it('returns null on error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('timeout'));
      expect(await client.getInstanceStatus('pod-1', creds)).toBeNull();
    });
  });

  // ── resolveInstanceEndpoint ───────────────────────────────────────────

  describe('resolveInstanceEndpoint', () => {
    it('re-resolves endpoint from pod data', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({
        id: 'pod-1',
        publicIp: '10.0.0.1',
        portMappings: { '8000': 38000 },
      }));
      expect(await client.resolveInstanceEndpoint!('pod-1', creds)).toBe('http://10.0.0.1:38000');
    });

    it('returns null on error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('fail'));
      expect(await client.resolveInstanceEndpoint!('pod-1', creds)).toBeNull();
    });
  });
});
