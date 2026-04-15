/**
 * GPU Handlers Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  GPU_VRAM_GB,
  estimateModelVramGb,
  gpuTypesWithSufficientVram,
  validateVramForModel,
} from '../../server/handlers/gpu/vram';

import {
  generateDeployId,
  sanitizeGpuTypes,
  estimateDeployCost,
} from '../../server/handlers/gpu/deploy-utils';

describe('GPU VRAM Module', () => {
  describe('GPU_VRAM_GB constants', () => {
    it('should have RTX 4090 with 24GB', () => {
      expect(GPU_VRAM_GB['NVIDIA GeForce RTX 4090']).toBe(24);
    });

    it('should have A100 with 80GB', () => {
      expect(GPU_VRAM_GB['NVIDIA A100 80GB PCIe']).toBe(80);
    });

    it('should have H200 with 141GB', () => {
      expect(GPU_VRAM_GB['NVIDIA H200']).toBe(141);
    });
  });

  describe('estimateModelVramGb', () => {
    it('should estimate 70B model VRAM', () => {
      const result = estimateModelVramGb('llama-70b', '', {}, '');
      expect(result.vramGb).toBeGreaterThan(0);
      expect(result.hint).toContain('70B');
    });

    it('should estimate 7B model VRAM', () => {
      const result = estimateModelVramGb('llama-7b', '', {}, '');
      expect(result.vramGb).toBeGreaterThan(0);
      expect(result.hint).toContain('7B');
    });

    it('should detect quantization', () => {
      const q4 = estimateModelVramGb('llama-7b-q4', '', {}, '');
      const q8 = estimateModelVramGb('llama-7b-q8', '', {}, '');
      expect(q4.vramGb).toBeLessThan(q8.vramGb);
    });

    it('should handle long context', () => {
      const normal = estimateModelVramGb('llama-7b', '', {}, '');
      const longContext = estimateModelVramGb('llama-7b-32k', '', {}, '');
      expect(longContext.vramGb).toBeGreaterThan(normal.vramGb);
    });

    it('should return 0 for unknown model', () => {
      const result = estimateModelVramGb('unknown', '', {}, '');
      expect(result.vramGb).toBe(0);
      expect(result.hint).toBe('');
    });
  });

  describe('gpuTypesWithSufficientVram', () => {
    it('should filter GPUs with enough VRAM', () => {
      const gpuTypes = [
        'NVIDIA GeForce RTX 4090',
        'NVIDIA RTX A5000',
        'NVIDIA T4',
      ];
      const result = gpuTypesWithSufficientVram(gpuTypes, 20);
      expect(result).toContain('NVIDIA GeForce RTX 4090');
      expect(result).toContain('NVIDIA RTX A5000');
      expect(result).not.toContain('NVIDIA T4');
    });

    it('should reject unknown GPU types', () => {
      const gpuTypes = ['NVIDIA GeForce RTX 4090', 'Unknown GPU'];
      const result = gpuTypesWithSufficientVram(gpuTypes, 20);
      expect(result).toContain('NVIDIA GeForce RTX 4090');
      expect(result).not.toContain('Unknown GPU');
    });
  });

  describe('validateVramForModel', () => {
    it('should validate sufficient VRAM', () => {
      const gpuTypes = ['NVIDIA GeForce RTX 4090', 'NVIDIA RTX A6000'];
      const result = validateVramForModel(gpuTypes, 20, 'Test model');
      expect(result.valid).toBe(true);
      expect(result.sufficient.length).toBeGreaterThan(0);
    });

    it('should fail validation for insufficient VRAM', () => {
      const gpuTypes = ['NVIDIA T4'];
      const result = validateVramForModel(gpuTypes, 40, 'Large model');
      expect(result.valid).toBe(false);
      expect(result.message).toContain('40GB');
    });

    it('should report insufficient GPUs', () => {
      const gpuTypes = ['NVIDIA GeForce RTX 4090', 'NVIDIA T4'];
      const result = validateVramForModel(gpuTypes, 20, 'Test');
      expect(result.valid).toBe(true);
      expect(result.insufficient.length).toBe(1);
      expect(result.insufficient[0].gpu).toBe('NVIDIA T4');
    });
  });
});

describe('GPU Deploy Utils', () => {
  describe('generateDeployId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateDeployId();
      const id2 = generateDeployId();
      expect(id1).not.toBe(id2);
      expect(id1).toContain('deploy-');
    });

    it('should include timestamp', () => {
      const id = generateDeployId();
      const timestamp = parseInt(id.split('-')[1]);
      expect(timestamp).toBeGreaterThan(0);
      expect(timestamp).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('sanitizeGpuTypes', () => {
    it('should handle string input', () => {
      const result = sanitizeGpuTypes('RTX 4090, RTX A6000');
      expect(result).toEqual(['RTX 4090', 'RTX A6000']);
    });

    it('should handle array input', () => {
      const result = sanitizeGpuTypes(['RTX 4090', 'RTX A6000']);
      expect(result).toEqual(['RTX 4090', 'RTX A6000']);
    });

    it('should handle null/undefined', () => {
      const result = sanitizeGpuTypes(null);
      expect(result).toEqual(['NVIDIA GeForce RTX 4090']);
    });

    it('should filter empty strings', () => {
      const result = sanitizeGpuTypes(['RTX 4090', '', 'RTX A6000']);
      expect(result).toEqual(['RTX 4090', 'RTX A6000']);
    });
  });

  describe('estimateDeployCost', () => {
    it('should calculate cost for RTX 4090', () => {
      const cost = estimateDeployCost('NVIDIA GeForce RTX 4090', 'runpod', 1);
      expect(cost).toBeGreaterThan(0);
    });

    it('should calculate cost for multiple hours', () => {
      const cost1 = estimateDeployCost('NVIDIA GeForce RTX 4090', 'runpod', 1);
      const cost2 = estimateDeployCost('NVIDIA GeForce RTX 4090', 'runpod', 2);
      expect(cost2).toBe(cost1 * 2);
    });

    it('should use default price for unknown GPU', () => {
      const cost = estimateDeployCost('Unknown GPU', 'runpod', 1);
      expect(cost).toBeGreaterThan(0);
    });
  });
});
