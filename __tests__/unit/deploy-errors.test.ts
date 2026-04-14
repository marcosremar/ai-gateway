/**
 * Tests for deploy error categorization system.
 *
 * Based on real-world error patterns from Vast.ai, RunPod, Docker Hub,
 * NVIDIA/CUDA, and LLM deployment.
 */

import { describe, it, expect } from 'vitest';
import {
  categorizeDeployError,
  DeployError,
  summarizeErrors,
  CATEGORY_METADATA,
  ERROR_CODE_METADATA,
  validationError,
  resourceError,
  networkError,
  containerError,
  gpuError,
} from '../../src/errors/deploy-errors';

describe('Error Categories', () => {
  it('should have metadata for all 10 categories', () => {
    expect(Object.keys(CATEGORY_METADATA)).toHaveLength(10);
    for (const [key, meta] of Object.entries(CATEGORY_METADATA)) {
      expect(meta.name).toBeDefined();
      expect(meta.icon).toBeDefined();
      expect(meta.suggestedAction).toBeDefined();
    }
  });
});

describe('Error Codes', () => {
  it('should have metadata for all error codes', () => {
    expect(Object.keys(ERROR_CODE_METADATA).length).toBeGreaterThan(50);
    for (const [code, meta] of Object.entries(ERROR_CODE_METADATA)) {
      expect(meta.message).toBeDefined();
      expect(meta.retryable).toBeDefined();
      expect(meta.httpStatus).toBeDefined();
      expect(meta.severity).toBeDefined();
      expect(meta.realWorldPattern).toBeDefined();
    }
  });
});

describe('categorizeDeployError — VALIDATION', () => {
  it('should categorize VLD_INVALID_INPUT', () => {
    const err = categorizeDeployError(new Error('Invalid input: bad format'));
    expect(err.category).toBe('VALIDATION');
    expect(err.code).toBe('VLD_INVALID_INPUT');
    expect(err.retryable).toBe(false);
  });

  it('should categorize VLD_MISSING_FIELD', () => {
    const err = categorizeDeployError(new Error('Missing required field: gpuTypes'));
    expect(err.category).toBe('VALIDATION');
    expect(err.code).toBe('VLD_MISSING_FIELD');
  });

  it('should categorize VLD_PREFLIGHT_FAILED', () => {
    const err = categorizeDeployError(new Error('Pre-flight checks failed'));
    expect(err.category).toBe('VALIDATION');
    expect(err.code).toBe('VLD_PREFLIGHT_FAILED');
  });

  it('should categorize VLD_SPEND_RATE_LIMIT', () => {
    const err = categorizeDeployError(new Error('spend_rate_limit'));
    expect(err.category).toBe('VALIDATION');
    expect(err.code).toBe('VLD_SPEND_RATE_LIMIT');
  });
});

describe('categorizeDeployError — RESOURCE', () => {
  it('should categorize RES_CUDA_OOM', () => {
    const err = categorizeDeployError(new Error('CUDA out of memory: 22GB/24GB'));
    expect(err.category).toBe('RESOURCE');
    expect(err.code).toBe('RES_CUDA_OOM');
    expect(err.severity).toBe('critical');
  });

  it('should categorize RES_DISK_FULL', () => {
    const err = categorizeDeployError(new Error('No space left on device (ENOSPC)'));
    expect(err.category).toBe('RESOURCE');
    expect(err.code).toBe('RES_DISK_FULL');
  });

  it('should categorize RES_VRAM_INSUFFICIENT', () => {
    const err = categorizeDeployError(new Error('Insufficient VRAM: 48GB needed, 24GB available'));
    expect(err.category).toBe('RESOURCE');
    expect(err.code).toBe('RES_VRAM_INSUFFICIENT');
  });
});

describe('categorizeDeployError — NETWORK', () => {
  it('should categorize NET_DNS_FAILURE', () => {
    const err = categorizeDeployError(new Error('getaddrinfo ENOTFOUND console.vast.ai'));
    expect(err.category).toBe('NETWORK');
    expect(err.code).toBe('NET_DNS_FAILURE');
    expect(err.retryable).toBe(true);
  });

  it('should categorize NET_TIMEOUT', () => {
    const err = categorizeDeployError(new Error('Request timed out after 30000ms'));
    expect(err.category).toBe('NETWORK');
    expect(err.code).toBe('NET_TIMEOUT');
  });

  it('should categorize NET_DOCKER_HUB_RATE_LIMIT', () => {
    const err = categorizeDeployError(new Error('toomanyrequests: Docker Hub rate limit'));
    expect(err.category).toBe('NETWORK');
    expect(err.code).toBe('NET_DOCKER_HUB_RATE_LIMIT');
  });

  it('should categorize NET_PROVIDER_RATE_LIMIT', () => {
    const err = categorizeDeployError(new Error('429 Rate limit exceeded'));
    expect(err.category).toBe('NETWORK');
    expect(err.code).toBe('NET_PROVIDER_RATE_LIMIT');
  });
});

describe('categorizeDeployError — PROVIDER', () => {
  it('should categorize PRV_AUTH_FAILED', () => {
    const err = categorizeDeployError(new Error('Invalid API key'));
    expect(err.category).toBe('PROVIDER');
    expect(err.code).toBe('PRV_AUTH_FAILED');
  });

  it('should categorize PRV_NO_GPUS', () => {
    const err = categorizeDeployError(new Error('No GPUs available (0 offers matched)'));
    expect(err.category).toBe('PROVIDER');
    expect(err.code).toBe('PRV_NO_GPUS');
  });

  it('should categorize PRV_SCHEDULING_STUCK', () => {
    const err = categorizeDeployError(new Error('Instance stuck in scheduling'));
    expect(err.category).toBe('PROVIDER');
    expect(err.code).toBe('PRV_SCHEDULING_STUCK');
  });
});

describe('categorizeDeployError — CONTAINER', () => {
  it('should categorize CNT_IMAGE_NOT_FOUND', () => {
    const err = categorizeDeployError(new Error('manifest unknown: image not found'));
    expect(err.category).toBe('CONTAINER');
    expect(err.code).toBe('CNT_IMAGE_NOT_FOUND');
  });

  it('should categorize CNT_PULL_FAILED', () => {
    const err = categorizeDeployError(new Error('Docker pull failed'));
    expect(err.category).toBe('CONTAINER');
    expect(err.code).toBe('CNT_PULL_FAILED');
  });

  it('should categorize CNT_HEALTHCHECK_FAIL', () => {
    const err = categorizeDeployError(new Error('Container health check failed'));
    expect(err.category).toBe('CONTAINER');
    expect(err.code).toBe('CNT_HEALTHCHECK_FAIL');
  });

  it('should categorize CNT_GPU_DRIVER_MISSING', () => {
    const err = categorizeDeployError(new Error('could not select device driver with capabilities: [[gpu]]'));
    expect(err.category).toBe('CONTAINER');
    expect(err.code).toBe('CNT_GPU_DRIVER_MISSING');
    expect(err.retryable).toBe(false);
  });

  it('should categorize CNT_PULL_BACKOFF', () => {
    const err = categorizeDeployError(new Error('ImagePullBackOff: back-off pulling image'));
    expect(err.category).toBe('CONTAINER');
    expect(err.code).toBe('CNT_PULL_BACKOFF');
  });
});

describe('categorizeDeployError — GPU_HARDWARE', () => {
  it('should categorize GPU_DRIVER_MISMATCH', () => {
    const err = categorizeDeployError(new Error('Failed to initialize NVML: Driver/library version mismatch'));
    expect(err.category).toBe('GPU_HARDWARE');
    expect(err.code).toBe('GPU_DRIVER_MISMATCH');
  });

  it('should categorize GPU_NVML_FAILURE', () => {
    const err = categorizeDeployError(new Error('NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver'));
    expect(err.category).toBe('GPU_HARDWARE');
    expect(err.code).toBe('GPU_NVML_FAILURE');
  });

  it('should categorize GPU_THERMAL_THROTTLE', () => {
    const err = categorizeDeployError(new Error('GPU temperature high: 90°C'));
    expect(err.category).toBe('GPU_HARDWARE');
    expect(err.code).toBe('GPU_THERMAL_THROTTLE');
  });
});

describe('categorizeDeployError — SECURITY', () => {
  it('should categorize SEC_TLS_FAILURE', () => {
    const err = categorizeDeployError(new Error('TLS certificate verification failed'));
    expect(err.category).toBe('SECURITY');
    expect(err.code).toBe('SEC_TLS_FAILURE');
  });

  it('should categorize SEC_SSH_KEY_DENIED', () => {
    const err = categorizeDeployError(new Error('Permission denied (publickey)'));
    expect(err.category).toBe('SECURITY');
    expect(err.code).toBe('SEC_SSH_KEY_DENIED');
  });
});

describe('categorizeDeployError — STATE', () => {
  it('should categorize ST_DUPLICATE_REQUEST', () => {
    const err = categorizeDeployError(new Error('Duplicate deploy request (idempotency)'));
    expect(err.category).toBe('STATE');
    expect(err.code).toBe('ST_DUPLICATE_REQUEST');
    expect(err.httpStatus).toBe(200);
  });

  it('should categorize ST_GHOST_MACHINE', () => {
    const err = categorizeDeployError(new Error('Ghost machine detected'));
    expect(err.category).toBe('STATE');
    expect(err.code).toBe('ST_GHOST_MACHINE');
  });
});

describe('categorizeDeployError — COST', () => {
  it('should categorize CST_BUDGET_EXCEEDED', () => {
    const err = categorizeDeployError(new Error('Budget exceeded'));
    expect(err.category).toBe('COST');
    expect(err.code).toBe('CST_BUDGET_EXCEEDED');
  });

  it('should categorize CST_UNREASONABLE_PRICE', () => {
    const err = categorizeDeployError(new Error('Unreasonable price: $10/hr'));
    expect(err.category).toBe('COST');
    expect(err.code).toBe('CST_UNREASONABLE_PRICE');
  });
});

describe('categorizeDeployError — INFRASTRUCTURE', () => {
  it('should categorize INF_HOST_RECLAIM', () => {
    const err = categorizeDeployError(new Error('Host reclaimed instance'));
    expect(err.category).toBe('INFRASTRUCTURE');
    expect(err.code).toBe('INF_HOST_RECLAIM');
  });

  it('should categorize INF_CREDIT_ZERO', () => {
    const err = categorizeDeployError(new Error('Account credit balance is zero'));
    expect(err.category).toBe('INFRASTRUCTURE');
    expect(err.code).toBe('INF_CREDIT_ZERO');
  });
});

describe('DeployError class', () => {
  it('should create error with all properties', () => {
    const err = new DeployError('RESOURCE', 'RES_CUDA_OOM', { used: 22, total: 24, model: '70B' });
    expect(err.name).toBe('DeployError');
    expect(err.category).toBe('RESOURCE');
    expect(err.code).toBe('RES_CUDA_OOM');
    expect(err.retryable).toBe(false);
    expect(err.httpStatus).toBe(507);
    expect(err.severity).toBe('critical');
  });

  it('should generate userMessage', () => {
    const err = categorizeDeployError(new Error('CUDA out of memory'));
    expect(err.userMessage).toContain('Resource Error');
    expect(err.userMessage).toContain('→');
  });

  it('should serialize to JSON', () => {
    const err = categorizeDeployError(new Error('Test error'));
    const json = err.toJSON();
    expect(json).toHaveProperty('category');
    expect(json).toHaveProperty('code');
    expect(json).toHaveProperty('message');
    expect(json).toHaveProperty('userMessage');
    expect(json).toHaveProperty('retryable');
    expect(json).toHaveProperty('httpStatus');
    expect(json).toHaveProperty('severity');
    expect(json).toHaveProperty('context');
  });
});

describe('Factory functions', () => {
  it('validationError should create correct error', () => {
    const err = validationError('VLD_MISSING_FIELD', { field: 'gpuTypes' });
    expect(err.category).toBe('VALIDATION');
    expect(err.code).toBe('VLD_MISSING_FIELD');
  });

  it('resourceError should create correct error', () => {
    const err = resourceError('RES_CUDA_OOM', { used: 22, total: 24 });
    expect(err.category).toBe('RESOURCE');
    expect(err.code).toBe('RES_CUDA_OOM');
  });

  it('networkError should create correct error', () => {
    const err = networkError('NET_DOCKER_HUB_RATE_LIMIT', {});
    expect(err.category).toBe('NETWORK');
    expect(err.code).toBe('NET_DOCKER_HUB_RATE_LIMIT');
  });

  it('containerError should create correct error', () => {
    const err = containerError('CNT_IMAGE_NOT_FOUND', { image: 'my-llm:latest' });
    expect(err.category).toBe('CONTAINER');
    expect(err.code).toBe('CNT_IMAGE_NOT_FOUND');
  });

  it('gpuError should create correct error', () => {
    const err = gpuError('GPU_DRIVER_MISMATCH', {});
    expect(err.category).toBe('GPU_HARDWARE');
    expect(err.code).toBe('GPU_DRIVER_MISMATCH');
  });
});

describe('summarizeErrors', () => {
  it('should summarize errors by category', () => {
    const errors = [
      categorizeDeployError(new Error('CUDA out of memory')),
      categorizeDeployError(new Error('CUDA out of memory')),
      categorizeDeployError(new Error('DNS resolution failed')),
      categorizeDeployError(new Error('Budget exceeded')),
    ];

    const summary = summarizeErrors(errors);
    expect(summary.totalErrors).toBe(4);
    expect(summary.byCategory.RESOURCE).toBe(2);
    expect(summary.byCategory.NETWORK).toBe(1);
    expect(summary.byCategory.COST).toBe(1);
    expect(summary.retryableCount).toBeGreaterThanOrEqual(1);
    expect(summary.topErrors.length).toBeGreaterThan(0);
  });
});
