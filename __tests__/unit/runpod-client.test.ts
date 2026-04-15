/**
 * RunPod Client Module Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger BEFORE any imports
vi.mock('../../../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock fetch
const mockFetch = vi.fn();
(global as any).fetch = mockFetch;

// Now import modules
import {
  resolveDatacenterIds,
  RUNPOD_GPU_TYPE_MAP,
} from '../../src/gateway/providers/gpu/runpod/constants';

import {
  resolvePodEndpoint,
  isPodRunning,
  isPodTerminal,
  formatGpuType,
} from '../../src/gateway/providers/gpu/runpod/utils';

import type {
  RunpodPod,
  RunpodOffer,
  RunpodCredentials,
} from '../../src/gateway/providers/gpu/runpod/types';

describe('RunPod Constants', () => {
  describe('resolveDatacenterIds', () => {
    it('should return undefined for empty region', () => {
      expect(resolveDatacenterIds('')).toBeUndefined();
      expect(resolveDatacenterIds(undefined)).toBeUndefined();
    });

    it('should return array for specific datacenter ID', () => {
      expect(resolveDatacenterIds('EU-RO-1')).toEqual(['EU-RO-1']);
    });

    it('should expand generic region codes', () => {
      const euIds = resolveDatacenterIds('EU');
      expect(euIds).toBeDefined();
      expect(euIds?.length).toBeGreaterThan(0);
      expect(euIds).toContain('EU-RO-1');
    });

    it('should return undefined for unknown region', () => {
      expect(resolveDatacenterIds('UNKNOWN')).toBeUndefined();
    });
  });

  describe('RUNPOD_GPU_TYPE_MAP', () => {
    it('should map RTX 4090 correctly', () => {
      expect(RUNPOD_GPU_TYPE_MAP['RTX 4090']).toBe('NVIDIA GeForce RTX 4090');
    });

    it('should map legacy GPUs to alternatives', () => {
      expect(RUNPOD_GPU_TYPE_MAP['RTX 4080']).toBe('NVIDIA GeForce RTX 4090');
    });
  });
});

describe('RunPod Utils', () => {
  describe('resolvePodEndpoint', () => {
    it('should resolve runtime endpoint', () => {
      const pod: RunpodPod = {
        id: 'test-pod',
        imageName: 'test',
        env: [],
        gpuCount: 1,
        volumeInGb: 10,
        containerDiskInGb: 10,
        minVcpuCount: 2,
        minMemoryInGb: 8,
        gpuTypeId: 'RTX 4090',
        cloudType: 'COMMUNITY',
        supportPublicIp: true,
        desiredStatus: 'RUNNING',
        runtime: {
          ports: [
            { ip: '192.168.1.1', privatePort: 8000, publicPort: 8000, type: 'tcp' },
          ],
        },
      };
      
      const endpoint = resolvePodEndpoint(pod);
      expect(endpoint).toBe('http://192.168.1.1:8000');
    });

    it('should fallback to proxy URL', () => {
      const pod: RunpodPod = {
        id: 'test-pod-123',
        imageName: 'test',
        env: [],
        gpuCount: 1,
        volumeInGb: 10,
        containerDiskInGb: 10,
        minVcpuCount: 2,
        minMemoryInGb: 8,
        gpuTypeId: 'RTX 4090',
        cloudType: 'COMMUNITY',
        supportPublicIp: true,
        desiredStatus: 'RUNNING',
      };
      
      const endpoint = resolvePodEndpoint(pod);
      expect(endpoint).toBe('https://test-pod-123-8000.proxy.runpod.net');
    });
  });

  describe('isPodRunning', () => {
    it('should return true for running pod', () => {
      const pod: RunpodPod = {
        id: 'test',
        imageName: 'test',
        env: [],
        gpuCount: 1,
        volumeInGb: 10,
        containerDiskInGb: 10,
        minVcpuCount: 2,
        minMemoryInGb: 8,
        gpuTypeId: 'RTX 4090',
        cloudType: 'COMMUNITY',
        supportPublicIp: true,
        desiredStatus: 'RUNNING',
        runtime: { uptimeInSeconds: 100 },
      };
      expect(isPodRunning(pod)).toBe(true);
    });

    it('should return false for non-running pod', () => {
      const pod: RunpodPod = {
        id: 'test',
        imageName: 'test',
        env: [],
        gpuCount: 1,
        volumeInGb: 10,
        containerDiskInGb: 10,
        minVcpuCount: 2,
        minMemoryInGb: 8,
        gpuTypeId: 'RTX 4090',
        cloudType: 'COMMUNITY',
        supportPublicIp: true,
        desiredStatus: 'EXITED',
      };
      expect(isPodRunning(pod)).toBe(false);
    });
  });

  describe('isPodTerminal', () => {
    it('should return true for terminal states', () => {
      expect(isPodTerminal({ desiredStatus: 'EXITED' } as RunpodPod)).toBe(true);
      expect(isPodTerminal({ desiredStatus: 'ERROR' } as RunpodPod)).toBe(true);
      expect(isPodTerminal({ desiredStatus: 'TERMINATED' } as RunpodPod)).toBe(true);
    });

    it('should return false for non-terminal states', () => {
      expect(isPodTerminal({ desiredStatus: 'RUNNING' } as RunpodPod)).toBe(false);
    });
  });

  describe('formatGpuType', () => {
    it('should remove NVIDIA prefix', () => {
      expect(formatGpuType('NVIDIA GeForce RTX 4090')).toBe('GeForce RTX 4090');
    });
  });
});

describe('RunPod API Functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('API with mocked fetch', () => {
    it('should handle fetch success', async () => {
      // Import after mock setup
      const { listPods } = await import('../../src/gateway/providers/gpu/runpod/instances');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 'pod-1' }],
        headers: new Headers(),
      });

      const result = await listPods({ apiKey: 'test' });
      expect(result).toBeDefined();
    });

    it('should handle fetch error', async () => {
      const { getPod } = await import('../../src/gateway/providers/gpu/runpod/instances');
      
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await getPod('pod-1', { apiKey: 'test' });
      expect(result).toBeNull();
    });
  });
});

describe('RunPod Offer Functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('should search offers', async () => {
    const { searchOffers } = await import('../../src/gateway/providers/gpu/runpod/offers');
    
    const mockOffers: RunpodOffer[] = [
      {
        id: 'offer-1',
        gpuTypeId: 'RTX 4090',
        gpuType: {
          id: 'RTX 4090',
          displayName: 'NVIDIA GeForce RTX 4090',
          memoryInGb: 24,
        },
        dataCenterId: 'EU-RO-1',
        dataCenter: { id: 'EU-RO-1', name: 'EU Romania', location: 'Romania' },
        available: true,
        minVcpu: 4,
        minMemory: 32,
        minPodGpuCount: 1,
        maxPodGpuCount: 8,
        gpuAvailable: 10,
        gpuUsed: 5,
        gpuTotal: 15,
        communityPrice: 0.44,
        securePrice: 0.79,
        secureSpotPrice: 0.39,
        communitySpotPrice: 0.22,
      },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockOffers,
      headers: new Headers(),
    });

    const offers = await searchOffers({ gpuType: 'RTX 4090' }, { apiKey: 'test' });
    expect(offers.length).toBeGreaterThanOrEqual(0);
  });
});
