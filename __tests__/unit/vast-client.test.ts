/**
 * Vast Client Module Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VastInstance, VastOffer, VastTemplate, VastCredentials } from '../../src/gateway/providers/gpu/vast/types';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock('../../src/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  calculateOfferScore,
  formatInstanceStatus,
  isTerminalStatus,
  isRunningStatus,
} from '../../src/gateway/providers/gpu/vast/utils';

import {
  listInstances,
  getInstance,
  createInstance,
  destroyInstance,
  stopInstance,
  startInstance,
} from '../../src/gateway/providers/gpu/vast/instances';

import {
  searchOffers,
  getBestOffer,
} from '../../src/gateway/providers/gpu/vast/offers';

const mockCredentials: VastCredentials = { apiKey: 'test-api-key' };

describe('Vast Utils', () => {
  describe('calculateOfferScore', () => {
    it('should calculate score correctly', () => {
      const offer = {
        dph_total: 0.5,
        reliability: 0.95,
        dlperf: 100,
        inet_up: 1000,
        inet_down: 1000,
      };
      
      const score = calculateOfferScore(offer);
      expect(score).toBeGreaterThan(0);
    });

    it('should handle zero price', () => {
      const offer = {
        dph_total: 0,
        reliability: 0.95,
        dlperf: 100,
        inet_up: 1000,
        inet_down: 1000,
      };
      
      const score = calculateOfferScore(offer);
      // When price is 0, priceScore is 0 but other factors still contribute
      // reliability: 0.95 * 100 = 95, dlperf: 100, bandwidth: 2000/100 = 20
      // Total: 0*0.3 + 95*0.3 + 100*0.2 + 20*0.2 = 0 + 28.5 + 20 + 4 = 52.5
      expect(score).toBe(52.5);
    });
  });

  describe('formatInstanceStatus', () => {
    it('should map known statuses', () => {
      expect(formatInstanceStatus('running')).toBe('running');
      expect(formatInstanceStatus('created')).toBe('creating');
      expect(formatInstanceStatus('loading')).toBe('loading');
    });

    it('should lowercase unknown statuses', () => {
      expect(formatInstanceStatus('UNKNOWN')).toBe('unknown');
    });
  });

  describe('isTerminalStatus', () => {
    it('should identify terminal statuses', () => {
      expect(isTerminalStatus('terminated')).toBe(true);
      expect(isTerminalStatus('error')).toBe(true);
      expect(isTerminalStatus('stopped')).toBe(true);
    });

    it('should identify non-terminal statuses', () => {
      expect(isTerminalStatus('running')).toBe(false);
      expect(isTerminalStatus('creating')).toBe(false);
    });
  });

  describe('isRunningStatus', () => {
    it('should identify running status', () => {
      expect(isRunningStatus('running')).toBe(true);
    });

    it('should identify non-running statuses', () => {
      expect(isRunningStatus('stopped')).toBe(false);
      expect(isRunningStatus('creating')).toBe(false);
    });
  });
});

describe('Vast Instances', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listInstances', () => {
    it('should return list of instances', async () => {
      const mockInstances: VastInstance[] = [
        {
          id: '1',
          machine_id: 123,
          actual_status: 'running',
          desired_status: 'running',
          cur_state: 'running',
          int_state: 'running',
          image_uuid: 'test',
          image_args: [],
          env: {},
          price_hr: 0.5,
          disk_space: 10,
          storage: 10,
          cpu_cores: 4,
          cpu_ram: 16384,
          gpu_name: 'RTX 4090',
          gpu_ram: 24576,
          dlperf: 100,
          inet_up: 1000,
          inet_down: 1000,
          direct_port_count: 1,
          credit_discount: 0,
          dph_total: 0.5,
          dph_base: 0.4,
          dph_packing: 0,
          dph_machine: 0.1,
          inet_up_cost: 0,
          inet_down_cost: 0,
          storage_cost: 0,
          gpu_cost: 0.4,
          cpu_cost: 0,
          ram_cost: 0,
          start_date: new Date().toISOString(),
          duration: 3600,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ instances: mockInstances }),
      } as Response);

      const instances = await listInstances(mockCredentials);
      expect(instances).toHaveLength(1);
      expect(instances[0].id).toBe('1');
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Server error',
      } as Response);

      await expect(listInstances(mockCredentials)).rejects.toThrow();
    });
  });

  describe('getInstance', () => {
    it('should return instance details', async () => {
      const mockInstance: VastInstance = {
        id: '1',
        machine_id: 123,
        actual_status: 'running',
        desired_status: 'running',
        cur_state: 'running',
        int_state: 'running',
        image_uuid: 'test',
        image_args: [],
        env: {},
        price_hr: 0.5,
        disk_space: 10,
        storage: 10,
        cpu_cores: 4,
        cpu_ram: 16384,
        gpu_name: 'RTX 4090',
        gpu_ram: 24576,
        dlperf: 100,
        inet_up: 1000,
        inet_down: 1000,
        direct_port_count: 1,
        credit_discount: 0,
        dph_total: 0.5,
        dph_base: 0.4,
        dph_packing: 0,
        dph_machine: 0.1,
        inet_up_cost: 0,
        inet_down_cost: 0,
        storage_cost: 0,
        gpu_cost: 0.4,
        cpu_cost: 0,
        ram_cost: 0,
        start_date: new Date().toISOString(),
        duration: 3600,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ instance: mockInstance }),
      } as Response);

      const instance = await getInstance('1', mockCredentials);
      expect(instance).not.toBeNull();
      expect(instance?.id).toBe('1');
    });

    it('should return null on error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response);

      const instance = await getInstance('999', mockCredentials);
      expect(instance).toBeNull();
    });
  });

  describe('createInstance', () => {
    it('should create instance successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          instance: { id: 123 },
        }),
      } as Response);

      const result = await createInstance(
        456,
        { image: 'test-image', disk: 20 },
        mockCredentials
      );

      expect(result.success).toBe(true);
      expect(result.id).toBe('123');
    });

    it('should handle creation failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: false,
          error: 'Insufficient funds',
        }),
      } as Response);

      const result = await createInstance(
        456,
        { image: 'test-image' },
        mockCredentials
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Insufficient funds');
    });
  });

  describe('destroyInstance', () => {
    it('should destroy instance successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as Response);

      const result = await destroyInstance('1', mockCredentials);
      expect(result).toBe(true);
    });

    it('should return false on error', async () => {
      // Mock fetch to throw an error
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await destroyInstance('1', mockCredentials);
      expect(result).toBe(false);
    });
  });

  describe('stopInstance', () => {
    it('should stop instance successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as Response);

      const result = await stopInstance('1', mockCredentials);
      expect(result).toBe(true);
    });
  });

  describe('startInstance', () => {
    it('should start instance successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as Response);

      const result = await startInstance('1', mockCredentials);
      expect(result).toBe(true);
    });
  });
});

describe('Vast Offers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('searchOffers', () => {
    it('should return offers', async () => {
      const mockOffers: VastOffer[] = [
        {
          id: 1,
          machine_id: 100,
          machine_name: 'Test Machine',
          verified: true,
          dph_total: 0.5,
          dph_base: 0.4,
          dph_packing: 0,
          dph_machine: 0.1,
          inet_up: 1000,
          inet_down: 1000,
          cpu_cores: 4,
          cpu_ram: 16384,
          disk_space: 100,
          gpu_name: 'RTX 4090',
          gpu_ram: 24576,
          reliability: 0.95,
          dlperf: 100,
          num_gpus: 1,
          gpu_frac: 1,
          cuda_max_good: 12,
          direct_port_count: 1,
          direct_port_price: 0,
          storage_cost: 0,
          public_ipaddr: '1.2.3.4',
          flops_per_dphtotal: 100,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ offers: mockOffers }),
      } as Response);

      const offers = await searchOffers({}, mockCredentials);
      expect(offers).toHaveLength(1);
      expect(offers[0].gpu_name).toBe('RTX 4090');
    });

    it('should apply filters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ offers: [] }),
      } as Response);

      await searchOffers(
        {
          gpuName: 'RTX 4090',
          maxPrice: 1.0,
          verifiedOnly: true,
        },
        mockCredentials
      );

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('gpu_name=RTX+4090'),
        expect.any(Object)
      );
    });
  });

  describe('getBestOffer', () => {
    it('should return best offer', async () => {
      const mockOffers: VastOffer[] = [
        {
          id: 1,
          machine_id: 100,
          machine_name: 'Test Machine',
          verified: true,
          dph_total: 0.5,
          dph_base: 0.4,
          dph_packing: 0,
          dph_machine: 0.1,
          inet_up: 1000,
          inet_down: 1000,
          cpu_cores: 4,
          cpu_ram: 16384,
          disk_space: 100,
          gpu_name: 'RTX 4090',
          gpu_ram: 24576,
          reliability: 0.95,
          dlperf: 100,
          num_gpus: 1,
          gpu_frac: 1,
          cuda_max_good: 12,
          direct_port_count: 1,
          direct_port_price: 0,
          storage_cost: 0,
          public_ipaddr: '1.2.3.4',
          flops_per_dphtotal: 100,
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ offers: mockOffers }),
      } as Response);

      const offer = await getBestOffer('RTX 4090', mockCredentials);
      expect(offer).not.toBeNull();
      expect(offer?.id).toBe(1);
    });

    it('should return null when no offers found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ offers: [] }),
      } as Response);

      const offer = await getBestOffer('NonExistent', mockCredentials);
      expect(offer).toBeNull();
    });
  });
});
