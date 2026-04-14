/**
 * Tests for auto-remediation system.
 *
 * Verifies that specific error categories receive appropriate
 * automatic remediation suggestions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tryAutoRemediation } from '../../src/auto-remediation';
import { DeployError, categorizeDeployError } from '../../src/errors/deploy-errors';

// Mock gpu-compat module
vi.mock('../../src/gpu-compat', () => ({
  getCompatibleGpus: vi.fn(),
  analyzeDockerImage: vi.fn(),
}));

// Import the mocked module
import { getCompatibleGpus } from '../../src/gpu-compat';

const mockedGetCompatibleGpus = vi.mocked(getCompatibleGpus);

describe('tryAutoRemediation — OOM', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should suggest larger GPUs when available for RES_CUDA_OOM', async () => {
    mockedGetCompatibleGpus.mockReturnValue([
      'NVIDIA A100-SXM4-80GB',
      'NVIDIA H100 80GB HBM3',
      'NVIDIA L40S',
    ]);

    const err = categorizeDeployError(new Error('CUDA out of memory: 22GB/24GB'));
    const result = await tryAutoRemediation(err);

    expect(result).not.toBeNull();
    expect(result!.action).toBe('Suggest larger GPUs');
    expect(result!.success).toBe(true);
    expect(result!.suggestions).toHaveLength(1);
    expect(result!.suggestions[0]).toContain('Try these GPUs with more VRAM');
  });

  it('should suggest larger GPUs for RES_VRAM_INSUFFICIENT', async () => {
    mockedGetCompatibleGpus.mockReturnValue([
      'NVIDIA A100-SXM4-80GB',
      'NVIDIA H200',
    ]);

    const err = categorizeDeployError(new Error('Insufficient VRAM: 40GB needed, 24GB available'));
    const result = await tryAutoRemediation(err);

    expect(result).not.toBeNull();
    expect(result!.action).toBe('Suggest larger GPUs');
    expect(result!.success).toBe(true);
  });

  it('should provide fallback suggestions when no larger GPUs available', async () => {
    mockedGetCompatibleGpus.mockReturnValue([]);

    const err = categorizeDeployError(new Error('CUDA out of memory: 22GB/24GB'));
    const result = await tryAutoRemediation(err);

    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.suggestions).toContain('Use a quantized model (Q4 instead of FP16)');
    expect(result!.suggestions).toContain('Reduce context length');
    expect(result!.suggestions).toContain('Use CPU offloading');
  });

  it('should limit suggestions to top 3 GPUs', async () => {
    mockedGetCompatibleGpus.mockReturnValue([
      'NVIDIA T4',
      'NVIDIA L4',
      'NVIDIA A10G',
      'NVIDIA RTX A4000',
      'NVIDIA RTX A5000',
      'NVIDIA A100 40GB PCIe',
      'NVIDIA A100-SXM4-80GB',
    ]);

    const err = categorizeDeployError(new Error('CUDA out of memory'));
    const result = await tryAutoRemediation(err);

    expect(result).not.toBeNull();
    expect(result!.suggestions).toHaveLength(1);
    // Should only mention first 3 GPUs
    const suggestionText = result!.suggestions[0];
    const gpuCount = suggestionText.split(',').length;
    expect(gpuCount).toBeLessThanOrEqual(3);
  });
});

describe('tryAutoRemediation — Docker Hub Rate Limit', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env
    process.env = { ...originalEnv };
    delete process.env.DOCKERHUB_USERNAME;
    delete process.env.DOCKERHUB_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should suggest Docker Hub authentication when not authenticated', async () => {
    // Create error with status 429 to trigger NET_DOCKER_HUB_RATE_LIMIT
    const errObj = new Error('Docker Hub rate limit exceeded') as any;
    errObj.status = 429;
    const err = categorizeDeployError(errObj);
    expect(err.code).toBe('NET_DOCKER_HUB_RATE_LIMIT');

    const result = await tryAutoRemediation(err);

    expect(result).not.toBeNull();
    expect(result!.action).toBe('Suggest Docker Hub authentication');
    expect(result!.success).toBe(true);
    expect(result!.suggestions).toContain(
      'Set DOCKERHUB_USERNAME and DOCKERHUB_TOKEN to increase limit to 200 pulls/6h',
    );
    expect(result!.suggestions).toContain(
      'Use a mirror registry (ghcr.io, quay.io)',
    );
  });

  it('should indicate already authenticated when credentials are set', async () => {
    process.env.DOCKERHUB_USERNAME = 'testuser';
    process.env.DOCKERHUB_TOKEN = 'testtoken';

    // Create error with status 429 to trigger NET_DOCKER_HUB_RATE_LIMIT
    const errObj = new Error('Docker Hub rate limit exceeded') as any;
    errObj.status = 429;
    const err = categorizeDeployError(errObj);

    const result = await tryAutoRemediation(err);

    expect(result).not.toBeNull();
    expect(result!.action).toContain('authenticated');
    expect(result!.success).toBe(true);
  });
});

describe('tryAutoRemediation — Healthcheck Fail', () => {
  it('should suggest removing or extending HEALTHCHECK', async () => {
    const err = categorizeDeployError(new Error('Container health check failed'));
    const result = await tryAutoRemediation(err);

    expect(result).not.toBeNull();
    expect(result!.action).toBe('Suggest removing or extending HEALTHCHECK');
    expect(result!.success).toBe(true);
    expect(result!.suggestions).toContain('Add --start-period=600s to HEALTHCHECK in Dockerfile');
    expect(result!.suggestions).toContain('Remove HEALTHCHECK entirely if model loading takes >5 min');
    expect(result!.suggestions).toContain('Use a lighter health check endpoint (/ping instead of /health)');
  });
});

describe('tryAutoRemediation — Credit Zero', () => {
  it('should block deploy and suggest adding credits', async () => {
    const err = categorizeDeployError(new Error('Account credit balance is zero'));
    const result = await tryAutoRemediation(err);

    expect(result).not.toBeNull();
    expect(result!.action).toBe('Block deploy — account credits exhausted');
    expect(result!.success).toBe(false);
    expect(result!.suggestions).toContain('Add credits to your Vast.ai account before deploying');
    expect(result!.suggestions).toContain('Use a different provider (RunPod, TensorDock, Modal)');
  });
});

describe('tryAutoRemediation — GPU Mismatch', () => {
  it('should suggest compatible GPUs for GPU_DRIVER_MISMATCH', async () => {
    // Use exact pattern that categorizeDeployError recognizes
    const err = categorizeDeployError(new Error('Failed to initialize NVML: Driver/library version mismatch'));
    const result = await tryAutoRemediation(err);

    expect(result).not.toBeNull();
    expect(result!.action).toBe('Suggest compatible GPUs');
    expect(result!.success).toBe(true);
    expect(result!.reason).toContain('NVIDIA driver version incompatible');
    expect(result!.suggestions).toContain('Use an image built for older CUDA version');
    expect(result!.suggestions).toContain('Choose a GPU host with newer NVIDIA drivers');
    expect(result!.suggestions).toContain('Rebuild Docker image with --build-arg CUDA_VERSION=12.0');
  });

  it('should suggest compatible GPUs for GPU_CUDA_MISMATCH', async () => {
    const err = categorizeDeployError(new Error('CUDA version mismatch: image requires CUDA 12.8'));
    const result = await tryAutoRemediation(err);

    expect(result).not.toBeNull();
    expect(result!.action).toBe('Suggest compatible GPUs');
    expect(result!.success).toBe(true);
    expect(result!.reason).toContain('CUDA version mismatch');
  });
});

describe('tryAutoRemediation — Default (no remediation)', () => {
  it('should return null for errors without auto-remediation', async () => {
    // Test various error codes that should not have auto-remediation
    const errorMessages = [
      'Invalid input: bad format',
      'DNS resolution failed',
      'Connection refused',
      'Provider API error',
      'Budget exceeded',
      'Host lost power',
    ];

    for (const msg of errorMessages) {
      const err = categorizeDeployError(new Error(msg));
      const result = await tryAutoRemediation(err);
      expect(result).toBeNull();
    }
  });

  it('should return null for VLD_PREFLIGHT_FAILED', async () => {
    const err = categorizeDeployError(new Error('Pre-flight checks failed'));
    const result = await tryAutoRemediation(err);
    expect(result).toBeNull();
  });

  it('should return null for RES_DISK_FULL', async () => {
    const err = categorizeDeployError(new Error('Disk full: no space left on device'));
    const result = await tryAutoRemediation(err);
    expect(result).toBeNull();
  });
});

describe('RemediationAction interface', () => {
  it('should have all required fields', async () => {
    mockedGetCompatibleGpus.mockReturnValue(['NVIDIA A100-SXM4-80GB']);

    const err = categorizeDeployError(new Error('CUDA out of memory'));
    const result = await tryAutoRemediation(err);

    expect(result).toHaveProperty('action');
    expect(result).toHaveProperty('reason');
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('suggestions');
    expect(Array.isArray(result!.suggestions)).toBe(true);
  });
});
