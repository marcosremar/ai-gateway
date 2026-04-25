/**
 * SnapgpuClient unit tests — verifies the wrapper logic that sits between
 * the ai-gateway autoscaler and the underlying GPU providers (Vast/RunPod).
 *
 * These tests use mocked fetch and registry stubs — no real API calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SnapgpuClient, DEFAULT_SNAPGPU_IMAGE } from '../../src/gpu-providers/snapgpu-client';
import { GpuProviderRegistry } from '../../src/gpu-providers/registry';
import { AbstractGpuProvider } from '../../src/gpu-providers/abstract-provider';
import type { GpuInstance, InstanceSpec, ProviderCredentials } from '../../src/gpu-providers/types';

// ── Stubs ───────────────────────────────────────────────────────────────────

function mockResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Minimal mock backend that records calls. */
function createMockBackend(providerId: 'vast' | 'runpod' = 'vast') {
  const created: GpuInstance = {
    instanceId: 'inst-123',
    endpoint: 'http://10.0.0.1:8000',
    status: 'creating',
    gpuType: 'RTX 4090',
    providerMeta: { provider: providerId },
  };
  return {
    providerId,
    bootTimeSecs: 600,
    createInstance: vi.fn().mockResolvedValue(created),
    startInstance: vi.fn().mockResolvedValue(undefined),
    stopInstance: vi.fn().mockResolvedValue(undefined),
    deleteInstance: vi.fn().mockResolvedValue(undefined),
    getInstanceStatus: vi.fn().mockResolvedValue('RUNNING'),
    listInstances: vi.fn().mockResolvedValue([created]),
    discoverInstance: vi.fn().mockResolvedValue(null),
    resolveInstanceEndpoint: vi.fn().mockResolvedValue('http://10.0.0.1:8000'),
    preflight: vi.fn().mockResolvedValue({ canDeploy: true, blockReason: null, balance: 50 }),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

let fetchSpy: ReturnType<typeof vi.fn>;
let registry: GpuProviderRegistry;
let vastMock: ReturnType<typeof createMockBackend>;

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue(mockResp({ credit: 100 }));
  vi.stubGlobal('fetch', fetchSpy);
  vi.spyOn(AbstractGpuProvider, 'estimateImageDiskGb').mockResolvedValue(20);

  vastMock = createMockBackend('vast');
  registry = new GpuProviderRegistry();
  registry.register(vastMock as unknown as import('../../src/gpu-providers/types').GpuProviderClient);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SnapgpuClient', () => {
  describe('createInstance', () => {
    it('forces the snapgpu-runtime image on the underlying backend', async () => {
      const client = new SnapgpuClient({ registry, defaultBackend: 'vast' });

      await client.createInstance(
        { gpuTypes: ['RTX 4090'] },
        { apiKey: 'test-key' },
      );

      expect(vastMock.createInstance).toHaveBeenCalledOnce();
      const passedSpec = vastMock.createInstance.mock.calls[0][0] as InstanceSpec;
      expect(passedSpec.dockerImage).toBe(DEFAULT_SNAPGPU_IMAGE);
      expect(passedSpec.env?.SNAPGPU_PORT).toBe('8000');
    });

    it('uses spec.dockerImage when explicitly set (child image)', async () => {
      const client = new SnapgpuClient({ registry, defaultBackend: 'vast' });

      await client.createInstance(
        { gpuTypes: ['RTX 4090'], dockerImage: 'marcosremar/snapgpu-runtime-babelcast:latest' },
        { apiKey: 'test-key' },
      );

      const passedSpec = vastMock.createInstance.mock.calls[0][0] as InstanceSpec;
      expect(passedSpec.dockerImage).toBe('marcosremar/snapgpu-runtime-babelcast:latest');
    });

    it('injects SNAPGPU_PRELOAD_APP when snapgpuPreloadApp is set', async () => {
      const client = new SnapgpuClient({ registry, defaultBackend: 'vast' });

      await client.createInstance(
        { gpuTypes: ['RTX 4090'], snapgpuPreloadApp: 'babelcast' },
        { apiKey: 'test-key' },
      );

      const passedSpec = vastMock.createInstance.mock.calls[0][0] as InstanceSpec;
      expect(passedSpec.env?.SNAPGPU_PRELOAD_APP).toBe('babelcast');
    });

    it('injects SNAPGPU_RESTORE_SNAPSHOT_ID when set', async () => {
      const client = new SnapgpuClient({ registry, defaultBackend: 'vast' });

      await client.createInstance(
        { gpuTypes: ['RTX 4090'], snapgpuRestoreFromSnapshot: 'snap-abc123' },
        { apiKey: 'test-key' },
      );

      const passedSpec = vastMock.createInstance.mock.calls[0][0] as InstanceSpec;
      expect(passedSpec.env?.SNAPGPU_RESTORE_SNAPSHOT_ID).toBe('snap-abc123');
    });

    it('adds port 8000/http if not present in ports', async () => {
      const client = new SnapgpuClient({ registry, defaultBackend: 'vast' });

      await client.createInstance(
        { gpuTypes: ['RTX 4090'], ports: ['22/tcp'] },
        { apiKey: 'test-key' },
      );

      const passedSpec = vastMock.createInstance.mock.calls[0][0] as InstanceSpec;
      expect(passedSpec.ports).toContain('8000/http');
      expect(passedSpec.ports).toContain('22/tcp');
    });

    it('returns providerMeta with provider=snapgpu', async () => {
      const client = new SnapgpuClient({ registry, defaultBackend: 'vast' });

      const result = await client.createInstance(
        { gpuTypes: ['RTX 4090'] },
        { apiKey: 'test-key' },
      );

      expect(result.providerMeta?.provider).toBe('snapgpu');
      expect((result.providerMeta as any).backendProvider).toBe('vast');
    });

    it('throws when backend is not registered', async () => {
      const emptyRegistry = new GpuProviderRegistry();
      const client = new SnapgpuClient({ registry: emptyRegistry, defaultBackend: 'vast' });

      await expect(
        client.createInstance({ gpuTypes: ['RTX 4090'] }, { apiKey: 'k' }),
      ).rejects.toThrow('not registered');
    });
  });

  describe('preflight', () => {
    it('delegates to the default backend', async () => {
      const client = new SnapgpuClient({ registry, defaultBackend: 'vast' });

      const result = await client.preflight({ apiKey: 'test-key' });

      expect(vastMock.preflight).toHaveBeenCalled();
      expect(result?.canDeploy).toBe(true);
    });

    it('returns null when backend is not registered', async () => {
      const emptyRegistry = new GpuProviderRegistry();
      const client = new SnapgpuClient({ registry: emptyRegistry, defaultBackend: 'vast' });

      const result = await client.preflight({ apiKey: 'test-key' });
      expect(result).toBeNull();
    });
  });

  describe('snapshot operations', () => {
    it('createSnapshot POSTs to the gateway /v1/snapshots', async () => {
      const client = new SnapgpuClient({ registry, defaultBackend: 'vast' });
      fetchSpy.mockResolvedValueOnce(mockResp({ snapshot_id: 'snap-abc123' }));

      const id = await client.createSnapshot('http://10.0.0.1:8000', 'babelcast');

      expect(id).toBe('snap-abc123');
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://10.0.0.1:8000/v1/snapshots',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('listSnapshots GETs from /v1/snapshots', async () => {
      const client = new SnapgpuClient({ registry, defaultBackend: 'vast' });
      fetchSpy.mockResolvedValueOnce(mockResp({
        snapshots: [{ snapshot_id: 'snap-1', app_name: 'test', size_bytes: 1024, gpu_memory_included: true }],
      }));

      const snaps = await client.listSnapshots('http://10.0.0.1:8000');

      expect(snaps.length).toBe(1);
      expect(snaps[0].snapshot_id).toBe('snap-1');
    });

    it('restoreSnapshot POSTs to /v1/snapshots/:id/restore', async () => {
      const client = new SnapgpuClient({ registry, defaultBackend: 'vast' });
      fetchSpy.mockResolvedValueOnce(mockResp({ success: true, restored_pid: 42 }));

      const ok = await client.restoreSnapshot('http://10.0.0.1:8000', 'snap-abc123');

      expect(ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://10.0.0.1:8000/v1/snapshots/snap-abc123/restore',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('deleteSnapshot DELETEs /v1/snapshots/:id', async () => {
      const client = new SnapgpuClient({ registry, defaultBackend: 'vast' });
      fetchSpy.mockResolvedValueOnce(mockResp({ deleted: true }));

      const ok = await client.deleteSnapshot('http://10.0.0.1:8000', 'snap-abc123');

      expect(ok).toBe(true);
    });

    it('createSnapshot returns null when gateway reports no CRIU', async () => {
      const client = new SnapgpuClient({ registry, defaultBackend: 'vast' });
      fetchSpy.mockResolvedValueOnce(mockResp({ error: 'CRIU not available' }, 200));

      const id = await client.createSnapshot('http://10.0.0.1:8000', 'babelcast');
      expect(id).toBeNull();
    });

    it('createSnapshot returns null on network error (graceful degradation)', async () => {
      const client = new SnapgpuClient({ registry, defaultBackend: 'vast' });
      fetchSpy.mockRejectedValueOnce(new Error('Connection refused'));

      const id = await client.createSnapshot('http://10.0.0.1:8000', 'babelcast');
      expect(id).toBeNull();
    });
  });

  describe('probeSnapgpuReady', () => {
    it('reports CRIU + cuda-checkpoint readiness', async () => {
      const client = new SnapgpuClient({ registry, defaultBackend: 'vast' });
      fetchSpy.mockResolvedValueOnce(mockResp({
        status: 'ok', criu: true, cuda_checkpoint: true,
      }));

      const result = await client.probeSnapgpuReady('http://10.0.0.1:8000');

      expect(result.reachable).toBe(true);
      expect(result.criuReady).toBe(true);
      expect(result.cudaCheckpointReady).toBe(true);
    });

    it('returns all false on network error', async () => {
      const client = new SnapgpuClient({ registry, defaultBackend: 'vast' });
      fetchSpy.mockRejectedValueOnce(new Error('timeout'));

      const result = await client.probeSnapgpuReady('http://10.0.0.1:8000');

      expect(result.reachable).toBe(false);
      expect(result.criuReady).toBe(false);
    });
  });
});
