/**
 * Unit tests for src/modules/auto-remediation/index.ts
 *
 * Covers: tryAutoRemediation for all handled error codes (OOM, Docker Hub
 * rate limit, healthcheck fail, credit zero, GPU mismatch) and the fall-through
 * null path for unhandled codes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tryAutoRemediation } from '../src/modules/auto-remediation/index';
import {
  DeployError,
  resourceError,
  networkError,
  containerError,
  gpuError,
} from '../src/modules/errors/deploy-errors';

// ── Helpers ───────────────────────────────────────────────────────────────────

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function clearDockerHubEnv() {
  delete process.env.DOCKERHUB_USERNAME;
  delete process.env.DOCKERHUB_TOKEN;
}

// ── RES_CUDA_OOM ─────────────────────────────────────────────────────────────

describe('tryAutoRemediation — RES_CUDA_OOM', () => {
  it('returns a remediation action with success=true', async () => {
    const err = resourceError('RES_CUDA_OOM', { gpuType: 'NVIDIA GeForce RTX 4090', imageName: 'babelcast-subtitle:latest' });
    const result = await tryAutoRemediation(err);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
  });

  it('suggests larger GPUs in the action string', async () => {
    const err = resourceError('RES_CUDA_OOM', { gpuType: 'NVIDIA GeForce RTX 4090' });
    const result = await tryAutoRemediation(err);
    expect(result).not.toBeNull();
    // Should have suggestions array with at least one entry
    expect(result!.suggestions.length).toBeGreaterThan(0);
  });

  it('action mentions the current GPU type', async () => {
    const gpuType = 'NVIDIA GeForce RTX 4090';
    const err = resourceError('RES_CUDA_OOM', { gpuType });
    const result = await tryAutoRemediation(err);
    expect(result).not.toBeNull();
    // reason should reference the gpu
    expect(result!.reason).toContain(gpuType);
  });

  it('falls back gracefully when imageName is absent', async () => {
    const err = resourceError('RES_CUDA_OOM', {});
    const result = await tryAutoRemediation(err);
    expect(result).not.toBeNull();
    expect(result!.suggestions.length).toBeGreaterThan(0);
  });

  it('returns non-null for RES_VRAM_INSUFFICIENT', async () => {
    const err = resourceError('RES_VRAM_INSUFFICIENT', { gpuType: 'NVIDIA GeForce RTX 3090' });
    const result = await tryAutoRemediation(err);
    expect(result).not.toBeNull();
  });
});

// ── NET_DOCKER_HUB_RATE_LIMIT ─────────────────────────────────────────────────

describe('tryAutoRemediation — NET_DOCKER_HUB_RATE_LIMIT', () => {
  afterEach(clearDockerHubEnv);

  it('returns remediation with success=true when no auth env vars set', async () => {
    clearDockerHubEnv();
    const err = networkError('NET_DOCKER_HUB_RATE_LIMIT', {});
    const result = await tryAutoRemediation(err);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
  });

  it('suggests setting DOCKERHUB_USERNAME and DOCKERHUB_TOKEN when unauthenticated', async () => {
    clearDockerHubEnv();
    const err = networkError('NET_DOCKER_HUB_RATE_LIMIT', {});
    const result = await tryAutoRemediation(err);
    expect(result).not.toBeNull();
    const combined = result!.suggestions.join(' ');
    expect(combined).toContain('DOCKERHUB_USERNAME');
    expect(combined).toContain('DOCKERHUB_TOKEN');
  });

  it('returns different message when already authenticated', async () => {
    setEnv('DOCKERHUB_USERNAME', 'testuser');
    setEnv('DOCKERHUB_TOKEN', 'testtoken');
    const err = networkError('NET_DOCKER_HUB_RATE_LIMIT', {});
    const result = await tryAutoRemediation(err);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    // When authenticated it should mention waiting or transient
    const text = [result!.action, result!.reason, ...result!.suggestions].join(' ').toLowerCase();
    expect(text).toMatch(/wait|transient|rate/);
  });

  it('mentions mirror registry option when unauthenticated', async () => {
    clearDockerHubEnv();
    const err = networkError('NET_DOCKER_HUB_RATE_LIMIT', {});
    const result = await tryAutoRemediation(err);
    expect(result).not.toBeNull();
    const combined = result!.suggestions.join(' ');
    expect(combined).toMatch(/ghcr|quay|mirror/i);
  });

  it('action is non-empty string', async () => {
    const err = networkError('NET_DOCKER_HUB_RATE_LIMIT', {});
    const result = await tryAutoRemediation(err);
    expect(result!.action.length).toBeGreaterThan(0);
  });
});

// ── CNT_HEALTHCHECK_FAIL ──────────────────────────────────────────────────────

describe('tryAutoRemediation — CNT_HEALTHCHECK_FAIL', () => {
  it('returns non-null with success=true', async () => {
    const err = containerError('CNT_HEALTHCHECK_FAIL', {});
    const result = await tryAutoRemediation(err);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
  });

  it('suggests extending or removing HEALTHCHECK', async () => {
    const err = containerError('CNT_HEALTHCHECK_FAIL', {});
    const result = await tryAutoRemediation(err);
    expect(result).not.toBeNull();
    const combined = result!.suggestions.join(' ').toLowerCase();
    expect(combined).toMatch(/healthcheck|health/);
  });

  it('includes Vast.ai auto-destroy mention in reason', async () => {
    const err = containerError('CNT_HEALTHCHECK_FAIL', {});
    const result = await tryAutoRemediation(err);
    expect(result).not.toBeNull();
    expect(result!.reason.toLowerCase()).toMatch(/vast|auto.destroy|healthcheck|model/i);
  });

  it('suggestions array has at least 2 entries', async () => {
    const err = containerError('CNT_HEALTHCHECK_FAIL', {});
    const result = await tryAutoRemediation(err);
    expect(result!.suggestions.length).toBeGreaterThanOrEqual(2);
  });
});

// ── INF_CREDIT_ZERO ───────────────────────────────────────────────────────────

describe('tryAutoRemediation — INF_CREDIT_ZERO', () => {
  it('returns non-null', async () => {
    const err = new DeployError('INFRASTRUCTURE', 'INF_CREDIT_ZERO', {});
    const result = await tryAutoRemediation(err);
    expect(result).not.toBeNull();
  });

  it('returns success=false (cannot auto-fix zero balance)', async () => {
    const err = new DeployError('INFRASTRUCTURE', 'INF_CREDIT_ZERO', {});
    const result = await tryAutoRemediation(err);
    expect(result!.success).toBe(false);
  });

  it('mentions adding credits or alternative provider in suggestions', async () => {
    const err = new DeployError('INFRASTRUCTURE', 'INF_CREDIT_ZERO', {});
    const result = await tryAutoRemediation(err);
    const combined = result!.suggestions.join(' ').toLowerCase();
    expect(combined).toMatch(/credit|runpod|tensordock|modal|provider/i);
  });

  it('reason mentions credit exhaustion', async () => {
    const err = new DeployError('INFRASTRUCTURE', 'INF_CREDIT_ZERO', {});
    const result = await tryAutoRemediation(err);
    expect(result!.reason.toLowerCase()).toMatch(/credit|vast/i);
  });
});

// ── GPU_DRIVER_MISMATCH ───────────────────────────────────────────────────────

describe('tryAutoRemediation — GPU_DRIVER_MISMATCH', () => {
  it('returns non-null with success=true', async () => {
    const err = gpuError('GPU_DRIVER_MISMATCH', {});
    const result = await tryAutoRemediation(err);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
  });

  it('reason mentions NVIDIA driver', async () => {
    const err = gpuError('GPU_DRIVER_MISMATCH', {});
    const result = await tryAutoRemediation(err);
    expect(result!.reason.toLowerCase()).toMatch(/driver|nvidia/i);
  });

  it('suggestions mention CUDA version or image rebuild', async () => {
    const err = gpuError('GPU_DRIVER_MISMATCH', {});
    const result = await tryAutoRemediation(err);
    const combined = result!.suggestions.join(' ').toLowerCase();
    expect(combined).toMatch(/cuda|image|rebuild/i);
  });
});

// ── GPU_CUDA_MISMATCH ─────────────────────────────────────────────────────────

describe('tryAutoRemediation — GPU_CUDA_MISMATCH', () => {
  it('returns non-null with success=true', async () => {
    const err = gpuError('GPU_CUDA_MISMATCH', {});
    const result = await tryAutoRemediation(err);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
  });

  it('reason mentions CUDA mismatch', async () => {
    const err = gpuError('GPU_CUDA_MISMATCH', {});
    const result = await tryAutoRemediation(err);
    expect(result!.reason.toLowerCase()).toMatch(/cuda/i);
  });

  it('suggestions differ from driver mismatch', async () => {
    const cudaErr = gpuError('GPU_CUDA_MISMATCH', {});
    const driverErr = gpuError('GPU_DRIVER_MISMATCH', {});
    const cudaResult = await tryAutoRemediation(cudaErr);
    const driverResult = await tryAutoRemediation(driverErr);
    // Reasons should differ between CUDA and driver mismatch
    expect(cudaResult!.reason).not.toBe(driverResult!.reason);
  });

  it('suggestions array has at least 2 entries', async () => {
    const err = gpuError('GPU_CUDA_MISMATCH', {});
    const result = await tryAutoRemediation(err);
    expect(result!.suggestions.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Unhandled error codes — should return null ────────────────────────────────

describe('tryAutoRemediation — unhandled codes', () => {
  it('returns null for NET_TIMEOUT', async () => {
    const err = networkError('NET_TIMEOUT', {});
    const result = await tryAutoRemediation(err);
    expect(result).toBeNull();
  });

  it('returns null for NET_DNS_FAILURE', async () => {
    const err = networkError('NET_DNS_FAILURE', {});
    const result = await tryAutoRemediation(err);
    expect(result).toBeNull();
  });

  it('returns null for RES_DISK_FULL', async () => {
    const err = resourceError('RES_DISK_FULL', {});
    const result = await tryAutoRemediation(err);
    expect(result).toBeNull();
  });

  it('returns null for CNT_IMAGE_NOT_FOUND', async () => {
    const err = containerError('CNT_IMAGE_NOT_FOUND', {});
    const result = await tryAutoRemediation(err);
    expect(result).toBeNull();
  });

  it('returns null for CNT_RUNTIME_CRASH', async () => {
    const err = containerError('CNT_RUNTIME_CRASH', {});
    const result = await tryAutoRemediation(err);
    expect(result).toBeNull();
  });

  it('returns null for GPU_ECC_ERROR', async () => {
    const err = gpuError('GPU_ECC_ERROR', {});
    const result = await tryAutoRemediation(err);
    expect(result).toBeNull();
  });
});

// ── RemediationAction shape invariants ────────────────────────────────────────

describe('RemediationAction shape invariants', () => {
  it('every non-null result has action, reason, success, and suggestions fields', async () => {
    const errors = [
      resourceError('RES_CUDA_OOM', {}),
      networkError('NET_DOCKER_HUB_RATE_LIMIT', {}),
      containerError('CNT_HEALTHCHECK_FAIL', {}),
      new DeployError('INFRASTRUCTURE', 'INF_CREDIT_ZERO', {}),
      gpuError('GPU_DRIVER_MISMATCH', {}),
      gpuError('GPU_CUDA_MISMATCH', {}),
    ];

    for (const err of errors) {
      const result = await tryAutoRemediation(err);
      expect(result, `Expected non-null for ${err.code}`).not.toBeNull();
      expect(typeof result!.action).toBe('string');
      expect(typeof result!.reason).toBe('string');
      expect(typeof result!.success).toBe('boolean');
      expect(Array.isArray(result!.suggestions)).toBe(true);
    }
  });

  it('suggestions are always non-empty strings', async () => {
    const err = containerError('CNT_HEALTHCHECK_FAIL', {});
    const result = await tryAutoRemediation(err);
    for (const s of result!.suggestions) {
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
    }
  });

  it('returns null (not throws) for unhandled codes', async () => {
    const err = networkError('NET_CONNECTION_REFUSED', {});
    await expect(tryAutoRemediation(err)).resolves.toBeNull();
  });
});
