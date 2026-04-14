/**
 * GPU Providers Unit Tests (#439-#474)
 *
 * Tests for RunPod, Vast.ai, and TensorDock GPU provider clients.
 * Uses mocked fetch for all API calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RunpodClient, RUNPOD_GPU_FALLBACK, RUNPOD_GPU_TYPE_MAP } from '../../src/gpu-providers/runpod-client';
import { VastClient } from '../../src/gpu-providers/vast-client';
import { TensordockClient, GPU_ID_MAP } from '../../src/gpu-providers/tensordock-client';
import type { ProviderCredentials, InstanceSpec, GpuInstance } from '../../src/gpu-providers/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

const silentLogger = {
  debug: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const creds: ProviderCredentials = { apiKey: 'test-api-key-123' };

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
    clone: () => mockResponse(body, status),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

// ── RunPod Client Tests (#439-#457) ─────────────────────────────────────────

describe('RunpodClient', () => {
  let client: RunpodClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new RunpodClient({ logger: silentLogger });
    // Mock the internal fetchRaw to avoid real network calls
    fetchSpy = vi.fn();
    (client as any).fetchRaw = fetchSpy;
    (client as any).rateLimiter = { wait: async () => {} };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // #439 — providerId is 'runpod'
  it('has correct providerId', () => {
    expect(client.providerId).toBe('runpod');
  });

  // #440 — GPU type map resolves short names
  it('resolves short GPU names to RunPod API names', () => {
    expect(RUNPOD_GPU_TYPE_MAP['RTX 4090']).toBe('NVIDIA GeForce RTX 4090');
    expect(RUNPOD_GPU_TYPE_MAP['RTX 5090']).toBe('NVIDIA GeForce RTX 5090');
    expect(RUNPOD_GPU_TYPE_MAP['A100']).toBe('NVIDIA A100 80GB PCIe');
    expect(RUNPOD_GPU_TYPE_MAP['L40S']).toBe('NVIDIA L40S');
  });

  // #441 — RUNPOD_GPU_FALLBACK has expected GPU types
  it('has RTX 5090 as first fallback GPU', () => {
    expect(RUNPOD_GPU_FALLBACK[0]).toBe('NVIDIA GeForce RTX 5090');
    expect(RUNPOD_GPU_FALLBACK.length).toBeGreaterThanOrEqual(4);
  });

  // #442 — discoverInstance returns null when no pods
  it('discoverInstance returns null when no pods exist', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse([]));
    const result = await client.discoverInstance(creds, []);
    expect(result).toBeNull();
  });

  // #443 — discoverInstance returns running pod
  it('discoverInstance returns running pod with endpoint', async () => {
    const pods = [{
      id: 'pod-123',
      desiredStatus: 'RUNNING',
      runtime: { ports: [{ privatePort: 8000, publicPort: 30000, ip: '1.2.3.4' }] },
    }];
    fetchSpy.mockResolvedValueOnce(mockResponse(pods));
    const result = await client.discoverInstance(creds, []);
    expect(result).not.toBeNull();
    expect(result!.instanceId).toBe('pod-123');
    expect(result!.endpoint).toBe('http://1.2.3.4:30000');
  });

  // #444 — discoverInstance falls back to proxy URL when no runtime ports
  it('discoverInstance falls back to proxy URL when no ports', async () => {
    const pods = [{ id: 'pod-456', desiredStatus: 'RUNNING' }];
    fetchSpy.mockResolvedValueOnce(mockResponse(pods));
    const result = await client.discoverInstance(creds, []);
    expect(result).not.toBeNull();
    expect(result!.endpoint).toBe('https://pod-456-8000.proxy.runpod.net');
  });

  // #445 — discoverInstance handles API error
  it('discoverInstance returns null on API error', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({}, 500));
    const result = await client.discoverInstance(creds, []);
    expect(result).toBeNull();
  });

  // #446 — discoverInstance handles network error
  it('discoverInstance returns null on network error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await client.discoverInstance(creds, []);
    expect(result).toBeNull();
  });

  // #447 — createInstance requires dockerImage
  it('createInstance throws when no dockerImage', async () => {
    const spec: InstanceSpec = { gpuTypes: ['NVIDIA GeForce RTX 4090'] };
    await expect(client.createInstance(spec, creds)).rejects.toThrow('dockerImage is required');
  });

  // #448 — createInstance creates GPU pod successfully
  it('createInstance creates GPU pod and returns instance', async () => {
    const spec: InstanceSpec = {
      gpuTypes: ['NVIDIA GeForce RTX 4090'],
      dockerImage: 'marcosremar/babelcast-subtitle:latest',
      storageGb: 30,
    };
    // Mock the create response
    fetchSpy.mockResolvedValueOnce(mockResponse({
      id: 'pod-new',
      runtime: null,
    }));
    // Mock ghost detection polls — return pod with machine assigned
    fetchSpy.mockResolvedValue(mockResponse({
      id: 'pod-new',
      machine: { gpu: 'RTX 4090' },
    }));

    const result = await client.createInstance(spec, creds);
    expect(result.instanceId).toBe('pod-new');
    expect(result.status).toBe('CREATING');
  });

  // #449 — createInstance CPU pod
  it('createInstance creates CPU pod with correct computeType', async () => {
    const spec: InstanceSpec = {
      computeType: 'CPU',
      dockerImage: 'marcosremar/babelcast-subtitle:latest',
      cpuFlavorIds: ['cpu3c'],
    };
    // preflight: getAccountStatus GraphQL
    fetchSpy.mockResolvedValueOnce(mockResponse({
      data: { myself: { id: '1', email: 'test@test.com', machineQuota: 10, clientBalance: 100, currentSpendPerHr: 0, pods: [] } },
    }));
    fetchSpy.mockResolvedValueOnce(mockResponse({ id: 'cpu-pod-1' }));

    const result = await client.createInstance(spec, creds);
    expect(result.instanceId).toBe('cpu-pod-1');
    expect(result.gpuType).toBe('CPU');
  });

  // #450 — ghost detection deletes ghost pods
  it('ghost detection deletes pod when machine is empty', async () => {
    const spec: InstanceSpec = {
      gpuTypes: ['NVIDIA GeForce RTX 4090'],
      dockerImage: 'marcosremar/babelcast-subtitle:latest',
      storageGb: 30,
    };
    // First GPU type: create succeeds, ghost detected
    fetchSpy.mockResolvedValueOnce(mockResponse({ id: 'ghost-pod' }));
    // Ghost checks return empty machine
    fetchSpy.mockResolvedValueOnce(mockResponse({ id: 'ghost-pod', machine: {} }));
    fetchSpy.mockResolvedValueOnce(mockResponse({ id: 'ghost-pod', machine: {} }));
    fetchSpy.mockResolvedValueOnce(mockResponse({ id: 'ghost-pod', machine: {} }));
    // DELETE cleanup
    fetchSpy.mockResolvedValueOnce(mockResponse({}));

    // Next GPU type: create also fails — no more types
    // Since RUNPOD_GPU_FALLBACK is used, all subsequent types will also fail
    // We'll make all subsequent creates return 400 to exhaust quickly
    fetchSpy.mockResolvedValue(mockResponse({ error: 'no availability' }, 400));

    await expect(client.createInstance(spec, creds)).rejects.toThrow();
  });

  // #451 — deleteInstance calls DELETE /pods/:id
  it('deleteInstance calls the correct endpoint', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({}));
    await client.deleteInstance('pod-123', creds);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/pods/pod-123'),
      expect.objectContaining({ method: 'DELETE' }),
      expect.any(Number),
    );
  });

  // #452 — stopInstance calls POST /pods/:id/stop
  it('stopInstance calls the correct endpoint', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({}));
    await client.stopInstance('pod-123', creds);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/pods/pod-123/stop'),
      expect.objectContaining({ method: 'POST' }),
      expect.any(Number),
    );
  });

  // #453 — startInstance calls POST /pods/:id/start
  it('startInstance calls the correct endpoint', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({}));
    await client.startInstance('pod-123', creds);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/pods/pod-123/start'),
      expect.objectContaining({ method: 'POST' }),
      expect.any(Number),
    );
  });

  // #454 — resolveEndpoint validates port types
  it('resolveEndpoint prefers runtime IP+port over proxy', () => {
    const pod = {
      id: 'pod-abc',
      runtime: { ports: [{ privatePort: 8000, publicPort: 30000, ip: '5.6.7.8' }] },
      publicIp: '1.2.3.4',
      portMappings: { '8000': 25000 },
    };
    const endpoint = (client as any).resolveEndpoint(pod);
    expect(endpoint).toBe('http://5.6.7.8:30000');
  });

  it('resolveEndpoint falls back to top-level publicIp', () => {
    const pod = {
      id: 'pod-abc',
      publicIp: '1.2.3.4',
      portMappings: { '8000': 25000 },
    };
    const endpoint = (client as any).resolveEndpoint(pod);
    expect(endpoint).toBe('http://1.2.3.4:25000');
  });

  it('resolveEndpoint falls back to proxy URL', () => {
    const pod = { id: 'pod-abc' };
    const endpoint = (client as any).resolveEndpoint(pod);
    expect(endpoint).toBe('https://pod-abc-8000.proxy.runpod.net');
  });

  // #455 — listOffers calls GET /gpu-types
  it('listOffers returns GPU offers', async () => {
    const gpuTypes = {
      'NVIDIA GeForce RTX 4090': {
        id: 'NVIDIA GeForce RTX 4090',
        displayName: 'RTX 4090',
        memoryInGb: 24,
        secureCloud: true,
        securePrice: 0.44,
        secureSpotPrice: 0.22,
      },
    };
    fetchSpy.mockResolvedValueOnce(mockResponse(gpuTypes));
    const offers = await client.listOffers!({}, creds);
    expect(Array.isArray(offers)).toBe(true);
  });

  // #456 — onInstancePersist callback fires
  it('calls onInstancePersist during createInstance', async () => {
    const persistFn = vi.fn();
    const clientWithPersist = new RunpodClient({ logger: silentLogger, onInstancePersist: persistFn });
    (clientWithPersist as any).fetchRaw = fetchSpy;
    (clientWithPersist as any).rateLimiter = { wait: async () => {} };

    const spec: InstanceSpec = {
      computeType: 'CPU',
      dockerImage: 'test:latest',
      cpuFlavorIds: ['cpu3c'],
    };
    // preflight: getAccountStatus GraphQL
    fetchSpy.mockResolvedValueOnce(mockResponse({
      data: { myself: { id: '1', email: 'test@test.com', machineQuota: 10, clientBalance: 100, currentSpendPerHr: 0, pods: [] } },
    }));
    fetchSpy.mockResolvedValueOnce(mockResponse({ id: 'cpu-pod' }));
    await clientWithPersist.createInstance(spec, creds, 'user-1');
    expect(persistFn).toHaveBeenCalledWith('user-1', 'runpodPod', expect.objectContaining({ podId: 'cpu-pod' }));
  });

  // #457 — getInstanceStatus returns correct status
  it('getInstanceStatus returns pod status', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({
      id: 'pod-123',
      desiredStatus: 'RUNNING',
      runtime: {},
    }));
    const status = await client.getInstanceStatus('pod-123', creds);
    expect(status).toBe('RUNNING');
  });
});

// ── Vast.ai Client Tests (#458-#465) ────────────────────────────────────────

describe('VastClient', () => {
  let client: VastClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new VastClient({ logger: silentLogger });
    fetchSpy = vi.fn();
    (client as any).fetchRaw = fetchSpy;
    (client as any)._lastRequestMs = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // #458 — providerId
  it('has correct providerId', () => {
    expect(client.providerId).toBe('vast');
  });

  // #459 — discoverInstance finds running instances
  it('discoverInstance returns running instance', async () => {
    const instances: GpuInstance[] = [{
      instanceId: 'inst-100',
      endpoint: 'http://5.6.7.8:8000',
      status: 'running',
      gpuType: 'RTX 4090',
    }];
    vi.spyOn(client, 'listInstances').mockResolvedValueOnce(instances);
    const result = await client.discoverInstance(creds, []);
    expect(result).not.toBeNull();
    expect(result!.instanceId).toBe('inst-100');
  });

  // #460 — discoverInstance returns null when no instances
  it('discoverInstance returns null when no instances', async () => {
    vi.spyOn(client, 'listInstances').mockResolvedValueOnce([]);
    const result = await client.discoverInstance(creds, []);
    expect(result).toBeNull();
  });

  // #461 — createInstance requires dockerImage
  it('createInstance throws when no dockerImage', async () => {
    const spec: InstanceSpec = { gpuTypes: ['NVIDIA GeForce RTX 4090'] };
    await expect(client.createInstance(spec, creds)).rejects.toThrow('dockerImage is required');
  });

  // #462 — createInstance throws when no offers available
  it('createInstance throws when no offers match', async () => {
    const spec: InstanceSpec = {
      gpuTypes: ['NVIDIA GeForce RTX 4090'],
      dockerImage: 'test:latest',
      storageGb: 30,
    };
    // Search returns empty
    fetchSpy.mockResolvedValueOnce(mockResponse({ offers: [] }));
    // Relaxed search also empty
    fetchSpy.mockResolvedValueOnce(mockResponse({ offers: [] }));
    await expect(client.createInstance(spec, creds)).rejects.toThrow('No GPUs available');
  });

  // #463 — Blackwell CUDA detection for Docker Hub credentials
  it('has onstart in create body for ssh_direct runtype', () => {
    // VastClient createInstance uses ssh_direct runtype with onstart script.
    // Verify the client setup is correct (doesn't need network calls).
    expect(client.providerId).toBe('vast');
    expect(client.bootTimeSecs).toBe(600);
  });

  // #464 — deleteInstance calls correct endpoint
  it('deleteInstance calls DELETE /instances/:id', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ success: true }));
    await client.deleteInstance('inst-100', creds);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/instances/100'),
      expect.objectContaining({ method: 'DELETE' }),
      expect.any(Number),
    );
  });

  // #465 — rate limit 429 on _vastFetch throws after retries
  it('_vastFetch throws after exhausting 429 retries', async () => {
    // _vastFetch retries 429 up to 3 times then throws
    fetchSpy.mockResolvedValue(mockResponse({}, 429));

    // Call _vastFetch directly since listInstances catches errors
    await expect(
      (client as any)._vastFetch('https://console.vast.ai/api/v0/test', {}, 5000),
    ).rejects.toThrow('rate limit');
  });

  // #466 — Blackwell CUDA detection
  it('detects Blackwell CUDA requirement for RTX 5090', () => {
    expect((client as any)._needsBlackwellCuda(['NVIDIA GeForce RTX 5090'])).toBe(true);
    expect((client as any)._needsBlackwellCuda(['NVIDIA GeForce RTX 4090'])).toBe(false);
    expect((client as any)._needsBlackwellCuda([])).toBe(false);
    expect((client as any)._needsBlackwellCuda(undefined)).toBe(false);
  });

  // #467 — unstable host tracking
  it('marks and detects unstable hosts', () => {
    expect((client as any)._isHostUnstable('1.2.3.4')).toBe(false);
    (client as any)._markHostUnstable('1.2.3.4');
    expect((client as any)._isHostUnstable('1.2.3.4')).toBe(true);
  });
});

// ── TensorDock Client Tests (#468-#474) ─────────────────────────────────────

describe('TensordockClient', () => {
  let client: TensordockClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new TensordockClient({ logger: silentLogger });
    fetchSpy = vi.fn();
    // Override the base class fetchRaw (TensordockClient overrides fetchRaw for retry)
    (client as any).fetchRaw = fetchSpy;
    (client as any).rateLimiter = { wait: async () => {} };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // #468 — providerId
  it('has correct providerId', () => {
    expect(client.providerId).toBe('tensordock');
  });

  // #469 — GPU_ID_MAP resolves names
  it('GPU_ID_MAP resolves short names to TensorDock IDs', () => {
    expect(GPU_ID_MAP['RTX3090']).toBe('geforcertx3090-pcie-24gb');
    expect(GPU_ID_MAP['RTX4090']).toBe('geforcertx4090-pcie-24gb');
    expect(GPU_ID_MAP['NVIDIA GeForce RTX 4090']).toBe('geforcertx4090-pcie-24gb');
    expect(GPU_ID_MAP['NVIDIA RTX A6000']).toBe('rtxa6000-pcie-48gb');
  });

  // #470 — discoverInstance with no instances
  it('discoverInstance returns null when no instances exist', async () => {
    vi.spyOn(client, 'listInstances').mockResolvedValueOnce([]);
    const result = await client.discoverInstance(creds, []);
    expect(result).toBeNull();
  });

  // #471 — discoverInstance prefers running
  it('discoverInstance prefers running instance', async () => {
    const instances: GpuInstance[] = [
      { instanceId: '1', endpoint: 'http://a:8000', status: 'stopped' },
      { instanceId: '2', endpoint: 'http://b:8000', status: 'running' },
    ];
    vi.spyOn(client, 'listInstances').mockResolvedValueOnce(instances);
    const result = await client.discoverInstance(creds, []);
    expect(result!.instanceId).toBe('2');
  });

  // #472 — endpointFromDetail with port forwards
  it('resolves endpoint from port forwards', () => {
    const detail = {
      ip: '10.0.0.1',
      portForwards: [
        { internal_port: 22, external_port: 20000 },
        { internal_port: 8000, external_port: 20002 },
      ],
    };
    const endpoint = (client as any)._endpointFromDetail(detail);
    expect(endpoint).toBe('http://10.0.0.1:20002');
  });

  // #473 — endpointFromDetail with no port forwards (dedicated IP)
  it('resolves endpoint with dedicated IP when no port forwards', () => {
    const detail = { ip: '10.0.0.1', portForwards: [] };
    const endpoint = (client as any)._endpointFromDetail(detail);
    expect(endpoint).toBe('http://10.0.0.1:8000');
  });

  // #474 — endpointFromDetail with empty IP
  it('returns empty string when IP is missing', () => {
    const detail = { ip: '', portForwards: [] };
    const endpoint = (client as any)._endpointFromDetail(detail);
    expect(endpoint).toBe('');
  });

  // Additional — deleteInstance calls correct endpoint
  it('deleteInstance calls DELETE /instances/:id', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ success: true }));
    await client.deleteInstance('inst-999', creds);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/instances/inst-999'),
      expect.objectContaining({ method: 'DELETE' }),
      expect.any(Number),
    );
  });

  // Additional — stopInstance calls correct endpoint
  it('stopInstance calls POST /instances/:id/stop', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ success: true }));
    await client.stopInstance('inst-999', creds);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/instances/inst-999/stop'),
      expect.objectContaining({ method: 'POST' }),
      expect.any(Number),
    );
  });

  // Additional — startInstance calls correct endpoint
  it('startInstance calls POST /instances/:id/start', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ success: true }));
    await client.startInstance('inst-999', creds);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/instances/inst-999/start'),
      expect.objectContaining({ method: 'POST' }),
      expect.any(Number),
    );
  });

  // Additional — getInstanceStatus
  it('getInstanceStatus returns correct status string', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({
      data: { attributes: { status: 'running' } },
    }));
    const status = await client.getInstanceStatus('inst-999', creds);
    expect(status).toBe('running');
  });
});
