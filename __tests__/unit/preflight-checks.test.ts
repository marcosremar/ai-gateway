/**
 * Tests for pre-flight checks module.
 */

import { describe, it, expect, vi } from 'vitest';
import { runPreFlightChecks } from '../../src/preflight-checks';

describe('PreFlightChecks', () => {
  it('should check image existence for Docker Hub images', async () => {
    const result = await runPreFlightChecks({
      imageName: 'marcosremar/babelcast-subtitle:latest',
      provider: 'vast',
      apiKey: 'test-key',
      gpuTypes: ['NVIDIA GeForce RTX 4090'],
    });

    expect(result.checks.find(c => c.name === 'image_exists')).toBeDefined();
  });

  it('should detect CUDA version from image name', async () => {
    const result = await runPreFlightChecks({
      imageName: 'my-llm:cuda12.4',
      provider: 'vast',
      apiKey: 'test-key',
      gpuTypes: ['NVIDIA GeForce RTX 4090'],
    });

    const cudaCheck = result.checks.find(c => c.name === 'cuda_compatibility');
    expect(cudaCheck).toBeDefined();
    expect(cudaCheck?.passed).toBe(true);
  });

  it('should warn about Blackwell CUDA requirements', async () => {
    const result = await runPreFlightChecks({
      imageName: 'my-llm:cuda12.8',
      provider: 'vast',
      apiKey: 'test-key',
      gpuTypes: ['NVIDIA GeForce RTX 5090'],
    });

    const cudaCheck = result.checks.find(c => c.name === 'cuda_compatibility');
    expect(cudaCheck?.warning).toContain('570');
  });

  it('should validate DNS resolution', async () => {
    const result = await runPreFlightChecks({
      imageName: 'my-llm:latest',
      provider: 'vast',
      apiKey: 'test-key',
      gpuTypes: ['NVIDIA GeForce RTX 4090'],
    });

    const dnsCheck = result.checks.find(c => c.name === 'dns_resolution');
    expect(dnsCheck).toBeDefined();
  });

  it('should validate cost', async () => {
    const result = await runPreFlightChecks({
      imageName: 'my-llm:latest',
      provider: 'vast',
      apiKey: 'test-key',
      gpuTypes: ['NVIDIA GeForce RTX 4090'],
      quotedPricePerHr: 0.44,
    });

    const costCheck = result.checks.find(c => c.name === 'cost_validation');
    expect(costCheck?.passed).toBe(true);
  });

  it('should reject unreasonable prices', async () => {
    const result = await runPreFlightChecks({
      imageName: 'my-llm:latest',
      provider: 'vast',
      apiKey: 'test-key',
      gpuTypes: ['NVIDIA GeForce RTX 4090'],
      quotedPricePerHr: 10.0,
    });

    const costCheck = result.checks.find(c => c.name === 'cost_validation');
    expect(costCheck?.passed).toBe(false);
    expect(costCheck?.error).toContain('maximum reasonable price');
  });

  it('should warn about HEALTHCHECK risk on Vast.ai', async () => {
    const result = await runPreFlightChecks({
      imageName: 'tensorflow/gpu:latest',
      provider: 'vast',
      apiKey: 'test-key',
      gpuTypes: ['NVIDIA GeForce RTX 4090'],
    });

    const healthCheck = result.checks.find(c => c.name === 'healthcheck_risk');
    expect(healthCheck?.warning).toContain('HEALTHCHECK');
  });

  it('should not warn about HEALTHCHECK for non-Vast providers', async () => {
    const result = await runPreFlightChecks({
      imageName: 'tensorflow/gpu:latest',
      provider: 'runpod',
      apiKey: 'test-key',
      gpuTypes: ['NVIDIA GeForce RTX 4090'],
    });

    const healthCheck = result.checks.find(c => c.name === 'healthcheck_risk');
    expect(healthCheck?.warning).toBeUndefined();
  });

  it('should return ok=true when all checks pass', async () => {
    const result = await runPreFlightChecks({
      imageName: 'marcosremar/babelcast-subtitle:latest',
      provider: 'vast',
      apiKey: 'test-key',
      gpuTypes: ['NVIDIA GeForce RTX 4090'],
    });

    expect(result.ok).toBe(true);
    expect(result.checks.length).toBe(7);
  });

  it('should include warnings in result', async () => {
    const result = await runPreFlightChecks({
      imageName: 'my-unknown-image:cuda99.0',
      provider: 'vast',
      apiKey: 'test-key',
      gpuTypes: ['NVIDIA GeForce RTX 4090'],
    });

    expect(result.warnings.length).toBeGreaterThan(0);
  });

  // ── Provider-specific tests ─────────────────────────────────────────────────

  it('should run pre-flight checks for RunPod', async () => {
    const result = await runPreFlightChecks({
      imageName: 'marcosremar/babelcast-subtitle:latest',
      provider: 'runpod',
      apiKey: 'test-runpod-key',
      gpuTypes: ['NVIDIA A100'],
      quotedPricePerHr: 1.50,
    });

    expect(result.checks.length).toBe(7);
    const dnsCheck = result.checks.find(c => c.name === 'dns_resolution');
    expect(dnsCheck).toBeDefined();
    // RunPod DNS endpoint should be resolvable
    expect(dnsCheck?.error).toBeUndefined();
  });

  it('should run pre-flight checks for TensorDock', async () => {
    const result = await runPreFlightChecks({
      imageName: 'marcosremar/babelcast-subtitle:latest',
      provider: 'tensordock',
      apiKey: 'test-tensordock-key',
      gpuTypes: ['NVIDIA RTX 4090'],
      quotedPricePerHr: 0.80,
    });

    expect(result.checks.length).toBe(7);
    const dnsCheck = result.checks.find(c => c.name === 'dns_resolution');
    expect(dnsCheck).toBeDefined();
    // TensorDock DNS endpoint should be resolvable
    expect(dnsCheck?.error).toBeUndefined();
  });

  it('should run pre-flight checks for Modal', async () => {
    const result = await runPreFlightChecks({
      imageName: 'marcosremar/babelcast-subtitle:latest',
      provider: 'modal',
      apiKey: 'test-modal-key',
      gpuTypes: ['NVIDIA A100'],
      quotedPricePerHr: 2.00,
    });

    expect(result.checks.length).toBe(7);
    const dnsCheck = result.checks.find(c => c.name === 'dns_resolution');
    expect(dnsCheck).toBeDefined();
    // Modal DNS endpoint should be resolvable
    expect(dnsCheck?.error).toBeUndefined();
  });

  it('should warn about unknown provider DNS', async () => {
    const result = await runPreFlightChecks({
      imageName: 'my-llm:latest',
      provider: 'unknown-provider',
      apiKey: 'test-key',
      gpuTypes: ['NVIDIA RTX 4090'],
    });

    const dnsCheck = result.checks.find(c => c.name === 'dns_resolution');
    expect(dnsCheck?.warning).toContain('Unknown provider');
  });

  it('should warn about unreasonable cost for any provider', async () => {
    const providers = ['runpod', 'tensordock', 'modal'] as const;
    for (const provider of providers) {
      const result = await runPreFlightChecks({
        imageName: 'my-llm:latest',
        provider,
        apiKey: 'test-key',
        gpuTypes: ['NVIDIA RTX 4090'],
        quotedPricePerHr: 10.0,
      });

      const costCheck = result.checks.find(c => c.name === 'cost_validation');
      expect(costCheck?.passed).toBe(false);
      expect(costCheck?.error).toContain('maximum reasonable price');
    }
  });
});
